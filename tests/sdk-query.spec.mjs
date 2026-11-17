import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSdkQuery, validateSdkQuery } from '../lib/sdk-query.js'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const base = { session: { kind: 'new', sessionId: ID, name: '排查告警 · DSH' }, permissionMode: 'dontAsk', text: 'Review the alert delivery path.' }

test('SDK descriptor preserves native presets and uses an explicit unattended permission policy', () => {
  const query = buildSdkQuery(base)
  assert.equal(query.version, 1)
  assert.deepEqual(query.options.systemPrompt, { type: 'preset', preset: 'claude_code' })
  assert.deepEqual(query.options.tools, { type: 'preset', preset: 'claude_code' })
  assert.equal(query.options.permissionMode, 'dontAsk')
  assert.equal(query.options.permissionPrompts, 'none')
  assert.equal(query.options.includePartialMessages, true)
  assert.equal(query.options.forwardSubagentText, true)
  assert.deepEqual(query.options.settingSources, ['user', 'project', 'local'])
  assert.equal(query.options.allowedTools, undefined, 'migration must not auto-approve tools')
  assert.equal(query.options.allowDangerouslySkipPermissions, undefined)
  assert.deepEqual(validateSdkQuery(JSON.parse(JSON.stringify(query))), query)
  assert.equal(query.message.type, 'user')
  assert.equal(query.message.session_id, '')
  assert.equal(query.message.parent_tool_use_id, null)
})

test('new, resumed, forked and ephemeral SDK histories keep distinct identity semantics', () => {
  for (const [session, expected] of [
    [{ kind: 'new', sessionId: ID, name: '--no-session-persistence' }, { persistSession: true, sessionId: ID, title: '--no-session-persistence' }],
    [{ kind: 'resume', resumeId: ID }, { persistSession: true, resume: ID }],
    [{ kind: 'resume', resumeId: ID, forkSession: true }, { persistSession: true, resume: ID, forkSession: true }],
    [{ kind: 'ephemeral' }, { persistSession: false }],
  ]) {
    const { options } = buildSdkQuery({ ...base, session })
    const observed = Object.fromEntries(['persistSession', 'sessionId', 'resume', 'forkSession', 'title']
      .filter(key => Object.hasOwn(options, key)).map(key => [key, options[key]]))
    assert.deepEqual(observed, expected)
  }
  for (const session of [
    { kind: 'new', sessionId: ID, resumeId: OTHER_ID },
    { kind: 'resume', resumeId: ID, name: 'must not rename existing history' },
    { kind: 'new', sessionId: ID, forkSession: true },
    { kind: 'ephemeral', sessionId: ID },
    { kind: 'ephemeral', name: 'should not be retained' },
    { kind: 'resume', resumeId: 'missing' },
  ]) assert.throws(() => buildSdkQuery({ ...base, session }), /invalid SDK query/)
})

test('all supported permission policies retain no-prompt behavior and bypass is explicit only', () => {
  for (const permissionMode of ['plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions']) {
    const { options } = buildSdkQuery({ ...base, permissionMode, settingSources: [] })
    assert.equal(options.permissionMode, permissionMode)
    assert.equal(options.permissionPrompts, 'none')
    assert.deepEqual(options.settingSources, [])
    assert.equal(options.allowDangerouslySkipPermissions, permissionMode === 'bypassPermissions' ? true : undefined)
  }
  assert.deepEqual(buildSdkQuery({ ...base, settingSources: ['project', 'local'] }).options.settingSources, ['project', 'local'])
  assert.throws(() => buildSdkQuery({ ...base, permissionMode: 'default' }), /permission policy/)
  assert.throws(() => buildSdkQuery({ ...base, settingSources: ['managed'] }), /settingSources/)
})

test('multimodal messages preserve text and encoded content without sending local attachment paths', () => {
  const text = '看图并阅读 PDF\nLiteral --resume "not-an-id" and $(not-a-command).'
  const images = [{ path: '/private/screenshot.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
  const documents = [{ path: '/private/design.pdf', mimeType: 'application/pdf', data: 'cGRm' }]
  const query = buildSdkQuery({ ...base, text, images, documents })
  assert.deepEqual(query.message.message, { role: 'user', content: [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
  ] })
  assert.equal(JSON.stringify(query).includes('/private/'), false)
  images[0].data = 'bmV3'
  documents[0].mimeType = 'text/plain'
  assert.equal(query.message.message.content[1].source.data, 'aW1hZ2U=')
  assert.equal(query.message.message.content[2].source.media_type, 'application/pdf')
  assert.throws(() => buildSdkQuery({ ...base, images: [{ mimeType: 'image/png', data: 'not base64' }] }), /attachment/)
})

test('a large encoded image remains valid without repeated-group regexp stack growth', () => {
  const data = 'A'.repeat(12 * 1024 * 1024)
  const query = buildSdkQuery({ ...base, images: [{ mimeType: 'image/png', data }] })
  assert.equal(query.message.message.content[1].source.data, data)
})

test('native mapping preserves independent root/child effort, model and inherited child defaults', () => {
  const native = { version: 1,
    agents: { enabled: true, maxConcurrent: 3, maxDepth: 2, definitions: {
      reviewer: { description: 'Review', prompt: 'Inspect the changes.', model: 'opus', effort: 'max', permissionMode: 'plan',
        tools: ['Read', 'Bash'], disallowedTools: ['Edit'], maxTurns: 7 },
      inherited: { description: 'Implement', prompt: 'Complete the task.' },
    } },
    workflows: { enabled: true, maxConcurrent: 5 }, advisor: { enabled: true, model: 'opus' },
  }
  const query = buildSdkQuery({ ...base, model: 'sonnet', reasoningEffort: 'medium', native })
  assert.equal(query.options.model, 'sonnet')
  assert.equal(query.options.effort, 'medium')
  assert.deepEqual(query.options.agents, native.agents.definitions)
  assert.equal(Object.hasOwn(query.options.agents.inherited, 'effort'), false)
  assert.deepEqual(query.options.settings, { disableWorkflows: false, env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0', CLAUDE_CODE_DISABLE_WORKFLOWS: '0', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '0',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2', CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '5',
  } })
  assert.deepEqual(query.options.disallowedTools, ['TeamCreate', 'TeamDelete'])
  assert.deepEqual(query.options.extraArgs, { advisor: 'opus' })
  native.agents.definitions.reviewer.effort = 'low'
  assert.equal(query.options.agents.reviewer.effort, 'max', 'descriptor must not follow later input mutation')
})

test('omitted native settings remain native defaults; explicit off retains all tool restrictions', () => {
  const inherited = buildSdkQuery(base)
  for (const key of ['settings', 'agents', 'disallowedTools', 'extraArgs']) assert.equal(Object.hasOwn(inherited.options, key), false)
  const off = buildSdkQuery({ ...base, native: { version: 1 } })
  assert.deepEqual(off.options.disallowedTools, ['Agent', 'Task', 'Workflow', 'TeamCreate', 'TeamDelete'])
  assert.deepEqual(off.options.settings, { disableWorkflows: true, env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0', CLAUDE_CODE_DISABLE_WORKFLOWS: '1', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  } })
  assert.equal(off.options.extraArgs, undefined)
  assert.equal(off.options.agents, undefined)
})

test('schema and maximum budget become SDK options without changing the requested constraints', () => {
  const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
  const query = buildSdkQuery({ ...base, outputSchema, maxBudgetUsd: 0.25 })
  assert.deepEqual(query.options.outputFormat, { type: 'json_schema', schema: outputSchema })
  assert.equal(query.options.maxBudgetUsd, 0.25)
  outputSchema.required.push('laterMutation')
  assert.deepEqual(query.options.outputFormat.schema.required, ['answer'])
  for (const maxBudgetUsd of [0, -1, Infinity, NaN, '1']) assert.throws(() => buildSdkQuery({ ...base, maxBudgetUsd }))
  for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(buildSdkQuery({ ...base, reasoningEffort }).options.effort, reasoningEffort)
})

test('deserialized descriptors cannot override runtime ownership, widen permissions or change history', () => {
  for (const key of ['cwd', 'env', 'pathToClaudeCodeExecutable', 'spawnClaudeCodeProcess', 'canUseTool', 'allowedTools', 'continue']) {
    const query = buildSdkQuery(base)
    query.options[key] = key === 'env' ? { ANTHROPIC_API_KEY: 'unexpected' } : 'unexpected'
    assert.throws(() => validateSdkQuery(query), /unsupported SDK options/)
  }
  for (const mutate of [
    query => { query.options.permissionPrompts = 'host' },
    query => { query.options.allowDangerouslySkipPermissions = true },
    query => { query.options.systemPrompt = 'replace native behavior' },
    query => { query.options.sessionId = OTHER_ID },
    query => { query.options.resume = OTHER_ID },
    query => { query.options.persistSession = false },
    query => { query.options.extraArgs = { 'dangerously-skip-permissions': null } },
    query => { query.options.settings = { hooks: {} } },
    query => { query.message.parent_tool_use_id = 'foreign-child' },
  ]) {
    const query = buildSdkQuery(base)
    mutate(query)
    assert.throws(() => validateSdkQuery(query), /invalid SDK query/)
  }
  assert.throws(() => buildSdkQuery({ ...base, args: ['--resume', OTHER_ID] }), /argv is not a query descriptor/)
  assert.throws(() => validateSdkQuery({ ...buildSdkQuery(base), callback() {} }), /serializable JSON/)
})
