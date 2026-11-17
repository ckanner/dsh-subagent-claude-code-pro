#!/usr/bin/env node
/**
 * Optional native acceptance, with no account or paid model inference.
 * Usage: node scripts/verify-sdk-native.mjs /absolute/path/to/claude
 * The explicitly supplied native CLI and installed official SDK are real. Only
 * the Anthropic HTTP peer is a loopback fixture. No executable is downloaded.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { runMachine } from 'dsh-subagent-claude-code-pro/machine'

const args = process.argv.slice(2)
assert.equal(args.length, 1, 'pass exactly one explicit absolute path to an installed Claude Code CLI')
assert.ok(isAbsolute(args[0]), 'the native CLI path must be absolute')
const command = realpathSync(args[0])
assert.ok(statSync(command).isFile(), 'the native CLI path must name a file')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccpro-sdk-native-')))
const home = join(root, 'home'), config = join(root, 'config'), cwd = join(root, 'workspace')
for (const dir of [home, config, cwd, join(root, 'journal')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const require = createRequire(import.meta.url)
const sdkVersion = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version
const apiKey = 'loopback-only-not-a-real-credential'
const inference = [], otherRequests = []
const ownedGroups = new Set()
let serverFailure, passed = false
const marker = body => {
  const user = [...(body.messages ?? [])].reverse().find(message => message.role === 'user')
  const text = JSON.stringify(user?.content ?? '')
  if (text.includes('SDK_NATIVE_RESUME')) return 'resume'
  if (text.includes('SDK_NATIVE_EPHEMERAL')) return 'ephemeral'
  if (text.includes('SDK_NATIVE_NEW')) return 'new'
  throw new Error('unexpected model request in the isolated native fixture')
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of request) {
      raw += chunk
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('fixture request exceeded its bound')
    }
    if (url.pathname === '/v1/messages/count_tokens') {
      otherRequests.push(url.pathname)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ input_tokens: 256 })); return
    }
    if (url.pathname !== '/v1/messages') {
      otherRequests.push(url.pathname)
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'offline fixture endpoint' } })); return
    }
    assert.equal(request.headers['x-api-key'], apiKey, 'native request must use only the loopback fixture credential')
    const body = JSON.parse(raw), kind = marker(body)
    inference.push({ kind, model: body.model, hasOriginalPrompt: JSON.stringify(body.messages).includes('SDK_NATIVE_NEW') })
    const text = 'NATIVE_' + kind.toUpperCase() + '_OK'
    const message = { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(message)); return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'loopback-fixture' })
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    event({ type: 'message_start', message: { ...message, content: [], stop_reason: null,
      usage: { ...message.usage, output_tokens: 0 } } })
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
    event({ type: 'message_stop' })
    response.end()
  } catch (error) {
    serverFailure ??= error
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'api_error', message: 'isolated fixture rejected this request' } }))
  }
})

function transcripts(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? transcripts(join(directory, entry.name)) : entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : [])
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
function readHistory(id) {
  const files = transcripts(join(config, 'projects')).filter(file => file.endsWith('/' + id + '.jsonl'))
  assert.equal(files.length, 1, 'the native persistent transcript must exist exactly once after physical cleanup')
  return readFileSync(files[0], 'utf8').trim().split('\n').map(line => JSON.parse(line))
}
const assertCleanup = receipt => {
  assert.equal(receipt.cleanup.confirmed, true)
  assert.equal(receipt.execution.ownership, 'process-group')
  assert.equal(receipt.execution.terminalReceived, true)
  assert.equal(receipt.execution.exitCode, 0)
  assert.throws(() => process.kill(-receipt.execution.processGroupId, 0), error => error.code === 'ESRCH')
  ownedGroups.delete(receipt.execution.processGroupId)
}
function groupExists(id) {
  try { process.kill(-id, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}
async function cleanupOwnedGroups() {
  for (const id of ownedGroups) {
    for (const [signal, grace] of [['SIGTERM', 500], ['SIGKILL', 2000]]) {
      if (!groupExists(id)) break
      try { process.kill(-id, signal) } catch (error) { if (error.code === 'ESRCH') break }
      const end = Date.now() + grace
      while (groupExists(id) && Date.now() < end) await delay(20)
    }
    if (groupExists(id)) process.stderr.write(`Could not confirm native fixture group ${id} stopped\n`)
    else ownedGroups.delete(id)
  }
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
  const common = { protocol: 1, cwd, command, model: 'sonnet', effort: 'high', permissionMode: 'dontAsk',
    settingSources: [], timeoutMs: 45000, disposeGraceMs: 500 }
  const run = async (requestId, extra) => {
    const result = await runMachine({ ...common, requestId, ...extra }, { env, credentialEnv: { ANTHROPIC_API_KEY: apiKey },
      recoveryDirectory: join(root, 'journal', requestId), onLifecycle() {} })
    const id = result.execution?.processGroupId
    if (result.execution?.ownership === 'process-group' && Number.isSafeInteger(id) && id > 1
      && id === result.execution.pid && id !== process.pid && groupExists(id)) ownedGroups.add(id)
    if (serverFailure) throw serverFailure
    assert.equal(result.ok, true, JSON.stringify(result.failure))
    assertCleanup(result)
    assert.equal(result.configuration.matched, true)
    return result
  }
  const title = 'SDK native acceptance · 可读会话'
  const fresh = await run('native-new', { prompt: 'SDK_NATIVE_NEW: return the fixed fixture answer.', sessionMode: 'persistent', sessionName: title })
  assert.equal(fresh.output[0].text, 'NATIVE_NEW_OK')
  assert.equal(fresh.session.resumable, true)
  let history = readHistory(fresh.session.id)
  assert.equal(history.filter(event => event.type === 'custom-title').at(-1)?.customTitle, title)
  assert.ok(history.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes('NATIVE_NEW_OK')))
  const resumed = await run('native-resume', { prompt: 'SDK_NATIVE_RESUME: return the fixed fixture answer.',
    sessionMode: 'persistent', sessionId: fresh.session.id })
  assert.equal(resumed.output[0].text, 'NATIVE_RESUME_OK')
  assert.equal(resumed.session.id, fresh.session.id)
  assert.equal(resumed.session.resumed, true)
  history = readHistory(fresh.session.id)
  assert.equal(history.filter(event => event.type === 'custom-title').at(-1)?.customTitle, title)
  assert.ok(history.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes('NATIVE_RESUME_OK')))
  assert.ok(inference.some(request => request.kind === 'resume' && request.hasOriginalPrompt))
  const temporary = await run('native-ephemeral', { prompt: 'SDK_NATIVE_EPHEMERAL: return the fixed fixture answer.', sessionMode: 'ephemeral' })
  assert.equal(temporary.output[0].text, 'NATIVE_EPHEMERAL_OK')
  assert.equal(temporary.session.resumable, false)
  assert.equal(transcripts(join(config, 'projects')).some(file => file.endsWith('/' + temporary.session.id + '.jsonl')), false)
  assert.equal(inference.filter(request => request.kind === 'ephemeral').some(request => request.hasOriginalPrompt), false)
  assert.deepEqual(inference.map(request => request.kind), ['new', 'resume', 'ephemeral'], 'each explicit request must dispatch exactly once')
  passed = true
  process.stdout.write(JSON.stringify({ ok: true, adapterVersion: require('dsh-subagent-claude-code-pro/package.json').version,
    sdkVersion, cliVersion: fresh.configuration.observed.cliVersion, actualPublicMachineAPI: true,
    isolatedHomeAndConfig: true, nativeNamedTranscript: true, nativeResumeSameSession: true, nativeEphemeralWithoutTranscript: true,
    physicalCleanup: true, loopbackModelRequests: inference.length, paidModelRequests: 0, otherLoopbackRequests: otherRequests }) + '\n')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await cleanupOwnedGroups()
  if (passed) rmSync(root, { recursive: true, force: true })
  else process.stderr.write(`Native acceptance evidence retained at ${root}\n`)
}
