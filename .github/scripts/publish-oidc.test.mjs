import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { summarizeNpm, runPublish } from './publish-oidc.mjs'

const secret = 'fixture-sensitive-value-never-display'
const requestUrl = `https://example.invalid/oidc/request?credential=${secret}`
const exchangedUrl = `${requestUrl}&audience=npm%3Aregistry.npmjs.org`
const exchangeUrl = 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/dsh-subagent-claude-code-pro'
const environment = {
  GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: secret, NODE_AUTH_TOKEN: secret,
}

test('only known diagnostic categories, HTTP statuses and error codes survive free-form sensitive output', () => {
  const output = [
    `Authorization: Bearer ${secret}`,
    `NODE_AUTH_TOKEN=${secret}`,
    `npm verbose oidc Failed token exchange request with body message: ${secret}`,
    `npm verbose oidc Failure with message: ${secret}`,
    `npm error need auth ${secret}`,
    'npm error code ENEEDAUTH',
    `npm error code ${secret}`,
    `npm http fetch GET ${exchangedUrl} 200 9ms`,
    `npm http fetch POST 403 ${exchangeUrl} 11ms`,
    `npm http fetch POST 404 ${exchangeUrl} 12ms`,
    `npm http fetch PUT 403 https://registry.npmjs.org/dsh-subagent-claude-code-pro 13ms`,
    `npm http fetch POST 401 https://unrelated.invalid/${secret} 14ms`,
  ].join('\n')
  const result = summarizeNpm(output, requestUrl)
  assert.deepEqual(result, {
    oidc: ['exchange_failed', 'oidc_failed'], npmErrorCodes: ['ENEEDAUTH', 'OTHER'],
    httpStatus: { githubOidc: [200], registryExchange: [403, 404], registryPublish: [403] },
  })
  for (const text of [secret, requestUrl, 'Authorization', 'Bearer']) assert.equal(JSON.stringify(result).includes(text), false)
})

test('npm 12.2.1 fixed messages identify each authentication stage without repeating message bodies', () => {
  const messages = [
    ['Successfully retrieved and set token', 'exchange_succeeded'],
    ['Failed to fetch id_token from GitHub: received an invalid response', 'github_request_failed'],
    ['Failed to fetch id_token from GitHub: missing value', 'github_response_missing_token'],
    ['Failed because token exchange was missing the token in the response body', 'exchange_response_missing_token'],
    ['Skipped because incorrect permissions for id-token within GitHub workflow', 'github_oidc_environment_missing'],
    ['Skipped because no id_token available', 'oidc_token_unavailable'],
  ]
  for (const [message, expected] of messages) {
    const result = summarizeNpm(`\u001b[32mnpm verbose oidc ${message}\u001b[0m`, requestUrl)
    assert.deepEqual(result.oidc, [expected])
  }
  const otherUrl = `https://example.invalid/unrelated?audience=npm%3Aregistry.npmjs.org&token=${secret}`
  assert.deepEqual(summarizeNpm(`npm http fetch GET ${otherUrl} 401 3ms`, requestUrl).httpStatus.githubOidc, [])
  assert.deepEqual(summarizeNpm(`npm http fetch GET ${exchangedUrl} 401 3ms`, 'invalid URL').httpStatus.githubOidc, [])
})

test('npm receives the normal publish operation while terminal output contains only the safe summary', () => {
  for (const status of [0, 1, 37]) {
    const emitted = []
    const code = runPublish({ env: environment, write: text => emitted.push(text), spawn(command, args, options) {
      assert.equal(command, 'npm')
      assert.deepEqual(args, ['publish', '--access', 'public', '--provenance', '--loglevel=verbose', '--logs-max=0'])
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
      assert.equal(options.env.NODE_AUTH_TOKEN, '')
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, secret)
      return { status, stdout: secret, stderr: status === 0
        ? 'npm verbose oidc Successfully retrieved and set token'
        : `npm verbose oidc Failed token exchange request with body message: ${secret}\nnpm error code ENEEDAUTH` }
    } })
    assert.equal(code, status)
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].includes(secret), false)
    const summary = JSON.parse(emitted[0])
    assert.deepEqual(summary.oidcEnvironment, { githubActions: true, requestUrlPresent: true, requestTokenPresent: true })
    assert.equal(summary.exitCode, status)
    assert.equal(summary.outcome, status === 0 ? 'success' : 'failure')
  }
})

test('missing OIDC environment, process failures and cancellation remain failures without leaking error details', () => {
  for (const [result, expected] of [
    [{ status: null, signal: 'SIGTERM', stderr: secret }, 143],
    [{ status: null, signal: secret, stderr: secret }, 1],
    [{ status: null, error: Object.assign(new Error(secret), { code: 'ENOENT' }) }, 1],
    [{ status: 0, error: Object.assign(new Error(secret), { code: secret }) }, 1],
    [{ status: null }, 1],
  ]) {
    let text
    assert.equal(runPublish({ env: {}, spawn: () => result, write: value => { text = value } }), expected)
    assert.equal(text.includes(secret), false)
    assert.deepEqual(JSON.parse(text).oidcEnvironment, { githubActions: false, requestUrlPresent: false, requestTokenPresent: false })
    assert.equal(JSON.parse(text).outcome, 'failure')
  }
  let text
  assert.equal(runPublish({ env: {}, spawn() { throw new Error(secret) }, write: value => { text = value } }), 1)
  assert.equal(text.includes(secret), false)
})

test('the actual wrapper process preserves successful and failed npm exits without printing subprocess secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-release-diag-'))
  try {
    writeFileSync(join(directory, 'npm'), `#!/usr/bin/env node
process.stdout.write(process.env.FIXTURE_SECRET)
process.stderr.write('npm verbose oidc Failed token exchange request with body message: ' + process.env.FIXTURE_SECRET + '\\nnpm error code ENEEDAUTH\\n')
process.exitCode = Number(process.env.FIXTURE_EXIT)
`, { mode: 0o700 })
    const script = fileURLToPath(new URL('./publish-oidc.mjs', import.meta.url))
    for (const status of [0, 1, 37]) {
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, ...environment, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
          FIXTURE_SECRET: secret, FIXTURE_EXIT: String(status) },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      })
      assert.equal(result.status, status)
      assert.equal(result.stderr, '')
      assert.equal(result.stdout.includes(secret), false)
      assert.equal(JSON.parse(result.stdout).exitCode, status)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
