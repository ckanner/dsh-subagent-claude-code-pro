/**
 * Local Claude Code CLI doctor.
 *
 * Checks the things this plugin depends on without sending a model request:
 * the executable, the CLI version, the login state, the flags the plugin drives,
 * and (on macOS) whether the Claude Code keychain item actually holds tokens.
 * Token values are never printed — only lengths and expiry.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   CLAUDE_PRO_COMMAND=/abs/path/to/claude node scripts/doctor.mjs
 */

import { spawnSync } from 'node:child_process'

const command = process.env.CLAUDE_PRO_COMMAND ?? 'claude'

/** @type {string[]} */
const problems = []

function report(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) problems.push(label)
}

function run(args, timeout = 20_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

const version = run(['--version'])
const versionText = (version.stdout + version.stderr).trim().split('\n')[0] ?? ''
report(version.status === 0 && versionText !== '', 'claude executable', versionText || String(version.error ?? 'not found'))

const auth = run(['auth', 'status'])
let authJson
try {
  authJson = JSON.parse(auth.stdout)
} catch {
  authJson = undefined
}
if (authJson === undefined) {
  report(false, 'claude auth status', (auth.stdout + auth.stderr).trim().slice(0, 200) || 'did not return JSON')
} else {
  report(
    authJson.loggedIn === true,
    'claude login',
    `loggedIn=${String(authJson.loggedIn)} authMethod=${String(authJson.authMethod)} apiProvider=${String(authJson.apiProvider)}`,
  )
}

const help = run(['--help'])
const helpText = help.stdout + help.stderr
const requiredFlags = [
  '--input-format',
  '--output-format',
  '--session-id',
  '--resume',
  '--fork-session',
  '--no-session-persistence',
  '--permission-mode',
  '--permission-prompts',
  '--model',
  '--effort',
  '--json-schema',
  '--setting-sources',
]
const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag))
report(missingFlags.length === 0, 'CLI flags', missingFlags.length === 0 ? `${requiredFlags.length}/${requiredFlags.length} present` : `missing ${missingFlags.join(', ')}`)

if (process.platform === 'darwin') {
  const keychain = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (keychain.status !== 0) {
    report(false, 'Claude Code keychain item', 'not found — run `claude auth login`')
  } else {
    const match = /password: "(.*)"/s.exec(keychain.stdout)
    let tokenState = 'unparseable'
    if (match !== null) {
      try {
        const oauth = JSON.parse(match[1]).claudeAiOauth ?? {}
        const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : ''
        const refreshToken = typeof oauth.refreshToken === 'string' ? oauth.refreshToken : ''
        tokenState = `accessToken.length=${accessToken.length} refreshToken.length=${refreshToken.length} expiresAt=${String(oauth.expiresAt)}`
        report(accessToken.length > 0 || refreshToken.length > 0, 'Claude Code keychain tokens', tokenState)
      } catch {
        report(false, 'Claude Code keychain tokens', tokenState)
      }
    } else {
      report(false, 'Claude Code keychain tokens', tokenState)
    }
  }
}

if (problems.length === 0) {
  console.log('\nCLAUDE CODE DOCTOR OK')
  process.exit(0)
}
console.log('\nNext steps:')
console.log('- Run `claude auth login` in a normal Terminal window (not through an agent),')
console.log('  complete the browser sign-in, then re-run this doctor.')
console.log('- If `command` is not found, set the plugin config to an absolute path:')
console.log('  config: { command: "/Users/you/.local/bin/claude" }')
console.log(`\nCLAUDE CODE DOCTOR FAILED (${String(problems.length)} problem(s))`)
process.exit(1)
