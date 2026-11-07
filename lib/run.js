/**
 * One delegation's process lifecycle around the local `claude` CLI.
 *
 * The run has one absolute deadline from before spawn through process exit.
 * A caller cancellation, the deadline, and a protocol failure are distinct
 * outcomes. Cleanup targets the whole owned process group, because Claude Code
 * spawns its own tool processes; a dead leader with live descendants would
 * otherwise leak work the caller cannot see.
 *
 * @module dsh-subagent-claude-code-pro/run
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { createCollector } from './protocol.js'
import { ClaudeCodeProFailure, delay, errorMessage } from './util.js'

/** Generous default: coding delegations take minutes, not seconds. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000

/** Grace between SIGTERM and SIGKILL for the owned process group. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

const MAX_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 16 * 1024 * 1024
const STDERR_TAIL_CHARS = 8_192
const GROUP_REAP_TIMEOUT_MS = 2_000

/**
 * Turn a spawn failure into the message a person can act on.
 * @param {unknown} error
 * @param {string} command
 * @returns {string}
 */
function spawnFailureDetail(error, command) {
  const code = /** @type {any} */ (error)?.code
  if (code === 'ENOENT') {
    return `cannot start "${command}" (ENOENT): install the Claude Code CLI or set the plugin's "command" to its absolute path`
  }
  return errorMessage(error)
}

/**
 * Run one delegation and return its terminal answer.
 *
 * Resolves with `{ stopReason: 'completed', ... }` or
 * `{ stopReason: 'aborted' }`; throws {@link ClaudeCodeProFailure} for failures
 * that carry a safe stage/category/detail.
 *
 * @param {{
 *   command: string,
 *   args: readonly string[],
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   input: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   disposeGraceMs?: number,
 *   onEvent?: (event: { type: 'assistant-text', text: string }) => void,
 * }} options
 * @returns {Promise<{
 *   stopReason: 'completed' | 'aborted',
 *   text?: string,
 *   sessionId?: string,
 *   structuredOutput?: unknown,
 *   usage?: unknown,
 *   init?: any,
 *   images?: { data: string, mimeType: string }[],
 *   outcome?: { code: number | null, signal: string | null },
 *   cleanupConfirmed?: boolean,
 * }>}
 */
export async function runClaude(options) {
  const {
    command,
    args,
    cwd,
    env,
    input,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    signal,
    disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
    onEvent,
  } = options

  const collector = createCollector()
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child
  try {
    child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A POSIX process group is the unit cleanup owns. Windows has no group
      // here; the direct process is killed instead.
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    throw new ClaudeCodeProFailure({ stage: 'start', category: 'spawn', detail: spawnFailureDetail(error, command) }, error)
  }

  const pid = child.pid
  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | undefined} */
  let outcome
  /** @type {unknown} */
  let spawnError
  let timedOut = false
  let cancelled = false
  let outputOverflow = false
  let malformedChunks = 0
  let stdoutBytes = 0
  let stderrTail = ''
  /** @type {Promise<any> | undefined} */
  let termination

  const closed = new Promise((resolve) => {
    child.once('close', (code, signalName) => {
      outcome = { code, signal: signalName }
      resolve(outcome)
    })
  })
  const failedToSpawn = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error
      resolve(undefined)
    })
  })

  const killGroup = (signalName) => {
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill(signalName)
      else process.kill(-pid, signalName)
    } catch {
      try {
        child.kill(signalName)
      } catch {
        // The range is already gone.
      }
    }
  }

  /** Prove the owned range is gone; false means a descendant survived. */
  const reapGroup = async () => {
    if (pid === undefined) return true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (process.platform === 'win32') child.kill(0)
        else process.kill(-pid, 0)
      } catch {
        return true
      }
      await delay(100)
    }
    return false
  }

  const terminate = () => {
    if (termination !== undefined) return termination
    termination = (async () => {
      if (pid === undefined) return
      if (outcome !== undefined) {
        await reapGroup()
        return
      }
      killGroup('SIGTERM')
      const exited = await Promise.race([closed.then(() => true), delay(disposeGraceMs).then(() => false)])
      if (!exited) {
        killGroup('SIGKILL')
        await Promise.race([closed, delay(GROUP_REAP_TIMEOUT_MS)])
      }
      await reapGroup()
    })()
    return termination
  }

  if (child.stdout !== null) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line === '') return
      const bytes = Buffer.byteLength(line, 'utf8')
      if (bytes > MAX_LINE_BYTES) {
        outputOverflow = true
        void terminate()
        return
      }
      stdoutBytes += bytes
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        outputOverflow = true
        void terminate()
        return
      }
      let event
      try {
        event = JSON.parse(line)
      } catch {
        malformedChunks += 1
        return
      }
      collector.accept(event)
      if (onEvent !== undefined && event?.type === 'assistant') {
        const content = event?.message?.content
        if (Array.isArray(content)) {
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('')
          if (text !== '') {
            try {
              onEvent({ type: 'assistant-text', text })
            } catch {
              // Progress reporting must never fail the delegation.
            }
          }
        }
      }
    })
  }

  if (child.stderr !== null) {
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.stderr.on('error', () => {})
  }

  if (child.stdin !== null) {
    child.stdin.on('error', () => {
      // EPIPE means the CLI exited before reading the prompt; the result path
      // reports the real cause.
    })
    try {
      child.stdin.end(input)
    } catch {
      // Same as above.
    }
  }

  const onAbort = () => {
    cancelled = true
    void terminate()
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      cancelled = true
      void terminate()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  let timer
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      void terminate()
    }, timeoutMs)
    timer.unref?.()
  }

  // A spawn failure may never emit `close`; wait for the first of the two and
  // give `close` a short chance to arrive afterwards.
  await Promise.race([closed, failedToSpawn])
  await Promise.race([closed, delay(50)])

  if (timer !== undefined) clearTimeout(timer)
  signal?.removeEventListener?.('abort', onAbort)

  if (cancelled) {
    await terminate()
    return { stopReason: 'aborted' }
  }
  if (spawnError !== undefined) {
    throw new ClaudeCodeProFailure(
      { stage: 'start', category: 'spawn', detail: spawnFailureDetail(spawnError, command) },
      spawnError,
    )
  }

  const facts = { exitCode: outcome?.code ?? null, signal: outcome?.signal ?? null }
  if (timedOut) {
    throw new ClaudeCodeProFailure({
      stage: 'run',
      category: 'timeout',
      detail: `the delegation exceeded its ${timeoutMs} ms deadline and was cancelled`,
      ...facts,
    })
  }
  if (outputOverflow) {
    throw new ClaudeCodeProFailure({
      stage: 'query-run',
      category: 'protocol',
      detail: `the CLI produced more than ${MAX_STDOUT_BYTES} bytes of output; the run was cancelled`,
      ...facts,
    })
  }

  const finished = collector.finish()
  if (finished.kind === 'success') {
    if (outcome?.code !== 0) {
      throw new ClaudeCodeProFailure({
        stage: 'process',
        category: 'process',
        detail: `the CLI reported success but exited with code ${String(outcome?.code)}${stderrTail.trim() === '' ? '' : `: ${stderrTail.trim().slice(-500)}`}`,
        ...facts,
      })
    }
    const cleanupConfirmed = await reapGroup()
    return {
      stopReason: 'completed',
      text: finished.text,
      sessionId: finished.sessionId,
      structuredOutput: finished.structuredOutput,
      usage: finished.usage,
      init: finished.init,
      images: finished.images,
      outcome: facts,
      cleanupConfirmed,
    }
  }

  let detail = finished.facts.detail
  if (finished.facts.category === 'invalid-result' && malformedChunks > 0) {
    detail = `${detail ?? 'unparseable output'}; ${malformedChunks} unparseable line(s)`
  }
  if (finished.facts.category === 'invalid-result' && stderrTail.trim() !== '') {
    detail = stderrTail.trim().slice(-500)
  }
  throw new ClaudeCodeProFailure({ ...finished.facts, detail, ...facts })
}
