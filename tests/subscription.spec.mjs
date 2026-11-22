import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectSubscription, parseMachineRequest, runMachine, recoverMachine, MACHINE_SUBSCRIPTION_CAPABILITIES } from '../lib/machine.js'
import { observeSubscription, validUsageResponse } from '../lib/subscription.js'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'

const policy = { version: 1, mode: 'subscription-only' }
const records = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const usage = () => ({ session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
  total_lines_added: 0, total_lines_removed: 0, model_usage: {} }, subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null } }, behaviors: null })
function fixture(t, overrides = {}) {
  const cwd = makeTempDir('ccpro-subscription-')
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const calls = join(cwd, 'calls'), sequence = join(cwd, 'sequence'), help = join(cwd, 'help')
  const request = { protocol: 1, requestId: 'subscription', command: makeFakeCommand(), cwd, prompt: 'private fixture task',
    permissionMode: 'dontAsk', sessionMode: 'ephemeral', model: 'fable', effort: 'high', subscription: policy,
    timeoutMs: 4000, disposeGraceMs: 25, ...overrides }
  const env = { PATH: process.env.PATH, HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config'),
    FAKE_CLAUDE_LOG: calls, FAKE_CLAUDE_SEQUENCE_LOG: sequence, FAKE_CLAUDE_HELP_LOG: help }
  return { request, env, calls, sequence, help,
    run: (runtime = {}, changes = {}) => runMachine({ ...request, ...changes }, { env, ...runtime }) }
}

test('subscription request is opt-in, versioned and cannot accept caller billing attestations', t => {
  const f = fixture(t)
  assert.deepEqual(parseMachineRequest(f.request).subscription, policy)
  assert.equal(MACHINE_SUBSCRIPTION_CAPABILITIES.sameProcessBeforePrompt, true)
  for (const subscription of [null, {}, { ...policy, extraUsageEnabled: false }, { ...policy, verified: true }, { ...policy, version: 2 }]) {
    assert.throws(() => parseMachineRequest({ ...f.request, subscription }), /subscription/)
  }
})

test('actual pinned SDK checks native billing before its only prompt, resolving Fable and retaining sanitized evidence', async t => {
  const f = fixture(t)
  f.env.FAKE_CLAUDE_ACCOUNT = JSON.stringify({ apiProvider: 'firstParty', subscriptionType: 'pro', email: 'secret@example.test', organization: 'private-org' })
  const limits = usage(); limits.rate_limits.extra_usage.used_credits = 123456
  f.env.FAKE_CLAUDE_USAGE = JSON.stringify(limits)
  const receipt = await f.run()
  assert.equal(receipt.ok, true, JSON.stringify(receipt.failure))
  const steps = records(f.sequence)
  assert.deepEqual(steps.map(s => s.subtype ?? s.type), ['initialize', 'get_usage', 'user'])
  assert.equal(new Set(steps.map(s => s.pid)).size, 1)
  assert.equal(steps[1].skipBehaviors, true)
  assert.equal(records(f.calls).length, 1)
  assert.equal(receipt.requested.model, 'fable')
  assert.equal(receipt.subscription.resolvedModel, 'claude-fable-5-2')
  assert.equal(receipt.subscription.status, 'verified')
  assert.equal(receipt.subscription.extraUsageEnabled, false)
  assert.equal(receipt.subscription.subscriptionType, 'pro')
  assert.equal(receipt.subscription.scope, 'pre-prompt-snapshot')
  assert.ok(Number.isFinite(Date.parse(receipt.subscription.checkedAt)))
  assert.equal(receipt.costUSD, null)
  assert.doesNotMatch(JSON.stringify(receipt), /secret@example|private-org|123456|used_credits|monthly_limit/)
})

test('enabled, missing and malformed extra usage all refuse before a user message', async t => {
  const mutations = [
    x => { x.rate_limits.extra_usage.is_enabled = true },
    x => { delete x.rate_limits.extra_usage },
    x => { x.rate_limits.extra_usage = null },
    x => { x.rate_limits.extra_usage.is_enabled = 'false' },
    x => { delete x.rate_limits.extra_usage.used_credits },
    x => { x.rate_limits_available = false; x.rate_limits = null },
    x => { x.subscription_type = 'max' },
    x => { delete x.session },
    x => { delete x.behaviors },
    x => { x.extra_usage = { is_enabled: false } },
  ]
  for (const mutate of mutations) {
    const f = fixture(t), value = usage(); mutate(value)
    f.env.FAKE_CLAUDE_USAGE = JSON.stringify(value)
    const lifecycle = []
    const result = await f.run({ onLifecycle: event => lifecycle.push(event) })
    assert.equal(result.ok, false)
    assert.notEqual(result.subscription.status, 'verified')
    assert.equal(result.execution.turnDispatch, 'not-dispatched')
    assert.equal(result.cleanup.confirmed, true)
    assert.equal(result.output.length, 0)
    assert.equal(result.costUSD, null)
    assert.equal(result.usage.status, 'unknown')
    assert.deepEqual(records(f.calls), [])
    assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize', 'get_usage'])
    assert.equal(lifecycle.at(-1).dispatch, 'not-dispatched')
  }
})

test('external or unobservable native accounts are rejected without even a usage query', async t => {
  for (const account of [{}, { apiProvider: 'gateway', subscriptionType: 'pro' }, { apiProvider: 'firstParty' },
    { apiProvider: 'firstParty', subscriptionType: 'future-plan' }]) {
    const f = fixture(t); f.env.FAKE_CLAUDE_ACCOUNT = JSON.stringify(account)
    const result = await f.run()
    assert.equal(result.subscription.status, 'blocked')
    assert.equal(result.execution.turnDispatch, 'not-dispatched')
    assert.deepEqual(records(f.calls), [])
    assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize'])
  }
})

test('durable recovery preserves a pre-prompt billing rejection and cannot replay it', async t => {
  const f = fixture(t), value = usage()
  value.rate_limits.extra_usage.is_enabled = true
  f.env.FAKE_CLAUDE_USAGE = JSON.stringify(value)
  const recoveryDirectory = join(f.request.cwd, 'journal')
  const result = await f.run({ recoveryDirectory, onLifecycle() {} })
  const recovered = await recoverMachine({ protocol: 1, requestId: result.requestId, runId: result.runId, recoveryDirectory })
  assert.equal(recovered.status, 'terminal')
  assert.deepEqual(recovered.receipt, result)
  assert.equal(recovered.receipt.execution.turnDispatch, 'not-dispatched')
  assert.equal(recovered.receipt.subscription.extraUsageEnabled, true)
  assert.deepEqual(records(f.calls), [])
})

test('native usage errors and deadline cancellation never trigger fallback or expose raw diagnostics', async t => {
  for (const mode of ['sdk-usage-error', 'sdk-usage-hang']) {
    const f = fixture(t, { timeoutMs: mode === 'sdk-usage-hang' ? 1200 : 4000 })
    f.env.FAKE_CLAUDE_MODE = mode
    const result = await f.run()
    assert.equal(result.ok, false)
    assert.equal(result.subscription.status, 'unknown')
    assert.equal(result.execution.turnDispatch, 'not-dispatched')
    assert.equal(result.cleanup.confirmed, true)
    assert.deepEqual(records(f.calls), [])
    assert.equal(records(f.sequence).filter(s => s.subtype === 'get_usage').length, 1)
    assert.doesNotMatch(JSON.stringify(result), /private account diagnostic/)
  }
})

test('explicit API credentials, provider selectors and overriding effort stop before even the help process', async t => {
  for (const runtime of [{ credentialEnv: { ANTHROPIC_API_KEY: 'private-secret' } },
    { credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'explicit-token' } },
    { credentialEnv: { ANTHROPIC_BASE_URL: 'https://private-gateway.invalid' } }]) {
    const f = fixture(t), result = await f.run(runtime)
    assert.equal(result.ok, false)
    assert.equal(result.execution.dispatch, 'not-dispatched')
    assert.deepEqual(records(f.help), [])
    assert.doesNotMatch(JSON.stringify(result), /private-secret|explicit-token|private-gateway/)
  }
  for (const override of [{ CLAUDE_CODE_USE_VERTEX: '1' }, { CLAUDE_CODE_EFFORT_LEVEL: 'low' }]) {
    const f = fixture(t); Object.assign(f.env, override)
    const result = await f.run()
    assert.equal(result.ok, false)
    assert.deepEqual(records(f.help), [])
  }
  const f = fixture(t)
  f.env.ANTHROPIC_API_KEY = 'ambient-never-inherited'
  assert.equal((await f.run()).ok, true)
  assert.equal(records(f.calls)[0].env.ANTHROPIC_API_KEY, undefined)
})

test('selected native settings cannot hide fallback, credentials, fast mode or effort clamps', async t => {
  for (const setting of [{ apiKeyHelper: 'do-not-run-this' }, { fallbackModel: ['sonnet'] }, { fastMode: true },
    { forceLoginMethod: 'console' }, { env: { ANTHROPIC_BASE_URL: 'private-value' } },
    { env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } }, { maxEffortLevel: 'medium' },
    { modelSettings: { 'claude-fable-5-2': { maxEffortLevel: 'medium' } } }]) {
    const f = fixture(t)
    mkdirSync(f.env.CLAUDE_CONFIG_DIR); writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(setting))
    const result = await f.run()
    assert.equal(result.ok, false, JSON.stringify(setting))
    assert.equal(result.subscription.status, 'blocked')
    assert.deepEqual(records(f.help), [])
    assert.doesNotMatch(JSON.stringify(result), /do-not-run-this|private-value/)
  }
})

test('native model capabilities reject unsupported effort before billing lookup or prompt delivery', async t => {
  const f = fixture(t, { effort: 'xhigh' })
  f.env.FAKE_CLAUDE_MODELS = JSON.stringify([{ value: 'fable', resolvedModel: 'claude-fable-5-2',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }])
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(result.execution.turnDispatch, 'not-dispatched')
  assert.match(result.failure.detail, /does not support the requested effort/)
  assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize'])
})

test('canonical aliases freeze before dispatch and root observations catch every observed switch', async t => {
  const f = fixture(t)
  f.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5-1'
  f.env.FAKE_CLAUDE_ROOT_MODELS = JSON.stringify(['claude-fable-5-2'])
  const result = await f.run()
  assert.equal(result.subscription.resolvedModel, 'claude-fable-5-1')
  assert.equal(result.ok, false)
  assert.equal(result.configuration.modelEvidence.rootMatched, false)
  assert.deepEqual(result.configuration.modelEvidence.rootModels, ['claude-fable-5-2', 'claude-fable-5-1'])
  assert.equal(records(f.calls).length, 1, 'no fallback retry')
  const missing = fixture(t); missing.env.FAKE_CLAUDE_NO_MODEL = '1'
  assert.equal((await missing.run()).ok, false, 'subscription success needs actual root model evidence')
})

test('cumulative modelUsage is observation of history/auxiliary models, never a current root switch or actual charge', async t => {
  const f = fixture(t)
  f.env.FAKE_CLAUDE_MODEL_USAGE = JSON.stringify({ 'claude-opus-4-6': {}, 'claude-haiku-5-5': {}, 'claude-fable-5-2': {} })
  const result = await f.run()
  assert.equal(result.ok, true, JSON.stringify(result.failure))
  const evidence = result.configuration.modelEvidence
  assert.deepEqual(evidence.usageModels, ['claude-opus-4-6', 'claude-haiku-5-5', 'claude-fable-5-2'])
  assert.equal(evidence.usageScope, 'native-cumulative-including-history-and-auxiliary')
  assert.equal(evidence.wholeRunVerified, false)
  assert.equal(evidence.rootMatched, true)
  assert.equal(result.costUSD, null)
})

test('public inspection and doctor share exact SDK preflight without sending a task prompt', async t => {
  const f = fixture(t)
  const input = { protocol: 1, requestId: 'inspection', command: f.request.command, cwd: f.request.cwd, model: 'fable', effort: 'high' }
  const result = await inspectSubscription(input, { env: f.env })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.promptDispatched, false)
  assert.equal(result.cleanup.confirmed, true)
  assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize', 'get_usage'])
  assert.deepEqual(records(f.calls), [])
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url)),
    '--subscription-only', '--model', 'fable', '--effort', 'high', '--cwd', f.request.cwd], {
    cwd: f.request.cwd, env: { ...f.env, CLAUDE_PRO_COMMAND: f.request.command }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /No task prompt or model request was submitted/)
  assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize', 'get_usage', 'initialize', 'get_usage'])
  assert.deepEqual(records(f.calls), [])
})

test('without subscription the existing explicit credential path remains usable and makes no usage probe', async t => {
  const f = fixture(t)
  f.env.FAKE_CLAUDE_ACCOUNT = JSON.stringify({ apiProvider: 'gateway' })
  const result = await f.run({ credentialEnv: { ANTHROPIC_API_KEY: 'explicit-compatible' } }, { subscription: undefined })
  assert.equal(result.ok, true, JSON.stringify(result.failure))
  assert.equal(result.subscription, undefined)
  assert.equal(records(f.calls)[0].env.ANTHROPIC_API_KEY, 'explicit-compatible')
  assert.deepEqual(records(f.sequence).map(s => s.subtype ?? s.type), ['initialize', 'user'])
})

test('unsupported SDK controls and response versions never fabricate verified billing', async () => {
  assert.equal(validUsageResponse(usage()), true)
  assert.equal(validUsageResponse({ ...usage(), new_contract: true }), false)
  const prior = usage()
  prior.session.model_usage['claude-opus-5-5'] = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.001, contextWindow: 1000000,
    maxOutputTokens: 64000, thinkingTokens: 1, provider: 'firstParty', canonicalModel: 'claude-opus-5-5', costBasis: 'list' }
  assert.equal(validUsageResponse(prior), true)
  prior.session.model_usage['claude-opus-5-5'].costBasis = 'future-contract'
  assert.equal(validUsageResponse(prior), false)
  const result = await observeSubscription({ accountInfo() {} }, {})
  assert.equal(result.status, 'unknown')
  assert.match(result.diagnostic, /unavailable/)
})
