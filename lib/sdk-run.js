/** Official Agent SDK queries inside the existing, independently owned guardian. */
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { query } from '@anthropic-ai/claude-agent-sdk'

import { createCollector } from './protocol.js'
import { createActivityReporter } from './activity.js'
import { validateSdkQuery } from './sdk-query.js'
import { ClaudeCodeProFailure, delay, errorMessage, isPlainObject } from './util.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS } from './run-local.js'

const MAX_LINE_BYTES = 16 * 1024 * 1024
const MAX_DISPLAY_BYTES = 4 * 1024 * 1024
const MAX_DISPLAY_EVENTS = 4096

function supportedVersion(version) {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const parts = match.slice(1).map(Number), minimum = [2, 1, 325]
  if (!parts.every(Number.isSafeInteger)) return false
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i]
  }
  return true
}

const idleExecution = () => ({ pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched',
  outcome: 'not-started', terminalReceived: false, exitCode: null, signal: null,
  cancelled: false, timedOut: false, truncated: false })

/** Validate fields the SDK consumes before it exposes a message to our collector. */
function validSdkEnvelope(event) {
  const identity = value => typeof value === 'string' && value.trim() !== ''
  if (!isPlainObject(event) || !identity(event.type)) return false
  if (event.type === 'control_response') {
    const response = event.response
    return isPlainObject(response) && identity(response.request_id)
      && (response.subtype === 'success' || (response.subtype === 'error' && typeof response.error === 'string'))
  }
  if (event.type === 'control_request') return identity(event.request_id) && isPlainObject(event.request) && identity(event.request.subtype)
  if (event.type === 'control_cancel_request') return identity(event.request_id)
  if (event.type === 'result') {
    if (typeof event.is_error !== 'boolean' || !identity(event.subtype)) return false
    if (event.is_error) return event.subtype === 'success' ? typeof event.result === 'string'
      : Array.isArray(event.errors) && event.errors.every(error => typeof error === 'string')
  }
  return true
}

/**
 * The SDK deliberately skips malformed stdout lines. Validate the actual wire
 * first, including envelopes, UTF-8 and the final delimiter. Its decoder can
 * otherwise mask a malformed tail with an earlier native error result. Unknown
 * message types remain supported; the SDK still owns the control protocol.
 * The transform preserves backpressure and bounded frames.
 */
function guardedOutput(fail) {
  let buffered = Buffer.alloc(0)
  return new Transform({
    transform(chunk, encoding, callback) {
      buffered = Buffer.concat([buffered, chunk])
      let newline
      while ((newline = buffered.indexOf(10)) >= 0) {
        if (newline > MAX_LINE_BYTES) { fail('output-limit'); buffered = Buffer.alloc(0); callback(); return }
        const line = buffered.subarray(0, newline)
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
          if (text.trim() && !validSdkEnvelope(JSON.parse(text))) throw new Error('invalid SDK envelope')
        } catch { fail('malformed'); buffered = Buffer.alloc(0); callback(); return }
        this.push(buffered.subarray(0, newline + 1))
        buffered = buffered.subarray(newline + 1)
      }
      if (buffered.length > MAX_LINE_BYTES) { fail('output-limit'); buffered = Buffer.alloc(0) }
      callback()
    },
    flush(callback) {
      if (buffered.length) fail('malformed')
      buffered = Buffer.alloc(0)
      callback()
    },
  })
}

/** The returned shape is shared with the machine receipt and DSH tool callers. */
export async function runSdkClaude(options) {
  const descriptor = validateSdkQuery(options.query)
  const { command, cwd, env, signal, timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS, maxOutputBytes = 64 * 1024 * 1024 } = options
  const initial = idleExecution()
  if (signal?.aborted) return { stopReason: 'aborted', cleanupConfirmed: true, terminalReceived: false,
    execution: { ...initial, cancelled: true } }
  const session = descriptor.session
  const expectedSessionId = session.kind === 'new' ? session.sessionId
    : session.kind === 'resume' && !session.forkSession ? session.resumeId : undefined
  const collector = createCollector({ native: options.native, onNativeEvent: options.onNativeEvent, expectedSessionId })
  const activity = createActivityReporter(options.onActivity, options.activityIntervalMs, { signal })
  const abort = new AbortController()
  let child, stdout, sdk, outcome, spawnError, streamError, sdkError, startupFailure, stopCause
  let closed = false, stdoutEnded = false, readFinished = false, outputOverflow = false, malformed = false
  let rootResultIsError = false
  let displayBytes = 0, displayEvents = 0, displayOmitted = false
  let wake, resolveClosed
  const settled = new Promise(resolve => { wake = resolve })
  const closePromise = new Promise(resolve => { resolveClosed = resolve })
  const stop = cause => {
    stopCause ??= cause
    activity.close()
    abort.abort()
    wake()
  }
  const rawFailure = kind => {
    if (kind === 'output-limit') outputOverflow = true
    else { malformed = true; collector.malformed() }
    stop(kind)
  }
  const groupExists = () => {
    if (!child?.pid) return false
    try { process.kill(-child.pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
  }
  const killGroup = name => { if (child?.pid) { try { process.kill(-child.pid, name) } catch { /* Probe is authoritative. */ } } }
  const waitGroup = async ms => {
    const end = Date.now() + ms
    while (groupExists()) {
      if (Date.now() >= end) return false
      await delay(Math.min(25, end - Date.now()))
    }
    return true
  }
  const cleanup = async () => {
    if (!groupExists()) return true
    killGroup('SIGTERM')
    if (await waitGroup(disposeGraceMs)) return true
    killGroup('SIGKILL')
    return waitGroup(2000)
  }
  const spawnOwned = request => {
    if (child !== undefined) throw new Error('one invocation cannot spawn another Claude process')
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env,
        stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (error) { spawnError = error; throw error }
    child.once('error', error => { spawnError = error; wake() })
    child.once('exit', (code, exitSignal) => { outcome = { code, signal: exitSignal }; wake() })
    child.once('close', (code, exitSignal) => {
      outcome ??= { code, signal: exitSignal }; closed = true; resolveClosed(); wake()
    })
    if (child.pid !== undefined) { try { options.onSpawn?.(child.pid) } catch { /* Ownership does not depend on display callbacks. */ } }
    stdout = guardedOutput(rawFailure)
    stdout.on('error', error => { streamError = error; stop('stream') })
    child.stdout.on('error', error => { streamError = error; stop('stream') })
    child.stdout.once('end', () => { stdoutEnded = true })
    child.stderr.on('data', () => { /* Drain diagnostics without retaining secrets or treating them as activity. */ })
    child.stderr.on('error', error => { streamError = error; stop('stream') })
    child.stdout.pipe(stdout)
    // A facade lets the SDK consume the checked stream while its process
    // transport retains the real exit/error semantics. Group teardown remains
    // our responsibility even when SDK close() only signals the leader.
    return { stdin: child.stdin, stdout,
      get killed() { return child.killed }, get exitCode() { return child.exitCode }, get signalCode() { return child.signalCode },
      kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) }
  }
  const onAbort = () => stop('cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : undefined
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  let reading = Promise.resolve()
  try {
    const messages = async function* () {
      await ready
      if (!abort.signal.aborted) yield descriptor.message
    }
    sdk = query({ prompt: messages(), options: { ...descriptor.options,
      pathToClaudeCodeExecutable: command, cwd, env, abortController: abort, spawnClaudeCodeProcess: spawnOwned } })
    sdk.initializationResult().then(response => {
      // Version comes from this owned process's actual SDK handshake, avoiding
      // a separate executable/version time-of-check gap. 2.1.325 is the minimum
      // validated contract for initialize title, agents and subagent forwarding.
      if (!supportedVersion(response?.claude_code_version)) {
        startupFailure = { stage: 'start', category: 'unsupported-runtime',
          detail: 'the Agent SDK requires the configured Claude Code to identify itself as version 2.1.325 or newer during initialize; no task prompt was sent' }
        rejectReady(new Error(startupFailure.detail)); stop('sdk'); return
      }
      resolveReady()
    }, error => { sdkError ??= error; rejectReady(error); stop('sdk') })
    reading = (async () => {
      try {
        for await (const event of sdk) {
          collector.accept(event)
          if (collector.invalid) { outputOverflow ||= collector.outputOverflow; stop('protocol'); break }
          if (event.type === 'result' && (typeof event.parent_tool_use_id !== 'string' || event.parent_tool_use_id === '')) rootResultIsError = event.is_error === true
          if (!collector.owns(event)) continue
          activity.observe(event)
          if (options.onEvent && event.type === 'assistant' && !event.parent_tool_use_id) {
            const text = Array.isArray(event.message?.content) ? event.message.content
              .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').slice(0, 16384) : ''
            if (!text) continue
            const bytes = Buffer.byteLength(text)
            if (displayBytes + bytes <= MAX_DISPLAY_BYTES && displayEvents < MAX_DISPLAY_EVENTS) {
              displayBytes += bytes; displayEvents++
              try { options.onEvent({ type: 'assistant-text', text }) } catch { /* Display only. */ }
            } else if (!displayOmitted) {
              displayOmitted = true
              try { options.onEvent({ type: 'assistant-text', text: '[Further display progress omitted; activity and the final answer remain available.]' }) } catch {}
            }
          }
        }
      } catch (error) { sdkError ??= error }
      finally { readFinished = true; wake() }
    })()
  } catch (error) { sdkError = error; readFinished = true; rejectReady(error); wake() }
  await settled
  if (timer !== undefined) clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  const cancelled = stopCause === 'cancelled', timedOut = stopCause === 'timeout'
  // A normally exiting process may still have SDK messages queued. Inherited
  // pipes cannot extend that drain indefinitely; settle owned descendants next.
  if (outcome && !stopCause && !readFinished) await Promise.race([reading, delay(100)])
  const cleanupConfirmed = await cleanup()
  if (child && !closed) await Promise.race([closePromise, delay(100)])
  if (!readFinished) await Promise.race([reading, delay(100)])
  if (!readFinished || (child && !closed)) {
    sdk?.close()
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); stdout?.destroy()
    await Promise.race([reading, delay(100)])
  }
  activity.close()
  const finished = collector.finish()
  const expectedExit = finished.kind === 'success' ? outcome?.code === 0 : outcome?.code === 0 || outcome?.code === 1
  // The pinned SDK rejects its iterator for a valid native failed result/exit1.
  // Preserve that known failure only; every other SDK rejection invalidates the
  // terminal proof. The raw guard above prevents decoder corruption from being
  // disguised by the SDK's error_result wrapper after a prior failed result.
  const expectedSdkFailure = rootResultIsError && finished.kind === 'failure' && finished.terminalReceived === true
    && outcome?.code === 1 && (sdkError?.errorClass === 'error_result'
      || (sdkError?.errorClass === 'process_exited_nonzero' && sdkError.exitCode === 1))
  const sdkProtocolError = sdkError !== undefined && !expectedSdkFailure
  const terminalReceived = finished.terminalReceived === true && expectedExit && outcome?.signal === null
    && closed && stdoutEnded && readFinished && !streamError && !outputOverflow && !malformed && !sdkProtocolError
  const pid = child?.pid
  const execution = { ...initial, pid: pid ?? null, processGroupId: pid ?? null,
    ownership: pid === undefined ? 'none' : 'process-group', dispatch: pid === undefined ? 'not-dispatched' : 'dispatched',
    outcome: pid === undefined ? 'not-started' : terminalReceived ? (finished.kind === 'success' ? 'completed' : 'failed') : 'unknown',
    terminalReceived, exitCode: pid === undefined ? null : outcome?.code ?? null, signal: pid === undefined ? null : outcome?.signal ?? null,
    cancelled, timedOut, truncated: outputOverflow }
  const run = { ...(options.native === undefined ? {} : { native: collector.nativeReport(cleanupConfirmed) }),
    cleanupConfirmed, execution, terminalReceived, init: finished.init, sessionId: finished.sessionId,
    outcome: { exitCode: execution.exitCode, signal: execution.signal },
    ...(terminalReceived ? { usage: finished.usage, reportedCostUSD: finished.reportedCostUSD } : {}) }
  const fail = (facts, cause) => {
    const error = new ClaudeCodeProFailure({ ...facts, exitCode: execution.exitCode, signal: execution.signal,
      cleanupConfirmed, terminalReceived }, cause)
    error.run = run
    throw error
  }
  if (!cleanupConfirmed) fail({ stage: 'cleanup', category: 'cleanup-unconfirmed', detail: 'the owned process group could not be confirmed stopped; do not retry this invocation' })
  if (cancelled) return { ...run, stopReason: 'aborted' }
  if (spawnError) fail({ stage: pid === undefined ? 'start' : 'process', category: pid === undefined ? 'spawn' : 'process',
    detail: spawnError.code === 'ENOENT' ? `cannot start "${command}" (ENOENT): install the Claude Code CLI or set the plugin's "command" to its absolute path` : errorMessage(spawnError) }, spawnError)
  if (!child && sdkError) fail({ stage: 'start', category: 'unsupported-runtime', detail: 'the Agent SDK could not start the configured Claude query; no task prompt was sent' }, sdkError)
  if (timedOut) fail({ stage: 'run', category: 'timeout', detail: `the delegation exceeded its ${timeoutMs} ms deadline and was cancelled` })
  if (startupFailure) fail(startupFailure)
  if (outputOverflow) fail({ stage: 'query-run', category: 'protocol', detail: 'the CLI exceeded the bounded stream output limit; the run was cancelled' })
  if (streamError || !closed || !stdoutEnded || !readFinished || sdkProtocolError) fail({ stage: 'query-run', category: 'protocol', detail: 'the SDK output stream did not finish cleanly' }, sdkError)
  if (finished.kind === 'failure') fail(finished.facts, sdkError)
  if (!terminalReceived) fail({ stage: 'process', category: 'process', detail: 'the SDK query ended without a complete, clean native terminal result' }, sdkError)
  if (Buffer.byteLength(finished.text, 'utf8') > maxOutputBytes) {
    execution.truncated = true
    fail({ stage: 'query-run', category: 'limit', detail: `the terminal answer exceeded maxOutputBytes (${maxOutputBytes})` })
  }
  return { ...run, stopReason: 'completed', text: finished.text, structuredOutput: finished.structuredOutput, images: finished.images }
}
