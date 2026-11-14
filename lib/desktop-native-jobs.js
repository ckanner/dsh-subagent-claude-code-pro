/** DSH-owned entry points for independent native jobs; never part of ordinary delegation. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as homePaths from '@deepseek-ai/dsh-home-paths'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { runNativeReview, runInteractiveTeam, recoverNativeJob, controlInteractiveTeam, validateNativeReviewRequest, validateInteractiveTeamRequest } from './native-jobs.js'
import { resolvePermissionOverride } from './cli.js'
import { checkedDirectory, isPlainObject, errorMessage } from './util.js'
import { NATIVE_TOOL_SCHEMA, resolveDesktopNative, desktopNativeEnvironment } from './native-desktop.js'

const apiDefault = { runNativeReview, runInteractiveTeam, recoverNativeJob, controlInteractiveTeam, validateNativeReviewRequest, validateInteractiveTeamRequest }
const credentials = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']
const hash = value => createHash('sha256').update(value).digest('hex')
const text = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || Buffer.byteLength(value) > 65536) throw new Error(name + ' must be a non-empty bounded string')
  return value
}
function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()) || realpathSync(path) !== path) {
    throw new Error('native job storage must be a private, owned physical directory')
  }
  return path
}
function ownerDirectory(owner) {
  // The latest desktop has dshPath; the published same-version helper predates it.
  const data = typeof homePaths.dshPath === 'function' ? homePaths.dshPath('data')
    : join(typeof homePaths.resolveDshHome === 'function' ? homePaths.resolveDshHome()
      : resolve(process.env.DSH_HOME?.trim() ? process.env.DSH_HOME === '~' ? homedir() : process.env.DSH_HOME.startsWith('~/') ? join(homedir(), process.env.DSH_HOME.slice(2)) : process.env.DSH_HOME : join(homedir(), '.dsh')), 'data')
  mkdirSync(data, { recursive: true, mode: 0o700 })
  const plugin = privateDirectory(join(realpathSync(data), 'claude-code-pro'))
  const root = privateDirectory(join(plugin, 'native-jobs'))
  return privateDirectory(join(root, hash(owner)))
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function paths(owner, jobId) {
  const directory = ownerDirectory(owner)
  const key = hash(text(jobId, 'job_id'))
  return { directory, record: join(directory, key + '.json'), recoveryDirectory: join(directory, key) }
}
function writeMapping(location, value, exclusive = false) {
  const temporary = exclusive ? location.record : join(location.directory, '.mapping-' + randomUUID())
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    if (!exclusive) renameSync(temporary, location.record)
    syncDirectory(location.directory)
  } finally {
    if (!exclusive) try { unlinkSync(temporary) } catch { /* already renamed */ }
  }
}
function readMapping(owner, jobId) {
  const location = paths(owner, jobId)
  const fd = openSync(location.record, constants.O_RDONLY | constants.O_NOFOLLOW)
  let mapping
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('untrusted native job ownership record')
    mapping = JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
  if (mapping.version !== 1 || mapping.owner !== owner || mapping.jobId !== jobId || mapping.requestId !== jobId
    || !['native-review', 'interactive-team'].includes(mapping.operation)
    || (mapping.runId !== null && !/^[0-9a-f-]{36}$/i.test(mapping.runId))
    || typeof mapping.ready !== 'boolean') throw new Error('native job ownership does not match this Agent')
  return { location, mapping }
}
/** Preserve explicitly configured credentials across the machine API's ambient filter. */
export function desktopJobEnvironment(configured, native) {
  return {
    env: desktopNativeEnvironment(configured, native),
    credentialEnv: Object.fromEntries(credentials.filter(key => Object.hasOwn(configured, key)).map(key => [key, configured[key]])),
  }
}
function jobOutcome(receipt) {
  return { status: receipt.ok === true ? 'completed' : receipt.execution?.cancelled === true ? 'killed' : 'failed',
    result: JSON.stringify(receipt), ...(receipt.failure?.detail ? { detail: receipt.failure.detail } : {}) }
}
const property = (type, description) => ({ type, description })
const common = ['action', 'description', 'cwd', 'timeout_ms']
const actionFields = {
  review: [...common, 'target', 'consent', 'trust_workspace', 'timeout_minutes'],
  team: [...common, 'prompt', 'permission_mode', 'native', 'columns', 'rows'],
  recover: ['action', 'job_id'],
  control: ['action', 'job_id', 'control', 'text', 'enter', 'columns', 'rows'],
}
/** One tool with explicit operations; no operation runs during registration or settings changes. */
export function createNativeJobTool({ agent, config, jobs, cwd, api = apiDefault }) {
  const owner = String(agent.id)
  const output = value => [{ type: 'text', text: JSON.stringify(value) }]
  const teamFields = [...actionFields.team, ...(config.modelSelection ? ['model', 'reasoning_effort'] : [])]
  const schema = {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['review', 'team', 'recover', 'control'] },
      description: property('string', 'Short display label.'),
      cwd: property('string', 'Existing absolute workspace; defaults to this Agent workspace.'),
      timeout_ms: { type: 'integer', minimum: 0, description: 'Local deadline. 0 disables it; cancellation does not prove remote review cancellation.' },
      target: property('string', 'Optional native ultrareview target, never a CLI option.'),
      consent: { type: 'boolean', const: true, description: 'Required for every review: explicit consent to a potentially billable remote native review.' },
      trust_workspace: property('boolean', 'Explicitly trust the workspace for this review. Never inferred from another setting.'),
      timeout_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      prompt: property('string', 'Complete initial interactive team prompt.'),
      permission_mode: property('string', 'A mode no broader than the plugin policy.'),
      native: NATIVE_TOOL_SCHEMA,
      columns: { type: 'integer', minimum: 20, maximum: 500 },
      rows: { type: 'integer', minimum: 10, maximum: 200 },
      ...(config.modelSelection ? { model: property('string', 'Team root model override.'), reasoning_effort: property('string', 'Team effort override.') } : {}),
      job_id: property('string', 'Job id returned to this Agent by this tool. No arbitrary journal paths are accepted.'),
      control: { type: 'string', enum: ['capture', 'send', 'resize', 'cancel', 'attach'] },
      text: property('string', 'Literal text to send to the interactive team.'),
      enter: property('boolean', 'Send Enter after text; defaults true.'),
    },
  }
  return {
    name: config.toolName + '_native_job',
    description: 'Explicit independent Claude native jobs. review runs ultrareview --json --no-post with consent:true; team starts an interactive tmux session. Both return a DSH background job id before work completes. recover reads durable evidence and control addresses only a team owned by this Agent. Local cancellation cannot prove remote cancellation; never replay an uncertain review. Terminal text is display-only, not a task verdict.',
    parameters: schema,
    output: { schema: { type: 'object' }, render: (_args, value) => output(value) },
    async execute(args, exec = {}) {
      if (!isPlainObject(args) || !Object.hasOwn(actionFields, args.action)) throw new Error('native job action must be review, team, recover or control')
      const allowed = args.action === 'team' ? teamFields : actionFields[args.action]
      for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error('unsupported ' + args.action + ' argument: ' + key)
      if (args.action === 'recover' || args.action === 'control') {
        const jobId = text(args.job_id, 'job_id')
        const { location, mapping } = readMapping(owner, jobId)
        if (mapping.runId === null) return { kind: 'native-recovery', jobId, status: 'pending', reason: 'No acknowledged lifecycle yet; dispatch and replay safety remain unknown.' }
        const identity = { protocol: 1, requestId: mapping.requestId, runId: mapping.runId, recoveryDirectory: location.recoveryDirectory }
        if (args.action === 'recover') return { kind: 'native-recovery', jobId, ...await api.recoverNativeJob(identity) }
        if (mapping.operation !== 'interactive-team') throw new Error('control requires an interactive team owned by this Agent')
        if (!['capture', 'send', 'resize', 'cancel', 'attach'].includes(args.control)) throw new Error('unsupported interactive team control')
        for (const key of ['text', 'enter', 'columns', 'rows']) {
          if (Object.hasOwn(args, key) && !(args.control === 'send' && ['text', 'enter'].includes(key)) && !(args.control === 'resize' && ['columns', 'rows'].includes(key))) {
            throw new Error('unsupported ' + args.control + ' argument: ' + key)
          }
        }
        if (!mapping.ready && args.control !== 'cancel') {
          const recovered = await api.recoverNativeJob(identity)
          return { kind: 'native-recovery', jobId, ...recovered, reason: 'Interactive controls are not ready. ' + (recovered.reason ?? '') }
        }
        const controls = Object.fromEntries(['text', 'enter', 'columns', 'rows'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]))
        return { kind: 'native-control', jobId, ...await api.controlInteractiveTeam({ ...identity, action: args.control, ...controls }) }
      }
      const operation = args.action === 'review' ? 'native-review' : 'interactive-team'
      const request = {
        protocol: 1, requestId: 'preflight', cwd: args.cwd === undefined ? cwd : checkedDirectory('cwd', args.cwd),
        command: config.command, disposeGraceMs: config.disposeGraceMs,
        timeoutMs: args.timeout_ms ?? config.runTimeoutMs,
      }
      let native
      if (args.action === 'review') {
        if (args.consent !== true) throw new Error('native review requires explicit consent:true for this invocation')
        Object.assign(request, { consent: true, ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.trust_workspace === undefined ? {} : { trustWorkspace: args.trust_workspace }),
          ...(args.timeout_minutes === undefined ? {} : { timeoutMinutes: args.timeout_minutes }) })
        api.validateNativeReviewRequest(request)
      } else {
        const permissionMode = resolvePermissionOverride(config.permissionMode, args.permission_mode)
        native = resolveDesktopNative(config.native, args.native, permissionMode, config.modelSelection)
        // This explicitly requested operation requires Agent/Team tools. Ordinary delegation never enters it.
        if (native === undefined) native = { version: 1, agents: { enabled: true } }
        Object.assign(request, { prompt: text(args.prompt, 'prompt'), permissionMode, native,
          model: args.model ?? config.model, effort: args.reasoning_effort ?? config.reasoningEffort,
          settingSources: config.settingSources,
          ...(args.columns === undefined ? {} : { columns: args.columns }),
          ...(args.rows === undefined ? {} : { rows: args.rows }) })
        api.validateInteractiveTeamRequest(request)
      }
      if (jobs === undefined) throw new Error('independent native jobs require the DSH jobs service')
      const environment = desktopJobEnvironment(config.env, native)
      const run = async (jobId, signal, handle) => {
        const location = paths(owner, jobId)
        let mapping = { version: 1, owner, jobId, requestId: jobId, runId: null, operation, ready: false }
        writeMapping(location, mapping, true)
        const runtime = {
          ...environment, signal, recoveryDirectory: location.recoveryDirectory,
          onLifecycle: async event => {
            if (event.requestId !== jobId || (mapping.runId !== null && mapping.runId !== event.runId)) throw new Error('native job lifecycle identity changed')
            mapping = { ...mapping, runId: event.runId }
            // This awaited fsync precedes the supervisor's dispatch ACK.
            writeMapping(location, mapping)
            try { handle?.append(JSON.stringify(event) + '\n') } catch { /* Progress is not a dispatch ACK. */ }
          },
          onNativeEvent: event => {
            if (event.kind === 'interactive-ready') { mapping = { ...mapping, ready: true }; writeMapping(location, mapping) }
            handle?.append(JSON.stringify(event) + '\n')
          },
          onProgress: event => { handle?.append(JSON.stringify(event) + '\n') },
        }
        return (args.action === 'review' ? api.runNativeReview : api.runInteractiveTeam)({ ...request, requestId: jobId }, runtime)
      }
      const controller = new AbortController()
      const jobId = jobs.start({
        kind: 'subagent', owner, label: args.description === undefined ? 'Claude ' + args.action : text(args.description, 'description'),
        ...(exec.callId === undefined ? {} : { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } }),
        run(handle) {
          handle.updateProgress?.('starting Claude ' + args.action)
          const done = run(String(handle.id), controller.signal, handle).then(jobOutcome,
            error => ({ status: controller.signal.aborted ? 'killed' : 'failed', detail: errorMessage(error) }))
            .finally(() => { handle.updateProgress?.('') })
          return { cancel: reason => controller.abort(new Error(reason ?? 'native job killed')), done }
        },
      })
      return { kind: 'background', jobId, operation }
    },
  }
}
