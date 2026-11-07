import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { MACHINE_PROTOCOL_VERSION, MachineInputError, parseMachineRequest, runMachine } from 'dsh-subagent-claude-code-pro/machine'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'

const UUID = '22222222-2222-4222-8222-222222222222'
function fixture(mode = 'normal') {
  const cwd = makeTempDir('ccpro-machine-')
  const log = join(cwd, 'calls.jsonl')
  const request = { protocol: 1, requestId: 'machine-test', cwd, prompt: 'remember alpha',
    command: makeFakeCommand(), model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', sessionMode: 'persistent' }
  const env = { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATE: join(cwd, 'state') }
  return { cwd, log, request, env,
    run: (overrides = {}, runtime = {}) => runMachine({ ...request, ...overrides }, { env, ...runtime }),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
}

function absentProcessGroup(receipt) {
  const group = receipt.execution.processGroupId
  if (group !== null && receipt.cleanup.confirmed) {
    assert.throws(() => process.kill(-group, 0), error => error.code === 'ESRCH')
  }
}

test('public package export validates one explicit machine request without starting the CLI', () => {
  const f = fixture()
  const request = parseMachineRequest(f.request)
  assert.equal(MACHINE_PROTOCOL_VERSION, 1)
  assert.equal(request.command, f.request.command)
  assert.deepEqual(request.settingSources, ['user', 'project', 'local'])
  assert.equal(request.timeoutMs, 600000)
  assert.equal(request.maxOutputBytes, 1024 * 1024)
  assert.equal(Object.isFrozen(request), true)
  assert.equal(Object.isFrozen(request.settingSources), true)
  assert.deepEqual(f.calls(), [])
})

test('validation rejects ambiguous sessions, native policy names, unsafe fields and bounds before dispatch', () => {
  const f = fixture()
  const invalid = [null, [], {}, { ...f.request, protocol: 2 }, { ...f.request, unknown: true },
    { ...f.request, cwd: 'relative' }, { ...f.request, cwd: '/nonexistent/ccpro-machine' },
    { ...f.request, command: './claude' }, { ...f.request, prompt: '' }, { ...f.request, prompt: '\0' },
    { ...f.request, prompt: 'x'.repeat(1024 * 1024 + 1) }, { ...f.request, requestId: 'x'.repeat(257) },
    { ...f.request, model: '' }, { ...f.request, model: ' sonnet' }, { ...f.request, effort: 'ultra' },
    { ...f.request, permissionMode: 'danger-full-access' }, { ...f.request, sessionMode: 'session' },
    { ...f.request, sessionId: 'not-a-uuid' }, { ...f.request, sessionMode: 'ephemeral', sessionId: UUID },
    { ...f.request, timeoutMs: -1 }, { ...f.request, timeoutMs: 2147483648 },
    { ...f.request, maxOutputBytes: 0 }, { ...f.request, disposeGraceMs: 30001 },
    { ...f.request, settingSources: ['user', 'user'] }, { ...f.request, settingSources: ['unknown'] },
    { ...f.request, settingSources: null }]
  // Explicit null is not an array and must not silently become native defaults.
  for (const input of invalid) assert.throws(() => parseMachineRequest(input), MachineInputError)
  assert.deepEqual(f.calls(), [])
})

test('cwd canonicalization and no-setting-source requests reach the CLI exactly', async () => {
  const f = fixture()
  const link = join(makeTempDir(), 'alias')
  symlinkSync(f.cwd, link)
  const receipt = await f.run({ cwd: link, settingSources: [], timeoutMs: 0 })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.requested.cwd, f.cwd)
  assert.deepEqual(receipt.requested.settingSources, [])
  const args = f.calls()[0].args
  assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  absentProcessGroup(receipt)
})

test('persistent completion provides observed configuration, per-invocation usage and explicit resume', async () => {
  const f = fixture()
  const first = await f.run()
  assert.equal(first.ok, true)
  assert.equal(first.execution.outcome, 'completed')
  assert.equal(first.execution.terminalReceived, true)
  assert.equal(first.configuration.source, 'cli-init')
  assert.equal(first.configuration.observed.permissionMode, 'bypassPermissions')
  assert.equal(first.session.resumed, false)
  assert.equal(first.session.resumable, true)
  assert.equal(first.reportedCostUSD, 0.001)
  assert.equal(first.costUSD, null)
  assert.equal(first.costStatus, 'unknown')
  assert.deepEqual(first.usage, { status: 'complete', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 })
  const resumed = await f.run({ requestId: 'second-attempt', sessionId: first.session.id, prompt: 'what next?' })
  assert.equal(resumed.ok, true)
  assert.notEqual(resumed.runId, first.runId)
  assert.equal(resumed.session.id, first.session.id)
  assert.equal(resumed.session.resumed, true)
  assert.equal(resumed.requested.sessionId, first.session.id)
  assert.match(resumed.output[0].text, /prior:remember alpha/)
  assert.equal(resumed.usage.totalTokens, 22)
  assert.equal(resumed.usage.cacheReadTokens, 7)
  assert.equal(f.calls().length, 2)
  assert.ok(f.calls()[1].args.includes('--resume'))
  absentProcessGroup(first)
  absentProcessGroup(resumed)
})

test('independent persistent requests and ephemeral requests never inherit hidden remembered context', async () => {
  const f = fixture()
  const first = await f.run()
  const second = await f.run({ prompt: 'independent' })
  assert.notEqual(first.session.id, second.session.id)
  assert.doesNotMatch(second.output[0].text, /prior:/)
  const ephemeral = await f.run({ sessionMode: 'ephemeral' })
  assert.equal(ephemeral.ok, true)
  assert.equal(ephemeral.session.resumable, false)
  assert.ok(f.calls()[2].args.includes('--no-session-persistence'))
})

test('a missing explicit session returns one failure and never starts a replacement', async () => {
  const f = fixture('resume-missing')
  const result = await f.run({ sessionId: UUID })
  assert.equal(result.ok, false)
  assert.equal(result.failure.category, 'resume')
  assert.equal(result.execution.outcome, 'failed')
  assert.equal(result.session.resumed, false)
  assert.equal(result.session.resumable, false)
  assert.equal(result.cleanup.confirmed, true)
  assert.equal(f.calls().length, 1)
})

test('pre-cancelled resume proves no dispatch and does not claim the requested history was opened', async () => {
  const f = fixture()
  const signal = AbortSignal.abort()
  const result = await f.run({ sessionId: UUID }, { signal })
  assert.equal(result.failure.category, 'cancelled')
  assert.equal(result.execution.dispatch, 'not-dispatched')
  assert.equal(result.execution.outcome, 'not-started')
  assert.equal(result.execution.pid, null)
  assert.equal(result.cleanup.method, 'not-started')
  assert.equal(result.cleanup.confirmed, true)
  assert.equal(result.session.id, null)
  assert.equal(result.session.resumed, false)
  assert.equal(result.requested.sessionId, UUID)
  assert.equal(result.usage.status, 'unknown')
  assert.deepEqual(f.calls(), [])
})

test('a missing executable produces correlated no-dispatch evidence, including a resume request', async () => {
  const f = fixture()
  const result = await f.run({ command: '/nonexistent/claude-code-pro-machine', sessionId: UUID })
  assert.equal(result.failure.category, 'spawn')
  assert.equal(result.execution.dispatch, 'not-dispatched')
  assert.equal(result.execution.exitCode, null)
  assert.equal(result.execution.signal, null)
  assert.equal(result.session.resumed, false)
  assert.equal(result.session.id, null)
  assert.equal(result.cleanup.confirmed, true)
  assert.deepEqual(f.calls(), [])
})

test('caller cancellation after CLI startup settles the complete owned group without trusting partial output', async () => {
  const f = fixture('progress-hang')
  const controller = new AbortController()
  const result = await f.run({}, { signal: controller.signal, onProgress: () => controller.abort() })
  assert.equal(result.ok, false)
  assert.equal(result.failure.category, 'cancelled')
  assert.equal(result.execution.cancelled, true)
  assert.equal(result.execution.dispatch, 'dispatched')
  assert.equal(result.execution.outcome, 'unknown')
  assert.equal(result.session.resumable, false)
  assert.equal(result.usage.status, 'unknown')
  assert.equal(result.cleanup.confirmed, true)
  absentProcessGroup(result)
})

test('deadline escalates to SIGKILL when the CLI ignores SIGTERM', async () => {
  const f = fixture('ignore-term')
  const result = await f.run({ timeoutMs: 200, disposeGraceMs: 25 })
  assert.equal(result.failure.category, 'timeout')
  assert.equal(result.execution.timedOut, true)
  assert.equal(result.execution.signal, 'SIGKILL')
  assert.equal(result.execution.outcome, 'unknown')
  assert.equal(result.cleanup.confirmed, true)
  absentProcessGroup(result)
})

test('an intact failed terminal preserves measured usage and never invents account quota from a CLI limit', async () => {
  for (const [mode, category] of [['auth-fail', 'auth'], ['limit', 'limit']]) {
    const f = fixture(mode)
    const result = await f.run()
    assert.equal(result.ok, false)
    assert.equal(result.failure.category, category)
    assert.equal(result.execution.terminalReceived, true)
    assert.equal(result.execution.outcome, 'failed')
    assert.equal(result.usage.totalTokens, 15)
    assert.deepEqual(result.output, [])
    assert.equal(result.cleanup.confirmed, true)
    absentProcessGroup(result)
  }
})

test('absent or unsafe token counters and cost remain explicit instead of fabricated zero', async () => {
  for (const [mode, status] of [['partial-usage', 'partial'], ['invalid-usage', 'partial'], ['missing-usage', 'unknown']]) {
    const result = await fixture(mode).run()
    assert.equal(result.ok, true)
    assert.equal(result.usage.status, status)
    assert.equal(result.usage.totalTokens, null)
  }
  const cost = await fixture('invalid-cost').run()
  assert.equal(cost.reportedCostUSD, null)
  assert.equal(cost.costUSD, null)
})

test('missing, malformed, duplicate or conflicting protocol evidence cannot become a recoverable completion', async () => {
  for (const mode of ['no-result', 'garbage', 'partial-line', 'duplicate-result', 'duplicate-init',
    'corrupt-tail', 'trailing-assistant', 'missing-status', 'result-session-mismatch', 'wrong-session', 'nonzero-success']) {
    const result = await fixture(mode).run()
    assert.equal(result.ok, false, mode)
    assert.equal(result.execution.outcome, 'unknown', mode)
    assert.equal(result.execution.terminalReceived, false, mode)
    assert.equal(result.session.resumable, false, mode)
    assert.equal(result.usage.status, 'unknown', mode)
    assert.equal(result.reportedCostUSD, null, mode)
    assert.deepEqual(result.output, [], mode)
    assert.equal(result.cleanup.confirmed, true, mode)
    absentProcessGroup(result)
  }
})

test('configuration observations must prove requested cwd, policy and model', async () => {
  for (const mode of ['wrong-cwd', 'wrong-permission', 'wrong-model', 'no-init']) {
    const result = await fixture(mode).run()
    assert.equal(result.ok, false, mode)
    assert.equal(result.failure.category, 'configuration-mismatch', mode)
    assert.equal(result.configuration.matched, false, mode)
    assert.equal(result.session.resumable, false, mode)
    assert.equal(result.cleanup.confirmed, true, mode)
  }
})

test('known model aliases match only their canonical family and full ids match exactly', async () => {
  const f = fixture()
  for (const [model, observed, expected] of [
    ['sonnet', 'claude-sonnet-4-6', true], ['opus', 'claude-opus-9-9', true], ['haiku', 'claude-haiku-4-5', true],
    ['sonnet', 'claude-opus-4-6', false], ['fable', 'claude-fable-1', false],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', true], ['claude-sonnet-4-6', 'claude-sonnet-4-7', false],
    ['fixture-model', 'other-model', false], [undefined, 'native-default-model', true],
  ]) {
    const result = await f.run({ model }, { env: { ...f.env, FAKE_CLAUDE_OBSERVED_MODEL: observed } })
    assert.equal(result.ok, expected, `${String(model)} -> ${observed}`)
    assert.equal(result.configuration.observed.model, observed)
  }
})

test('effort and progress pass through the public API without implying an unobserved effective effort', async () => {
  const f = fixture()
  const progress = []
  const result = await f.run({ effort: 'xhigh' }, { onProgress: text => { progress.push(text); throw new Error('display failed') } })
  assert.equal(result.ok, true)
  assert.equal(result.requested.effort, 'xhigh')
  assert.equal(result.configuration.observed.effort, undefined)
  assert.ok(progress.length > 0)
  const args = f.calls()[0].args
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh')
})

test('bounded terminal output fails closed but preserves separately attributable consumption', async () => {
  const result = await fixture('large-answer').run({ maxOutputBytes: 100 })
  assert.equal(result.ok, false)
  assert.equal(result.failure.category, 'limit')
  assert.equal(result.execution.truncated, true)
  assert.equal(result.execution.terminalReceived, true)
  assert.equal(result.usage.totalTokens, 15)
  assert.deepEqual(result.output, [])
})

test('credentials are explicit, unrelated deployment secrets do not enter the CLI or receipt', async () => {
  const f = fixture()
  const result = await f.run({}, { env: { ...f.env, DEEPSEEK_API_KEY: 'unrelated-secret', DSH_PRIVATE: 'private', ANTHROPIC_API_KEY: 'ambient-key' },
    credentialEnv: { ANTHROPIC_API_KEY: 'explicit-key' } })
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls()[0].env, { ANTHROPIC_API_KEY: 'explicit-key' })
  assert.doesNotMatch(JSON.stringify(result), /unrelated-secret|ambient-key|explicit-key/)
  for (const runtime of [{ onProgress: true }, { signal: {} }, { unsupported: true }, { env: { X: 1 } },
    { credentialEnv: { DEEPSEEK_API_KEY: 'no' } }, { credentialEnv: { ANTHROPIC_API_KEY: '\0' } }]) {
    await assert.rejects(f.run({}, runtime), MachineInputError)
  }
  assert.equal(f.calls().length, 1)
})

test('a leader that exits does not exempt live descendants from cleanup on success or failure', async () => {
  for (const mode of ['descendant-success', 'descendant-failure']) {
    const f = fixture(mode)
    const path = join(f.cwd, 'descendant.pid')
    const result = await f.run({ disposeGraceMs: 25 }, { env: { ...f.env, FAKE_CLAUDE_DESCENDANT_PID: path } })
    const descendant = Number(readFileSync(path, 'utf8'))
    let live = false
    try {
      process.kill(descendant, 0)
      // An orphan zombie cannot execute. Its still-visible group is deliberately
      // not accepted as confirmed cleanup by the public receipt.
      live = process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${descendant}/stat`, 'utf8'))
    } catch (error) { assert.ok(error.code === 'ESRCH' || error.code === 'ENOENT') }
    assert.equal(live, false)
    if (!result.cleanup.confirmed) {
      assert.equal(result.ok, false)
      assert.equal(result.failure.category, 'cleanup-unconfirmed')
      assert.equal(result.session.resumable, false)
    }
    absentProcessGroup(result)
  }
})

test('unsupported operating systems fail before dispatch with no CLI or session claims', async () => {
  const f = fixture()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  let result
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    result = await f.run({ sessionId: UUID })
  } finally { Object.defineProperty(process, 'platform', original) }
  assert.equal(result.failure.category, 'unsupported-runtime')
  assert.equal(result.execution.dispatch, 'not-dispatched')
  assert.equal(result.session.resumed, false)
  assert.deepEqual(f.calls(), [])
})
