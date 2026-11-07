import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

process.env.DSH_HOME = makeTempDir('ccpro-home-plugin-')

function setup(overrides = {}) {
  const command = overrides.command ?? makeFakeCommand()
  const state = overrides.state ?? makeTempDir('ccpro-state-')
  const logDir = makeTempDir('ccpro-log-')
  const log = join(logDir, 'spawn.log')
  const { ctx, emit } = makeContext()
  apply(ctx, {
    command,
    presets: overrides.presets ?? ['daily'],
    sessionMode: overrides.sessionMode ?? 'session',
    permissionMode: overrides.permissionMode ?? 'dontAsk',
    modelSelection: overrides.modelSelection ?? true,
    runTimeoutMs: overrides.runTimeoutMs ?? 20_000,
    env: {
      FAKE_CLAUDE_MODE: overrides.mode ?? 'normal',
      FAKE_CLAUDE_STATE: state,
      FAKE_CLAUDE_LOG: log,
      ...(overrides.env ?? {}),
    },
  })
  const { agent, tools } = makeAgent(makeTempDir('ccpro-cwd-'), { preset: overrides.preset ?? 'daily' })
  emit('agent/created', { agent })
  return { agent, tools, emit, log, state }
}

function spawnLog(logPath) {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function textOf(result) {
  return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

function sessionIdOf(text) {
  const match = /\[claude-code session ([0-9a-f-]{36})/.exec(text)
  return match?.[1]
}

async function execute(tool, args) {
  return tool.execute(
    { description: 'probe', prompt: 'hello', ...args },
    { signal: new AbortController().signal },
  )
}

test('registers the official tool name with the pro schema', () => {
  const { tools } = setup()
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'subagent_claude_code')
  assert.ok(tool.parameters.properties.prompt)
  assert.ok(tool.parameters.properties.model)
  assert.ok(tool.parameters.properties.reasoning_effort)
  assert.ok(tool.parameters.properties.session_mode)
  assert.ok(tool.parameters.properties.session_id)
  assert.equal(tool.parameters.additionalProperties, false)
})

test('session mode reuses one Claude Code session across delegations', async () => {
  const { tools } = setup({ sessionMode: 'session' })
  const first = textOf(await execute(tools[0], { prompt: 'remember 42' }))
  assert.match(first, /echo:remember 42/)
  const firstId = sessionIdOf(first)
  assert.ok(firstId)

  const second = textOf(await execute(tools[0], { prompt: 'what next' }))
  assert.match(second, /prior:remember 42\|echo:what next/)
  assert.equal(sessionIdOf(second), firstId)
})

test('ephemeral runs write nothing resumable', async () => {
  const { tools, log } = setup()
  const text = textOf(await execute(tools[0], { prompt: 'throwaway', session_mode: 'ephemeral' }))
  assert.doesNotMatch(text, /claude-code session/)
  const runs = spawnLog(log)
  assert.ok(runs.at(-1).args.includes('--no-session-persistence'))
  assert.ok(!runs.at(-1).args.includes('--session-id'))
})

test('an explicit session id continues that session and is forwarded as --resume', async () => {
  const { tools, log } = setup({ sessionMode: 'persistent' })
  const first = textOf(await execute(tools[0], { prompt: 'remember alpha' }))
  const id = sessionIdOf(first)
  assert.ok(id)
  const second = textOf(await execute(tools[0], { prompt: 'next', session_id: id }))
  assert.match(second, /prior:remember alpha/)
  const runs = spawnLog(log)
  assert.ok(runs.at(-1).args.includes('--resume'))
  assert.ok(runs.at(-1).args.includes(id))
})

test('model and effort are forwarded per call', async () => {
  const { tools, log } = setup()
  await execute(tools[0], { model: 'haiku', reasoning_effort: 'low' })
  const run = spawnLog(log).at(-1)
  assert.deepEqual(run.args.slice(run.args.indexOf('--model'), run.args.indexOf('--model') + 2), ['--model', 'haiku'])
  assert.deepEqual(run.args.slice(run.args.indexOf('--effort'), run.args.indexOf('--effort') + 2), ['--effort', 'low'])
})

test('a call may not widen the configured permission mode', async () => {
  const { tools } = setup({ permissionMode: 'dontAsk' })
  await assert.rejects(
    execute(tools[0], { permission_mode: 'acceptEdits' }),
    /permission_mode must be one of/,
  )
})

test('presets that are not served get no tool', () => {
  const { tools } = setup({ preset: 'other', presets: ['daily'] })
  assert.equal(tools.length, 0)
})

test('an authentication failure reaches the caller with actionable text', async () => {
  const { tools } = setup({ mode: 'auth-fail' })
  await assert.rejects(execute(tools[0], { prompt: 'x' }), /authenticate/i)
})

test('a stale remembered session is repaired by starting a fresh one', async () => {
  const { tools, log } = setup({ mode: 'resume-missing' })
  const first = textOf(await execute(tools[0], { prompt: 'first' }))
  const firstId = sessionIdOf(first)
  assert.ok(firstId)

  const second = textOf(await execute(tools[0], { prompt: 'second' }))
  const secondId = sessionIdOf(second)
  assert.ok(secondId)
  assert.notEqual(secondId, firstId)
  assert.match(second, /echo:second/)
  const runs = spawnLog(log)
  assert.equal(runs.length, 3)
  assert.ok(runs[1].args.includes('--resume'))
  assert.ok(!runs[2].args.includes('--resume'))
})

test('a delegation deadline cancels the run and is reported', async () => {
  const { tools } = setup({ mode: 'hang', runTimeoutMs: 300 })
  await assert.rejects(execute(tools[0], { prompt: 'x' }), /deadline/)
})

test('fork_session requires a session_id', async () => {
  const { tools } = setup()
  await assert.rejects(execute(tools[0], { fork_session: true }), /requires `session_id`/)
})

test('an invalid cwd is refused before anything is spawned', async () => {
  const { tools, log } = setup()
  await assert.rejects(execute(tools[0], { cwd: '/nonexistent/ccpro-cwd' }), /does not exist/)
  assert.equal(spawnLog(log).length, 0)
})
