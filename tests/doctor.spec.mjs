import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir } from './helpers.mjs'

const SDK_NAME = '@anthropic-ai/claude-agent-sdk'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const sdkVersion = manifest.dependencies[SDK_NAME]
const flags = ['--input-format', '--output-format', '--include-partial-messages', '--forward-subagent-text',
  '--name', '--session-id', '--resume', '--fork-session', '--no-session-persistence',
  '--permission-mode', '--permission-prompts', '--model', '--effort', '--json-schema', '--setting-sources']

function fixture(t, { sdk = 'fake', platform } = {}) {
  const directory = makeTempDir('ccpro-doctor-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const scripts = join(directory, 'scripts'), bin = join(directory, 'bin'), home = join(directory, 'home')
  for (const path of [scripts, bin, home]) mkdirSync(path)
  const script = join(scripts, 'doctor.mjs')
  copyFileSync(new URL('../scripts/doctor.mjs', import.meta.url), script)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', dependencies: { [SDK_NAME]: sdkVersion } }))
  const sdkParent = join(directory, 'node_modules', '@anthropic-ai')
  mkdirSync(sdkParent, { recursive: true })
  const sdkDirectory = join(sdkParent, 'claude-agent-sdk')
  if (sdk === 'actual') {
    symlinkSync(fileURLToPath(new URL('./', import.meta.resolve(SDK_NAME))), sdkDirectory, 'dir')
  } else if (sdk !== 'missing') {
    mkdirSync(sdkDirectory)
    writeFileSync(join(sdkDirectory, 'package.json'), JSON.stringify({ name: SDK_NAME,
      version: sdk === 'mismatch' ? '0.0.0' : sdkVersion, type: 'module', exports: './sdk.mjs' }))
    writeFileSync(join(sdkDirectory, 'sdk.mjs'), sdk === 'broken'
      ? "throw new Error('SDK fixture import failure')\n"
      : sdk === 'no-query' ? 'export const unrelated = true\n'
        : "export function query() { throw new Error('doctor must never call a model') }\n")
  }
  const state = join(directory, 'state.json'), calls = join(directory, 'calls.jsonl'), trap = join(directory, 'unexpected-command')
  const command = join(bin, 'configured claude')
  writeFileSync(command, `#!${process.execPath}\n` + `
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.DOCTOR_CALLS, JSON.stringify(args) + '\\n')
const state = JSON.parse(readFileSync(process.env.DOCTOR_STATE, 'utf8'))
if (JSON.stringify(args) === '["--version"]') {
  process.stdout.write(state.version + '\\n'); process.exit(state.versionStatus ?? 0)
}
if (JSON.stringify(args) === '["auth","status"]') {
  process.stdout.write(state.authRaw ?? JSON.stringify(state.auth)); process.exit(state.authStatus ?? 0)
}
if (JSON.stringify(args) === '["--help"]') {
  process.stdout.write(state.help); process.exit(state.helpStatus ?? 0)
}
throw new Error('unexpected native operation: ' + JSON.stringify(args))
`)
  chmodSync(command, 0o755)
  for (const name of ['claude', 'security']) {
    const decoy = join(bin, name)
    writeFileSync(decoy, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.DOCTOR_TRAP, ${JSON.stringify(name)})\nprocess.exit(91)\n`)
    chmodSync(decoy, 0o755)
  }
  const args = []
  if (platform) {
    const preload = join(directory, 'platform.mjs')
    writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })\n`)
    args.push('--import', preload)
  }
  return {
    run(overrides = {}) {
      writeFileSync(state, JSON.stringify({ version: '2.1.325 (Claude Code)',
        auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, help: flags.join('\n'), ...overrides }))
      // No ambient credentials, configuration or native CLI are available to the test.
      return spawnSync(process.execPath, [...args, script], { cwd: directory, encoding: 'utf8', timeout: 15_000,
        env: { PATH: [bin, dirname(process.execPath)].join(delimiter), HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_PRO_COMMAND: command, DOCTOR_CALLS: calls, DOCTOR_STATE: state, DOCTOR_TRAP: trap } })
    },
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    unexpected: () => existsSync(trap),
  }
}

test('doctor imports the exact installed official SDK and accepts native API authentication', t => {
  const f = fixture(t, { sdk: 'actual' })
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS  official Agent SDK/)
  assert.ok(result.stdout.includes(`${SDK_NAME}@${sdkVersion}`))
  assert.match(result.stdout, /PASS  native authentication/)
  assert.match(result.stdout, /actual SDK initialize response before sending its task prompt/)
  assert.doesNotMatch(result.stdout, /auth login|subscription|accessToken|refreshToken/)
  assert.deepEqual(f.calls(), [['--version'], ['auth', 'status'], ['--help']])
  assert.equal(f.unexpected(), false, 'the explicit command must not be replaced with a PATH fallback')
})

test('macOS doctor accepts API authentication without opening the keychain or inspecting tokens', t => {
  const f = fixture(t, { platform: 'darwin' })
  const result = f.run({ auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty',
    accessToken: 'fixture-secret-must-not-appear', refreshToken: 'fixture-refresh-must-not-appear' } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(f.unexpected(), false, 'no security/keychain command is authorized by doctor')
  assert.deepEqual(f.calls(), [['--version'], ['auth', 'status'], ['--help']])
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|fixture-refresh|accessToken|refreshToken/)
})

test('doctor refuses older, prerelease and unparseable CLI versions and accepts supported stable releases', t => {
  const f = fixture(t)
  for (const version of ['2.1.324 (Claude Code)', '2.1.325-beta.1 (Claude Code)', '2.1.325+test', 'missing', '1.99.999', '2.1.9007199254740992']) {
    const result = f.run({ version })
    assert.equal(result.status, 1, version)
    assert.match(result.stdout, /FAIL  SDK runtime version/)
    assert.match(result.stdout, /stable Claude Code >= 2\.1\.325/)
  }
  for (const version of ['2.1.325', '2.1.326 (Claude Code)', '2.2.0', '3.0.0']) {
    const result = f.run({ version })
    assert.equal(result.status, 0, `${version}: ${result.stdout}${result.stderr}`)
  }
})

test('doctor fails clearly for missing, mismatched or unusable SDK installations', t => {
  for (const sdk of ['missing', 'mismatch', 'broken', 'no-query']) {
    const f = fixture(t, { sdk })
    const result = f.run()
    assert.equal(result.status, 1, sdk)
    assert.match(result.stdout, /FAIL  official Agent SDK/)
    assert.match(result.stdout, /Reinstall this plugin and its pinned dependencies/)
    assert.match(result.stdout, /PASS  native authentication/)
    assert.doesNotMatch(result.stdout + result.stderr, /auth login|SDK fixture import failure/)
    assert.equal(f.unexpected(), false)
  }
})

test('doctor trusts only a successful native auth status and does not echo raw authentication diagnostics', t => {
  const f = fixture(t)
  for (const auth of [{ loggedIn: false }, null, [], {}, { loggedIn: 'true' }]) {
    const result = f.run({ auth })
    assert.equal(result.status, 1, JSON.stringify(auth))
    assert.match(result.stdout, /FAIL  native authentication/)
    assert.doesNotMatch(result.stdout, /auth login|keychain/)
  }
  for (const overrides of [{ authStatus: 1 }, { authRaw: 'fixture-private-auth-error' }]) {
    const result = f.run(overrides)
    assert.equal(result.status, 1)
    assert.match(result.stdout, /FAIL  native authentication/)
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-auth-error/)
  }
})

test('doctor requires successful capability help and version commands', t => {
  const f = fixture(t)
  for (const overrides of [{ helpStatus: 1 }, { help: flags.filter(flag => flag !== '--include-partial-messages').join('\n') }]) {
    const result = f.run(overrides)
    assert.equal(result.status, 1)
    assert.match(result.stdout, /FAIL  CLI flags/)
  }
  const result = f.run({ versionStatus: 1 })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL  claude executable/)
  assert.match(result.stdout, /FAIL  SDK runtime version/)
})
