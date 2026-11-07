/**
 * Live product probe: run the plugin's own runner against the user's local
 * `claude` CLI. This is the real-product smoke test; it needs a logged-in CLI
 * and spends a small amount of subscription usage. It is not part of the unit
 * test suite.
 *
 * Usage:
 *   node scripts/probe-live.mjs
 *   CLAUDE_PRO_COMMAND=/abs/path/to/claude node scripts/probe-live.mjs
 */

import { randomUUID } from 'node:crypto'

import { buildArguments } from '../lib/cli.js'
import { userMessageLine } from '../lib/protocol.js'
import { runClaude } from '../lib/run.js'

const command = process.env.CLAUDE_PRO_COMMAND ?? 'claude'
const model = process.env.CLAUDE_PRO_MODEL ?? 'haiku'
const cwd = process.env.CLAUDE_PRO_CWD ?? process.cwd()

function line(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

async function main() {
  const sessionId = randomUUID()
  console.log(`command: ${command}`)
  console.log(`cwd:     ${cwd}`)
  console.log(`model:   ${model}`)
  console.log(`session: ${sessionId}`)

  let failures = 0
  const first = await runClaude({
    command,
    args: buildArguments({
      session: { kind: 'new', sessionId, name: 'DSH · live probe' },
      permissionMode: 'dontAsk',
      model,
    }),
    cwd,
    env: process.env,
    input: userMessageLine({ text: 'Remember this number: 8642. Reply with exactly: LIVE_OK' }),
    timeoutMs: 120_000,
  })
  const firstOk = first.stopReason === 'completed' && first.text.trim() === 'LIVE_OK' && first.sessionId === sessionId
  if (!firstOk) failures += 1
  line(firstOk, 'new session + text', `cli=${first.init?.cliVersion ?? '?'} model=${first.init?.model ?? '?'} text=${JSON.stringify(first.text)}`)

  const second = await runClaude({
    command,
    args: buildArguments({
      session: { kind: 'resume', resumeId: sessionId },
      permissionMode: 'dontAsk',
      model,
    }),
    cwd,
    env: process.env,
    input: userMessageLine({ text: 'What number did I ask you to remember? Reply with just the number.' }),
    timeoutMs: 120_000,
  })
  const secondOk = second.stopReason === 'completed' && second.text.includes('8642')
  if (!secondOk) failures += 1
  line(secondOk, 'session resume + recall', `text=${JSON.stringify(second.text)} cacheRead=${String(second.usage?.cache_read_input_tokens ?? 0)}`)

  console.log(failures === 0 ? 'LIVE PROBE OK' : `LIVE PROBE FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('LIVE PROBE CRASHED')
  console.error(error)
  process.exit(1)
})
