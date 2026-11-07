import test from 'node:test'
import assert from 'node:assert/strict'

import { buildArguments } from '../lib/cli.js'
import { userMessageLine } from '../lib/protocol.js'
import { runLocalClaude as runClaude } from '../lib/run-local.js'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'

const UUID = '22222222-2222-4222-8222-222222222222'
process.env.DSH_HOME = makeTempDir('ccpro-home-run-')

function fakeRun(overrides = {}) {
  const command = overrides.command ?? makeFakeCommand()
  const cwd = overrides.cwd ?? makeTempDir('ccpro-cwd-')
  return runClaude({
    command,
    args: buildArguments({
      session: overrides.session ?? { kind: 'new', sessionId: UUID },
      permissionMode: 'dontAsk',
    }),
    cwd,
    env: { ...process.env, ...overrides.env },
    input: userMessageLine({ text: overrides.prompt ?? 'hello' }),
    timeoutMs: overrides.timeoutMs ?? 20_000,
    signal: overrides.signal,
  })
}

test('a successful run returns the final answer, session id and usage', async () => {
  const result = await fakeRun({ prompt: 'remember 42' })
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.text, 'echo:remember 42')
  assert.equal(result.sessionId, UUID)
  assert.equal(result.init.cliVersion, '9.9.9-fake')
  assert.equal(result.init.model, 'fake-model')
  assert.equal(result.usage.output_tokens, 5)
  assert.equal(result.cleanupConfirmed, true)
})

test('a hanging run is cancelled by its deadline and says so', async () => {
  const started = Date.now()
  await assert.rejects(
    fakeRun({ env: { FAKE_CLAUDE_MODE: 'hang' }, timeoutMs: 300 }),
    (error) => {
      assert.equal(error.facts.category, 'timeout')
      assert.match(error.message, /deadline/)
      return true
    },
  )
  assert.ok(Date.now() - started < 10_000)
})

test('caller cancellation settles as aborted, not as a failure', async () => {
  const controller = new AbortController()
  const running = fakeRun({ env: { FAKE_CLAUDE_MODE: 'hang' }, signal: controller.signal })
  setTimeout(() => controller.abort(), 200)
  const result = await running
  assert.equal(result.stopReason, 'aborted')
})

test('an authentication failure is classified as auth and keeps the CLI text', async () => {
  await assert.rejects(
    fakeRun({ env: { FAKE_CLAUDE_MODE: 'auth-fail' } }),
    (error) => {
      assert.equal(error.facts.category, 'auth')
      assert.match(error.message, /authenticate/i)
      return true
    },
  )
})

test('a missing executable is a spawn failure with actionable text', async () => {
  await assert.rejects(
    fakeRun({ command: '/nonexistent/claude-code-pro-test' }),
    (error) => {
      assert.equal(error.facts.category, 'spawn')
      assert.match(error.message, /cannot start/)
      return true
    },
  )
})

test('a run with no result message fails closed', async () => {
  await assert.rejects(
    fakeRun({ env: { FAKE_CLAUDE_MODE: 'no-result' } }),
    (error) => {
      assert.equal(error.facts.category, 'invalid-result')
      return true
    },
  )
})

test('unparseable output fails closed as a protocol problem', async () => {
  await assert.rejects(
    fakeRun({ env: { FAKE_CLAUDE_MODE: 'garbage' } }),
    (error) => {
      assert.equal(error.facts.category, 'invalid-result')
      return true
    },
  )
})

test('a missing resumed session is classified as a resume failure', async () => {
  await assert.rejects(
    fakeRun({
      session: { kind: 'resume', resumeId: UUID },
      env: { FAKE_CLAUDE_MODE: 'resume-missing' },
    }),
    (error) => {
      assert.equal(error.facts.category, 'resume')
      return true
    },
  )
})
