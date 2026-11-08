// Exercise the actual npm tarball through its installed public entry.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'claude-machine-package-')))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = { ...process.env }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: temp, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout)
  return result.stdout
}
try {
  execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', temp], { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  const tarballs = readdirSync(temp).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const installed = join(temp, 'installed')
  mkdirSync(installed)
  run(npm, ['install', '--prefix', installed, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, tarballs[0])])
  const command = join(temp, 'fake-claude.mjs')
  copyFileSync(join(root, 'tests/fixtures/fake-claude.mjs'), command)
  chmodSync(command, 0o755)
  const request = { protocol: 1, requestId: 'packed-call', prompt: 'Exercise the installed machine entry.', cwd: temp,
    command, model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', sessionMode: 'persistent', timeoutMs: 5000 }
  writeFileSync(join(installed, 'consumer.mjs'),
    'import { runMachine, recoverMachine, MACHINE_LIFECYCLE_CAPABILITIES } from "dsh-subagent-claude-code-pro/machine";\n'
    + 'const request = ' + JSON.stringify(request) + '; const directory = ' + JSON.stringify(join(temp, 'journal')) + ';\n'
    + 'const events = []; const receipt = await runMachine(request, { recoveryDirectory: directory, onLifecycle: e => { events.push(e.event); } });\n'
    + 'const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory: directory });\n'
    + 'if (!receipt.ok || JSON.stringify(recovered.receipt) !== JSON.stringify(receipt)) throw new Error("installed lifecycle mismatch");\n'
    + 'const resumed = await runMachine({ ...request, requestId: "packed-resume", sessionId: receipt.session.id });\n'
    + 'if (!resumed.ok || !resumed.session.resumed) throw new Error("installed resume mismatch");\n'
    + 'process.stdout.write(JSON.stringify({ status: recovered.status, capabilities: MACHINE_LIFECYCLE_CAPABILITIES, events, resumed: resumed.session.resumed }));\n')
  const observed = JSON.parse(run(process.execPath, [join(installed, 'consumer.mjs')]))
  assert.deepEqual(observed, { status: 'terminal',
    capabilities: { version: 1, durableJournal: true, readOnlyRecovery: true, threadReadyBeforeDispatch: false },
    events: ['dispatch-intent', 'dispatch-possible', 'terminal', 'cleanup-confirmed'], resumed: true })
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version, actualNpmInstall: true,
    publicMachineAPI: true, machineSupervisor: true, durableLifecycle: true, readOnlyRecovery: true, explicitResume: true,
    inferenceRequests: 0 }) + '\n')
} finally { rmSync(temp, { recursive: true, force: true }) }
