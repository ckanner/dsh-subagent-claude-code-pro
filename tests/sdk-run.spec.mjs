import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoverMachine, runMachine } from '../lib/machine.js'
import { runSdkClaude } from '../lib/sdk-run.js'
import { buildSdkQuery } from '../lib/sdk-query.js'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const records = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
function fixture(mode = 'normal') {
  const cwd = makeTempDir('ccpro-sdk-runtime-')
  const calls = join(cwd, 'calls.jsonl'), controls = join(cwd, 'controls.jsonl')
  const request = { protocol: 1, requestId: 'sdk-runtime', cwd, command: makeFakeCommand(),
    prompt: 'private task', model: 'sonnet', effort: 'high', permissionMode: 'dontAsk', sessionMode: 'persistent',
    sessionName: 'SDK session', timeoutMs: 5000, disposeGraceMs: 25 }
  const env = { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: calls, FAKE_CLAUDE_CONTROL_LOG: controls }
  return { request, env, calls, controls, run: (runtime = {}, overrides = {}) => runMachine({ ...request, ...overrides }, { env, ...runtime }) }
}

async function until(predicate) {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('fixture did not reach the expected protocol boundary')
    await pause(10)
  }
}

test('actual official SDK initializes the authoritative local CLI before delivering the user message', async () => {
  const f = fixture()
  const receipt = await f.run()
  assert.equal(receipt.ok, true, JSON.stringify(receipt.failure))
  assert.equal(receipt.cleanup.confirmed, true)
  const init = records(f.controls)
  assert.equal(init.length, 1)
  assert.equal(init[0].type, 'control_request')
  assert.equal(init[0].request.subtype, 'initialize')
  assert.equal(init[0].request.title, 'SDK session')
  assert.equal(init[0].request.forwardSubagentText, true)
  const calls = records(f.calls)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].initialize, init[0].request)
  assert.equal(calls[0].prompt, 'private task')
  assert.equal(calls[0].args.some(arg => arg === '-p' || arg === '--print'), false,
    'the official SDK owns the query transport and initialize request')
  assert.throws(() => process.kill(-receipt.execution.processGroupId, 0), error => error.code === 'ESRCH')
})

test('cancelling SDK initialization sends no user prompt and control traffic creates no activity', async () => {
  const f = fixture('sdk-initialize-hang')
  const activity = [], controller = new AbortController()
  const pending = f.run({ signal: controller.signal, onActivity: event => activity.push(event), onLifecycle() {} })
  await until(() => records(f.controls).length > 0)
  assert.deepEqual(activity, [])
  assert.deepEqual(records(f.calls), [])
  controller.abort()
  const receipt = await pending
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.cancelled, true)
  assert.equal(receipt.execution.terminalReceived, false)
  assert.equal(receipt.session.resumable, false)
  assert.equal(receipt.cleanup.confirmed, true)
  assert.deepEqual(activity, [])
  assert.deepEqual(records(f.calls), [])
})

test('rejected SDK initialize never falls back to an uninitialized raw print request', async () => {
  const f = fixture('sdk-initialize-fail')
  const receipt = await f.run()
  assert.equal(receipt.ok, false)
  assert.equal(receipt.execution.terminalReceived, false)
  assert.equal(receipt.session.resumable, false)
  assert.equal(receipt.cleanup.confirmed, true)
  assert.equal(records(f.controls).length, 1)
  assert.deepEqual(records(f.calls), [])
})

test('the actual initialized CLI must meet the validated version before any task prompt is yielded', async () => {
  for (const version of ['missing', 'unparseable', '2.1.324', '2.1.325-beta.1']) {
    const f = fixture()
    f.env.FAKE_CLAUDE_SDK_VERSION = version
    const receipt = await f.run()
    assert.equal(receipt.ok, false, version)
    assert.equal(receipt.failure.category, 'unsupported-runtime', version)
    assert.match(receipt.failure.detail, /no task prompt was sent/)
    assert.equal(receipt.execution.dispatch, 'dispatched', 'the actual owned process must remain recorded')
    assert.equal(receipt.execution.outcome, 'unknown', 'existing protocol remains conservative about physical dispatch')
    assert.equal(receipt.execution.terminalReceived, false)
    assert.equal(receipt.session.resumable, false)
    assert.equal(receipt.cleanup.confirmed, true)
    assert.equal(records(f.controls).length, 1)
    assert.deepEqual(records(f.calls), [])
  }
  const f = fixture()
  f.env.FAKE_CLAUDE_SDK_VERSION = '2.1.325'
  assert.equal((await f.run()).ok, true)
})

test('SDK cannot turn invalid UTF-8, skipped JSON or an undelimited frame into completion', async () => {
  for (const mode of ['sdk-bad-utf8', 'corrupt-tail', 'partial-line']) {
    const receipt = await fixture(mode).run()
    assert.equal(receipt.ok, false, mode)
    assert.equal(receipt.execution.terminalReceived, false, mode)
    assert.equal(receipt.execution.outcome, 'unknown', mode)
    assert.equal(receipt.usage.status, 'unknown', mode)
    assert.equal(receipt.session.resumable, false, mode)
    assert.equal(receipt.cleanup.confirmed, true, mode)
  }
})

test('a malformed SDK tail cannot preserve terminal, usage or durable completion facts from an earlier result', async () => {
  for (const mode of ['sdk-terminal-tail-success', 'sdk-terminal-tail-failure', 'sdk-terminal-tail-truthy-error', 'sdk-terminal-tail-object-error']) {
    const f = fixture(mode), recoveryDirectory = join(f.request.cwd, 'journal'), lifecycle = []
    const receipt = await f.run({ recoveryDirectory, onLifecycle: event => lifecycle.push(event) })
    assert.equal(receipt.ok, false, mode)
    assert.equal(receipt.failure.category, 'protocol', mode)
    assert.equal(receipt.execution.outcome, 'unknown', mode)
    assert.equal(receipt.execution.terminalReceived, false, mode)
    assert.equal(receipt.execution.turnDispatch, 'possible', mode)
    assert.equal(receipt.usage.status, 'unknown', mode)
    assert.equal(receipt.usage.totalTokens, null, mode)
    assert.equal(receipt.reportedCostUSD, null, mode)
    assert.equal(receipt.session.resumable, false, mode)
    assert.deepEqual(receipt.output, [], mode)
    assert.equal(receipt.cleanup.confirmed, true, mode)
    assert.throws(() => process.kill(-receipt.execution.processGroupId, 0), error => error.code === 'ESRCH')
    assert.equal(lifecycle.find(event => event.event === 'terminal').outcome, 'unknown', mode)
    assert.equal(lifecycle.at(-1).outcome, 'unknown', mode)
    const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory })
    assert.deepEqual(recovered.receipt, receipt, mode)
    assert.equal(recovered.lifecycle.outcome, 'unknown', mode)
  }
})

test('the SDK expected failed-exit rejection preserves an intact native failure and its measured usage', async () => {
  for (const [mode, category] of [['auth-fail', 'auth'], ['limit', 'limit'], ['sdk-empty-failure', 'product-error'], ['resume-missing', 'resume']]) {
    const f = fixture(mode), recoveryDirectory = join(f.request.cwd, 'journal')
    const receipt = await f.run({ recoveryDirectory, onLifecycle() {} }, mode === 'resume-missing'
      ? { sessionName: undefined, sessionId: '33333333-3333-4333-8333-333333333333' } : {})
    assert.equal(receipt.ok, false, mode)
    assert.equal(receipt.failure.category, category, mode)
    assert.equal(receipt.execution.outcome, 'failed', mode)
    assert.equal(receipt.execution.terminalReceived, true, mode)
    assert.equal(receipt.execution.exitCode, 1, mode)
    assert.equal(receipt.execution.turnDispatch, 'accepted', mode)
    assert.equal(receipt.usage.status, 'complete', mode)
    assert.equal(receipt.usage.totalTokens, mode === 'resume-missing' ? 22 : 15, mode)
    assert.equal(receipt.reportedCostUSD, 0.001, mode)
    assert.equal(receipt.cleanup.confirmed, true, mode)
    const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory })
    assert.deepEqual(recovered.receipt, receipt, mode)
    assert.equal(recovered.lifecycle.outcome, 'failed', mode)
  }
})

test('a synchronous SDK child spawn rejection retains no-dispatch evidence and cleans no invented group', async () => {
  const query = buildSdkQuery({ session: { kind: 'ephemeral' }, permissionMode: 'dontAsk', text: 'unused' })
  await assert.rejects(runSdkClaude({ query, command: 'invalid\0command', cwd: makeTempDir(), env: process.env }), error => {
    assert.equal(error.facts.category, 'spawn')
    assert.equal(error.run.execution.dispatch, 'not-dispatched')
    assert.equal(error.run.execution.pid, null)
    assert.equal(error.run.cleanupConfirmed, true)
    return true
  })
})
