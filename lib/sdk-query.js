/** Semantic delegation input mapped to the official Agent SDK query contract. */
import { PERMISSION_MODES } from './cli.js'
import { nativeControls, parseNativeRequest } from './native.js'
import { checkedOutputSchema } from './structured.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCES = ['user', 'project', 'local']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const OPTION_KEYS = ['systemPrompt', 'tools', 'permissionMode', 'permissionPrompts', 'allowDangerouslySkipPermissions',
  'settingSources', 'includePartialMessages', 'forwardSubagentText', 'persistSession', 'sessionId', 'resume',
  'forkSession', 'title', 'model', 'effort', 'outputFormat', 'maxBudgetUsd', 'settings', 'disallowedTools', 'agents', 'extraArgs']
const NATIVE_ENV = ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_DISABLE_WORKFLOWS', 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS']
const fail = message => { throw new Error('claude-code-pro: invalid SDK query: ' + message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const text = value => typeof value === 'string' && value.trim() !== '' && !value.includes('\0')

/** Only JSON data crosses the guardian boundary; no executable/runtime overrides. */
function copyJson(value, depth = 0) {
  if (depth > 128) fail('descriptor nesting exceeds 128 levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Array.from(value, item => copyJson(item, depth + 1))
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, depth + 1)]))
  }
  fail('descriptor must contain only serializable JSON values')
}

function sessionOptions(session) {
  if (!object(session)) fail('session must be explicit')
  if (session.kind === 'ephemeral') {
    if (!keys(session, ['kind'])) fail('ephemeral session cannot name, resume or fork history')
    return { persistSession: false }
  }
  if (session.kind === 'resume') {
    if (!keys(session, ['kind', 'resumeId', 'forkSession']) || !UUID.test(session.resumeId ?? '')
      || (session.forkSession !== undefined && typeof session.forkSession !== 'boolean')) fail('resume requires only an exact UUID and optional fork')
    return { persistSession: true, resume: session.resumeId, ...(session.forkSession === true ? { forkSession: true } : {}) }
  }
  if (session.kind !== 'new' || !keys(session, ['kind', 'sessionId', 'name']) || !UUID.test(session.sessionId ?? '')) fail('new history requires an exact UUID')
  if (session.name !== undefined && (!text(session.name) || /[\u0000-\u001f\u007f]/.test(session.name)
    || Buffer.byteLength(session.name) > 512)) fail('new history name must be single-line text of at most 512 bytes')
  return { persistSession: true, sessionId: session.sessionId, ...(session.name === undefined ? {} : { title: session.name }) }
}

function preset(value) { return keys(value, ['type', 'preset']) && value.type === 'preset' && value.preset === 'claude_code' }

/** Validate a private descriptor again after serialization, before SDK startup. */
export function validateSdkQuery(value) {
  const query = copyJson(value)
  if (!keys(query, ['version', 'session', 'options', 'message']) || query.version !== 1) fail('unsupported descriptor version or fields')
  const expectedSession = sessionOptions(query.session)
  const options = query.options
  if (!keys(options, OPTION_KEYS)) fail('unsupported SDK options; runtime fields belong to the process owner')
  if (!preset(options.systemPrompt) || !preset(options.tools)) fail('Claude Code system prompt and tool presets are required')
  if (!PERMISSION_MODES.includes(options.permissionMode) || options.permissionPrompts !== 'none') fail('explicit unattended permission policy is required')
  if (options.permissionMode === 'bypassPermissions' ? options.allowDangerouslySkipPermissions !== true
    : Object.hasOwn(options, 'allowDangerouslySkipPermissions')) fail('dangerous bypass must match the selected permission mode')
  if (!Array.isArray(options.settingSources) || options.settingSources.some(source => !SOURCES.includes(source))
    || new Set(options.settingSources).size !== options.settingSources.length) fail('invalid settingSources')
  if (options.includePartialMessages !== true || options.forwardSubagentText !== true) fail('native activity observation must remain enabled')
  for (const key of ['persistSession', 'sessionId', 'resume', 'forkSession', 'title']) {
    if (options[key] !== expectedSession[key] || Object.hasOwn(options, key) !== Object.hasOwn(expectedSession, key)) fail('session options conflict with the selected history')
  }
  if (options.model !== undefined && !text(options.model)) fail('invalid model')
  if (options.effort !== undefined && !EFFORTS.includes(options.effort)) fail('invalid reasoning effort')
  if (options.maxBudgetUsd !== undefined && (typeof options.maxBudgetUsd !== 'number' || !Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0)) fail('invalid maximum budget')
  if (options.outputFormat !== undefined) {
    if (!keys(options.outputFormat, ['type', 'schema']) || options.outputFormat.type !== 'json_schema') fail('invalid output format')
    checkedOutputSchema(options.outputFormat.schema)
  }
  if (options.settings !== undefined && (!keys(options.settings, ['disableWorkflows', 'env'])
    || typeof options.settings.disableWorkflows !== 'boolean' || !keys(options.settings.env, NATIVE_ENV)
    || Object.values(options.settings.env).some(value => typeof value !== 'string' || value.includes('\0')))) fail('invalid native settings')
  if (options.disallowedTools !== undefined && (!Array.isArray(options.disallowedTools)
    || options.disallowedTools.some(tool => !['Agent', 'Task', 'Workflow', 'TeamCreate', 'TeamDelete'].includes(tool)))) fail('invalid native tool restrictions')
  if (options.agents !== undefined) parseNativeRequest({ version: 1, agents: { enabled: true, definitions: options.agents } })
  if (options.extraArgs !== undefined && (!keys(options.extraArgs, ['advisor']) || !text(options.extraArgs.advisor))) fail('unsupported native CLI extension')
  const message = query.message
  if (!keys(message, ['type', 'message', 'parent_tool_use_id', 'session_id']) || message.type !== 'user'
    || message.parent_tool_use_id !== null || message.session_id !== '' || !keys(message.message, ['role', 'content'])
    || message.message.role !== 'user' || !Array.isArray(message.message.content) || message.message.content.length === 0) fail('invalid SDK user message')
  for (const block of message.message.content) {
    if (block?.type === 'text') {
      if (!keys(block, ['type', 'text']) || typeof block.text !== 'string') fail('invalid text block')
      continue
    }
    const mediaTypes = block?.type === 'image' ? ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
      : block?.type === 'document' ? ['application/pdf'] : []
    if (!keys(block, ['type', 'source']) || !keys(block.source, ['type', 'media_type', 'data'])
      || block.source.type !== 'base64' || !mediaTypes.includes(block.source.media_type) || !text(block.source.data)
      || block.source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.source.data)) fail('invalid attachment block')
  }
  return query
}

/**
 * Build a serializable SDK descriptor directly from the selected delegation.
 * The local executable, cwd, environment, abort signal and spawn ownership stay
 * outside it. No names, sessions or native definitions are recovered from argv.
 */
export function buildSdkQuery(input) {
  if (!keys(input, ['session', 'permissionMode', 'model', 'reasoningEffort', 'settingSources', 'outputSchema', 'maxBudgetUsd',
    'native', 'text', 'images', 'documents'])) fail('unsupported semantic input; argv is not a query descriptor')
  const session = copyJson(input.session)
  const options = {
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: input.permissionMode,
    permissionPrompts: 'none',
    ...(input.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: [...new Set(input.settingSources ?? SOURCES)],
    includePartialMessages: true,
    forwardSubagentText: true,
    ...sessionOptions(session),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
    ...(input.outputSchema === undefined ? {} : { outputFormat: { type: 'json_schema', schema: input.outputSchema } }),
    ...(input.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.maxBudgetUsd }),
  }
  if (input.native !== undefined) {
    const native = parseNativeRequest(input.native)
    options.settings = nativeControls(native).settings
    options.disallowedTools = [...(native.agents?.enabled ? [] : ['Agent', 'Task']),
      ...(native.workflows?.enabled ? [] : ['Workflow']), 'TeamCreate', 'TeamDelete']
    if (native.agents?.definitions !== undefined) options.agents = native.agents.definitions
    // Advisor has no top-level SDK option; extraArgs is the public extension.
    if (native.advisor?.enabled) options.extraArgs = { advisor: native.advisor.model }
  }
  const content = [{ type: 'text', text: input.text }]
  for (const [type, attachments] of [['image', input.images], ['document', input.documents]]) {
    for (const attachment of attachments ?? []) content.push({ type,
      source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data } })
  }
  return validateSdkQuery({ version: 1, session, options,
    message: { type: 'user', session_id: '', message: { role: 'user', content }, parent_tool_use_id: null } })
}
