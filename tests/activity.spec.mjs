import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MACHINE_ACTIVITY_VERSION, MACHINE_ACTIVITY_CAPABILITIES, runMachine, parseMachineRequest, recoverMachine } from 'dsh-subagent-claude-code-pro/machine'
import { createActivityReporter, validActivity, claudeActivity } from '../lib/activity.js'
import { apply } from '../lib/index.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

const calls = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
function fixture(mode = 'normal', extraEnv = {}) {
  const cwd = makeTempDir('claude-activity-'), log = join(cwd, 'query.jsonl'), help = join(cwd, 'help.jsonl')
  const request = { protocol: 1, requestId: 'activity-test', cwd, command: makeFakeCommand(), model: 'sonnet',
    prompt: 'Investigate alert delivery', permissionMode: 'bypassPermissions', sessionMode: 'persistent', timeoutMs: 10000, disposeGraceMs: 200 }
  const env = { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HELP_LOG: help, ...extraEnv }
  return { request, cwd, log, help, env, run: (overrides = {}, runtime = {}) => runMachine({ ...request, ...overrides }, { env, ...runtime }) }
}

test('activity schema is private, bounded and driven only by actual events', () => {
  assert.equal(MACHINE_ACTIVITY_VERSION, 1)
  assert.deepEqual(MACHINE_ACTIVITY_CAPABILITIES, { version: 1, metadataOnly: true, coalesced: true, rootAndChildren: true })
  let now = 0
  const events = [], reporter = createActivityReporter(e => events.push(e), 250, { now: () => now })
  reporter.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'private-answer' }] } })
  for (let i = 0; i < 100000; i++) reporter.observe({ type: 'stream_event', parent_tool_use_id: 'private-child-id',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private-thought' } } })
  assert.equal(events.length, 1)
  now = 1000
  assert.equal(events.length, 1, 'time passing cannot invent heartbeat activity')
  reporter.observe({ type: 'system', subtype: 'api_retry', error: 'private-error' })
  assert.equal(events.length, 2)
  assert.equal(events[1].scope, 'mixed')
  assert.equal(events[1].observedEvents, 100001)
  assert.deepEqual(events[1].eventTypes, ['stream-delta', 'api-retry'])
  assert.ok(events.every(validActivity))
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 1024)
  assert.doesNotMatch(JSON.stringify(events), /private-/)
  reporter.close(); now += 1000
  reporter.observe({ type: 'system', subtype: 'init' })
  assert.equal(events.length, 2)
  assert.equal(claudeActivity({ type: 'diagnostic', text: 'not progress' }), undefined)
  assert.equal(validActivity({ ...events[0], text: 'not allowed' }), false)
})

for (const mode of ['activity-root', 'activity-child']) test(`${mode} reaches the public API through both supervisors without exposing bodies`, async () => {
  const f = fixture(mode), activity = [], progress = []
  const directory = join(f.cwd, 'journal')
  const receipt = await f.run({}, { recoveryDirectory: directory, onLifecycle: () => {}, activityIntervalMs: 50,
    onActivity: e => activity.push(e), onProgress: t => progress.push(t) })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.ok(activity.length >= 8, JSON.stringify(activity))
  assert.ok(activity.every(validActivity))
  assert.deepEqual(activity.map(e => e.sequence), activity.map((_, i) => i + 1))
  assert.ok(activity.some(e => e.eventTypes.includes(mode === 'activity-root' ? 'tool-use' : 'stream-delta')))
  if (mode === 'activity-child') assert.ok(activity.filter(e => e.scope === 'child').length >= 8)
  assert.equal(progress.length, 1, 'display text remains independent of tool/child activity')
  assert.doesNotMatch(JSON.stringify(activity), /private-|child-only-tool|child-session/)
  assert.ok(calls(f.log)[0].args.includes('--include-partial-messages'))
  assert.ok(calls(f.log)[0].args.includes('--forward-subagent-text'))
  const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory: directory })
  assert.deepEqual(recovered.receipt, receipt)
  assert.equal(Object.hasOwn(receipt, 'activity'), false, 'activity is not receipt/dispatch evidence')
})

test('continued native task progress survives state-ledger deduplication', async () => {
  const f = fixture('activity-native'), activity = [], native = { version: 1, agents: { enabled: true } }
  const receipt = await f.run({ native }, { activityIntervalMs: 50, onActivity: e => activity.push(e) })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.ok(activity.filter(e => e.eventTypes.includes('task-progress')).length >= 8)
  assert.equal(receipt.native.observed.events.filter(e => e.kind === 'task-progress').length, 1,
    'durable state deduplication is independent of observed activity')
  assert.equal(receipt.native.children[0].usage.total_tokens, 12)
})

test('100000 raw stream deltas produce bounded metadata and a trustworthy final receipt', async () => {
  const f = fixture('activity-burst'), activity = []
  const receipt = await f.run({ timeoutMs: 30000 }, { onActivity: e => activity.push(e) })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.ok(activity.every(validActivity))
  assert.ok(activity.length < 128, 'coalescing must bound IPC activity, not count every token')
  assert.ok(Buffer.byteLength(JSON.stringify(activity)) < 64 * 1024)
  assert.ok(activity.reduce((sum, e) => sum + e.observedEvents, 0) >= 100000)
  assert.equal(receipt.execution.truncated, false)
})

test('more than 64 MiB of actual stream activity does not consume the final-answer budget', async () => {
  const f = fixture('activity-volume'), activity = []
  const receipt = await f.run({ timeoutMs: 15000, maxOutputBytes: 1024 }, { onActivity: e => activity.push(e) })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.execution.truncated, false)
  assert.equal(receipt.cleanup.confirmed, true)
  assert.ok(activity.reduce((sum, e) => sum + e.observedEvents, 0) >= 1100)
  assert.ok(activity.length < 64)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 16384)
})

test('the single-frame bound still aborts an oversized provider frame and confirms cleanup', async () => {
  const f = fixture('activity-frame-overflow')
  const receipt = await f.run({ timeoutMs: 15000 })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.truncated, true)
  assert.equal(receipt.failure.category, 'protocol')
  assert.equal(receipt.cleanup.confirmed, true)
})

test('large root text uses a bounded optional display stream while retaining the terminal answer', async () => {
  const f = fixture('activity-display-volume'), progress = [], activity = []
  const receipt = await f.run({ timeoutMs: 15000, maxOutputBytes: 1024 }, { onProgress: text => progress.push(text), onActivity: e => activity.push(e) })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.execution.truncated, false)
  assert.ok(progress.some(text => text.includes('Further display progress omitted')))
  assert.ok(progress.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 4 * 1024 * 1024 + 1024)
  assert.ok(activity.reduce((sum, e) => sum + e.observedEvents, 0) >= 512)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 16384)
})

for (const mode of ['activity-foreign-stream', 'activity-foreign-tool', 'activity-foreign-assistant']) {
  test(`${mode} cannot extend liveness or display foreign progress`, async () => {
    const f = fixture(mode), activity = [], progress = []
    const receipt = await f.run({}, { activityIntervalMs: 10, onActivity: e => activity.push(e), onProgress: text => progress.push(text) })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.failure.category, 'protocol')
    assert.equal(receipt.cleanup.confirmed, true)
    assert.equal(receipt.execution.outcome, 'unknown')
    assert.deepEqual(activity.map(e => e.eventTypes), [['session-init']])
    assert.deepEqual(progress, [])
    assert.doesNotMatch(JSON.stringify(receipt), /foreign-private/)
  })
}

test('a silent CLI creates no periodic activity and cancellation still confirms cleanup', async () => {
  const f = fixture('activity-silent'), controller = new AbortController(), seen = Promise.withResolvers(), activity = []
  const running = f.run({}, { signal: controller.signal, activityIntervalMs: 10, onActivity: e => { activity.push(e); seen.resolve() } })
  await seen.promise
  await delay(300)
  assert.equal(activity.length, 1, 'one observed init is not a periodic keepalive')
  controller.abort()
  const receipt = await running
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.cancelled, true)
  assert.equal(receipt.execution.outcome, 'unknown')
  assert.equal(receipt.cleanup.confirmed, true)
  await delay(50)
  assert.equal(activity.length, 1)
})

test('cancellation during child-only activity stops callbacks and keeps unknown distinct from cleanup', async () => {
  const f = fixture('activity-child'), controller = new AbortController(), activity = []
  const receipt = await f.run({}, { signal: controller.signal, activityIntervalMs: 50, onActivity: e => {
    activity.push(e)
    if (e.scope === 'child') controller.abort()
  } })
  assert.equal(receipt.execution.cancelled, true)
  assert.equal(receipt.execution.outcome, 'unknown')
  assert.equal(receipt.cleanup.confirmed, true)
  const count = activity.length
  await delay(100)
  assert.equal(activity.length, count)
})

test('missing child-stream capability rejects before task prompt delivery and never echoes help text', async () => {
  const f = fixture('normal', { FAKE_CLAUDE_HELP_MODE: 'old' })
  const receipt = await f.run()
  assert.equal(receipt.ok, false)
  assert.equal(receipt.failure.category, 'unsupported-runtime')
  assert.equal(receipt.execution.dispatch, 'not-dispatched')
  assert.equal(receipt.cleanup.confirmed, true)
  assert.deepEqual(calls(f.log), [])
  assert.equal(calls(f.help).length, 1)
  assert.deepEqual(calls(f.help)[0].args, ['--help'])
  assert.doesNotMatch(JSON.stringify(receipt), /private-help/)
})

test('capability-probe cancellation never dispatches a task and does not leave its group alive', async () => {
  const f = fixture('normal', { FAKE_CLAUDE_HELP_MODE: 'hang' }), controller = new AbortController()
  const running = f.run({}, { signal: controller.signal })
  for (let i = 0; i < 500 && !existsSync(f.help); i++) await delay(10)
  assert.equal(existsSync(f.help), true)
  controller.abort()
  const receipt = await running
  assert.equal(receipt.execution.dispatch, 'not-dispatched')
  assert.equal(receipt.execution.cancelled, true)
  assert.equal(receipt.cleanup.confirmed, true)
  assert.deepEqual(calls(f.log), [])
  assert.throws(() => process.kill(-calls(f.help)[0].pid, 0), error => error.code === 'ESRCH')
})

test('a capability probe deadline remains a no-dispatch timeout with confirmed owned cleanup', async () => {
  const f = fixture('normal', { FAKE_CLAUDE_HELP_MODE: 'hang' })
  const receipt = await f.run({ timeoutMs: 1000 })
  assert.equal(receipt.failure.category, 'timeout')
  assert.equal(receipt.execution.timedOut, true)
  assert.equal(receipt.execution.dispatch, 'not-dispatched')
  assert.equal(receipt.cleanup.confirmed, true)
  assert.deepEqual(calls(f.log), [])
  assert.throws(() => process.kill(-calls(f.help)[0].pid, 0), error => error.code === 'ESRCH')
})

test('capability discovery spends the invocation wall budget instead of resetting it', async () => {
  const f = fixture('activity-budget', { FAKE_CLAUDE_HELP_DELAY: '2000' })
  const receipt = await f.run({ timeoutMs: 4500 })
  assert.equal(calls(f.log).length, 1, 'the capability probe finished and the query began')
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.timedOut, true, '2s discovery + 3s query exceeds the shared 4.5s deadline')
  assert.equal(receipt.cleanup.confirmed, true)
})

test('new machine sessions have readable names; resume and ephemeral preserve their native semantics', async () => {
  const f = fixture()
  const named = await f.run({ sessionName: '告警中心 · 故障分析' })
  assert.equal(named.ok, true)
  assert.equal(calls(f.log)[0].args[calls(f.log)[0].args.indexOf('-n') + 1], '告警中心 · 故障分析')
  const resumed = await f.run({ sessionId: named.session.id })
  assert.equal(resumed.ok, true)
  assert.equal(calls(f.log)[1].args.includes('-n'), false)
  const ephemeral = await f.run({ sessionMode: 'ephemeral' })
  assert.equal(ephemeral.ok, true)
  assert.equal(calls(f.log)[2].args.includes('-n'), false)
  const fallback = await f.run({ prompt: '\n# Investigate alert delivery\nPrivate detailed instructions' })
  assert.equal(fallback.ok, true)
  assert.equal(calls(f.log)[3].args[calls(f.log)[3].args.indexOf('-n') + 1], 'Claude · ' + basename(f.cwd))
  assert.doesNotMatch(calls(f.log)[3].args[calls(f.log)[3].args.indexOf('-n') + 1], /Investigate|Private/)
  for (const bad of [{ sessionName: 'name', sessionId: named.session.id }, { sessionName: 'name', sessionMode: 'ephemeral' }, { sessionName: 'multi\nline' }]) {
    assert.throws(() => parseMachineRequest({ ...f.request, ...bad }), /sessionName/)
  }
  for (const bad of [{ activityIntervalMs: 0 }, { activityIntervalMs: 1.2 }, { activityIntervalMs: 60001 }, { onActivity: 'not a callback' }]) {
    await assert.rejects(f.run({}, bad), /runtime\./)
  }
})

for (const background of [false, true]) test(`DSH ${background ? 'background' : 'foreground/PTC'} reports owned activity through the optional host extension`, async () => {
  const f = fixture('activity-child'), events = [], completions = []
  const service = { version: 1, intervalMs: 50, report: (agent, event) => events.push({ agent, event }) }
  const jobs = { start({ run }) { const owned = run({ updateProgress() {}, append() {} }); completions.push(owned.done); return 'owned-job' } }
  const { ctx, emit } = makeContext({ flywheelProviderActivity: service, jobs })
  apply(ctx, { command: f.request.command, presets: ['daily'], permissionMode: 'bypassPermissions', sessionMode: 'persistent', env: f.env })
  const { agent, tools } = makeAgent(f.cwd)
  emit('agent/created', { agent })
  const result = await tools[0].execute({ prompt: 'Review ownership\nDetails', ...(background ? { run_in_background: true } : {}) }, { signal: new AbortController().signal })
  if (background) { assert.equal(result.jobId, 'owned-job'); await Promise.all(completions) }
  assert.ok(events.length >= 8)
  assert.ok(events.every(e => e.agent === agent && e.event.source === 'claude-code-pro'))
  assert.equal(new Set(events.map(e => e.event.invocationId)).size, 1)
  assert.deepEqual(events.map(e => e.event.sequence), events.map((_, i) => i + 1))
  assert.doesNotMatch(JSON.stringify(events.map(e => e.event)), /private-reasoning|child-only-tool/)
  const argv = calls(f.log)[0].args
  assert.equal(argv[argv.indexOf('-n') + 1], 'DSH · ' + basename(f.cwd))
  const count = events.length
  await delay(100)
  assert.equal(events.length, count, 'completed calls cannot emit future activity')
})
