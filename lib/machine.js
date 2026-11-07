/**
 * Public terminal-only machine API. The caller owns task scope and persisted
 * receipts; this module owns one local CLI invocation and never silently
 * retries or substitutes a fresh session. Native permission modes are tool
 * approval policies, not filesystem or operating-system sandboxes.
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'

import { buildArguments, childEnvironment, PERMISSION_MODES, resolveCommand } from './cli.js'
import { userMessageLine } from './protocol.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS, runClaude } from './run.js'
import { checkedDirectory, isPlainObject } from './util.js'

export const MACHINE_PROTOCOL_VERSION = 1

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SOURCES = ['user', 'project', 'local']
const CREDENTIALS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
const FIELDS = new Set(['protocol', 'requestId', 'cwd', 'prompt', 'command', 'model', 'effort', 'permissionMode',
  'sessionMode', 'sessionId', 'timeoutMs', 'disposeGraceMs', 'maxOutputBytes', 'settingSources'])

export class MachineInputError extends Error {
  constructor(message) { super(`claude-code-pro machine: ${message}`); this.name = 'MachineInputError' }
}

function text(name, value, maxBytes, optional = false) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new MachineInputError(`${name} must be a nonempty string of at most ${maxBytes} bytes without NUL`)
  }
  return value
}

function integer(name, value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MachineInputError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** Validate the full request without starting a process or reading credentials. */
export function parseMachineRequest(input) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !FIELDS.has(key)) || input.protocol !== 1) {
    throw new MachineInputError('expected a protocol 1 request with only supported fields')
  }
  const requestId = text('requestId', input.requestId, 256)
  const prompt = text('prompt', input.prompt, 1024 * 1024)
  let cwd, command
  try {
    cwd = realpathSync(checkedDirectory('cwd', input.cwd))
    command = resolveCommand(text('command', input.command === undefined ? 'claude' : input.command, 4096))
  } catch (error) { throw new MachineInputError(error.message) }
  const model = text('model', input.model, 256, true)
  if (model !== undefined && model.trim() !== model) throw new MachineInputError('model must not contain surrounding whitespace')
  if (input.effort !== undefined && !EFFORTS.includes(input.effort)) throw new MachineInputError(`effort must be one of ${EFFORTS.join(', ')}`)
  if (!PERMISSION_MODES.includes(input.permissionMode)) throw new MachineInputError('permissionMode must be an explicit native Claude Code approval mode')
  if (!['ephemeral', 'persistent'].includes(input.sessionMode)) throw new MachineInputError('sessionMode must be ephemeral or persistent')
  const sessionId = text('sessionId', input.sessionId, 36, true)
  if (sessionId !== undefined && (!UUID.test(sessionId) || input.sessionMode !== 'persistent')) {
    throw new MachineInputError('sessionId must be a UUID and requires persistent sessionMode')
  }
  const sources = input.settingSources === undefined ? SOURCES : input.settingSources
  if (!Array.isArray(sources) || sources.some(source => !SOURCES.includes(source)) || new Set(sources).size !== sources.length) {
    throw new MachineInputError('settingSources must contain distinct user, project or local entries')
  }
  return Object.freeze({ protocol: 1, requestId, cwd, prompt, command,
    ...(model === undefined ? {} : { model }), ...(input.effort === undefined ? {} : { effort: input.effort }),
    permissionMode: input.permissionMode, sessionMode: input.sessionMode,
    ...(sessionId === undefined ? {} : { sessionId: sessionId.toLowerCase() }),
    timeoutMs: integer('timeoutMs', input.timeoutMs, DEFAULT_RUN_TIMEOUT_MS, 0, 2147483647),
    disposeGraceMs: integer('disposeGraceMs', input.disposeGraceMs, DEFAULT_DISPOSE_GRACE_MS, 0, 30000),
    maxOutputBytes: integer('maxOutputBytes', input.maxOutputBytes, 1024 * 1024, 1, 16 * 1024 * 1024),
    settingSources: Object.freeze([...sources]) })
}

function runtimeEnvironment(runtime) {
  if (!isPlainObject(runtime) || Object.keys(runtime).some(key => !['signal', 'env', 'credentialEnv', 'onProgress'].includes(key))) {
    throw new MachineInputError('runtime contains unsupported options')
  }
  if (runtime.signal !== undefined && !(runtime.signal instanceof AbortSignal)) throw new MachineInputError('runtime.signal must be an AbortSignal')
  if (runtime.onProgress !== undefined && typeof runtime.onProgress !== 'function') throw new MachineInputError('runtime.onProgress must be a function')
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
    execution: { pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched', outcome: 'not-started',
      terminalReceived: false, exitCode: null, signal: null, cancelled: false, timedOut: false, truncated: false },
    cleanup: { confirmed: true, method: 'not-started' },
    session: { mode: request.sessionMode, id: null, resumed: false, resumable: false },
    configuration: { source: null, observed: null, matched: false }, output: [],
    usage: usageOf(undefined, false), reportedCostUSD: null, costUSD: null, costStatus: 'unknown', failure: null }
}

/**
 * Execute exactly one invocation. A resolved failure is still an authoritative
 * terminal receipt; a rejected promise without one proves neither dispatch nor
 * cleanup. Invalid requests reject before spawn with MachineInputError.
 */
export async function runMachine(input, runtime = {}) {
  const request = parseMachineRequest(input)
  const env = runtimeEnvironment(runtime)
  const receipt = baseReceipt(request, randomUUID())
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!['darwin', 'linux'].includes(process.platform) || major < 22 || (major === 22 && minor < 18)) {
    receipt.failure = { stage: 'start', category: 'unsupported-runtime', detail: 'machine invocations require macOS or Linux with Node.js 22.18.0 or newer' }
    return receipt
  }
  const createdSessionId = request.sessionMode === 'persistent' && request.sessionId === undefined ? randomUUID() : undefined
  const expectedSessionId = request.sessionId ?? createdSessionId
  const session = request.sessionId !== undefined ? { kind: 'resume', resumeId: request.sessionId }
    : request.sessionMode === 'persistent' ? { kind: 'new', sessionId: createdSessionId } : { kind: 'ephemeral' }
  let run, failure
  try {
    run = await runClaude({ command: request.command, cwd: request.cwd, env,
      args: buildArguments({ session, permissionMode: request.permissionMode, model: request.model,
        reasoningEffort: request.effort, settingSources: request.settingSources }),
      input: userMessageLine({ text: request.prompt }), timeoutMs: request.timeoutMs,
      disposeGraceMs: request.disposeGraceMs, maxOutputBytes: request.maxOutputBytes, signal: runtime.signal,
      ...(runtime.onProgress === undefined ? {} : { onEvent: event => runtime.onProgress(event.text) }) })
    if (run.stopReason === 'aborted') failure = { stage: 'run', category: 'cancelled', detail: 'the invocation was cancelled by its caller' }
  } catch (error) {
    if (!error?.run?.execution) throw error
    run = error.run
    failure = { stage: error.facts.stage, category: error.facts.category, detail: (error.facts.detail ?? error.message).slice(0, 4096) }
  }
  receipt.execution = { ...run.execution }
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
  return receipt
}
