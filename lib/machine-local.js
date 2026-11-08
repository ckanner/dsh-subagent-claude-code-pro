/** Private one-run implementation, supervised by the public machine API. */
import { randomUUID } from 'node:crypto'
import { buildArguments, childEnvironment } from './cli.js'
import { userMessageLine } from './protocol.js'
import { runClaude } from './run.js'
import { isPlainObject } from './util.js'
import { validateRecoveryDirectory } from './machine-recovery.js'
import { MachineInputError, parseMachineRequest } from './machine.js'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREDENTIALS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'])

export function runtimeEnvironment(runtime) {
  if (!isPlainObject(runtime) || Object.keys(runtime).some(key => !['signal', 'env', 'credentialEnv', 'onProgress', 'onLifecycle', 'recoveryDirectory'].includes(key))) {
    throw new MachineInputError('runtime contains unsupported options')
  }
  if (runtime.signal !== undefined && !(runtime.signal instanceof AbortSignal)) throw new MachineInputError('runtime.signal must be an AbortSignal')
  if (runtime.onProgress !== undefined && typeof runtime.onProgress !== 'function') throw new MachineInputError('runtime.onProgress must be a function')
  if (runtime.onLifecycle !== undefined && typeof runtime.onLifecycle !== 'function') throw new MachineInputError('runtime.onLifecycle must be a function')
  if (runtime.recoveryDirectory !== undefined) {
    try { validateRecoveryDirectory(runtime.recoveryDirectory) } catch { throw new MachineInputError('invalid recoveryDirectory') }
  }
  const ambient = runtime.env === undefined ? process.env : runtime.env
  const explicit = runtime.credentialEnv === undefined ? {} : runtime.credentialEnv
  if (!isPlainObject(ambient) || Object.values(ambient).some(value => value !== undefined && (typeof value !== 'string' || value.includes('\0')))) {
    throw new MachineInputError('runtime.env must be a string environment')
  }
  if (!isPlainObject(explicit) || Object.entries(explicit).some(([key, value]) => !CREDENTIALS.has(key) || typeof value !== 'string' || value.includes('\0'))) {
    throw new MachineInputError('credentialEnv may contain only explicit Anthropic API key/auth token, Claude OAuth token or Anthropic base URL strings')
  }
  return childEnvironment(explicit, ambient)
}

function usageOf(raw, trusted) {
  const counter = name => trusted && isPlainObject(raw) && Number.isSafeInteger(raw[name]) && raw[name] >= 0 ? raw[name] : null
  const values = { inputTokens: counter('input_tokens'), outputTokens: counter('output_tokens'),
    cacheReadTokens: counter('cache_read_input_tokens'), cacheCreationTokens: counter('cache_creation_input_tokens') }
  const counters = Object.values(values)
  const sum = counters.every(value => value !== null) ? counters.reduce((a, b) => a + b, 0) : null
  const totalTokens = Number.isSafeInteger(sum) ? sum : null
  return { status: totalTokens !== null ? 'complete' : counters.some(value => value !== null) ? 'partial' : 'unknown', ...values, totalTokens }
}

function modelMatches(requested, observed) {
  if (typeof observed !== 'string' || observed.trim() === '') return false
  if (requested === undefined || requested === observed) return true
  if (!['sonnet', 'opus', 'haiku'].includes(requested)) return false
  return new RegExp(`^claude-${requested}-[a-z0-9][a-z0-9.-]*(?:\\[1m\\])?$`).test(observed)
}

function baseReceipt(request, runId) {
  return { protocol: 1, type: 'result', requestId: request.requestId, runId, ok: false,
    requested: { cwd: request.cwd, model: request.model ?? null, effort: request.effort ?? null,
      permissionMode: request.permissionMode, sessionMode: request.sessionMode, sessionId: request.sessionId ?? null,
      settingSources: [...request.settingSources] },
    execution: { pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched', turnDispatch: 'not-dispatched', outcome: 'not-started',
      terminalReceived: false, exitCode: null, signal: null, cancelled: false, timedOut: false, truncated: false },
    cleanup: { confirmed: true, method: 'not-started' },
    session: { mode: request.sessionMode, id: null, resumed: false, resumable: false },
    configuration: { source: null, observed: null, matched: false }, output: [],
    usage: usageOf(undefined, false), reportedCostUSD: null, costUSD: null, costStatus: 'unknown', failure: null }
}

/** Private supervisor entry; callers use runMachine to retain post-disconnect evidence. */
export async function runMachineLocal(input, runtime = {}, runId = randomUUID(), persistReceipt) {
  const request = parseMachineRequest(input)
  const env = runtimeEnvironment(runtime)
  const receipt = baseReceipt(request, runId)
  const startedAt = Date.now()
  let sequence = 0, turnDispatch = 'not-dispatched', last, proposedSessionId = request.sessionId ?? null
  const emit = async (event, patch = {}) => {
    if (runtime.onLifecycle === undefined) return
    const record = { threadId: proposedSessionId, turnId: null, persistent: request.sessionMode === 'persistent',
      configuration: null, dispatch: turnDispatch, outcome: 'unknown', cleanupConfirmed: false, ...last, ...patch,
      lifecycleVersion: 1, type: 'lifecycle', requestId: request.requestId, runId, sequence: ++sequence, event,
      dispatch: patch.dispatch ?? turnDispatch }
    last = record
    await runtime.onLifecycle(record)
  }
  const finish = async () => {
    receipt.execution.turnDispatch = turnDispatch
    // Original native facts survive lost notification delivery or final ACKs.
    persistReceipt?.(receipt)
    const facts = { threadId: receipt.session.id ?? proposedSessionId, turnId: null,
      configuration: receipt.configuration.source === null ? null : receipt.configuration,
      dispatch: turnDispatch,
      outcome: receipt.execution.outcome === 'completed' ? 'completed' : receipt.execution.outcome === 'failed' ? 'failed'
        : receipt.execution.cancelled ? 'cancelled' : turnDispatch === 'not-dispatched' ? 'failed' : 'unknown',
      cleanupConfirmed: receipt.cleanup.confirmed }
    try { await emit('terminal', facts) } catch { /* The journal already contains the actual receipt. */ }
    if (receipt.cleanup.confirmed) {
      try { await emit('cleanup-confirmed', facts) } catch { /* Delivery failure is not another native cancellation. */ }
    }
    return receipt
  }
  const checkpoint = async event => {
    let timeout, onAbort
    const remaining = request.timeoutMs === 0 ? undefined : Math.max(0, request.timeoutMs - (Date.now() - startedAt))
    const barrier = emit(event)
    const stop = new Promise((_, reject) => {
      onAbort = () => reject(new Error('machine checkpoint cancelled'))
      runtime.signal?.addEventListener('abort', onAbort, { once: true })
      if (runtime.signal?.aborted) onAbort()
      if (remaining !== undefined) timeout = setTimeout(() => reject(new Error('machine checkpoint deadline')), remaining)
    })
    try { await Promise.race([barrier, stop]) }
    finally { if (timeout !== undefined) clearTimeout(timeout); runtime.signal?.removeEventListener('abort', onAbort) }
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!['darwin', 'linux'].includes(process.platform) || major < 22 || (major === 22 && minor < 18)) {
    receipt.failure = { stage: 'start', category: 'unsupported-runtime', detail: 'machine invocations require macOS or Linux with Node.js 22.18.0 or newer' }
    return finish()
  }
  const createdSessionId = request.sessionMode === 'persistent' && request.sessionId === undefined ? randomUUID() : undefined
  const expectedSessionId = request.sessionId ?? createdSessionId
  proposedSessionId = expectedSessionId ?? null
  const session = request.sessionId !== undefined ? { kind: 'resume', resumeId: request.sessionId }
    : request.sessionMode === 'persistent' ? { kind: 'new', sessionId: createdSessionId } : { kind: 'ephemeral' }
  let run, failure
  // stream-json has no verified pre-prompt configuration handshake. Do not
  // invent thread-ready or turn-accepted: these barriers prove local intent only.
  try {
    if (runtime.signal?.aborted) throw new Error('machine caller already cancelled')
    await checkpoint('dispatch-intent')
    turnDispatch = 'possible'
    await checkpoint('dispatch-possible')
  } catch {
    const timedOut = request.timeoutMs > 0 && Date.now() - startedAt >= request.timeoutMs
    receipt.execution.cancelled = !timedOut
    receipt.execution.timedOut = timedOut
    receipt.failure = { stage: 'start', category: timedOut ? 'timeout' : 'cancelled',
      detail: timedOut ? 'the invocation deadline expired before prompt delivery' : 'the caller did not acknowledge a durable dispatch checkpoint' }
    return finish()
  }
  try {
    run = await runClaude({ command: request.command, cwd: request.cwd, env,
      args: buildArguments({ session, permissionMode: request.permissionMode, model: request.model,
        reasoningEffort: request.effort, settingSources: request.settingSources }),
      input: userMessageLine({ text: request.prompt }), timeoutMs: request.timeoutMs === 0 ? 0 : Math.max(1, request.timeoutMs - (Date.now() - startedAt)),
      disposeGraceMs: request.disposeGraceMs, maxOutputBytes: request.maxOutputBytes, signal: runtime.signal,
      ...(runtime.onProgress === undefined ? {} : { onEvent: event => runtime.onProgress(event.text) }) })
    if (run.stopReason === 'aborted') failure = { stage: 'run', category: 'cancelled', detail: 'the invocation was cancelled by its caller' }
  } catch (error) {
    if (!error?.run?.execution) throw error
    run = error.run
    failure = { stage: error.facts.stage, category: error.facts.category, detail: (error.facts.detail ?? error.message).slice(0, 4096) }
  }
  receipt.execution = { ...run.execution }
  turnDispatch = run.execution.dispatch === 'not-dispatched' ? 'not-dispatched' : run.terminalReceived ? 'accepted' : 'possible'
  receipt.cleanup = { confirmed: run.cleanupConfirmed === true,
    method: run.execution.dispatch === 'not-dispatched' ? 'not-started' : 'process-group' }
  const actualSessionId = UUID.test(run.sessionId ?? '') ? run.sessionId.toLowerCase()
    : UUID.test(run.init?.sessionId ?? '') ? run.init.sessionId.toLowerCase() : null
  receipt.session.id = actualSessionId
  const init = run.init
  receipt.session.resumed = request.sessionId !== undefined && actualSessionId === request.sessionId
    && typeof init?.sessionId === 'string' && init.sessionId.toLowerCase() === request.sessionId
  if (init !== undefined) {
    const observedString = key => typeof init[key] === 'string' && Buffer.byteLength(init[key]) <= 4096 ? init[key] : null
    receipt.configuration = { source: 'cli-init',
      observed: { cwd: observedString('cwd'), model: observedString('model'), permissionMode: observedString('permissionMode'), cliVersion: observedString('cliVersion') },
      matched: init.cwd === request.cwd && init.permissionMode === request.permissionMode
        && modelMatches(request.model, init.model) && UUID.test(init.sessionId ?? '')
        && init.sessionId.toLowerCase() === actualSessionId
        && (expectedSessionId === undefined || expectedSessionId === actualSessionId) }
  }
  receipt.usage = usageOf(run.usage, run.terminalReceived === true)
  if (run.terminalReceived === true && typeof run.reportedCostUSD === 'number' && Number.isFinite(run.reportedCostUSD) && run.reportedCostUSD >= 0) {
    receipt.reportedCostUSD = run.reportedCostUSD
  }
  if (!failure && !receipt.configuration.matched) failure = { stage: 'configuration', category: 'configuration-mismatch',
    detail: 'system/init did not confirm the requested working directory, model, native permission mode and session identity' }
  receipt.failure = failure ?? null
  receipt.ok = receipt.failure === null && run.stopReason === 'completed'
    && run.execution.outcome === 'completed' && run.execution.terminalReceived === true && receipt.cleanup.confirmed
  if (receipt.ok) receipt.output = [{ type: 'text', text: run.text }]
  receipt.session.resumable = receipt.ok && request.sessionMode === 'persistent' && actualSessionId !== null
  return finish()
}
