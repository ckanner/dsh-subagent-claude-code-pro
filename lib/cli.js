/**
 * The local `claude` CLI contract: the argv this plugin builds, the child
 * environment it allows, and the permission choices it will forward.
 *
 * This plugin never uses the bundled Agent SDK payload. It drives the CLI the
 * user installed and logged in themselves, so the native settings, hooks, MCP
 * servers, model defaults, and credentials are the ones the person already
 * trusts. Only the invocation shape lives here.
 *
 * @module dsh-subagent-claude-code-pro/cli
 */

import { isAbsolute } from 'node:path'

/** Claude Code permission modes this plugin understands. */
export const PERMISSION_MODES = ['plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions']

/** How long a delegation's Claude Code session lives. */
export const SESSION_MODES = ['ephemeral', 'persistent', 'session']

/**
 * Credential-shaped environment names are never forwarded implicitly, the same
 * policy the harness's own subprocess seam applies. A credential the delegation
 * really needs is supplied through the plugin's explicit `env` configuration.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The permission choices a per-call override may select without expanding the
 * configured policy. `dontAsk` and `plan` can never make the child more
 * powerful; `acceptEdits` and above must be configured explicitly.
 *
 * @param {string | undefined} configured
 * @returns {readonly string[]}
 */
export function allowedPermissionModes(configured) {
  if (configured === 'bypassPermissions') return PERMISSION_MODES
  if (configured === 'auto') return ['plan', 'dontAsk', 'acceptEdits', 'auto']
  if (configured === 'acceptEdits') return ['plan', 'dontAsk', 'acceptEdits']
  // `dontAsk` may execute pre-approved operations, so it is wider than `plan`.
  // A policy configured as `plan` therefore stays plan-only.
  if (configured === 'plan') return ['plan']
  return ['plan', 'dontAsk']
}

/**
 * Resolve one call's permission mode against the configured policy.
 *
 * A call may narrow the policy, never widen it. Widening is a configuration
 * decision, not a prompt decision.
 *
 * @param {string} configured
 * @param {string | undefined} requested
 * @returns {string}
 */
export function resolvePermissionOverride(configured, requested) {
  const permission = requested ?? configured
  if (!allowedPermissionModes(configured).includes(permission)) {
    throw new Error(`claude-code-pro: permission_mode "${permission}" exceeds the configured "${configured}" policy; change the plugin configuration explicitly`)
  }
  return permission
}

/**
 * Build the child environment: the ambient environment minus DSH deployment
 * facts and credential-shaped names, then explicit configuration overrides.
 *
 * @param {Record<string, string>} configured
 * @param {NodeJS.ProcessEnv} [parent]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnvironment(configured, parent = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  return { ...env, ...configured }
}

/**
 * Resolve the CLI executable. A configured absolute path is authoritative;
 * otherwise the bare command is resolved by the child's PATH.
 *
 * @param {string} command
 * @returns {string}
 */
export function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) {
    if (!isAbsolute(command)) {
      throw new Error(`claude-code-pro: command must be absolute when it contains a path separator: ${command}`)
    }
  }
  return command
}

/**
 * Session-shaping arguments, exactly one shape at a time.
 *
 * `--session-id` and `--resume` are mutually exclusive; a forked resume is the
 * one documented combination.
 *
 * @param {{ kind: 'new' | 'resume' | 'ephemeral', sessionId?: string, resumeId?: string, forkSession?: boolean, name?: string }} session
 * @returns {string[]}
 */
export function sessionArguments(session) {
  if (session.kind === 'ephemeral') return ['--no-session-persistence']
  if (session.kind === 'resume') {
    if (session.resumeId === undefined) throw new Error('claude-code-pro: a resume run needs a session id')
    const args = ['--resume', session.resumeId]
    if (session.forkSession === true) args.push('--fork-session')
    return args
  }
  if (session.sessionId === undefined) throw new Error('claude-code-pro: a new durable run needs a session id')
  const args = ['--session-id', session.sessionId]
  if (session.name !== undefined && session.name !== '') args.push('-n', session.name)
  return args
}

/**
 * Build the complete argv for one delegation.
 *
 * The prompt itself always travels through stream-json stdin, so the same shape
 * carries text today and model-native content blocks (images, documents) once
 * they are enabled.
 *
 * @param {{
 *   session: { kind: 'new' | 'resume' | 'ephemeral', sessionId?: string, resumeId?: string, forkSession?: boolean, name?: string },
 *   permissionMode: string,
 *   model?: string,
 *   reasoningEffort?: string,
 *   settingSources?: readonly string[],
 *   outputSchema?: Record<string, unknown>,
 *   maxBudgetUsd?: number,
 * }} options
 * @returns {string[]}
 */
export function buildArguments(options) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', options.permissionMode,
    '--permission-prompts', 'none',
  ]
  if (options.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  if (options.model !== undefined) args.push('--model', options.model)
  if (options.reasoningEffort !== undefined) args.push('--effort', options.reasoningEffort)
  if (options.settingSources !== undefined) {
    args.push('--setting-sources', options.settingSources.join(','))
  }
  if (options.outputSchema !== undefined) args.push('--json-schema', JSON.stringify(options.outputSchema))
  if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  args.push(...sessionArguments(options.session))
  return args
}
