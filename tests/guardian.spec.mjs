import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFakeCommand, makeTempDir } from './helpers.mjs'

const machineURL = new URL('../lib/machine.js', import.meta.url).href
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const killGroup = pid => { if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* test teardown */ } } }

async function absent(group) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    try { process.kill(-group, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      // macOS may report EPERM while an orphaned guardian is exiting.
      // Keep waiting: only ESRCH establishes that its group is absent.
      if (error.code !== 'EPERM') throw error
    }
    await pause(20)
  }
  assert.fail(`owned process group ${group} survived its supervising caller`)
}

function launch(mode = 'hang') {
  const cwd = makeTempDir('ccpro-guardian-')
  const log = join(cwd, 'native.jsonl')
  const request = { protocol: 1, requestId: 'guardian-physical-test', cwd, command: makeFakeCommand(),
    prompt: 'wait for cancellation', model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions',
    sessionMode: 'persistent', timeoutMs: 20000, disposeGraceMs: 25 }
  // This also protects against accidentally inheriting --input-type=module
  // into the guardian's file-based Node invocation.
  const code = `import { runMachine } from ${JSON.stringify(machineURL)};
    const receipt = await runMachine(${JSON.stringify(request)}, { env: process.env });
    process.stdout.write(JSON.stringify(receipt));`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  const started = async () => {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (existsSync(log)) {
        const text = readFileSync(log, 'utf8').trim()
        if (text) return JSON.parse(text.split('\n')[0])
      }
      await pause(20)
    }
    assert.fail(`native CLI did not start: ${stderr}`)
  }
  return { child, done, started }
}

for (const mode of ['hang', 'ignore-term']) test(`caller process-group SIGKILL stops the owned ${mode} native group`, async () => {
  const f = launch(mode)
  let native
  try {
    native = await f.started()
    assert.notEqual(native.parentPid, f.child.pid)
    assert.notEqual(native.pid, native.parentPid)
    killGroup(f.child.pid)
    const stopped = await f.done
    assert.equal(stopped.signal, 'SIGKILL')
    await absent(native.pid)
    await absent(native.parentPid)
  } finally {
    killGroup(f.child.pid)
    killGroup(native?.pid)
    killGroup(native?.parentPid)
  }
})

test('unexpected guardian death triggers parent cleanup without inventing a native terminal result', async () => {
  const f = launch()
  let native
  try {
    native = await f.started()
    killGroup(native.parentPid)
    const result = await f.done
    assert.equal(result.code, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.failure.category, 'process')
    assert.equal(receipt.execution.pid, native.pid)
    assert.equal(receipt.execution.outcome, 'unknown')
    assert.equal(receipt.execution.terminalReceived, false)
    assert.equal(receipt.cleanup.confirmed, true)
    assert.equal(receipt.usage.status, 'unknown')
    assert.equal(receipt.session.resumable, false)
    await absent(native.pid)
  } finally {
    killGroup(f.child.pid)
    killGroup(native?.pid)
    killGroup(native?.parentPid)
  }
})
