/**
 * One local Claude CLI invocation. Every post-spawn path settles the owned
 * process group before returning, including failed results and a leader that
 * exited while descendants still hold its pipes. Process cleanup does not
 * establish which business side effects an interrupted invocation performed.
 */
import { spawn } from 'node:child_process'

import { createCollector } from './protocol.js'
import { ClaudeCodeProFailure, delay, errorMessage } from './util.js'

export const DEFAULT_RUN_TIMEOUT_MS = 600_000
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

const MAX_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 16 * 1024 * 1024
const STDERR_TAIL_CHARS = 8_192
const GROUP_REAP_TIMEOUT_MS = 2_000

function spawnFailureDetail(error, command) {
  return error?.code === 'ENOENT'
    ? `cannot start "${command}" (ENOENT): install the Claude Code CLI or set the plugin's "command" to its absolute path`
    : errorMessage(error)
}

function idleExecution() {
  return { pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched',
    outcome: 'not-started', terminalReceived: false, exitCode: null, signal: null,
    cancelled: false, timedOut: false, truncated: false }
}

/**
 * Low-level shared runner. Desktop callers retain the completed/aborted shape
 * and ClaudeCodeProFailure, while machine callers read the attached `run`
 * evidence. A thrown error without run evidence must never prove no dispatch.
 *
 * @param {{ command: string, args: readonly string[], cwd: string,
 * env: NodeJS.ProcessEnv, input: string, timeoutMs?: number,
 * signal?: AbortSignal, disposeGraceMs?: number, maxOutputBytes?: number,
 * onEvent?: (event: { type: 'assistant-text', text: string }) => void,
 * onSpawn?: (pid: number) => void }} options
 */
export async function runLocalClaude(options) {
  const { command, args, cwd, env, input, timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    signal, disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS, maxOutputBytes = MAX_STDOUT_BYTES, onEvent } = options
  const initial = idleExecution()
  if (signal?.aborted) {
    return { stopReason: 'aborted', cleanupConfirmed: true, terminalReceived: false,
      execution: { ...initial, cancelled: true } }
  }
  if (process.platform === 'win32') {
    const error = new ClaudeCodeProFailure({ stage: 'start', category: 'unsupported-runtime',
      detail: 'Claude Code Pro delegation requires POSIX process-group cleanup; Windows is not supported',
      cleanupConfirmed: true, terminalReceived: false })
    error.run = { cleanupConfirmed: true, terminalReceived: false, execution: initial }
    throw error
  }

  let child
  try {
    child = spawn(command, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  } catch (cause) {
    const error = new ClaudeCodeProFailure({ stage: 'start', category: 'spawn', detail: spawnFailureDetail(cause, command),
      cleanupConfirmed: true, terminalReceived: false }, cause)
    error.run = { cleanupConfirmed: true, terminalReceived: false, execution: initial }
    throw error
  }

  const pid = child.pid
  const collector = createCollector()
  let outcome, spawnError, streamError, closed = false, stdoutEnded = false
  let timedOut = false, cancelled = false, outputOverflow = false, malformedChunks = 0
  let stdoutBytes = 0, buffer = Buffer.alloc(0), stderrTail = ''
  let wake
  const settled = new Promise(resolve => { wake = resolve })
  let closeResolve
  const closePromise = new Promise(resolve => { closeResolve = resolve })
  child.once('exit', (code, signalName) => { outcome = { code, signal: signalName }; wake() })
  child.once('close', (code, signalName) => {
    outcome ??= { code, signal: signalName }
    closed = true
    closeResolve()
    wake()
  })
  child.once('error', error => { spawnError = error; wake() })
  if (pid !== undefined && options.onSpawn !== undefined) {
    try { options.onSpawn(pid) } catch { /* Physical supervision must not depend on a diagnostic callback. */ }
  }

  // Only ESRCH proves absence. EPERM and other errors must not confirm cleanup.
  const groupExists = () => {
    if (pid === undefined) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) { return error?.code !== 'ESRCH' }
  }
  const killGroup = signalName => {
    if (pid === undefined) return
    try {
      process.kill(-pid, signalName)
    } catch { /* The subsequent liveness probe is the cleanup evidence. */ }
  }
  const waitForGroup = async milliseconds => {
    const deadline = Date.now() + milliseconds
    while (groupExists()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await delay(Math.min(25, remaining))
    }
    return true
  }
  const cleanup = async () => {
    if (!groupExists()) return true
    // A dead leader does not remove its still-running descendants.
    killGroup('SIGTERM')
    if (await waitForGroup(disposeGraceMs)) return true
    killGroup('SIGKILL')
    return waitForGroup(GROUP_REAP_TIMEOUT_MS)
  }

  const malformed = () => { malformedChunks += 1; collector.malformed() }
  const acceptLine = line => {
    if (line.length === 0 || (line.length === 1 && line[0] === 13)) return
    let event
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) }
    catch { malformed(); wake(); return }
    collector.accept(event)
    if (onEvent !== undefined && event?.type === 'assistant') {
      const content = event.message?.content
      if (Array.isArray(content)) {
        const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
        if (text !== '') {
          try { onEvent({ type: 'assistant-text', text }) } catch { /* Progress is not completion evidence. */ }
        }
      }
    }
  }
  child.stdout.on('data', chunk => {
    if (outputOverflow) return
    stdoutBytes += chunk.length
    if (stdoutBytes > MAX_STDOUT_BYTES) { outputOverflow = true; buffer = Buffer.alloc(0); wake(); return }
    buffer = Buffer.concat([buffer, chunk])
    let newline
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > MAX_LINE_BYTES) { outputOverflow = true; buffer = Buffer.alloc(0); wake(); return }
      acceptLine(buffer.subarray(0, newline))
      buffer = buffer.subarray(newline + 1)
    }
    if (buffer.length > MAX_LINE_BYTES) { outputOverflow = true; buffer = Buffer.alloc(0); wake() }
  })
  child.stdout.once('end', () => {
    stdoutEnded = true
    // A missing NDJSON delimiter is a truncated frame, even if it parses as JSON.
    if (buffer.length > 0) { malformed(); buffer = Buffer.alloc(0) }
  })
  child.stdout.once('error', error => { streamError = error; wake() })
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
  child.stderr.on('error', error => { streamError ??= error; wake() })
  child.stdin.on('error', () => { /* A terminal or missing result distinguishes EPIPE outcomes. */ })
  try { child.stdin.end(input) } catch { /* The exit and result paths remain authoritative. */ }

  const onAbort = () => { cancelled = true; wake() }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => { timedOut = true; wake() }, timeoutMs)
    : undefined

  await settled
  // Drain a normally exiting leader first; inherited pipes cannot hold us forever.
  if (!closed && outcome !== undefined && !cancelled && !timedOut && !outputOverflow && malformedChunks === 0 && !streamError) {
    await Promise.race([closePromise, delay(50)])
  }
  const cleanupConfirmed = await cleanup()
  if (!closed) await Promise.race([closePromise, delay(100)])
  if (timer !== undefined) clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  if (!closed) {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }

  const finished = collector.finish()
  const expectedExit = finished.kind === 'success' ? outcome?.code === 0 : outcome?.code === 0 || outcome?.code === 1
  const terminalReceived = finished.terminalReceived === true && expectedExit && outcome?.signal === null
    && closed && stdoutEnded && !streamError && !outputOverflow && malformedChunks === 0
  const execution = { ...initial,
    pid: pid ?? null, processGroupId: pid ?? null,
    ownership: pid === undefined ? 'none' : 'process-group',
    dispatch: pid === undefined ? 'not-dispatched' : 'dispatched',
    outcome: pid === undefined ? 'not-started' : terminalReceived ? (finished.kind === 'success' ? 'completed' : 'failed') : 'unknown',
    terminalReceived, exitCode: pid === undefined ? null : outcome?.code ?? null, signal: pid === undefined ? null : outcome?.signal ?? null,
    cancelled, timedOut, truncated: outputOverflow }
  const run = { cleanupConfirmed, execution, terminalReceived, init: finished.init,
    sessionId: finished.sessionId, outcome: { exitCode: execution.exitCode, signal: execution.signal },
    ...(terminalReceived ? { usage: finished.usage, reportedCostUSD: finished.reportedCostUSD } : {}) }
  const fail = (facts, cause) => {
    const error = new ClaudeCodeProFailure({ ...facts, exitCode: execution.exitCode, signal: execution.signal,
      cleanupConfirmed, terminalReceived }, cause)
    error.run = run
    throw error
  }

  if (!cleanupConfirmed) fail({ stage: 'cleanup', category: 'cleanup-unconfirmed', detail: 'the owned process group could not be confirmed stopped; do not retry this invocation' })
  if (cancelled) return { ...run, stopReason: 'aborted' }
  if (spawnError !== undefined) fail({ stage: pid === undefined ? 'start' : 'process', category: pid === undefined ? 'spawn' : 'process', detail: spawnFailureDetail(spawnError, command) }, spawnError)
  if (timedOut) fail({ stage: 'run', category: 'timeout', detail: `the delegation exceeded its ${timeoutMs} ms deadline and was cancelled` })
  if (outputOverflow) fail({ stage: 'query-run', category: 'protocol', detail: 'the CLI exceeded the bounded stream output limit; the run was cancelled' })
  if (streamError || !closed || !stdoutEnded) fail({ stage: 'query-run', category: 'protocol', detail: 'the CLI output stream did not finish cleanly' })
  if (finished.kind === 'failure') {
    let detail = finished.facts.detail ?? 'the CLI did not return a valid result'
    if (finished.facts.category === 'invalid-result' && malformedChunks > 0) detail += `; ${malformedChunks} unparseable line(s)`
    if (finished.facts.category === 'invalid-result' && stderrTail.trim() !== '') detail += `: ${stderrTail.trim().slice(-500)}`
    fail({ ...finished.facts, detail })
  }
  if (!terminalReceived) fail({ stage: 'process', category: 'process', detail: `the CLI reported success without a clean terminal exit (code ${String(outcome?.code)})` })
  if (Buffer.byteLength(finished.text, 'utf8') > maxOutputBytes) {
    execution.truncated = true
    fail({ stage: 'query-run', category: 'limit', detail: `the terminal answer exceeded maxOutputBytes (${maxOutputBytes})` })
  }
  return { ...run, stopReason: 'completed', text: finished.text, structuredOutput: finished.structuredOutput, images: finished.images }
}
