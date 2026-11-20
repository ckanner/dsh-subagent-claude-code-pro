/**
 * Public machine API. The caller owns task scope and persisted
 * receipts; this module owns one local CLI invocation and never silently
 * retries or substitutes a fresh session. Native permission modes are tool
 * approval policies, not filesystem or operating-system sandboxes.
 */
import { parseNativeRequest } from './native.js'
import { checkedOutputSchema } from './structured.js'
import { parseSubscriptionRequest } from './subscription.js'
export { MACHINE_SUBSCRIPTION_VERSION, MACHINE_SUBSCRIPTION_CAPABILITIES } from './subscription.js'
export { MACHINE_NATIVE_VERSION, MACHINE_NATIVE_CAPABILITIES } from './native.js'
export { MACHINE_ACTIVITY_VERSION, MACHINE_ACTIVITY_CAPABILITIES } from './activity.js'
import { realpathSync } from 'node:fs'

import { PERMISSION_MODES, resolveCommand } from './cli.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS } from './run.js'
import { checkedDirectory, isPlainObject } from './util.js'
import { runtimeEnvironment, runMachineLocal } from './machine-local.js'
import { superviseMachine } from './machine-supervision.js'
import { runClaudeQuery } from './run.js'
import { buildSdkQuery } from './sdk-query.js'
import { subscriptionReceipt } from './subscription.js'

export { MACHINE_LIFECYCLE_VERSION, MACHINE_LIFECYCLE_CAPABILITIES, recoverMachine } from './machine-recovery.js'

export const MACHINE_PROTOCOL_VERSION = 1

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SOURCES = ['user', 'project', 'local']
const FIELDS = new Set(['protocol', 'requestId', 'cwd', 'prompt', 'command', 'model', 'effort', 'permissionMode',
  'sessionMode', 'sessionId', 'sessionName', 'timeoutMs', 'disposeGraceMs', 'maxOutputBytes', 'settingSources', 'native', 'images', 'outputSchema', 'maxBudgetUsd', 'subscription'])

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
  const sessionName = text('sessionName', input.sessionName, 512, true)
  if (sessionName !== undefined && (input.sessionMode !== 'persistent' || sessionId !== undefined || /[\u0000-\u001f\u007f]/.test(sessionName))) {
    throw new MachineInputError('sessionName must be a single-line name for a new persistent session; resumes preserve their existing name')
  }
  if (sessionId !== undefined && (!UUID.test(sessionId) || input.sessionMode !== 'persistent')) {
    throw new MachineInputError('sessionId must be a UUID and requires persistent sessionMode')
  }
  const sources = input.settingSources === undefined ? SOURCES : input.settingSources
  if (!Array.isArray(sources) || sources.some(source => !SOURCES.includes(source)) || new Set(sources).size !== sources.length) {
    throw new MachineInputError('settingSources must contain distinct user, project or local entries')
  }
  let native, outputSchema, images, subscription
  try {
    if (input.subscription !== undefined) subscription = parseSubscriptionRequest(input.subscription)
    if (input.native !== undefined) native = parseNativeRequest(input.native)
    if (input.outputSchema !== undefined) {
      outputSchema = structuredClone(checkedOutputSchema(input.outputSchema))
      if (Buffer.byteLength(JSON.stringify(outputSchema)) > 1024 * 1024) throw new Error('outputSchema exceeds 1 MiB')
    }
    if (input.images !== undefined) {
      if (!Array.isArray(input.images) || input.images.length > 20) throw new Error('images must be an array with at most 20 entries')
      images = input.images.map(image => {
        if (!isPlainObject(image) || Object.keys(image).some(k => !['data', 'mimeType'].includes(k))
          || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType)
          || typeof image.data !== 'string' || image.data.length === 0 || image.data.length > 32 * 1024 * 1024
          || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
          || Buffer.from(image.data, 'base64').toString('base64') !== image.data) throw new Error('invalid base64 image')
        return { data: image.data, mimeType: image.mimeType }
      })
      if (images.reduce((sum, i) => sum + Buffer.byteLength(i.data), 0) > 32 * 1024 * 1024) throw new Error('encoded images exceed 32 MiB')
    }
  } catch (error) { throw new MachineInputError(error.message) }
  if (input.maxBudgetUsd !== undefined && (typeof input.maxBudgetUsd !== 'number' || !Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0)) throw new MachineInputError('maxBudgetUsd must be a positive finite number')
  return Object.freeze({ protocol: 1, requestId, cwd, prompt, command,
    ...(model === undefined ? {} : { model }), ...(input.effort === undefined ? {} : { effort: input.effort }),
    permissionMode: input.permissionMode, sessionMode: input.sessionMode,
    ...(sessionId === undefined ? {} : { sessionId: sessionId.toLowerCase() }),
    ...(sessionName === undefined ? {} : { sessionName }),
    timeoutMs: integer('timeoutMs', input.timeoutMs, DEFAULT_RUN_TIMEOUT_MS, 0, 2147483647),
    disposeGraceMs: integer('disposeGraceMs', input.disposeGraceMs, DEFAULT_DISPOSE_GRACE_MS, 0, 30000),
    maxOutputBytes: integer('maxOutputBytes', input.maxOutputBytes, 1024 * 1024, 1, 16 * 1024 * 1024),
    settingSources: Object.freeze([...sources]),
    ...(native === undefined ? {} : { native }), ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(subscription === undefined ? {} : { subscription }),
    ...(images === undefined ? {} : { images }), ...(input.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.maxBudgetUsd }) })
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

/** Same environment and SDK admission as execution; the user-message gate never opens. */
export async function inspectSubscription(input, runtime = {}) {
  const fields = ['protocol', 'requestId', 'cwd', 'command', 'model', 'effort', 'settingSources', 'timeoutMs', 'disposeGraceMs']
  if (!isPlainObject(input) || Object.keys(input).some(key => !fields.includes(key))) throw new MachineInputError('unsupported subscription inspection fields')
  if (!isPlainObject(runtime) || Object.keys(runtime).some(key => !['env', 'credentialEnv', 'signal'].includes(key))) throw new MachineInputError('subscription inspection accepts only env, credentialEnv and signal')
  const request = parseMachineRequest({ ...input, prompt: 'Native subscription inspection; never dispatched.',
    permissionMode: 'plan', sessionMode: 'ephemeral', subscription: { version: 1, mode: 'subscription-only' } })
  const env = runtimeEnvironment(runtime)
  let run, failure
  try {
    run = await runClaudeQuery({ command: request.command, cwd: request.cwd, env, signal: runtime.signal,
      sessionMode: 'ephemeral', subscription: request.subscription, subscriptionInspection: true,
      query: buildSdkQuery({ session: { kind: 'ephemeral' }, permissionMode: 'plan', model: request.model,
        reasoningEffort: request.effort, settingSources: request.settingSources, text: request.prompt }),
      timeoutMs: request.timeoutMs, disposeGraceMs: request.disposeGraceMs })
  } catch (error) {
    if (!error?.run?.execution) throw error
    run = error.run
    failure = { stage: error.facts.stage, category: error.facts.category, detail: error.facts.detail }
  }
  return { protocol: 1, type: 'subscription-inspection', requestId: request.requestId,
    ok: run.stopReason === 'inspected' && run.subscription?.status === 'verified' && run.cleanupConfirmed === true,
    subscription: run.subscription ?? subscriptionReceipt(), promptDispatched: false,
    cleanup: { confirmed: run.cleanupConfirmed === true }, failure: failure ?? (run.stopReason === 'aborted'
      ? { stage: 'run', category: 'cancelled', detail: 'subscription inspection was cancelled' } : null) }
}

export { validateNativeReviewRequest, validateInteractiveTeamRequest, runNativeReview, runInteractiveTeam, recoverNativeJob, controlInteractiveTeam } from './native-jobs.js'
