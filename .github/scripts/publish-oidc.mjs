// Release-only wrapper: never print npm's raw output, credentials or request URLs.
// Message matches follow npm 12.2.1's lib/utils/oidc.js and lib/commands/publish.js:
// https://github.com/npm/cli/blob/v12.2.1/lib/utils/oidc.js
// https://github.com/npm/cli/blob/v12.2.1/lib/commands/publish.js
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageName = 'dsh-subagent-claude-code-pro'
const registry = 'https://registry.npmjs.org'
const npmCodes = new Set([
  'ENEEDAUTH', 'E401', 'E403', 'E404', 'EOTP', 'EUSAGE', 'EJSONPARSE', 'EINTEGRITY',
  'EPUBLISHCONFLICT', 'EUNSCOPED', 'EBADENGINE', 'EPRIVATE', 'EPROVENANCE',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS',
])
const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }
const oidcMessages = [
  ['Successfully retrieved and set token', 'exchange_succeeded'],
  ['Failed to fetch id_token from GitHub: received an invalid response', 'github_request_failed'],
  ['Failed to fetch id_token from GitHub: missing value', 'github_response_missing_token'],
  ['Failed because token exchange was missing the token in the response body', 'exchange_response_missing_token'],
  ['Skipped because incorrect permissions for id-token within GitHub workflow', 'github_oidc_environment_missing'],
  ['Skipped because no id_token available', 'oidc_token_unavailable'],
]

function safeCode(value) {
  return npmCodes.has(value) ? value : 'OTHER'
}

function parsedUrl(value) {
  try { return new URL(value) } catch { return undefined }
}

export function summarizeNpm(output, requestUrl) {
  const categories = new Set()
  const codes = new Set()
  const http = { githubOidc: new Set(), registryExchange: new Set(), registryPublish: new Set() }
  const expectedGithub = parsedUrl(requestUrl)
  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    const code = /^npm error code (\S+)$/.exec(line)
    if (code) codes.add(safeCode(code[1]))
    const message = /^npm (?:verbose|silly) oidc (.*)$/.exec(line)?.[1]
    if (message) {
      for (const [text, category] of oidcMessages) if (message === text) categories.add(category)
      // The registry's free-form error body can contain sensitive information.
      // Emit only the fact of failure, never the text after these prefixes.
      if (message.startsWith('Failed token exchange request with body message: ')) categories.add('exchange_failed')
      if (message.startsWith('Failure with message: ')) categories.add('oidc_failed')
      if (message.startsWith('Failed to set provenance with message: ')) categories.add('provenance_configuration_failed')
    }
    // npm-registry-fetch logs METHOD STATUS URL; npm's GitHub OIDC helper logs
    // GET URL STATUS. Only return status codes for the exact known operations.
    const registryFetch = /^npm http fetch (POST|PUT) ([1-5]\d{2}) (\S+)(?:\s|$)/.exec(line)
    if (registryFetch) {
      const url = parsedUrl(registryFetch[3])
      if (url?.origin === registry && url.pathname === `/-/npm/v1/oidc/token/exchange/package/${packageName}` && registryFetch[1] === 'POST') {
        http.registryExchange.add(Number(registryFetch[2]))
      }
      if (url?.origin === registry && url.pathname === `/${packageName}` && registryFetch[1] === 'PUT') {
        http.registryPublish.add(Number(registryFetch[2]))
      }
    }
    const githubFetch = /^npm http fetch GET (\S+) ([1-5]\d{2}) \d+ms$/.exec(line)
    if (githubFetch && expectedGithub) {
      const url = parsedUrl(githubFetch[1])
      if (url?.origin === expectedGithub.origin && url.pathname === expectedGithub.pathname &&
          url.searchParams.get('audience') === 'npm:registry.npmjs.org') http.githubOidc.add(Number(githubFetch[2]))
    }
  }
  return {
    oidc: [...categories].sort(),
    npmErrorCodes: [...codes].sort(),
    httpStatus: Object.fromEntries(Object.entries(http).map(([key, values]) => [key, [...values].sort((a, b) => a - b)])),
  }
}

export function runPublish({ env = process.env, spawn = spawnSync, write = value => console.log(value) } = {}) {
  const oidcEnvironment = {
    githubActions: env.GITHUB_ACTIONS === 'true',
    requestUrlPresent: Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL),
    requestTokenPresent: Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
  }
  let result
  try {
    result = spawn('npm', ['publish', '--access', 'public', '--provenance', '--loglevel=verbose', '--logs-max=0'], {
      env: { ...env, NODE_AUTH_TOKEN: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) { result = { error } }
  const exitCode = Number.isInteger(result.status) && result.status >= 0 && !result.error && !result.signal
    ? result.status : (Object.hasOwn(signalCodes, result.signal) ? signalCodes[result.signal] : 1)
  const diagnostics = summarizeNpm(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, env.ACTIONS_ID_TOKEN_REQUEST_URL)
  write(JSON.stringify({
    oidcEnvironment, outcome: exitCode === 0 ? 'success' : 'failure', exitCode,
    ...diagnostics,
    ...(result.error ? { processErrorCode: safeCode(result.error.code) } : {}),
    ...(result.signal ? { signal: Object.hasOwn(signalCodes, result.signal) ? result.signal : 'OTHER' } : {}),
  }))
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runPublish()
}
