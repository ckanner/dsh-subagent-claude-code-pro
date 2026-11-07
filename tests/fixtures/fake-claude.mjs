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
const logPath = process.env.FAKE_CLAUDE_LOG
if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify({ args, prompt, userContent, mode })}\n`)
}

const resumedId = flag('--resume')
const newId = flag('--session-id')
const sessionId = newId ?? resumedId ?? randomUUID()
const model = flag('--model') ?? 'fake-model'
const stateDir = process.env.FAKE_CLAUDE_STATE

const init = () => emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model,
  claude_code_version: '9.9.9-fake',
  cwd: process.cwd(),
  permissionMode: flag('--permission-mode'),
  apiKeySource: 'ANTHROPIC_API_KEY',
  capabilities: ['fake'],
})

const result = (fields) => emit({
  type: 'result',
  session_id: sessionId,
  uuid: randomUUID(),
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: resumedId === undefined ? 0 : 7 },
  total_cost_usd: 0.001,
  ...fields,
})

if (mode === 'hang') {
  init()
  await sleep(60_000)
  process.exit(0)
}

if (mode === 'auth-fail') {
  init()
  result({ subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  process.exit(1)
}

if (mode === 'resume-missing' && resumedId !== undefined) {
  process.stderr.write(`No conversation found with session ID: ${resumedId}\n`)
  result({ subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resumedId}` })
  process.exit(1)
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

const answer = prior === '' ? `echo:${prompt}` : `prior:${prior}|echo:${prompt}`
init()
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: answer }] } })
const structured = has('--json-schema') ? { answer: 42 } : undefined
result({
  subtype: 'success',
  is_error: false,
  result: answer,
  ...(structured === undefined ? {} : { structured_output: structured }),
})
process.exit(0)
