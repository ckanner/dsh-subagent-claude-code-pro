import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

process.env.DSH_HOME = makeTempDir('ccpro-home-plugin-')

function setup(overrides = {}) {
  const command = overrides.command ?? makeFakeCommand()
  const state = overrides.state ?? makeTempDir('ccpro-state-')
  const logDir = makeTempDir('ccpro-log-')
  const log = join(logDir, 'spawn.log')
  const { ctx, emit } = makeContext(overrides.services ?? {})
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
  const cwd = makeTempDir('ccpro-cwd-')
  const { agent, tools } = makeAgent(cwd, {
    preset: overrides.preset ?? 'daily',
    ...(overrides.requestHeader === undefined ? {} : { requestHeader: overrides.requestHeader }),
  })
  emit('agent/created', { agent })
  return { agent, tools, emit, log, state, cwd }
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

test('persistent configured calls create independent sessions unless a resume id is explicit', async () => {
  const { tools, log } = setup({ sessionMode: 'persistent' })
  const first = textOf(await execute(tools[0], { prompt: 'first task' }))
  const second = textOf(await execute(tools[0], { prompt: 'second task' }))
  assert.notEqual(sessionIdOf(first), sessionIdOf(second))
  assert.doesNotMatch(second, /prior:first task/)
  assert.equal(spawnLog(log).filter(run => run.args.includes('--resume')).length, 0)
})

test('an explicit per-call persistent mode overrides implicit conversation reuse', async () => {
  const { tools } = setup({ sessionMode: 'session' })
  const first = textOf(await execute(tools[0], { prompt: 'conversation task' }))
  const second = textOf(await execute(tools[0], { prompt: 'independent task', session_mode: 'persistent' }))
  assert.notEqual(sessionIdOf(first), sessionIdOf(second))
  assert.doesNotMatch(second, /prior:conversation task/)
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

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Write a temporary file and return its absolute path. */
function writeTemp(name, bytes) {
  const directory = makeTempDir('ccpro-file-')
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

test('images travel as model-native image blocks', async () => {
  const image = writeTemp('shot.png', TINY_PNG)
  const { tools, log } = setup()
  await execute(tools[0], { prompt: 'look at this', images: [image] })
  const run = spawnLog(log).at(-1)
  const block = run.userContent.find((item) => item.type === 'image')
  assert.ok(block)
  assert.equal(block.source.type, 'base64')
  assert.equal(block.source.media_type, 'image/png')
})

test('a missing image fails before anything is spawned', async () => {
  const { tools, log } = setup()
  await assert.rejects(
    execute(tools[0], { prompt: 'x', images: ['/nonexistent/picture.png'] }),
    /does not exist/,
  )
  assert.equal(spawnLog(log).length, 0)
})

test('an unsupported attachment type is refused', async () => {
  const file = writeTemp('notes.txt', Buffer.from('hello'))
  const { tools } = setup()
  await assert.rejects(execute(tools[0], { prompt: 'x', images: [file] }), /unsupported image type/)
})

test('PDF documents travel as document blocks', async () => {
  const pdf = writeTemp('spec.pdf', Buffer.from('%PDF-1.4\nfake pdf bytes\n%%EOF\n'))
  const { tools, log } = setup()
  await execute(tools[0], { prompt: 'read the pdf', documents: [pdf] })
  const run = spawnLog(log).at(-1)
  const block = run.userContent.find((item) => item.type === 'document')
  assert.ok(block)
  assert.equal(block.source.media_type, 'application/pdf')
})

test('tool-result images are delivered as attachment blocks', async () => {
  const attachments = {
    saveImages: async (payloads) => payloads.map((payload, index) => ({
      attachmentId: `att-${index}`,
      mediaType: payload.mediaType,
      bytes: payload.data.length,
      width: 1,
      height: 1,
    })),
  }
  const { tools } = setup({ mode: 'image-output', services: { attachments } })
  const result = await execute(tools[0], { prompt: 'take a screenshot' })
  const image = result.content.find((block) => block.type === 'image')
  assert.ok(image)
  assert.equal(image.attachment.attachmentId, 'att-0')
  assert.match(textOf(result), /image captured/)
})

test('images are withheld from a text-only parent route', async () => {
  const attachments = { saveImages: async () => [{ attachmentId: 'att-x' }] }
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  const { tools } = setup({
    mode: 'image-output',
    services: { attachments, llm },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'text-only' } }),
  })
  const result = await execute(tools[0], { prompt: 'take a screenshot' })
  assert.ok(!result.content.some((block) => block.type === 'image'))
  assert.match(textOf(result), /not delivered: this model route declares no image input/)
})

test('an image with no attachment store becomes a text note', async () => {
  const { tools } = setup({ mode: 'image-output' })
  const result = await execute(tools[0], { prompt: 'take a screenshot' })
  assert.ok(!result.content.some((block) => block.type === 'image'))
  assert.match(textOf(result), /not delivered: no attachment store is mounted/)
})

test('output_schema returns validated JSON and no session marker', async () => {
  const { tools } = setup()
  const result = await execute(tools[0], {
    prompt: 'answer',
    output_schema: {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    },
  })
  const text = textOf(result)
  assert.deepEqual(JSON.parse(text), { answer: 42 })
  assert.doesNotMatch(text, /claude-code session/)
})

test('a schema-constrained answer that is not JSON fails closed', async () => {
  const { tools } = setup({ mode: 'bad-structured' })
  await assert.rejects(
    execute(tools[0], { prompt: 'x', output_schema: { type: 'object' } }),
    /non-JSON/,
  )
})

test('run_in_background returns a DSH job id and completes with text', async () => {
  const jobs = {
    started: [],
    start(spec) {
      this.started.push(spec)
      return 'job-42'
    },
  }
  const { tools } = setup({ services: { jobs } })
  const value = await execute(tools[0], { prompt: 'background work', run_in_background: true })
  assert.deepEqual(value, { kind: 'background', jobId: 'job-42' })
  const spec = jobs.started[0]
  assert.equal(spec.kind, 'subagent')
  assert.equal(spec.label, 'probe')
  assert.equal(spec.owner, 'agent-1')
  const handle = { appended: '', append(text) { this.appended += text }, updateProgress() {} }
  const work = spec.run(handle)
  const outcome = await work.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /echo:background work/)
})

test('background images are reported as host paths in the job text', async () => {
  const jobs = { started: [], start(spec) { this.started.push(spec); return 'job-7' } }
  const { tools } = setup({ mode: 'image-output', services: { jobs } })
  await execute(tools[0], { prompt: 'screenshot forever', run_in_background: true })
  const handle = { append() {}, updateProgress() {} }
  const outcome = await jobs.started[0].run(handle).done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /\[1 image: .*claude-code-pro-images/)
})
