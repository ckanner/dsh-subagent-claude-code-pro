/** Native subscription admission. No credentials, account identifiers or balances leave this module. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { isPlainObject } from './util.js'
import { effortEnvironmentConflict, resolveSubscriptionModel } from './model-binding.js'

export const MACHINE_SUBSCRIPTION_VERSION = 1
export const SUBSCRIPTION_SDK_VERSION = '0.3.326'
export const MACHINE_SUBSCRIPTION_CAPABILITIES = Object.freeze({ version: 1, nativePreflight: true,
  sameProcessBeforePrompt: true, extraUsageEvidence: 'sdk-usage-0.3.326', callerAttestation: false })
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const PLANS = ['pro', 'max', 'team', 'enterprise']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY_FD', 'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_EXTRA_BODY']
const PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE']
const ownKeys = (value, allowed) => isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key))
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const nullableNumber = value => value === null || finite(value)
const nullableText = value => value === null || (typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))

export function parseSubscriptionRequest(value) {
  // Self-contained: DSH serializes this schema transform into its plain form.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['version', 'mode'].includes(key))
    || value.version !== 1 || value.mode !== 'subscription-only') {
    throw new Error('subscription must contain only version:1 and mode:"subscription-only"; caller billing attestations are not accepted')
  }
  return Object.freeze({ version: 1, mode: 'subscription-only' })
}

export function subscriptionReceipt(resolvedModel = null) {
  return { version: 1, mode: 'subscription-only', status: 'unknown', source: 'sdk-usage-0.3.326',
    checkedAt: null, apiProvider: null, subscriptionType: null, extraUsageEnabled: null, resolvedModel,
    scope: 'pre-prompt-snapshot', diagnostic: null }
}

function reject(detail) { throw new Error(detail) }
function environmentConflict(env) {
  for (const key of CREDENTIAL_KEYS) if (env[key]) reject(key + ' conflicts with native subscription-only authentication or request controls')
  for (const key of PROVIDER_KEYS) if (env[key] && !['0', 'false'].includes(env[key])) reject(key + ' selects an external provider')
}

/** Read configuration only, never credential files or keychains. Paths and raw values are not reported. */
function selectedSettings(cwd, env, sources) {
  const paths = new Map()
  const add = (path, source) => paths.set(path, source)
  const root = env.CLAUDE_CONFIG_DIR ? resolve(cwd, env.CLAUDE_CONFIG_DIR) : join(env.HOME || homedir(), '.claude')
  if (sources.includes('user')) add(join(root, 'settings.json'), 'user settings')
  const ancestors = []
  for (let path = cwd; ; path = dirname(path)) { ancestors.unshift(path); if (dirname(path) === path) break }
  for (const path of ancestors) {
    if (sources.includes('project')) add(join(path, '.claude', 'settings.json'), 'project settings')
    if (sources.includes('local')) add(join(path, '.claude', 'settings.local.json'), 'local settings')
  }
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'
  add(join(managed, 'managed-settings.json'), 'managed settings')
  try {
    for (const name of readdirSync(join(managed, 'managed-settings.d')).filter(name => name.endsWith('.json')).sort()) {
      add(join(managed, 'managed-settings.d', name), 'managed settings')
    }
  } catch (error) { if (error.code !== 'ENOENT') reject('managed settings could not be inspected before subscription admission') }
  const result = []
  for (const [path, source] of paths) {
    try {
      if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) reject('invalid settings file')
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!isPlainObject(value)) reject('invalid settings object')
      result.push({ source, value })
    } catch (error) {
      if (error.code !== 'ENOENT') reject(source + ' could not be inspected; resolve the native configuration before subscription admission')
    }
  }
  return result
}

/** Freeze aliases and reject known overrides before the CLI can receive a task. */
export function prepareSubscription({ subscription, cwd, env, query }) {
  parseSubscriptionRequest(subscription)
  const receipt = subscriptionReceipt()
  try {
    environmentConflict(env)
    const settings = selectedSettings(cwd, env, query.options.settingSources)
    const effectiveEnv = { ...env }
    for (const { source, value } of settings) {
      if (value.env !== undefined && (!isPlainObject(value.env) || Object.values(value.env).some(v => typeof v !== 'string' || v.includes('\0')))) reject(source + ' has an invalid environment')
      environmentConflict(value.env ?? {})
      Object.assign(effectiveEnv, value.env ?? {})
      if (value.apiKeyHelper || value.forceLoginGatewayUrl || (value.forceLoginMethod && value.forceLoginMethod !== 'claudeai')) reject(source + ' selects API, console or gateway authentication')
      if (value.fallbackModel !== undefined && (!Array.isArray(value.fallbackModel) || value.fallbackModel.length)) reject(source + ' enables model fallback; subscription bindings must not silently switch models')
      if (value.fastMode === true) reject(source + ' enables fast mode; disable it in the native configuration before using subscription-only')
    }
    const descriptor = structuredClone(query)
    descriptor.options.model = resolveSubscriptionModel(query.options.model, effectiveEnv)
    receipt.resolvedModel = descriptor.options.model
    const bindings = [{ model: descriptor.options.model, effort: descriptor.options.effort }]
    for (const definition of Object.values(descriptor.options.agents ?? {})) {
      if (definition.model && definition.model !== 'inherit') definition.model = resolveSubscriptionModel(definition.model, effectiveEnv)
      bindings.push({ model: definition.model === 'inherit' || !definition.model ? descriptor.options.model : definition.model,
        effort: definition.effort ?? descriptor.options.effort })
    }
    if (descriptor.options.extraArgs?.advisor) descriptor.options.extraArgs.advisor = resolveSubscriptionModel(descriptor.options.extraArgs.advisor, effectiveEnv)
    for (const binding of bindings) {
      const conflict = effortEnvironmentConflict(binding.effort, effectiveEnv)
      if (conflict) reject(conflict)
      for (const { source, value } of settings) {
        const cap = value.modelSettings?.[binding.model]?.maxEffortLevel
          ?? value.modelSettings?.[binding.model.replace(/\[1m\]$/, '')]?.maxEffortLevel ?? value.maxEffortLevel
        if (cap !== undefined && (!EFFORTS.includes(cap) || (binding.effort && EFFORTS.indexOf(binding.effort) > EFFORTS.indexOf(cap)))) reject(source + ' caps the requested effort; resolve the conflict before dispatch')
      }
    }
    // Explicit invocation settings take precedence over ordinary local config.
    // Managed/provider decisions are additionally verified from this SDK session.
    descriptor.options.settings = { ...descriptor.options.settings, fallbackModel: [], fastMode: false, forceLoginMethod: 'claudeai' }
    return { query: descriptor, env: { ...env, CLAUDE_CODE_DISABLE_FAST_MODE: '1' }, receipt }
  } catch (error) {
    receipt.status = 'blocked'; receipt.diagnostic = error.message
    error.subscription = receipt
    throw error
  }
}

/** Exact 0.3.326 response contract used by admission. Additions require a deliberate adapter update. */
export function validUsageResponse(value) {
  if (!ownKeys(value, ['session', 'subscription_type', 'rate_limits_available', 'rate_limits', 'behaviors'])
    || !['session', 'subscription_type', 'rate_limits_available', 'rate_limits', 'behaviors'].every(key => Object.hasOwn(value, key))
    || !ownKeys(value.session, ['total_cost_usd', 'total_api_duration_ms', 'total_duration_ms', 'total_lines_added', 'total_lines_removed', 'model_usage'])
    || !['total_cost_usd', 'total_api_duration_ms', 'total_duration_ms', 'total_lines_added', 'total_lines_removed'].every(key => finite(value.session[key]))
    || !isPlainObject(value.session.model_usage) || (value.subscription_type !== null && !PLANS.includes(value.subscription_type))
    || typeof value.rate_limits_available !== 'boolean' || value.behaviors !== null) return false
  for (const usage of Object.values(value.session.model_usage)) {
    const required = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
      'webSearchRequests', 'costUSD', 'contextWindow', 'maxOutputTokens']
    const optional = ['thinkingTokens', 'cacheCreationEphemeral5mInputTokens', 'cacheCreationEphemeral1hInputTokens']
    if (!ownKeys(usage, [...required, ...optional, 'canonicalModel', 'provider', 'costBasis'])
      || !required.every(key => finite(usage[key])) || !optional.every(key => usage[key] === undefined || finite(usage[key]))
      || !['canonicalModel', 'provider'].every(key => usage[key] === undefined || (typeof usage[key] === 'string' && nullableText(usage[key])))
      || (usage.costBasis !== undefined && !['list', 'managed', 'unknown'].includes(usage.costBasis))) return false
  }
  if (value.rate_limits === null) return value.rate_limits_available === false
  const rates = value.rate_limits
  const windows = ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']
  if (!ownKeys(rates, [...windows, 'model_scoped', 'extra_usage']) || value.rate_limits_available !== true) return false
  for (const key of windows) if (rates[key] !== undefined && rates[key] !== null
    && (!ownKeys(rates[key], ['utilization', 'resets_at']) || !nullableNumber(rates[key].utilization) || !nullableText(rates[key].resets_at))) return false
  if (rates.model_scoped !== undefined && (!Array.isArray(rates.model_scoped) || rates.model_scoped.some(row => !ownKeys(row, ['display_name', 'utilization', 'resets_at'])
    || typeof row.display_name !== 'string' || !nullableNumber(row.utilization) || !nullableText(row.resets_at)))) return false
  const extra = rates.extra_usage
  if (extra !== undefined && extra !== null && (!ownKeys(extra, ['is_enabled', 'monthly_limit', 'used_credits', 'utilization', 'currency'])
    || typeof extra.is_enabled !== 'boolean' || !['monthly_limit', 'used_credits', 'utilization'].every(key => nullableNumber(extra[key]))
    || (extra.currency !== undefined && !nullableText(extra.currency)))) return false
  return true
}

/** Read only public controls in the initialized query. This never submits a model prompt. */
export async function observeSubscription(sdk, previous) {
  const receipt = { ...previous, checkedAt: new Date().toISOString() }
  const fail = (status, diagnostic) => ({ ...receipt, status, diagnostic })
  if (typeof sdk.accountInfo !== 'function' || typeof sdk[USAGE_METHOD] !== 'function') return fail('unknown', 'the pinned SDK usage/account controls are unavailable; no task prompt was sent')
  try {
    const account = await sdk.accountInfo()
    if (!isPlainObject(account) || account.apiProvider !== 'firstParty' || !PLANS.includes(account.subscriptionType)) return fail('blocked', 'the initialized native CLI did not confirm a first-party Claude subscription; no task prompt was sent')
    receipt.apiProvider = 'firstParty'; receipt.subscriptionType = account.subscriptionType
    const usage = await sdk[USAGE_METHOD]({ skipBehaviors: true })
    receipt.checkedAt = new Date().toISOString()
    if (!validUsageResponse(usage)) return fail('unknown', 'native usage evidence did not match the pinned SDK contract; no task prompt was sent')
    if (!usage.rate_limits_available || usage.subscription_type !== account.subscriptionType) return fail('unknown', 'native subscription and usage evidence were unavailable or inconsistent; no task prompt was sent')
    const enabled = usage.rate_limits?.extra_usage?.is_enabled
    receipt.extraUsageEnabled = typeof enabled === 'boolean' ? enabled : null
    if (enabled === true) return fail('blocked', 'native extra usage is enabled; disable it in the official account settings before using subscription-only')
    if (enabled !== false) return fail('unknown', 'native extra usage status is unknown; no task prompt was sent')
    return { ...receipt, status: 'verified', diagnostic: null }
  } catch {
    return fail('unknown', 'native subscription usage lookup failed; no task prompt was sent')
  }
}
