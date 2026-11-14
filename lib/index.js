/**
 * The plugin entry: config, per-Agent delegation tool, and one delegation's
 * session/run orchestration.
 *
 * The execution target is the user's own `claude` CLI. Nothing here downloads
 * or ships a Claude Code runtime, and nothing here creates or rewrites login
 * state: the CLI a person installed and authenticated is the one that runs.
 *
 * Two harness facts shape the design:
 * 1. DSH's subagent seam treats externally executed children as one-shot, so a
 *    provider cannot own a resumable conversation. This plugin therefore
 *    registers its own model-facing tool (the Codex Pro path) instead of using
 *    `dsh-tool-subagent`.
 * 2. A plugin has no log surface, so every decision that can fail quietly is
 *    appended to `$DSH_HOME/claude-code-pro.log`.
 *
 * @module dsh-subagent-claude-code-pro
 */

import { randomUUID } from 'node:crypto'
export { Config } from './config.js'
import { readNativeDefault, resolveDesktopNative, desktopSessionIdentity, desktopNativeEnvironment, requireNativeCompletion, nativeSummary } from './native-desktop.js'
import { nativeControls } from './native.js'
import { createNativeJobTool } from './desktop-native-jobs.js'
import { createRequire } from 'node:module'

import { settleJob } from './background.js'
import {
  PERMISSION_MODES,
  SESSION_MODES,
  buildArguments,
  childEnvironment,
  resolveCommand,
  resolvePermissionOverride,
} from './cli.js'
import { deliverImages } from './deliver.js'
import { readDocuments, readImages } from './inputs.js'
import { userMessageLine } from './protocol.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_RUN_TIMEOUT_MS, runClaude } from './run.js'
import {
  chooseSession,
  isStaleSessionFailure,
  sessionMarker,
  sessionNameFor,
  shouldRemember,
} from './sessions.js'
import { checkedOutputSchema, validateJsonSchemaValue } from './structured.js'
import { createClaudeCodeTool } from './tool.js'
import {
  ClaudeCodeProFailure,
  checkedDirectory,
  checkedNonNegativeNumber,
  checkedString,
  diag,
  errorMessage,
  isPlainObject,
  optionalString,
} from './util.js'

/** Cordis plugin name. */
export const name = 'claude-code-pro'

/** This package's version, read once for the diagnostic line. */
const PLUGIN_VERSION = (() => {
  try {
    const require_ = createRequire(import.meta.url)
    const pkg = require_('../package.json')
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

const DEFAULT_SETTING_SOURCES = ['user', 'project', 'local']

/** Resolve and validate the plugin configuration. */
export function resolveConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const config = {
    toolName: input.toolName === undefined ? 'subagent_claude_code' : checkedString('toolName', input.toolName),
    command: input.command === undefined ? 'claude' : checkedString('command', input.command),
    presets: input.presets === undefined
      ? ['daily', 'heavy']
      : (Array.isArray(input.presets) ? input.presets.map((preset) => checkedString('presets[]', preset)) : null),
    modelSelection: input.modelSelection === undefined ? true : input.modelSelection,
    permissionMode: input.permissionMode === undefined ? 'dontAsk' : checkedString('permissionMode', input.permissionMode),
    sessionMode: input.sessionMode === undefined ? 'session' : checkedString('sessionMode', input.sessionMode),
    runTimeoutMs: input.runTimeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : checkedNonNegativeNumber('runTimeoutMs', input.runTimeoutMs),
    disposeGraceMs: input.disposeGraceMs === undefined ? DEFAULT_DISPOSE_GRACE_MS : checkedNonNegativeNumber('disposeGraceMs', input.disposeGraceMs),
    model: optionalString('model', input.model),
    reasoningEffort: optionalString('reasoningEffort', input.reasoningEffort),
    settingSources: input.settingSources === undefined
      ? [...DEFAULT_SETTING_SOURCES]
      : (Array.isArray(input.settingSources) ? input.settingSources.map((source) => checkedString('settingSources[]', source)) : null),
    env: input.env === undefined ? {} : input.env,
  }
  if (config.presets === null) throw new Error('claude-code-pro: presets must be an array of preset ids')
  if (config.settingSources === null) throw new Error('claude-code-pro: settingSources must be an array')
  if (!/^[A-Za-z0-9_-]+$/.test(config.toolName)) {
    throw new Error(`claude-code-pro: toolName must contain only letters, digits, "_" and "-": ${config.toolName}`)
  }
  if (!PERMISSION_MODES.includes(config.permissionMode)) {
    throw new Error(`claude-code-pro: permissionMode must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  if (!SESSION_MODES.includes(config.sessionMode)) {
    throw new Error(`claude-code-pro: sessionMode must be one of ${SESSION_MODES.join(', ')}`)
  }
  if (typeof config.modelSelection !== 'boolean') throw new Error('claude-code-pro: modelSelection must be a boolean')
  if (!isPlainObject(config.env)) throw new Error('claude-code-pro: env must be an object of strings')
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== 'string') throw new Error(`claude-code-pro: env.${key} must be a string`)
  }
  for (const source of config.settingSources) {
    if (!['user', 'project', 'local'].includes(source)) {
      throw new Error(`claude-code-pro: settingSources entries must be user, project or local: ${source}`)
    }
  }
  resolveCommand(config.command)
  readNativeDefault(input.native)
  Object.defineProperty(config, 'native', { enumerable: true, get: () => readNativeDefault(input.native) })
  return Object.freeze(config)
}

/**
 * Whether one Agent's committed preset is one this plugin serves.
 *
 * The preset registry is authoritative; the Session header is only the value
 * the session was created with, which the picker replaces afterwards.
 */
function presetAllows(ctx, agent, presets) {
  const registry = ctx.get?.('agentPresets')
  let composed
  let composeError
  try {
    composed = registry?.composedPreset?.(agent.ctx)
  } catch (error) {
    composeError = error
  }
  const header = agent?.session?.header?.agentPreset
  const preset = composed ?? header
  const allowed = typeof preset === 'string' && presets.includes(preset)
  diag(`decide ${String(agent?.id)} composed=${String(composed)} header=${String(header)} err=${String(composeError)} -> ${allowed ? 'serve' : 'skip'}`)
  return allowed
}

/**
 * Validate a schema-constrained answer.
 *
 * The CLI enforces the schema, but this plugin does not trust that the answer it
 * received is still what it asked for. A run that asked for JSON and got prose
 * fails; it does not report success with structured output absent.
 */
function structuredAnswer(result, schema) {
  let value
  if (result.structuredOutput !== undefined) {
    value = result.structuredOutput
  } else {
    try {
      value = JSON.parse(result.text)
    } catch {
      throw new ClaudeCodeProFailure({
        stage: 'query-run',
        category: 'structured-output',
        detail: 'the CLI returned a non-JSON answer for a schema-constrained delegation',
      })
    }
  }
  const violations = validateJsonSchemaValue(schema, value)
  if (violations.length > 0) {
    throw new ClaudeCodeProFailure({
      stage: 'query-run',
      category: 'structured-output',
      detail: violations.slice(0, 5).join('; '),
    })
  }
  return result.text
}

/**
 * Register the plugin on a Cordis context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const jobs = ctx.get?.('jobs')
  diag(`apply: v${PLUGIN_VERSION} command=${JSON.stringify(config.command)} tool=${config.toolName} `
    + `presets=${JSON.stringify(config.presets)} sessionMode=${config.sessionMode} `
    + `permission=${config.permissionMode} timeout=${String(config.runTimeoutMs)}ms `
    + `jobs=${jobs === undefined ? 'absent' : 'present'}`)

  if (typeof ctx.on !== 'function') return

  /** Durable Claude Code session each DSH Agent session remembers. */
  const rememberedSessions = new Map()
  /** Claude Code sessions currently carrying a delegation. */
  const inFlight = new Set()
  const sessionBindings = new Map()

  /**
   * Run one delegation.
   *
   * @param {any} agent
   * @param {string} defaultCwd
   * @param {any} call
   * @param {AbortSignal} signal
   * @param {{ background?: boolean, onEvent?: (text: string) => void }} [runtime]
   * @returns {Promise<{ content: { type: string, text?: string, attachment?: unknown }[], text: string }>}
   */
  const runCall = async (agent, defaultCwd, call, signal, runtime = {}) => {
    const agentKey = String(agent.id)
    const runCwd = call.cwd === undefined ? defaultCwd : checkedDirectory('cwd', call.cwd)
    const timeoutMs = call.timeoutMs === undefined
      ? config.runTimeoutMs
      : checkedNonNegativeNumber('timeout_ms', call.timeoutMs)
    const permissionMode = resolvePermissionOverride(config.permissionMode, call.permissionMode)
    const model = call.model ?? config.model
    const reasoningEffort = call.reasoningEffort ?? config.reasoningEffort
    const native = resolveDesktopNative(config.native, call.native, permissionMode, config.modelSelection)
    const nativeControl = nativeControls(native)
    const identity = desktopSessionIdentity({ cwd: runCwd, native, permissionMode, model, reasoningEffort,
      settingSources: config.settingSources, env: config.env })
    const images = readImages(call.images)
    const documents = readDocuments(call.documents)
    const outputSchema = call.outputSchema === undefined ? undefined : checkedOutputSchema(call.outputSchema)
    const startedAt = Date.now()
    const remaining = () => (timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 0)
    const deadlinePassed = () => timeoutMs > 0 && Date.now() - startedAt >= timeoutMs

    const previous = rememberedSessions.get(agentKey)
    const remembered = previous?.identity === identity ? previous : undefined
    const explicit = call.sessionId
    if (explicit !== undefined && sessionBindings.has(explicit) && sessionBindings.get(explicit) !== identity) {
      throw new Error('claude-code-pro: this session was created with different native/model/permission settings; start a fresh session')
    }
    const busy = explicit !== undefined
      ? inFlight.has(explicit)
      : remembered !== undefined
        ? inFlight.has(remembered.sessionId)
        : false
    if (explicit !== undefined && busy) {
      throw new Error(`claude-code-pro: session ${explicit} is busy with another delegation; wait for it to finish`)
    }

    let choice = chooseSession({
      explicitSessionId: explicit,
      requestedMode: call.sessionMode,
      configuredMode: config.sessionMode,
      remembered,
      cwd: runCwd,
      busy,
    })
    let newSessionId = choice.kind === 'new' ? randomUUID() : undefined
    let claimed = choice.kind === 'resume' ? choice.resumeId : undefined
    if (claimed !== undefined) inFlight.add(claimed)
    if (busy && choice.kind === 'new') {
      diag('run: the remembered session is busy with another delegation; this call starts its own')
    }

    const attempt = async (currentChoice, sessionIdForNew) => {
      const session = currentChoice.kind === 'resume'
        ? { kind: 'resume', resumeId: currentChoice.resumeId, ...(call.forkSession === true ? { forkSession: true } : {}) }
        : currentChoice.kind === 'ephemeral'
          ? { kind: 'ephemeral' }
          : { kind: 'new', sessionId: sessionIdForNew ?? randomUUID(), name: sessionNameFor(call.label) }
      const args = buildArguments({
        session,
        permissionMode,
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
        settingSources: config.settingSources,
      })
      diag(`run: model=${model ?? '<native>'} effort=${reasoningEffort ?? '<native>'} `
        + `session=${currentChoice.kind}${currentChoice.kind === 'resume' ? ` resume=${currentChoice.resumeId}` : ''} `
        + `permission=${permissionMode} cwd=${runCwd} timeout=${String(timeoutMs)}ms `
        + `images=${String(images.length)} documents=${String(documents.length)} `
        + `schema=${outputSchema === undefined ? 'none' : 'yes'} prompt=${String(call.prompt.length)}B via=local-cli`)
      if (currentChoice.runtimeMode !== 'ephemeral') sessionBindings.set(
        currentChoice.kind === 'resume' ? currentChoice.resumeId : sessionIdForNew, identity)
      return runClaude({
        command: config.command,
        args: [...args, ...nativeControl.args],
        cwd: runCwd,
        env: desktopNativeEnvironment(config.env, native),
        ...(native === undefined ? {} : { native, onNativeEvent: event => {
          diag('native event: ' + JSON.stringify(event))
          runtime.onEvent?.('[claude native] ' + JSON.stringify(event) + '\n')
        } }),
        input: userMessageLine({ text: call.prompt, images, documents }),
        timeoutMs: remaining(),
        signal,
        disposeGraceMs: config.disposeGraceMs,
        ...(runtime.onEvent === undefined
          ? {}
          : { onEvent: (event) => { if (event.type === 'assistant-text') runtime.onEvent?.(event.text) } }),
      })
    }

    /** Turn a completed run into the value the tool returns. */
    const finish = async (result, currentChoice, sessionIdForNew) => {
      if (result.stopReason === 'aborted') {
        const error = new Error('claude-code-pro: delegation cancelled by caller')
        error.run = result
        throw error
      }
      requireNativeCompletion(result)
      if (result.native) result.native.usage = { ...result.native.usage, root: result.usage ?? null,
        aggregateFamilyStatus: result.native.children.length ? 'unknown' : result.usage ? 'observed' : 'unknown' }
      const machineOutput = outputSchema !== undefined
      const durable = shouldRemember(currentChoice.runtimeMode)
      const sessionId = result.sessionId
        ?? (currentChoice.kind === 'resume' ? currentChoice.resumeId : sessionIdForNew)
      if (durable && typeof sessionId === 'string') {
        rememberedSessions.set(agentKey, { sessionId, cwd: runCwd, name: sessionNameFor(call.label), identity })
        sessionBindings.set(sessionId, identity)
      }
      let text = machineOutput ? structuredAnswer(result, outputSchema) : result.text
      if (!machineOutput && durable && typeof sessionId === 'string') {
        text = `${text}\n\n${sessionMarker(sessionId)}`
      }

      const runId = randomUUID()
      const delivered = await deliverImages({
        ctx,
        agent,
        images: result.images ?? [],
        background: runtime.background === true,
        runId,
      })
      if (!machineOutput && delivered.note !== '') text = `${text}\n\n${delivered.note}`
      const content = [{ type: 'text', text }, ...delivered.blocks]

      diag(`run done: len=${String(text.length)} session=${sessionId ?? '<none>'} `
        + `model=${result.init?.model ?? '<unknown>'} cli=${result.init?.cliVersion ?? '<unknown>'} `
        + `images=${String(result.images?.length ?? 0)} delivered=${String(delivered.blocks.length)} `
        + `schema=${machineOutput ? 'yes' : 'no'} `
        + `cleanup=${result.cleanupConfirmed === true ? 'confirmed' : 'unconfirmed'} `
        + `cacheRead=${String(result.usage?.cache_read_input_tokens ?? 0)}`)
      return { content, text, ...(result.native === undefined ? {} : { native: result.native }) }
    }

    try {
      const result = await attempt(choice, newSessionId)
      return await finish(result, choice, newSessionId)
    } catch (error) {
      if (error?.run?.native && !error.message.includes('; native=')) {
        error.message += '; native=' + nativeSummary(error.run.native)
      }
      // A remembered session can be gone (deleted, or the CLI moved its
      // storage). That bookkeeping is ours, so a fresh session is the right
      // repair. An id the caller passed explicitly is never repaired silently:
      // continuing that conversation was the whole request.
      if (
        choice.kind === 'resume'
        && choice.explicit === false
        && isStaleSessionFailure(error?.facts)
      ) {
        rememberedSessions.delete(agentKey)
        if (claimed !== undefined) inFlight.delete(claimed)
        claimed = undefined
        if (deadlinePassed()) throw error
        diag(`run: remembered session ${choice.resumeId} could not be resumed (${errorMessage(error)}); `
          + `starting a fresh session with ${String(timeoutMs > 0 ? timeoutMs - (Date.now() - startedAt) : 'no')}ms remaining`)
        choice = { kind: 'new', runtimeMode: 'persistent' }
        newSessionId = randomUUID()
        const result = await attempt(choice, newSessionId)
        return await finish(result, choice, newSessionId)
      }
      throw error
    } finally {
      if (claimed !== undefined) inFlight.delete(claimed)
    }
  }

  /** Register the delegation tool for one Agent. */
  const serve = (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      diag(`serve ${String(agent?.id)}: skipped, the session has no working directory`)
      return
    }

    /**
     * Start one delegation as a DSH background job.
     *
     * The jobs service is the harness's own background mechanism (the same one
     * Codex Pro and the official subagent tools use); Claude Code's `--bg` is a
     * terminal-session feature, not a tool result channel.
     */
    const startBackground = (call) => {
      if (jobs === undefined) {
        throw new Error('claude-code-pro: background runs need the jobs service (@deepseek-ai/dsh-jobs)')
      }
      const controller = new AbortController()
      const id = jobs.start({
        kind: 'subagent',
        label: call.label,
        owner: String(agent.id),
        run: (handle) => {
          handle.updateProgress('starting Claude Code delegation')
          return {
            cancel: (reason) => {
              controller.abort(new Error(reason ?? 'claude-code delegation killed'))
            },
            done: settleJob(
              runCall(agent, cwd, call, controller.signal, {
                background: true,
                onEvent: (text) => {
                  try {
                    handle.append(text)
                  } catch {
                    // Progress reporting must never fail the delegation.
                  }
                },
              })
                .then((result) => {
                  if (result.native) {
                    try { handle.append('[claude native result] ' + nativeSummary(result.native) + '\n') } catch { /* Display only. */ }
                  }
                  return result.text + (result.native && call.outputSchema === undefined ? '\n\n[claude native result] ' + nativeSummary(result.native) : '')
                })
                .finally(() => {
                  handle.updateProgress('')
                }),
            ),
          }
        },
      })
      diag(`serve ${String(agent.id)}: background job ${id} started for "${call.label}"`)
      return id
    }

    try {
      agent.ctx.tools.register(createClaudeCodeTool({
        toolName: config.toolName,
        cwd,
        modelSelectionEnabled: config.modelSelection,
        backgroundEnabled: jobs !== undefined,
        permissionMode: config.permissionMode,
        sessionMode: config.sessionMode,
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        run: async (call, signal) => {
          const result = await runCall(agent, cwd, call, signal)
          return { content: result.content, ...(result.native === undefined ? {} : { native: result.native }) }
        },
        startBackground,
      }))
      agent.ctx.tools.register(createNativeJobTool({ agent, config, jobs, cwd }))
      diag(`serve ${String(agent.id)}: ${config.toolName} registered (modelSelection=${String(config.modelSelection)}, `
        + `background=${String(jobs !== undefined)}, sessionMode=${config.sessionMode}, command=${JSON.stringify(config.command)})`)
    } catch (error) {
      diag(`serve ${String(agent?.id)} FAILED: ${errorMessage(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined) return
    if (!presetAllows(ctx, agent, config.presets)) return
    serve(agent)
  })
  ctx.on('agent-preset/selected', (sessionId, presetId) => {
    if (!config.presets.includes(presetId)) return
    const agents = ctx.get?.('agents')
    const agent = agents?.get?.(String(sessionId))
    if (agent === undefined) {
      diag(`preset/selected ${String(sessionId)}: no live agent`)
      return
    }
    serve(agent)
  })
}
