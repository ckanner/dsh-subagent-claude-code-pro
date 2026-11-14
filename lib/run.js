/**
 * Parent side of one private guardian. Establish supervision before the guardian
 * is allowed to spawn Claude. IPC disconnect survives caller SIGKILL and makes
 * the guardian settle its native process group before it exits.
 */
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS } from './run-local.js'
import { ClaudeCodeProFailure, delay } from './util.js'

export { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS }

const PROTOCOL = 1
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024
const GUARDIAN_PATH = fileURLToPath(new URL('./guardian.js', import.meta.url))

function idleExecution(cancelled = false) {
  return { pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched',
    outcome: 'not-started', terminalReceived: false, exitCode: null, signal: null,
    cancelled, timedOut: false, truncated: false }
}

function beforeDispatchFailure(category, detail, cancelled = false) {
  const error = new ClaudeCodeProFailure({ stage: 'start', category, detail, cleanupConfirmed: true, terminalReceived: false })
  error.run = { cleanupConfirmed: true, terminalReceived: false, execution: idleExecution(cancelled) }
  return error
}

// If a guardian itself exits unexpectedly after reporting the native group,
// the still-live parent performs bounded last-resort cleanup. No terminal
// outcome is reconstructed from the fact that a process was killed.
async function cleanKnownGroup(pid, graceMs) {
  const exists = () => {
    try { process.kill(-pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
  }
  const kill = signal => { try { process.kill(-pid, signal) } catch { /* probe below */ } }
  const wait = async ms => {
    const end = Date.now() + ms
    while (exists()) {
      const remaining = end - Date.now()
      if (remaining <= 0) return false
      await delay(Math.min(25, remaining))
    }
    return true
  }
  if (!exists()) return true
  kill('SIGTERM')
  if (await wait(graceMs)) return true
  kill('SIGKILL')
  return wait(2000)
}

/** Existing desktop result shape, with structured lifecycle evidence for machine callers. */
export async function runClaude(options) {
  const { signal, onEvent, onNativeEvent, ...nativeOptions } = options
  if (signal?.aborted) return { stopReason: 'aborted', cleanupConfirmed: true, terminalReceived: false, execution: idleExecution(true) }
  if (process.platform === 'win32') throw beforeDispatchFailure('unsupported-runtime', 'Claude Code Pro requires POSIX process-group supervision; Windows is not supported')

  let guardian
  try {
    guardian = fork(GUARDIAN_PATH, [], { execPath: process.execPath, execArgv: [], detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} })
  } catch { throw beforeDispatchFailure('spawn', 'the Claude Code supervisor could not be started') }

  const invocationId = randomUUID()
  let started = false, ready = false, response, protocolError, guardianError, nativePid
  let exitCode = null, exitSignal = null, stderrTail = '', closed = false
  let resolveClosed
  const finished = new Promise(resolve => { resolveClosed = resolve })
  const cancel = () => {
    if (!guardian.connected) return
    try { guardian.send({ protocol: PROTOCOL, type: 'cancel' }, () => {}) } catch { /* disconnect below is also a lifeline abort */ }
  }
  const disconnect = () => { try { if (guardian.connected) guardian.disconnect() } catch { /* guardian may already be exiting */ } }
  const invalid = detail => { protocolError ??= detail; cancel(); disconnect() }
  guardian.once('error', error => {
    guardianError = error
    if (!started) { closed = true; resolveClosed() }
    else { cancel(); disconnect() }
  })
  guardian.once('exit', (code, signalName) => { exitCode = code; exitSignal = signalName })
  guardian.once('close', (code, signalName) => {
    exitCode = code
    exitSignal = signalName
    closed = true
    resolveClosed()
  })
  guardian.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096) })
  guardian.stderr.on('error', () => invalid('the supervisor diagnostic stream failed'))
  guardian.on('message', message => {
    if (protocolError) return
    if (!message || message.protocol !== PROTOCOL || typeof message.type !== 'string' || response !== undefined
      || Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) { invalid('invalid supervisor protocol frame'); return }
    if (message.type === 'ready') {
      if (ready) { invalid('the supervisor repeated admission'); return }
      ready = true
      clearTimeout(admissionTimer)
      started = true
      try {
        guardian.send({ protocol: PROTOCOL, type: 'start', invocationId, options: nativeOptions }, error => {
          if (error) invalid('the supervisor request could not be delivered')
        })
      } catch { invalid('the supervisor request could not be delivered') }
      if (signal?.aborted) cancel()
      return
    }
    if (!started || message.invocationId !== invocationId) { invalid('the supervisor invocation identity did not match'); return }
    if (message.type === 'spawned') {
      if (nativePid !== undefined || !Number.isSafeInteger(message.pid) || message.pid <= 0) { invalid('invalid supervisor process identity'); return }
      nativePid = message.pid
    } else if (message.type === 'progress') {
      if (typeof message.text !== 'string') { invalid('invalid supervisor progress'); return }
      if (onEvent !== undefined) { try { onEvent({ type: 'assistant-text', text: message.text }) } catch { /* display only */ } }
    } else if (message.type === 'native-event') {
      if (message.event?.version !== 1 || !Number.isSafeInteger(message.event.sequence) || typeof message.event.id !== 'string') { invalid('invalid native event'); return }
      try { onNativeEvent?.(message.event) } catch { /* observation only */ }
    } else if (message.type === 'result' || message.type === 'failure') response = message
    else invalid('unknown supervisor frame')
  })
  const admissionTimer = setTimeout(() => {
    protocolError ??= 'the supervisor did not admit a request within 10 seconds'
    cancel()
    disconnect()
    if (!started) { try { guardian.kill('SIGTERM') } catch { /* no native request was sent */ } }
  }, 10000)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()

  await finished
  clearTimeout(admissionTimer)
  signal?.removeEventListener('abort', cancel)
  if (!started) throw beforeDispatchFailure('spawn', 'the Claude Code supervisor failed before invocation admission')
  if (guardianError || protocolError || exitCode !== 0 || exitSignal !== null || response === undefined || !closed) {
    if (nativePid === undefined) throw new Error(protocolError ?? 'the supervisor exited without complete native lifecycle evidence')
    const confirmed = await cleanKnownGroup(nativePid, nativeOptions.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS)
    const execution = { ...idleExecution(signal?.aborted === true), pid: nativePid, processGroupId: nativePid,
      ownership: 'process-group', dispatch: 'dispatched', outcome: 'unknown' }
    const error = new ClaudeCodeProFailure({ stage: confirmed ? 'process' : 'cleanup',
      category: confirmed ? 'process' : 'cleanup-unconfirmed',
      detail: protocolError ?? (stderrTail ? 'the supervisor exited unexpectedly; its diagnostic stream is not completion evidence' : 'the supervisor exited without a complete terminal response'),
      cleanupConfirmed: confirmed, terminalReceived: false })
    error.run = { cleanupConfirmed: confirmed, terminalReceived: false, execution }
    throw error
  }
  if (response.type === 'result') {
    if (!response.result?.execution) throw new Error('the supervisor omitted lifecycle evidence')
    return response.result
  }
  if (!response.error?.facts || !response.error?.run?.execution) throw new Error('the supervisor failed without complete lifecycle evidence')
  const error = new ClaudeCodeProFailure(response.error.facts)
  error.run = response.error.run
  throw error
}
