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
  const nativeRequest = { version: 1, agents: { enabled: true, definitions: {
    implementer: { description: 'Implement', prompt: 'Implement the requested change.', model: 'sonnet', effort: 'medium' },
    reviewer: { description: 'Review', prompt: 'Review the implementation.', model: 'opus', effort: 'xhigh' },
    inherited: { description: 'Follow CLI defaults', prompt: 'Use the native defaults.' },
  } } }
  const nativeLog = join(temp, 'native-argv.jsonl')
  const activityLog = join(temp, 'activity-argv.jsonl')
  writeFileSync(join(installed, 'consumer.mjs'),
    'import { runMachine, recoverMachine, runNativeReview, recoverNativeJob, MACHINE_NATIVE_CAPABILITIES, MACHINE_LIFECYCLE_CAPABILITIES, MACHINE_ACTIVITY_VERSION, MACHINE_ACTIVITY_CAPABILITIES } from "dsh-subagent-claude-code-pro/machine";\n'
    + 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n'
    + 'for (const peer of ["@deepseek-ai/schemastery", "@deepseek-ai/dsh-home-paths"]) { try { require.resolve(peer); throw new Error("machine consumer unexpectedly installed " + peer); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; } }\n'
    + 'const request = ' + JSON.stringify(request) + '; const directory = ' + JSON.stringify(join(temp, 'journal')) + ';\n'
    + 'if (MACHINE_NATIVE_CAPABILITIES.version !== 1 || typeof runNativeReview !== "function" || typeof recoverNativeJob !== "function") throw new Error("native exports missing");\n'
    + 'const nativeRequest = ' + JSON.stringify(nativeRequest) + ';\n'
    + 'const native = await runMachine({...request, native:nativeRequest}, {env:{...process.env,FAKE_CLAUDE_LOG:' + JSON.stringify(nativeLog) + '}}); if (!native.ok || !native.native.effective.matched) throw new Error("native configuration missing: " + JSON.stringify(native));\n'
    + 'if (JSON.stringify(native.native.requested) !== JSON.stringify(nativeRequest)) throw new Error("installed native child effort mismatch");\n'
    + 'const events = []; const receipt = await runMachine(request, { recoveryDirectory: directory, onLifecycle: e => { events.push(e.event); } });\n'
    + 'const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory: directory });\n'
    + 'if (!receipt.ok || JSON.stringify(recovered.receipt) !== JSON.stringify(receipt)) throw new Error("installed lifecycle mismatch");\n'
    + 'const resumed = await runMachine({ ...request, requestId: "packed-resume", sessionId: receipt.session.id });\n'
    + 'if (!resumed.ok || !resumed.session.resumed) throw new Error("installed resume mismatch");\n'
    + 'for (const sessionId of [undefined, receipt.session.id]) { const rejected = await runMachine({...request, sessionId}, {env:{...process.env,CLAUDE_CODE_SKIP_PROMPT_HISTORY:"1"}}); if (rejected.ok || rejected.failure?.category !== "invalid-request" || rejected.execution.dispatch !== "not-dispatched" || !rejected.cleanup.confirmed || rejected.session.resumable) throw new Error("installed persistence guard mismatch"); }\n'
    + 'const ephemeral = await runMachine({...request, sessionMode:"ephemeral"}, {env:{...process.env,CLAUDE_CODE_SKIP_PROMPT_HISTORY:"1"}}); if (!ephemeral.ok || ephemeral.session.resumable) throw new Error("installed explicit ephemeral mismatch");\n'
    + 'if (MACHINE_ACTIVITY_VERSION !== 1 || !MACHINE_ACTIVITY_CAPABILITIES.metadataOnly || !MACHINE_ACTIVITY_CAPABILITIES.rootAndChildren) throw new Error("activity exports missing");\n'
    + 'const activity = []; const active = await runMachine({...request, requestId:"packed-activity", sessionName:"Packed activity"}, {env:{...process.env,FAKE_CLAUDE_MODE:"activity-child",FAKE_CLAUDE_LOG:' + JSON.stringify(activityLog) + '},recoveryDirectory:' + JSON.stringify(join(temp, 'activity-journal')) + ',onLifecycle:()=>{},activityIntervalMs:50,onActivity:e=>activity.push(e)});\n'
    + 'if (!active.ok || activity.filter(e=>e.scope==="child").length<3 || JSON.stringify(activity).includes("private-reasoning")) throw new Error("installed activity mismatch");\n'
    + 'process.stdout.write(JSON.stringify({ status: recovered.status, capabilities: MACHINE_LIFECYCLE_CAPABILITIES, events, resumed: resumed.session.resumed, activity:true }));\n')
  const observed = JSON.parse(run(process.execPath, [join(installed, 'consumer.mjs')]))
  assert.deepEqual(observed, { status: 'terminal',
    capabilities: { version: 1, durableJournal: true, readOnlyRecovery: true, threadReadyBeforeDispatch: false },
    events: ['dispatch-intent', 'dispatch-possible', 'terminal', 'cleanup-confirmed'], resumed: true, activity: true })
  const nativeCall = JSON.parse(readFileSync(nativeLog, 'utf8').trim())
  assert.deepEqual(JSON.parse(nativeCall.args[nativeCall.args.indexOf('--agents') + 1]), nativeRequest.agents.definitions)
  assert.equal(nativeCall.args[nativeCall.args.indexOf('--effort') + 1], request.effort)
  const activeCall = JSON.parse(readFileSync(activityLog, 'utf8').trim())
  assert.equal(activeCall.args[activeCall.args.indexOf('-n') + 1], 'Packed activity')
  assert.ok(activeCall.args.includes('--include-partial-messages') && activeCall.args.includes('--forward-subagent-text'))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version, actualNpmInstall: true,
    publicMachineAPI: true, machineSupervisor: true, durableLifecycle: true, readOnlyRecovery: true, explicitResume: true,
    nativeChildEffort: true, observedActivity: true, namedSession: true, persistenceGuard: true, inferenceRequests: 0 }) + '\n')
} finally { rmSync(temp, { recursive: true, force: true }) }
