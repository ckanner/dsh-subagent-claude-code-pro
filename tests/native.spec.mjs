import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'
import { runMachine, parseMachineRequest, validateNativeReviewRequest, validateInteractiveTeamRequest, runNativeReview, runInteractiveTeam, recoverNativeJob, controlInteractiveTeam } from 'dsh-subagent-claude-code-pro/machine'
import { NativeTracker, nativeControls } from '../lib/native.js'
import { createCollector } from '../lib/protocol.js'

function fixture(mode = 'normal') {
  const cwd = makeTempDir('cc-native-'), log = join(cwd, 'calls')
  return { cwd, log, request: { protocol: 1, requestId: 'native-test', cwd, command: makeFakeCommand(), prompt: 'native fixture',
    permissionMode: 'bypassPermissions', sessionMode: 'ephemeral', model: 'sonnet', effort: 'high', timeoutMs: 5000 },
    runtime: { env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log } } }
}

test('native controls are explicit, bounded and process-scoped', () => {
  const f = fixture()
  for (const native of [{ version: 2 }, { version: 1, teams: { enabled: true } }, { version: 1, agents: { enabled: false, maxConcurrent: 3 } },
    { version: 1, advisor: { enabled: true } }, { version: 1, workflows: { enabled: true, maxConcurrent: 257 } }]) assert.throws(() => parseMachineRequest({ ...f.request, native }))
  const controls = nativeControls({ version: 1 })
  assert.equal(controls.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1')
  assert.equal(controls.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1')
  assert.equal(controls.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '0')
  assert.ok(controls.args.includes('Agent,Task,Workflow,TeamCreate,TeamDelete'))
  assert.doesNotThrow(() => validateNativeReviewRequest({ protocol: 1, requestId: 'review', cwd: f.cwd, consent: true }))
  assert.throws(() => validateNativeReviewRequest({ protocol: 1, requestId: 'review', cwd: f.cwd, consent: false }))
  assert.doesNotThrow(() => validateInteractiveTeamRequest({ protocol: 1, requestId: 'team', cwd: f.cwd, prompt: 'team', permissionMode: 'acceptEdits' }))
  assert.throws(() => validateInteractiveTeamRequest({ protocol: 1, requestId: 'team', cwd: f.cwd, prompt: 'team', permissionMode: 'acceptEdits', native: { version: 1 } }))
})

test('Agent/Workflow/advisor controls reach the CLI without changing credentials or model answer', async () => {
  const f = fixture('native-child'), events = []
  const receipt = await runMachine({ ...f.request, native: { version: 1,
    agents: { enabled: true, maxConcurrent: 5, maxDepth: 2, definitions: { implementer: { description: 'Implement', prompt: 'Use the full approved tools', model: 'sonnet' } } },
    workflows: { enabled: true, maxConcurrent: 6 }, advisor: { enabled: true, model: 'opus' },
  } }, { ...f.runtime, onNativeEvent: e => events.push(e), recoveryDirectory: join(f.cwd, 'journal'), onLifecycle: async () => {} })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.native.effective.matched, true)
  assert.equal(receipt.native.effective.verification, 'tools-only')
  assert.equal(receipt.native.children.length, 1)
  assert.equal(receipt.native.children[0].id, 'child-1')
  assert.equal(receipt.native.children[0].turnId, 'run-001')
  assert.equal(receipt.native.children[0].model, 'actual-child')
  assert.equal(receipt.native.children[0].usage.total_tokens, 25)
  assert.equal(receipt.native.usage.childSnapshotsAreAdditive, false)
  assert.equal(receipt.native.usage.aggregateFamilyStatus, 'unknown')
  assert.equal(receipt.usage.totalTokens, 15)
  assert.equal(receipt.native.cleanup.confirmed, true)
  assert.doesNotMatch(receipt.output[0].text, /CHILD IS NOT ROOT|child-only/)
  assert.ok(events.some(e => e.id === 'child-1' && e.state === 'completed'))
  const call = JSON.parse(readFileSync(f.log, 'utf8').trim())
  assert.equal(call.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '5')
  assert.equal(call.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, '6')
  assert.equal(call.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '2')
  assert.equal(call.args[call.args.indexOf('--advisor') + 1], 'opus')
})

test('native off cannot silently become enabled and a remote launch is not local cleanup', async () => {
  const f = fixture('native-mismatch')
  const mismatch = await runMachine({ ...f.request, native: { version: 1 } }, f.runtime)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.native.effective.matched, false)
  assert.equal(mismatch.cleanup.confirmed, true)
  const remote = fixture('native-remote')
  const receipt = await runMachine({ ...remote.request, native: { version: 1, agents: { enabled: true }, workflows: { enabled: true } } }, remote.runtime)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.cleanup.confirmed, true)
  assert.equal(receipt.native.cleanup.confirmed, false)
  assert.equal(receipt.native.cleanup.scope, 'remote-job')
  assert.deepEqual(receipt.native.cleanup.pendingIds, ['remote-1'])
})

test('task run IDs keep late completions separate and snapshots are never increments', () => {
  const tracker = new NativeTracker({ version: 1, agents: { enabled: true } })
  tracker.observe({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent'], agents: [] })
  const base = { type: 'system', session_id: 'root', task_id: 'child', task_type: 'local_agent' }
  for (const run_id of ['001', '002']) {
    tracker.observe({ ...base, subtype: 'task_started', run_id })
    for (const n of [10, 20, 20, 10]) tracker.observe({ ...base, subtype: 'task_progress', run_id, usage: { total_tokens: n, tool_uses: 1, duration_ms: 100 } })
  }
  tracker.observe({ ...base, subtype: 'task_notification', run_id: '001', status: 'completed' })
  const children = tracker.report().children
  assert.equal(children.length, 2)
  assert.equal(children.find(c => c.turnId === '002').state, 'running')
  assert.equal(children.find(c => c.turnId === '002').usage.total_tokens, 20)
})

test('opaque task run IDs use start evidence and unversioned events cannot end the latest run', () => {
  const tracker = new NativeTracker({ version: 1, agents: { enabled: true } })
  tracker.observe({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent'], agents: [] })
  const base = { type: 'system', session_id: 'root', task_id: 'child', task_type: 'local_agent' }
  tracker.observe({ ...base, subtype: 'task_started', run_id: 'z-previous' })
  tracker.observe({ ...base, subtype: 'task_notification', run_id: 'z-previous', status: 'completed' })
  tracker.observe({ ...base, subtype: 'task_started', run_id: 'a-current' })
  tracker.observe({ ...base, subtype: 'task_started', run_id: 'z-previous' })
  tracker.observe({ ...base, subtype: 'task_progress', run_id: 'z-previous' })
  tracker.observe({ ...base, subtype: 'task_notification', status: 'completed' })
  tracker.observe({ ...base, task_id: 'grandchild', parent_task_id: 'child', subtype: 'task_started', run_id: 'nested' })
  const report = tracker.report()
  assert.equal(report.children.find(c => c.turnId === 'a-current').state, 'running')
  assert.equal(report.children.find(c => c.turnId === 'z-previous').state, 'completed')
  assert.equal(report.completion.confirmed, false)
  assert.equal(report.resourceBounds.hard, false)
  assert.deepEqual(report.resourceBounds.agents.exceptions, ['ultracode', 'in-session-fork', 'resumed-agent'])
})

test('observed native overrun is a protocol failure and workflow limits have their own scope', () => {
  const native = { version: 1, agents: { enabled: true, maxConcurrent: 1 }, workflows: { enabled: true, maxConcurrent: 2 } }
  const tracker = new NativeTracker(native)
  tracker.observe({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent', 'Workflow'], agents: [] })
  const start = (task_id, task_type, parent_task_id) => tracker.observe({ type: 'system', session_id: 'root', subtype: 'task_started', task_id, task_type, parent_task_id, run_id: task_id + '-run' })
  start('flow', 'local_workflow')
  start('flow-1', 'local_agent', 'flow')
  start('flow-2', 'local_agent', 'flow')
  start('ordinary', 'local_agent')
  assert.equal(tracker.error, undefined)
  start('flow-3', 'local_agent', 'flow')
  assert.match(tracker.error, /workflow workers exceeded/)
  const collector = createCollector({ native })
  collector.accept({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent', 'Workflow'], agents: [] })
  for (const task_id of ['ordinary-1', 'ordinary-2']) collector.accept({ type: 'system', session_id: 'root', subtype: 'task_started', task_type: 'local_agent', task_id, run_id: task_id + '-run' })
  assert.equal(collector.invalid, true)
  assert.match(collector.nativeReport().diagnostic, /subagents exceeded/)
})

test('queued Agent tool calls do not masquerade as active native workers', () => {
  const collector = createCollector({ native: { version: 1, agents: { enabled: true, maxConcurrent: 1 } } })
  collector.accept({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent'], agents: [] })
  collector.accept({ type: 'assistant', session_id: 'root', message: { content: [
    { type: 'tool_use', name: 'Agent', id: 'first', input: {} },
    { type: 'tool_use', name: 'Agent', id: 'queued', input: {} },
  ] } })
  assert.equal(collector.invalid, false)
  collector.accept({ type: 'system', subtype: 'task_started', session_id: 'root', task_id: 'first-task', run_id: 'first-run', task_type: 'local_agent', tool_use_id: 'first' })
  assert.equal(collector.invalid, false)
  collector.accept({ type: 'system', subtype: 'task_started', session_id: 'root', task_id: 'second-task', run_id: 'second-run', task_type: 'local_agent', tool_use_id: 'queued' })
  assert.equal(collector.invalid, true)
  assert.match(collector.nativeReport().diagnostic, /subagents exceeded/)
})

test('late tool linkage reconciles existing task runs and completed snapshots', () => {
  for (const snapshot of [false, true]) for (const terminalFirst of [false, true]) {
    const collector = createCollector({ native: { version: 1, agents: { enabled: true, maxConcurrent: 1 } } })
    collector.accept({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent'], agents: [] })
    collector.accept({ type: 'assistant', session_id: 'root', message: { content: [
      { type: 'tool_use', name: 'Agent', id: 'spawn-1', input: { model: 'child-model' } },
    ] } })
    const task = { task_id: 'child', run_id: 'run-child', task_type: 'local_agent' }
    collector.accept(snapshot ? { type: 'system', subtype: 'background_tasks_changed', session_id: 'root', tasks: [task] }
      : { type: 'system', subtype: 'task_started', session_id: 'root', ...task })
    const completed = { type: 'system', subtype: 'task_notification', session_id: 'root', ...task, status: 'completed' }
    if (terminalFirst) collector.accept(completed)
    collector.accept({ type: 'user', session_id: 'root',
      message: { content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'launched' }] },
      tool_use_result: { status: 'async_launched', taskId: 'child', runId: 'run-child', taskType: 'local_agent' } })
    if (!terminalFirst) collector.accept(completed)
    const report = collector.nativeReport()
    assert.equal(collector.invalid, false)
    assert.equal(report.children.length, 1, `snapshot=${snapshot} terminalFirst=${terminalFirst}`)
    assert.equal(report.children[0].id, 'child')
    assert.equal(report.children[0].state, 'completed')
    assert.equal(report.children[0].toolUseId, 'spawn-1')
    assert.equal(report.children[0].model, 'child-model')
    assert.equal(report.children[0].parentId, 'root')
    assert.equal(report.completion.confirmed, true)
    assert.deepEqual(report.completion.pendingIds, [])
    collector.accept({ type: 'assistant', session_id: 'child', parent_tool_use_id: 'spawn-1',
      message: { model: 'resolved-child-model', content: [] } })
    assert.equal(collector.nativeReport().children[0].model, 'resolved-child-model')
  }
})

test('native Workflow completion can trigger a correlated follow-up result without counting snapshots twice', () => {
  const collector = createCollector({ native: { version: 1, agents: { enabled: true }, workflows: { enabled: true } } })
  collector.accept({ type: 'system', subtype: 'init', session_id: 'root', tools: ['Agent', 'Workflow'], agents: [] })
  collector.accept({ type: 'system', subtype: 'task_started', session_id: 'root', task_id: 'flow', task_type: 'local_workflow', run_id: 'run-1' })
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'root', usage: { input_tokens: 1, output_tokens: 2 } }
  collector.accept({ ...result, uuid: 'result-1', result: 'Started workflow' })
  collector.accept({ type: 'user', session_id: 'root', origin: { kind: 'task-notification', runId: 'run-1' }, message: { content: [] } })
  collector.accept({ type: 'assistant', session_id: 'root', message: { content: [{ type: 'text', text: 'Finished workflow' }] } })
  collector.accept({ ...result, uuid: 'result-2', result: 'Finished workflow', origin: { kind: 'task-notification', runId: 'run-1' } })
  assert.equal(collector.finish().kind, 'success')
  assert.equal(collector.finish().text, 'Finished workflow')
  assert.equal(collector.finish().usage, undefined)
  assert.equal(collector.nativeReport().usage.rootResults.length, 2)
})

test('machine media, schema and budget use the native wire and validate the result', async () => {
  const f = fixture()
  const receipt = await runMachine({ ...f.request, images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } }, additionalProperties: false }, maxBudgetUsd: 2 }, f.runtime)
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.structured, { answer: 42 })
  const call = JSON.parse(readFileSync(f.log, 'utf8').trim())
  assert.equal(call.userContent[1].type, 'image')
  assert.equal(call.args[call.args.indexOf('--max-budget-usd') + 1], '2')
  const bad = fixture('bad-structured')
  const invalid = await runMachine({ ...bad.request, outputSchema: { type: 'object', required: ['answer'] } }, bad.runtime)
  assert.equal(invalid.ok, false)
})

test('dedicated native review returns JSON and durable identity without print mode or posting', async () => {
  const f = fixture(), recoveryDirectory = join(f.cwd, 'review-journal')
  const receipt = await runNativeReview({ protocol: 1, requestId: 'review', cwd: f.cwd, command: f.request.command, target: 'main', consent: true, trustWorkspace: true, timeoutMinutes: 2 }, { ...f.runtime, recoveryDirectory })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.remote.state, 'completed')
  assert.equal(receipt.remote.cancelSupported, false)
  assert.equal(receipt.structured.bugs.length, 1)
  const call = JSON.parse(readFileSync(f.log, 'utf8').trim())
  assert.deepEqual(call.args, ['ultrareview', 'main', '--json', '--no-post', '--timeout', '2', '--trust-workspace'])
  const recovered = await recoverNativeJob({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory })
  assert.equal(recovered.status, 'terminal')
  assert.deepEqual(recovered.receipt, receipt)
  await assert.rejects(runNativeReview({ protocol: 1, requestId: 'review', cwd: f.cwd, consent: true }, { recoveryDirectory }))
})

test('native review timeout and malformed completion retain unknown remote responsibility', async () => {
  for (const mode of ['review-hang', 'review-bad']) {
    const f = fixture(mode)
    const receipt = await runNativeReview({ protocol: 1, requestId: mode, cwd: f.cwd, command: f.request.command, consent: true, timeoutMs: mode === 'review-hang' ? 500 : 5000, disposeGraceMs: 50 }, { ...f.runtime, recoveryDirectory: join(f.cwd, 'journal') })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.cleanup.confirmed, true)
    assert.equal(receipt.remote.state, 'unknown')
    assert.equal(receipt.remote.replaySafe, false)
    assert.equal(receipt.native.cleanup.confirmed, false)
  }
})

test('independent job validation does not start cloud work or hide the real interactive dependency', async () => {
  const f = fixture()
  await assert.rejects(runNativeReview({ protocol: 1, requestId: 'review', cwd: f.cwd }, { recoveryDirectory: join(f.cwd, 'no-consent') }), /consent/)
  await assert.rejects(runNativeReview({ protocol: 1, requestId: 'review', cwd: f.cwd, consent: true, target: '--post' }, { recoveryDirectory: join(f.cwd, 'bad-target') }), /target/)
  const receipt = await runInteractiveTeam({ protocol: 1, requestId: 'team', cwd: f.cwd, command: f.request.command,
    tmuxCommand: '/nonexistent-tmux-native-test', prompt: 'Work as a team', permissionMode: 'acceptEdits' }, { ...f.runtime, recoveryDirectory: join(f.cwd, 'team-journal') })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.dispatch, 'not-dispatched')
  assert.match(receipt.failure.detail, /tmux/)
  assert.equal(receipt.cleanup.confirmed, true)
})


test('interactive teams use the real terminal command interface and isolated control lifecycle', async () => {
  const f = fixture('team-hang'), ready = Promise.withResolvers(), recoveryDirectory = join(f.cwd, 'team-journal')
  const tmuxCommand = fileURLToPath(new URL('./fixtures/fake-tmux.mjs', import.meta.url))
  chmodSync(tmuxCommand, 0o755)
  const old = process.env.FAKE_TMUX_HOME
  process.env.FAKE_TMUX_HOME = f.cwd
  try {
    const running = runInteractiveTeam({ protocol: 1, requestId: 'team', cwd: f.cwd, command: f.request.command,
      tmuxCommand, prompt: 'Implement with independent teammates', permissionMode: 'acceptEdits', timeoutMs: 5000, disposeGraceMs: 50 },
      { ...f.runtime, env: { ...f.runtime.env, FAKE_TMUX_HOME: f.cwd }, recoveryDirectory,
        onNativeEvent: event => { if (event.kind === 'interactive-ready') ready.resolve(event.id) } })
    const runId = await ready.promise
    const identity = { protocol: 1, requestId: 'team', runId, recoveryDirectory }
    const attach = await controlInteractiveTeam({ ...identity, action: 'attach' })
    assert.equal(attach.command, tmuxCommand)
    assert.deepEqual(attach.args.slice(-3), ['attach-session', '-t', 'ccpro'])
    const captured = await controlInteractiveTeam({ ...identity, action: 'capture' })
    assert.equal(captured.text, 'TEAM_OUTPUT\n')
    assert.equal(captured.displayOnly, true)
    await controlInteractiveTeam({ ...identity, action: 'send', text: 'finish the integration', enter: true })
    await controlInteractiveTeam({ ...identity, action: 'resize', columns: 100, rows: 30 })
    assert.equal(readFileSync(join(f.cwd, 'ccpro-' + runId, 'input'), 'utf8'), 'finish the integration')
    await assert.rejects(controlInteractiveTeam({ ...identity, requestId: 'another-job', action: 'cancel' }), /identified/)
    const cancel = await controlInteractiveTeam({ ...identity, action: 'cancel' })
    assert.equal(cancel.cleanupConfirmed, false)
    const receipt = await running
    assert.equal(receipt.operation, 'interactive-team')
    assert.equal(receipt.execution.cancelled, true)
    assert.equal(receipt.cleanup.confirmed, true, JSON.stringify(receipt))
    assert.equal(receipt.completion.businessOutcome, 'unknown')
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim())
    assert.equal(call.args.includes('-p'), false)
    assert.equal(call.args[call.args.indexOf('--teammate-mode') + 1], 'in-process')
    assert.equal(call.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1')
    assert.ok(call.args.includes('Implement with independent teammates'))
    await assert.rejects(controlInteractiveTeam({ ...identity, action: 'send', text: 'again' }), /not pending/)
  } finally {
    if (old === undefined) delete process.env.FAKE_TMUX_HOME; else process.env.FAKE_TMUX_HOME = old
  }
})

test('an unidentified native pane cannot be certified cleaned by kill-server alone', async () => {
  const f = fixture('team-hang'), recoveryDirectory = join(f.cwd, 'team-journal')
  const tmuxCommand = fileURLToPath(new URL('./fixtures/fake-tmux.mjs', import.meta.url))
  chmodSync(tmuxCommand, 0o755)
  const receipt = await runInteractiveTeam({ protocol: 1, requestId: 'identity-failure', cwd: f.cwd, command: f.request.command,
    tmuxCommand, prompt: 'Work as a team', permissionMode: 'acceptEdits', timeoutMs: 5000, disposeGraceMs: 50 },
    { ...f.runtime, env: { ...f.runtime.env, FAKE_TMUX_HOME: f.cwd, FAKE_TMUX_BAD_IDENTITY: '1' }, recoveryDirectory })
  try {
    assert.equal(receipt.ok, false)
    assert.equal(receipt.execution.dispatch, 'dispatched')
    assert.equal(receipt.cleanup.confirmed, false)
    assert.equal(receipt.native.cleanup.confirmed, false)
  } finally {
    const { pid } = JSON.parse(readFileSync(join(f.cwd, 'ccpro-' + receipt.runId, 'state'), 'utf8'))
    try { process.kill(-pid, 'SIGKILL') } catch {}
  }
})
