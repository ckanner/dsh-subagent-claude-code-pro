/**
 * Public machine API. The caller owns task scope and persisted
 * receipts; this module owns one local CLI invocation and never silently
 * retries or substitutes a fresh session. Native permission modes are tool
 * approval policies, not filesystem or operating-system sandboxes.
 */
import { realpathSync } from 'node:fs'

import { PERMISSION_MODES, resolveCommand } from './cli.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS } from './run.js'
import { checkedDirectory, isPlainObject } from './util.js'
import { runtimeEnvironment, runMachineLocal } from './machine-local.js'
import { superviseMachine } from './machine-supervision.js'

export { MACHINE_LIFECYCLE_VERSION, MACHINE_LIFECYCLE_CAPABILITIES, recoverMachine } from './machine-recovery.js'

export const MACHINE_PROTOCOL_VERSION = 1

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SOURCES = ['user', 'project', 'local']
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

/**
 * Execute exactly one invocation. A resolved failure is still an authoritative
 * terminal receipt; a rejected promise without one proves neither dispatch nor
 * cleanup. Invalid requests reject before spawn with MachineInputError.
 */
export async function runMachine(input, runtime = {}) {
  const request = parseMachineRequest(input)
  runtimeEnvironment(runtime)
  if (runtime.onLifecycle !== undefined || runtime.recoveryDirectory !== undefined) return superviseMachine(request, runtime)
  return runMachineLocal(request, runtime)
}
