import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'

import { runLocalClaude } from '../lib/run-local.js'
import { buildArguments } from '../lib/cli.js'
import { userMessageLine } from '../lib/protocol.js'
import { makeFakeCommand, makeTempDir } from './helpers.mjs'

function request() {
  return { protocol: 1, requestId: 'spawn-boundary', cwd: makeTempDir(), command: makeFakeCommand(),
    prompt: 'hello', model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', sessionMode: 'persistent' }
}

function run(input) {
  return runLocalClaude({ ...input, env: process.env,
    args: buildArguments({ session: { kind: 'new', sessionId: '22222222-2222-4222-8222-222222222222' }, permissionMode: input.permissionMode, model: input.model }),
    input: userMessageLine({ text: input.prompt }) })
}

test('the desktop shared runner also refuses Windows before starting a CLI', async () => {
  const input = request()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await assert.rejects(runLocalClaude({ command: input.command, args: [], cwd: input.cwd, env: {}, input: '' }), error => {
      assert.equal(error.facts.category, 'unsupported-runtime')
      assert.equal(error.run.execution.dispatch, 'not-dispatched')
      assert.equal(error.run.cleanupConfirmed, true)
      return true
    })
  } finally { Object.defineProperty(process, 'platform', original) }
})

test('a synchronous spawn failure carries explicit no-dispatch and cleanup evidence', async t => {
  const input = request()
  const replacement = t.mock.method(childProcess, 'spawn', () => { throw Object.assign(new Error('cannot allocate process'), { code: 'EAGAIN' }) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(run(input), error => {
      assert.equal(error.facts.category, 'spawn')
      assert.equal(error.run.execution.dispatch, 'not-dispatched')
      assert.equal(error.run.cleanupConfirmed, true)
      assert.equal(error.run.sessionId, undefined)
      assert.equal(error.run.usage, undefined)
      return true
    })
  } finally { replacement.mock.restore(); syncBuiltinESMExports() }
})

test('an asynchronous spawn failure without a close event settles and destroys owned pipes', async t => {
  const input = request()
  const child = new EventEmitter()
  Object.assign(child, { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const replacement = t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing CLI'), { code: 'ENOENT' })))
    return child
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(run(input), error => {
      assert.equal(error.facts.category, 'spawn')
      assert.equal(error.run.execution.dispatch, 'not-dispatched')
      assert.equal(error.run.execution.exitCode, null)
      assert.equal(error.run.cleanupConfirmed, true)
      return true
    })
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed)
  } finally { replacement.mock.restore(); syncBuiltinESMExports() }
})

test('an unprobeable process group cannot produce a successful checkpoint', async t => {
  const input = { ...request(), disposeGraceMs: 0 }
  const original = process.kill
  const replacement = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && signal === 0) throw Object.assign(new Error('no permission to inspect'), { code: 'EPERM' })
    return original.call(process, pid, signal)
  })
  try {
    await assert.rejects(run(input), error => {
      assert.equal(error.facts.category, 'cleanup-unconfirmed')
      assert.equal(error.run.cleanupConfirmed, false)
      assert.equal(error.run.execution.terminalReceived, true)
      assert.equal(error.run.usage.input_tokens, 10)
      return true
    })
  } finally { replacement.mock.restore() }
})
