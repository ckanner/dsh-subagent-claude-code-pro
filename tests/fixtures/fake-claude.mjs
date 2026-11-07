#!/usr/bin/env node
/**
 * A deterministic stand-in for the local `claude` CLI.
 *
 * It speaks the same `--print --input-format stream-json
 * --output-format stream-json` shape this plugin drives, so every session,
 * timeout, error and protocol path can be tested without a network, a login,
 * or a real Anthropic call. Behaviour is selected by FAKE_CLAUDE_MODE.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const has = (name) => args.includes(name)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

let prompt = ''
let userContent = []
try {
  const message = JSON.parse(stdin.trim())
  userContent = Array.isArray(message?.message?.content) ? message.message.content : []
  prompt = userContent.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
} catch {
  prompt = stdin
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'normal'
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
const logPath = process.env.FAKE_CLAUDE_LOG
if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify({ args, prompt, userContent, mode, pid: process.pid, parentPid: process.ppid, env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DSH_PRIVATE: process.env.DSH_PRIVATE,
  } })}\n`)
}

const resumedId = flag('--resume')
const newId = flag('--session-id')
const sessionId = newId ?? resumedId ?? randomUUID()
const model = flag('--model') ?? 'fake-model'
const stateDir = process.env.FAKE_CLAUDE_STATE

const init = () => emit({
  type: 'system',
  subtype: 'init',
  session_id: mode === 'wrong-session' ? '33333333-3333-4333-8333-333333333333' : sessionId,
  model: process.env.FAKE_CLAUDE_OBSERVED_MODEL ?? (mode === 'wrong-model' ? 'different-model' : model),
  claude_code_version: '9.9.9-fake',
  cwd: mode === 'wrong-cwd' ? '/wrong-cwd' : process.cwd(),
  permissionMode: mode === 'wrong-permission' ? 'dontAsk' : flag('--permission-mode'),
  apiKeySource: 'ANTHROPIC_API_KEY',
  capabilities: ['fake'],
})

const result = (fields) => {
  const value = {
  type: 'result',
  session_id: sessionId,
  uuid: randomUUID(),
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: resumedId === undefined ? 0 : 7, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.001,
  ...fields,
  }
  if (mode === 'partial-usage') delete value.usage.cache_creation_input_tokens
  if (mode === 'invalid-usage') { value.usage.input_tokens = -5; value.usage.output_tokens = '5' }
  if (mode === 'missing-usage') delete value.usage
  if (mode === 'invalid-cost') value.total_cost_usd = -1
  if (mode === 'missing-status') delete value.is_error
  if (mode === 'result-session-mismatch') value.session_id = randomUUID()
  if (mode === 'partial-line') { process.stdout.write(JSON.stringify(value)); return }
  emit(value)
  if (mode === 'duplicate-result') emit(value)
  if (mode === 'corrupt-tail') process.stdout.write('not-json\n')
  if (mode === 'trailing-assistant') emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'too late' }] } })
}

if (mode.startsWith('descendant-')) {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' })
  if (process.env.FAKE_CLAUDE_DESCENDANT_PID) writeFileSync(process.env.FAKE_CLAUDE_DESCENDANT_PID, String(descendant.pid))
  await sleep(50)
}

if (mode === 'hang' || mode === 'ignore-term' || mode === 'descendant-timeout') {
  init()
  await sleep(60_000)
  process.exit(0)
}

if (mode === 'auth-fail' || mode === 'descendant-failure') {
  init()
  result({ subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  process.exit(1)
}

if (mode === 'resume-missing' && resumedId !== undefined) {
  process.stderr.write(`No conversation found with session ID: ${resumedId}\n`)
  result({ subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resumedId}` })
  process.exit(1)
}

/** A 1x1 PNG, enough to be a real image block. */
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

if (mode === 'image-output') {
  const answer = 'image captured'
  init()
  emit({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_fake',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_BASE64 } }],
      }],
    },
  })
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: answer }] } })
  result({ subtype: 'success', is_error: false, result: answer })
  process.exit(0)
}

if (mode === 'no-result') {
  init()
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'partial' }] } })
  process.exit(0)
}

if (mode === 'garbage') {
  process.stdout.write('this is not json\n')
  process.exit(0)
}

let prior = ''
if (stateDir !== undefined) {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, `${sessionId}.json`)
  if (resumedId !== undefined && existsSync(file)) {
    try {
      prior = JSON.parse(readFileSync(file, 'utf8')).prompt ?? ''
    } catch {
      prior = ''
    }
  }
  writeFileSync(file, JSON.stringify({ prompt }))
}

let answer = prior === '' ? `echo:${prompt}` : `prior:${prior}|echo:${prompt}`
if (mode === 'large-answer') answer = 'x'.repeat(2048)
/** When a schema is supplied the fake answers machine-readable JSON, as the CLI would. */
let structured
if (has('--json-schema')) {
  if (mode === 'bad-structured') {
    answer = 'not json'
  } else {
    structured = { answer: 42 }
    answer = JSON.stringify(structured)
  }
}
if (mode !== 'no-init') init()
if (mode === 'duplicate-init') init()
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: answer }] } })
if (mode === 'progress-hang') await sleep(60_000)
result({
  subtype: mode === 'limit' ? 'error_max_turns' : 'success',
  is_error: mode === 'limit',
  result: answer,
  ...(structured === undefined ? {} : { structured_output: structured }),
})
process.exit(mode === 'nonzero-success' ? 2 : mode === 'limit' ? 1 : 0)
