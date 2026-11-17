import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runInteractiveTeam, runMachine } from 'dsh-subagent-claude-code-pro/machine'
import { apply } from '../lib/index.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

process.env.DSH_HOME = makeTempDir('ccpro-home-history-')

const UUID = '22222222-2222-4222-8222-222222222222'
function fixture(value) {
  const cwd = makeTempDir('ccpro-history-'), log = join(cwd, 'calls'), helpLog = join(cwd, 'help-calls')
  const request = { protocol: 1, requestId: 'history', cwd, command: makeFakeCommand(), prompt: 'history fixture',
    permissionMode: 'dontAsk', sessionMode: 'persistent', timeoutMs: 10000 }
  const env = { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HELP_LOG: helpLog,
    FAKE_CLAUDE_STATE: join(cwd, 'history'), CLAUDE_CODE_SKIP_PROMPT_HISTORY: value }
  return { cwd, log, helpLog, request, env }
}

function assertNoDispatch(receipt, f) {
  assert.equal(receipt.ok, false)
  assert.equal(receipt.failure.category, 'invalid-request')
  assert.match(receipt.failure.detail, /CLAUDE_CODE_SKIP_PROMPT_HISTORY/)
  assert.equal(receipt.execution.dispatch, 'not-dispatched')
  assert.equal(receipt.execution.turnDispatch, 'not-dispatched')
  assert.equal(receipt.execution.outcome, 'not-started')
  assert.equal(receipt.execution.pid, null)
  assert.deepEqual(receipt.cleanup, { confirmed: true, method: 'not-started' })
  assert.equal(existsSync(f.log), false)
  assert.equal(existsSync(f.helpLog), false)
}

test('persistent machine creation and resume reject a native history opt-out before any CLI probe', async () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TrUe ']) {
    for (const sessionId of [undefined, UUID]) {
      const f = fixture(value)
      const receipt = await runMachine({ ...f.request, ...(sessionId ? { sessionId } : {}) }, { env: f.env })
      assertNoDispatch(receipt, f)
      assert.equal(receipt.session.id, null)
      assert.equal(receipt.session.resumed, false)
      assert.equal(receipt.session.resumable, false)
      assert.equal(f.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, value)
    }
  }
})

test('false and unrecognized native boolean values allow persistent sessions', async () => {
  for (const value of ['', '0', 'false', 'no', 'off', ' FALSE ', 'disabled']) {
    const f = fixture(value)
    const receipt = await runMachine(f.request, { env: f.env })
    assert.equal(receipt.ok, true, JSON.stringify(receipt))
    assert.equal(receipt.session.resumable, true)
    assert.equal(JSON.parse(readFileSync(f.log, 'utf8').trim()).env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, value)
    assert.equal(f.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, value)
  }
})

test('a persistent session name cannot masquerade as the ephemeral flag', async () => {
  const f = fixture('1')
  const receipt = await runMachine({ ...f.request, sessionName: '--no-session-persistence' }, { env: f.env })
  assertNoDispatch(receipt, f)
})

test('explicit ephemeral machine work preserves the history opt-out and stays non-resumable', async () => {
  const f = fixture('1')
  const receipt = await runMachine({ ...f.request, sessionMode: 'ephemeral' }, { env: f.env })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.session.resumable, false)
  const call = JSON.parse(readFileSync(f.log, 'utf8').trim())
  assert.ok(call.args.includes('--no-session-persistence'))
  assert.equal(call.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1')
  assert.equal(f.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1')
})

test('the DSH tool rejects persistent and resumed queries but accepts an explicit ephemeral call', async () => {
  for (const sessionMode of ['session', 'persistent']) {
    const f = fixture('yes'), { ctx, emit } = makeContext(), { agent, tools } = makeAgent(f.cwd)
    apply(ctx, { command: f.request.command, presets: ['daily'], sessionMode, permissionMode: 'dontAsk', env: f.env })
    emit('agent/created', { agent })
    for (const session_id of [undefined, UUID]) {
      await assert.rejects(tools[0].execute({ description: 'history fixture', prompt: 'task', ...(session_id ? { session_id } : {}) }, {}), error => {
        assert.equal(error.facts.category, 'invalid-request')
        assert.equal(error.run.execution.dispatch, 'not-dispatched')
        assert.equal(error.run.cleanupConfirmed, true)
        return true
      })
      assert.equal(existsSync(f.log), false)
      assert.equal(existsSync(f.helpLog), false)
    }
    const ephemeral = await tools[0].execute({ description: 'history fixture', prompt: 'task', session_mode: 'ephemeral' }, {})
    const text = ephemeral.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.doesNotMatch(text, /claude-code session/)
    assert.match(text, /echo:task/)
    assert.equal(JSON.parse(readFileSync(f.log, 'utf8').trim()).env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, 'yes')
    assert.equal(f.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, 'yes')
  }
})

test('independent interactive teams reject disabled history before tmux or native dispatch', async () => {
  const f = fixture('on')
  const receipt = await runInteractiveTeam({ protocol: 1, requestId: 'history-team', cwd: f.cwd, command: f.request.command,
    tmuxCommand: '/nonexistent-history-guard-tmux', prompt: 'history fixture', permissionMode: 'acceptEdits' },
  { env: f.env, recoveryDirectory: join(f.cwd, 'journal') })
  assertNoDispatch(receipt, f)
})
