/** Desktop/PTC native defaults. The machine protocol stays independent of DSH. */
import { createHash } from 'node:crypto'
import { allowedPermissionModes, childEnvironment } from './cli.js'
import { parseNativeRequest, nativeControls } from './native.js'
import { ClaudeCodeProFailure } from './util.js'

export const NATIVE_OFF = Object.freeze({ version: 1 })
export function nativeValue(value) {
  if (value === undefined) return undefined
  return parseNativeRequest(value === null ? NATIVE_OFF : value)
}
export function readNativeDefault(source) {
  return nativeValue(typeof source?.get === 'function' ? source.get() : source)
}
export function resolveDesktopNative(configured, requested, permission, modelSelection = true) {
  const value = requested === undefined ? configured : nativeValue(requested)
  if (value === undefined) return undefined
  const native = parseNativeRequest(value)
  for (const [name, definition] of Object.entries(native.agents?.definitions ?? {})) {
    if (definition.permissionMode !== undefined && !allowedPermissionModes(permission).includes(definition.permissionMode)) {
      throw new Error('claude-code-pro: native agent ' + name + ' permissionMode exceeds the selected root permission policy')
    }
  }
  if (!modelSelection && requested !== undefined) {
    if (native.advisor?.model !== undefined && native.advisor.model !== configured?.advisor?.model) {
      throw new Error('claude-code-pro: native advisor model overrides require modelSelection')
    }
    for (const [id, definition] of Object.entries(native.agents?.definitions ?? {})) {
      if (definition.model !== undefined && definition.model !== configured?.agents?.definitions?.[id]?.model) {
        throw new Error('claude-code-pro: native agent model overrides require modelSelection')
      }
    }
    if (native.agents?.enabled === true) for (const [id, definition] of Object.entries(configured?.agents?.definitions ?? {})) {
      if (definition.model !== undefined && native.agents.definitions?.[id]?.model !== definition.model) {
        throw new Error('claude-code-pro: enabled native agents must retain configured models when modelSelection is disabled')
      }
    }
  }
  return native
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
export function desktopSessionIdentity(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function desktopNativeEnvironment(configured, native) {
  const env = childEnvironment(configured)
  if (native === undefined) return env
  // A per-call replacement cannot retain old native bounds from plugin env.
  for (const key of ['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS']) delete env[key]
  return { ...env, ...nativeControls(native).env }
}
export function nativeSummary(native) {
  return JSON.stringify({ effective: native.effective, resourceBounds: native.resourceBounds,
    children: native.children, completion: native.completion, cleanup: native.cleanup, usage: native.usage })
}
export function requireNativeCompletion(result) {
  const n = result.native
  if (n === undefined) return
  let category, detail
  if (n.effective?.matched !== true) { category = 'configuration-mismatch'; detail = n.diagnostic ?? 'native tool availability was not confirmed' }
  else if (n.cleanup?.confirmed !== true) { category = 'cleanup-unconfirmed'; detail = 'native remote work remains unresolved after local cleanup' }
  else if (n.completion?.confirmed !== true) { category = 'product-error'; detail = 'root completion left observed native work pending' }
  if (category) {
    const error = new ClaudeCodeProFailure({ stage: category === 'cleanup-unconfirmed' ? 'cleanup' : 'query-run', category,
      detail: detail + '; native=' + nativeSummary(n), cleanupConfirmed: result.cleanupConfirmed, terminalReceived: result.terminalReceived })
    error.run = result
    throw error
  }
}
export const NATIVE_TOOL_SCHEMA = {
  anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['version'], properties: {
    version: { type: 'integer', const: 1 },
    agents: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
      enabled: { type: 'boolean' }, maxConcurrent: { type: 'integer', minimum: 1 }, maxDepth: { type: 'integer', minimum: 1 },
      definitions: { type: 'object', maxProperties: 128, additionalProperties: { type: 'object', additionalProperties: false,
        required: ['description','prompt'], properties: { description: { type: 'string' }, prompt: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } }, disallowedTools: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' }, permissionMode: { type: 'string', enum: ['plan','dontAsk','acceptEdits','auto','bypassPermissions'] },
          maxTurns: { type: 'integer', minimum: 1 } } } },
    } },
    workflows: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
      enabled: { type: 'boolean' }, maxConcurrent: { type: 'integer', minimum: 1, maximum: 256 } } },
    advisor: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
      enabled: { type: 'boolean' }, model: { type: 'string' } } },
  } }],
  description: 'Omit to inherit this installation native defaults. An object completely replaces them; omitted capabilities are off. null explicitly turns all off. Disabled capabilities must contain only enabled:false. Teams and remote reviews use the separate native-job tool.',
}
