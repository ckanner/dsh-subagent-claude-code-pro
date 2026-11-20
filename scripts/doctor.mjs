/**
 * Check the installed SDK and configured native Claude CLI without a model call.
 * Authentication is reported only by `claude auth status`; this script never
 * reads credential files or keychain contents, and never changes login state.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   CLAUDE_PRO_COMMAND=/abs/path/to/claude node scripts/doctor.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const command = process.env.CLAUDE_PRO_COMMAND ?? 'claude'
const SDK_NAME = '@anthropic-ai/claude-agent-sdk'
// Keep this static advisory aligned with the actual initialize gate in sdk-run.js.
const MINIMUM_CLI = [2, 1, 325]
const problems = []
const nextSteps = new Set()

function report(ok, label, detail = '', nextStep) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) {
    problems.push(label)
    if (nextStep) nextSteps.add(nextStep)
  }
}

function run(args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000, maxBuffer: 1024 * 1024 })
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(value)
  const parts = match?.slice(1).map(Number)
  return parts?.every(Number.isSafeInteger) ? parts : undefined
}

function meetsMinimum(parts) {
  if (!parts) return false
  for (let index = 0; index < MINIMUM_CLI.length; index++) {
    if (parts[index] !== MINIMUM_CLI[index]) return parts[index] > MINIMUM_CLI[index]
  }
  return true
}

let sdkVersion
try {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  sdkVersion = manifest.dependencies?.[SDK_NAME]
  if (typeof sdkVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(sdkVersion)) throw new Error('missing exact dependency')
  // The pinned SDK exports its entry module but not package.json. Resolve that
  // actual entry, then verify the adjacent manifest before importing its API.
  const entry = import.meta.resolve(SDK_NAME)
  const installed = JSON.parse(await readFile(new URL('./package.json', entry), 'utf8'))
  if (installed.name !== SDK_NAME || installed.version !== sdkVersion) throw new Error('dependency mismatch')
  const sdk = await import(SDK_NAME)
  if (typeof sdk.query !== 'function') throw new Error('query API is unavailable')
  report(true, 'official Agent SDK', `${SDK_NAME}@${sdkVersion}; exact dependency and query import verified`)
} catch {
  report(false, 'official Agent SDK', `missing, incompatible, or not importable; expected ${SDK_NAME}@${sdkVersion ?? 'the exact package dependency'}`,
    'Reinstall this plugin and its pinned dependencies; the doctor does not download or substitute an SDK.')
}

if (process.argv.includes('--subscription-only')) {
  // This path intentionally reuses the public execution preflight. The legacy
  // static checks below continue to support explicit API users without policy.
  const options = {}
  const names = new Map([['--cwd', 'cwd'], ['--model', 'model'], ['--effort', 'effort'], ['--setting-sources', 'settingSources']])
  try {
    const args = process.argv.slice(2).filter(arg => arg !== '--subscription-only')
    for (let i = 0; i < args.length; i += 2) {
      const name = names.get(args[i]), value = args[i + 1]
      if (!name || !value || value.startsWith('--')) throw new Error('expected --subscription-only with --model and optional --cwd, --effort, --setting-sources')
      options[name] = name === 'settingSources' ? value.split(',').filter(Boolean) : value
    }
    if (problems.length) throw new Error('the pinned official SDK check failed')
    const { inspectSubscription } = await import('../lib/machine.js')
    const result = await inspectSubscription({ protocol: 1, requestId: 'doctor', cwd: process.cwd(), command,
      timeoutMs: 20000, ...options }, { env: process.env })
    report(result.ok, 'native subscription admission', JSON.stringify(result.subscription),
      'Use the configured official CLI account settings to resolve the reported conflict. Unknown or unavailable extra-usage evidence blocks dispatch; this doctor never changes login or billing settings.')
    report(result.cleanup.confirmed, 'native process cleanup')
    console.log('\nNo task prompt or model request was submitted. Admission is an observed pre-prompt snapshot, not a billing lock or model-entitlement guarantee.')
  } catch (error) {
    report(false, 'native subscription admission', error.message)
  }
  console.log(problems.length ? '\nCLAUDE CODE DOCTOR FAILED' : '\nCLAUDE CODE DOCTOR OK')
  process.exit(problems.length ? 1 : 0)
}

const version = run(['--version'])
const versionText = (version.stdout ?? '').trim()
const parts = versionParts(versionText)
report(version.status === 0 && !version.error && parts !== undefined, 'claude executable',
  parts === undefined ? 'configured command did not report a stable Claude Code version' : parts.join('.'),
  'Check CLAUDE_PRO_COMMAND (or the plugin command setting) points to the intended native Claude executable.')
report(version.status === 0 && !version.error && meetsMinimum(parts), 'SDK runtime version',
  `requires stable Claude Code >= ${MINIMUM_CLI.join('.')} (--version check)`,
  `Upgrade that configured Claude executable to stable ${MINIMUM_CLI.join('.')} or newer.`)

const auth = run(['auth', 'status'])
let authJson
try { authJson = JSON.parse(auth.stdout ?? '') } catch { /* Report only native status, never raw credential-bearing diagnostics. */ }
const authenticated = auth.status === 0 && !auth.error && authJson !== null && typeof authJson === 'object'
  && !Array.isArray(authJson) && authJson.loggedIn === true
report(authenticated, 'native authentication', authenticated
  ? 'loggedIn=true according to the configured CLI; no credential contents inspected'
  : 'the configured CLI did not confirm authenticated status',
  'Check the configured CLI\'s auth status and follow the native authentication setup for your selected provider/account.')

const help = run(['--help'])
const helpText = (help.stdout ?? '') + (help.stderr ?? '')
const requiredFlags = [
  '--input-format', '--output-format', '--include-partial-messages', '--forward-subagent-text',
  '--name', '--session-id', '--resume', '--fork-session', '--no-session-persistence',
  '--permission-mode', '--permission-prompts', '--model', '--effort', '--json-schema', '--setting-sources',
]
const missingFlags = requiredFlags.filter(flag => !helpText.includes(flag))
report(help.status === 0 && !help.error && missingFlags.length === 0, 'CLI flags',
  help.status !== 0 || help.error ? 'configured CLI help failed'
    : missingFlags.length === 0 ? `${requiredFlags.length}/${requiredFlags.length} present` : `missing ${missingFlags.join(', ')}`,
  'Upgrade the configured native CLI so it advertises the required streaming and session controls.')

console.log('\nStatic checks only: each query still validates the actual SDK initialize response before sending its task prompt.')
if (problems.length === 0) {
  console.log('\nCLAUDE CODE DOCTOR OK')
  process.exitCode = 0
} else {
  console.log('\nNext steps:')
  for (const nextStep of nextSteps) console.log(`- ${nextStep}`)
  console.log(`\nCLAUDE CODE DOCTOR FAILED (${problems.length} problem(s))`)
  process.exitCode = 1
}
