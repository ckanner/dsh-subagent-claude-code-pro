import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { MACHINE_LIFECYCLE_CAPABILITIES, MACHINE_LIFECYCLE_VERSION, recoverMachine, runMachine } from 'dsh-subagent-claude-code-pro/machine'

const source = fileURLToPath(new URL('../lib/machine.js', import.meta.url))
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms) })
async function until(check, description, milliseconds = 10_000) {
  const end = Date.now() + milliseconds
  while (!check()) { if (Date.now() >= end) throw new Error('timed out: ' + description); await delay(20) }
}
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-recovery-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const command = join(dir, 'fake-claude.mjs')
  copyFileSync(fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)), command)
  chmodSync(command, 0o755)
  return { dir, capture: join(dir, 'calls.jsonl'), journal: join(dir, 'journal'),
    request: { protocol: 1, requestId: 'durable-attempt-1', prompt: 'Complete the fixture task.', cwd: dir,
      model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', command, timeoutMs: 8_000, sessionMode: 'persistent', disposeGraceMs: 100 } }
}
function calls(capture) {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

test('Claude advertises its actual handshake capability and persists pre-prompt intent before ACK', async t => {
  const { request, capture, journal } = fixture(t)
  assert.equal(MACHINE_LIFECYCLE_VERSION, 1)
  assert.deepEqual(MACHINE_LIFECYCLE_CAPABILITIES, { version: 1, durableJournal: true, readOnlyRecovery: true, threadReadyBeforeDispatch: false })
  const events = []
  const receipt = await runMachine(request, { recoveryDirectory: journal, env: { ...process.env, FAKE_CLAUDE_LOG: capture },
    onLifecycle: async event => {
      events.push(event)
      const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
      assert.deepEqual(recovered.lifecycle, event)
      if (['dispatch-intent', 'dispatch-possible'].includes(event.event)) {
        await delay(25)
        assert.equal(calls(capture).length, 0)
        assert.equal(event.configuration, null, 'pre-prompt intent must not invent observed init')
        assert.equal(recovered.status, 'pending')
      } else {
        assert.equal(recovered.status, 'terminal', 'native receipt must precede final delivery')
        assert.equal(recovered.receipt.ok, true)
      }
    } })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.execution.turnDispatch, 'accepted')
  assert.deepEqual(events.map(e => e.event), ['dispatch-intent', 'dispatch-possible', 'terminal', 'cleanup-confirmed'])
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4])
  assert.equal(events.every(e => e.turnId === null), true)
  assert.equal(events[2].configuration.matched, true)
  assert.equal(events[3].threadId, receipt.session.id)
  assert.equal(events[3].cleanupConfirmed, true)
  assert.equal(calls(capture).length, 1)
  const before = statSync(join(journal, 'machine-journal.json')).mtimeMs
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })
  assert.deepEqual(recovered.receipt, receipt)
  assert.equal(statSync(join(journal, 'machine-journal.json')).mtimeMs, before)
  assert.equal(calls(capture).length, 1)
})

for (const stage of ['dispatch-intent', 'dispatch-possible']) {
  test('a rejected ' + stage + ' checkpoint never sends prompt or starts CLI', async t => {
    const { request, capture, journal } = fixture(t)
    const receipt = await runMachine(request, { recoveryDirectory: journal, env: { ...process.env, FAKE_CLAUDE_LOG: capture },
      onLifecycle: event => { if (event.event === stage) throw new Error('checkpoint refused') } })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.execution.dispatch, 'not-dispatched')
    assert.equal(receipt.execution.turnDispatch, stage === 'dispatch-intent' ? 'not-dispatched' : 'possible')
    assert.equal(receipt.cleanup.confirmed, true)
    assert.equal(calls(capture).length, 0)
    const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })
    assert.deepEqual(recovered.receipt, receipt)
  })
}

test('terminal delivery rejection does not change completed native facts or recovered usage', async t => {
  const { request, journal } = fixture(t)
  const receipt = await runMachine(request, { recoveryDirectory: journal,
    onLifecycle: event => { if (event.event === 'terminal') throw new Error('consumer closed') } })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.execution.cancelled, false)
  assert.equal(receipt.usage.status, 'complete')
  assert.deepEqual((await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })).receipt, receipt)
})

test('durable supervision preserves explicit credentials but never records env in the journal', async t => {
  const { request, capture, journal } = fixture(t)
  const receipt = await runMachine(request, { recoveryDirectory: journal,
    env: { ...process.env, FAKE_CLAUDE_LOG: capture, DEEPSEEK_API_KEY: 'unrelated-value', ANTHROPIC_API_KEY: 'ambient-value' },
    credentialEnv: { ANTHROPIC_API_KEY: 'explicit-private-value' } })
  assert.equal(receipt.ok, true)
  assert.equal(calls(capture)[0].env.ANTHROPIC_API_KEY, 'explicit-private-value')
  assert.equal(calls(capture)[0].env.DEEPSEEK_API_KEY, undefined)
  const bytes = readFileSync(join(journal, 'machine-journal.json'), 'utf8')
  for (const secret of ['explicit-private-value', 'unrelated-value', 'ambient-value']) assert.equal(bytes.includes(secret), false)
})

test('read-only recovery refuses corrupt, absent, mismatched and aliased evidence; admission never replays an existing journal', async t => {
  const { dir, request, capture, journal } = fixture(t)
  const receipt = await runMachine(request, { recoveryDirectory: journal, env: { ...process.env, FAKE_CLAUDE_LOG: capture } })
  const input = { protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal }
  const before = readFileSync(join(journal, 'machine-journal.json'))
  await assert.rejects(runMachine(request, { recoveryDirectory: journal, env: { ...process.env, FAKE_CLAUDE_LOG: capture } }), /supervisor/)
  assert.deepEqual(readFileSync(join(journal, 'machine-journal.json')), before)
  assert.equal((await recoverMachine({ ...input, runId: 'another-run' })).status, 'unknown')
  assert.equal((await recoverMachine({ ...input, requestId: 'another-request' })).status, 'unknown')
  assert.equal((await recoverMachine({ ...input, recoveryDirectory: join(dir, 'absent') })).status, 'unknown')
  const alias = join(dir, 'alias')
  symlinkSync(journal, alias)
  assert.equal((await recoverMachine({ ...input, recoveryDirectory: alias })).status, 'unknown')
  writeFileSync(join(journal, 'machine-journal.json'), '{broken\n')
  assert.equal((await recoverMachine(input)).status, 'unknown')
  assert.equal(readFileSync(join(journal, 'machine-journal.json'), 'utf8'), '{broken\n')
  assert.equal(calls(capture).length, 1)
  await assert.rejects(recoverMachine({ ...input, extra: true }), /invalid machine recovery/)
})

test('machine supervisor death cannot manufacture a terminal outcome from later native guardian cleanup', { timeout: 15_000 }, async t => {
  const { request, capture, journal } = fixture(t)
  let hostPid, known
  const originalFork = childProcess.fork
  // Observe a real process solely to inject its unexpected death.
  childProcess.fork = (...args) => {
    const child = originalFork(...args)
    if (String(args[0]).endsWith('machine-supervisor.js')) hostPid = child.pid
    return child
  }
  syncBuiltinESMExports()
  t.after(() => { childProcess.fork = originalFork; syncBuiltinESMExports() })
  const result = runMachine(request, { recoveryDirectory: journal,
    env: { ...process.env, FAKE_CLAUDE_LOG: capture, FAKE_CLAUDE_MODE: 'hang' }, onLifecycle: event => { known = event } })
  result.catch(() => {})
  await until(() => known !== undefined && hostPid !== undefined && calls(capture).length === 1, 'active native Claude')
  const pid = calls(capture)[0].pid
  process.kill(hostPid, 'SIGKILL')
  await assert.rejects(result, /supervisor exited/)
  await until(() => { try { process.kill(-pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, 'independent native cleanup')
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: known.runId, recoveryDirectory: journal })
  assert.equal(recovered.status, 'pending')
  assert.equal(recovered.receipt, null)
  assert.equal(recovered.lifecycle.dispatch, 'possible')
  assert.equal(recovered.lifecycle.cleanupConfirmed, false)
  assert.equal(calls(capture).length, 1)
})

for (const stage of ['dispatch-intent', 'native-running', 'terminal', 'cleanup-confirmed']) {
  test('caller process-group SIGKILL at ' + stage + ' retains independently supervised evidence', { timeout: 20_000 }, async t => {
    const { dir, request, capture, journal } = fixture(t)
    const checkpoint = join(dir, 'checkpoint.json')
    const script = `import { runMachine } from ${JSON.stringify(source)};
      import { writeFileSync } from 'node:fs';
      await runMachine(${JSON.stringify(request)}, { recoveryDirectory: ${JSON.stringify(journal)},
        env: {...process.env, FAKE_CLAUDE_LOG: ${JSON.stringify(capture)}, FAKE_CLAUDE_MODE: ${JSON.stringify(stage === 'native-running' ? 'hang' : 'normal')}},
        onLifecycle: async e => { if (e.event === ${JSON.stringify(stage === 'native-running' ? 'dispatch-intent' : stage)}) {
          writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify(e)); ${stage === 'native-running' ? '' : 'await new Promise(() => {});'} } } });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = new Promise(resolve => { child.once('close', resolve) })
    child.stderr.on('data', () => {})
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already reaped */ } })
    await until(() => existsSync(checkpoint), 'checkpoint ' + stage)
    if (stage === 'native-running') await until(() => calls(capture).length === 1, 'native prompt dispatch')
    const event = JSON.parse(readFileSync(checkpoint, 'utf8'))
    process.kill(-child.pid, 'SIGKILL')
    await exited
    let recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
    const end = Date.now() + 10_000
    while (recovered.status !== 'terminal' && Date.now() < end) {
      await delay(25)
      recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
    }
    assert.equal(recovered.status, 'terminal', JSON.stringify(recovered))
    assert.equal(recovered.receipt.cleanup.confirmed, true)
    assert.equal(recovered.receipt.ok, stage === 'terminal' || stage === 'cleanup-confirmed')
    if (stage === 'terminal' || stage === 'cleanup-confirmed') assert.equal(recovered.receipt.execution.cancelled, false)
    assert.equal(calls(capture).length, stage === 'dispatch-intent' ? 0 : 1)
    const pgid = recovered.receipt.execution.processGroupId
    if (pgid !== null) assert.throws(() => process.kill(-pgid, 0), error => error.code === 'ESRCH')
  })
}
