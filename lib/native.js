/** Versioned native controls; CLI arguments configure, stream events provide evidence. */
import { isPlainObject } from './util.js'

export const MACHINE_NATIVE_VERSION = 1
export const MACHINE_NATIVE_CAPABILITIES = Object.freeze({ version: 1, agents: true, workflows: true,
  advisor: true, images: true, structuredOutput: true, childEvents: true,
  teams: 'interactive-job', remoteReview: 'ultrareview-command', cleanup: 'local-process-group' })
const string = v => typeof v === 'string' && v.trim() !== '' && !v.includes('\0') && Buffer.byteLength(v) <= 65536
const keys = (v, fields) => isPlainObject(v) && Object.keys(v).every(k => fields.includes(k))
const positive = v => Number.isSafeInteger(v) && v > 0
const modes = ['plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions', 'default']
const terminal = new Set(['completed', 'failed', 'stopped', 'killed'])

export function parseNativeRequest(value) {
  if (!keys(value, ['version', 'agents', 'workflows', 'advisor']) || value.version !== 1) throw new Error('invalid native version or fields')
  for (const name of ['agents', 'workflows', 'advisor']) {
    const v = value[name]
    if (v === undefined) continue
    const fields = name === 'agents' ? ['enabled', 'maxConcurrent', 'maxDepth', 'definitions']
      : name === 'workflows' ? ['enabled', 'maxConcurrent'] : ['enabled', 'model']
    if (!keys(v, fields) || typeof v.enabled !== 'boolean') throw new Error(`native.${name} requires explicit enabled`)
    if (!v.enabled && Object.keys(v).length !== 1) throw new Error(`disabled ${name} cannot have active controls`)
    if (v.maxConcurrent !== undefined && (!positive(v.maxConcurrent) || (name === 'workflows' && v.maxConcurrent > 256))) throw new Error(`invalid ${name} concurrency`)
    if (v.maxDepth !== undefined && !positive(v.maxDepth)) throw new Error('invalid native agent depth')
    if (name === 'advisor' && v.enabled && !string(v.model)) throw new Error('enabled advisor requires a model')
    if (v.definitions !== undefined) {
      if (!isPlainObject(v.definitions) || Object.keys(v.definitions).length > 128) throw new Error('invalid native agent definitions')
      for (const [id, def] of Object.entries(v.definitions)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) || !keys(def, ['description', 'prompt', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns'])
          || !string(def.description) || !string(def.prompt)) throw new Error('invalid native agent definition')
        for (const key of ['tools', 'disallowedTools']) if (def[key] !== undefined && (!Array.isArray(def[key]) || def[key].length > 256 || !def[key].every(string))) throw new Error(`invalid agent ${key}`)
        if (def.model !== undefined && !string(def.model)) throw new Error('invalid agent model')
        if (def.permissionMode !== undefined && !modes.includes(def.permissionMode)) throw new Error('invalid agent permission mode')
        if (def.maxTurns !== undefined && !positive(def.maxTurns)) throw new Error('invalid agent maxTurns')
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('native configuration exceeds 1 MiB')
  return structuredClone(value)
}

/** Scoped settings and environment only: no user settings files are changed. */
export function nativeControls(native) {
  if (native === undefined) return { args: [], env: {}, settings: {} }
  const agents = native.agents?.enabled === true, workflows = native.workflows?.enabled === true, advisor = native.advisor?.enabled === true
  const env = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0', CLAUDE_CODE_DISABLE_WORKFLOWS: workflows ? '0' : '1', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: advisor ? '0' : '1' }
  if (native.agents?.maxConcurrent !== undefined) env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(native.agents.maxConcurrent)
  if (native.agents?.maxDepth !== undefined) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(native.agents.maxDepth)
  if (native.workflows?.maxConcurrent !== undefined) env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS = String(native.workflows.maxConcurrent)
  const settings = { disableWorkflows: !workflows, env }
  const args = ['--settings', JSON.stringify(settings)]
  const denied = [...(agents ? [] : ['Agent', 'Task']), ...(workflows ? [] : ['Workflow']), 'TeamCreate', 'TeamDelete']
  args.push('--disallowedTools', denied.join(','))
  if (native.agents?.definitions !== undefined) args.push('--agents', JSON.stringify(native.agents.definitions))
  if (advisor) args.push('--advisor', native.advisor.model)
  return { args, env, settings }
}

/** Do not add child snapshots to the session's aggregate usage/cost. */
export class NativeTracker {
  #request; #root; #report; #events = []; #children = new Map(); #calls = new Map(); #current = new Map(); #sequence = 0; #rootResults = []; #seen = new Set(); #truncated = false; #error
  #effective = { source: null, matched: false, verification: 'tools-only', config: null }
  constructor(request, report) { this.#request = request; this.#report = report }
  get error() { return this.#error ??= this.#observedLimitError() }
  #observedLimitError() {
    const active = [...this.#children.values()].filter(c => !terminal.has(c.state) && c.state !== 'returned')
    const workflowFor = child => {
      const visited = new Set()
      let parentId = child.parentId
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId)
        const parent = this.#children.get(this.#current.get(parentId)) ?? [...this.#children.values()].find(c => c.id === parentId)
        if (!parent) return null
        if (['Workflow', 'local_workflow'].includes(parent.kind)) return parent.id
        parentId = parent.parentId
      }
      return null
    }
    // Agent/Task tool-use records can still be queued by the native scheduler.
    // Only started task-run identities establish observed active workers.
    const workers = active.filter(c => c.kind === 'local_agent' && c.turnId !== null && !c.historical)
    const ordinary = workers.filter(c => workflowFor(c) === null)
    if (this.#request.agents?.maxConcurrent !== undefined && ordinary.length > this.#request.agents.maxConcurrent)
      return 'observed native subagents exceeded the declared concurrency; cancellation is required'
    const workflowCounts = new Map()
    for (const child of workers) {
      const workflow = workflowFor(child)
      if (workflow) workflowCounts.set(workflow, (workflowCounts.get(workflow) ?? 0) + 1)
    }
    if (this.#request.workflows?.maxConcurrent !== undefined && [...workflowCounts.values()].some(count => count > this.#request.workflows.maxConcurrent))
      return 'observed workflow workers exceeded the declared concurrency; cancellation is required'
  }
  acceptsOrigin(origin) {
    return origin?.kind === 'task-notification' && origin.subkind === undefined && this.#children.size > 0
      && (origin.runId === undefined || [...this.#children.values()].some(c => c.turnId === origin.runId))
  }
  recordRootResult(event) {
    if (this.#rootResults.length >= 256) { this.#truncated = true; return }
    if (string(event.uuid) && this.#rootResults.some(r => r.id === event.uuid)) return
    const usage = isPlainObject(event.usage) ? Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(k => [k, Number.isSafeInteger(event.usage[k]) && event.usage[k] >= 0 ? event.usage[k] : null])) : null
    this.#rootResults.push({ id: string(event.uuid) ? event.uuid : null, usage, origin: event.origin?.kind ?? null })
  }
  #emit(kind, child) {
    const value = { version: 1, kind, id: child.id, parentId: child.parentId, state: child.state,
      ...(child.turnId === null ? {} : { turnId: child.turnId }), ...(child.model === null ? {} : { model: child.model }) }
    const key = JSON.stringify(value)
    if (this.#seen.has(key)) return
    if (this.#events.length >= 4096) { this.#truncated = true; return }
    this.#seen.add(key)
    const event = { ...value, sequence: ++this.#sequence }
    this.#events.push(event)
    try { this.#report?.(event) } catch { /* Observation is not a dispatch ACK. */ }
  }
  #create(key, value) {
    if (this.#children.size >= 4096) { this.#truncated = true; this.#error ??= 'native ledger exceeds its bounded size'; return }
    const child = { id: key, parentId: null, ownerId: this.#root ?? null, kind: 'unknown', state: 'running', model: null,
      turnId: null, toolUseId: null, usage: null, historical: false, ...value }
    this.#children.set(key, child)
    this.#emit('child-started', child)
    return child
  }
  #task(e, newRun = false) {
    if (!string(e.task_id) || e.ambient === true) return
    const runId = string(e.run_id) ? e.run_id : null
    const previousKey = this.#current.get(e.task_id)
    const previous = this.#children.get(previousKey)
    // Unversioned events cannot identify which run of a resumed task ended.
    if (runId === null && previous?.turnId !== null && previous?.turnId !== undefined) return
    // A late old-run notification must not complete or change the new run.
    const key = runId === null ? previousKey ?? e.task_id : `${e.task_id}:${runId}`
    let child = this.#children.get(key)
    const existed = child !== undefined
    if (newRun && existed && (terminal.has(child.state) || (previousKey !== undefined && previousKey !== key))) return
    if (!child) {
      const linked = string(e.tool_use_id) ? this.#calls.get(e.tool_use_id) : undefined
      const provisional = linked && this.#children.get(linked)
      const parent = string(e.parent_task_id) ? this.#children.get(this.#current.get(e.parent_task_id)) : undefined
      child = this.#create(key, { id: e.task_id, turnId: runId,
        parentId: parent?.id ?? provisional?.parentId ?? null, ownerId: this.#root,
        kind: e.task_type ?? provisional?.kind ?? 'unknown', model: provisional?.model ?? null,
        toolUseId: e.tool_use_id ?? null, historical: !newRun,
      })
      if (!child) return
      if (provisional && linked.startsWith('tool:')) this.#children.delete(linked)
      if (string(e.tool_use_id)) this.#calls.set(e.tool_use_id, key)
    }
    // IDs are opaque. A newly observed start establishes the current run;
    // replaying an older start/progress/terminal event never moves it back.
    if (!previous || previous.turnId === null || (newRun && !existed)) this.#current.set(e.task_id, key)
    if (newRun) child.historical = false
    if (newRun && child.kind === 'local_agent' && this.#request.agents?.enabled !== true && this.#request.workflows?.enabled !== true) this.#error ??= 'native subagent started while dispatch was disabled'
    return child
  }
  observe(e) {
    if (!isPlainObject(e)) return
    if (e.type === 'system' && e.subtype === 'init' && !string(e.parent_tool_use_id)) {
      this.#root = e.session_id
      const tools = Array.isArray(e.tools) && e.tools.every(string) ? e.tools : null
      const hasAgent = tools?.some(t => ['Agent', 'Task'].includes(t))
      const hasWorkflow = tools?.includes('Workflow')
      const definitions = Object.keys(this.#request.agents?.definitions ?? {})
      const matched = tools !== null && hasAgent === (this.#request.agents?.enabled === true)
        && hasWorkflow === (this.#request.workflows?.enabled === true)
        && definitions.every(name => Array.isArray(e.agents) && e.agents.includes(name))
      this.#effective = { source: 'cli-init+invocation', matched, verification: 'tools-only', config: {
        tools, agents: Array.isArray(e.agents) ? e.agents.filter(string) : null,
        controls: nativeControls(this.#request),
        unverified: ['concurrency limits', 'nesting limits', 'advisor activation/model', 'child permission-mode precedence'],
      } }
      if (!matched) this.#error ??= 'system/init did not confirm the requested native tool surface'
      return
    }
    const parentKey = string(e.parent_tool_use_id) ? this.#calls.get(e.parent_tool_use_id) : undefined
    const parent = this.#children.get(parentKey)
    const root = e.session_id === this.#root && !string(e.parent_tool_use_id)
    if (!root && !parent) return
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      if (parent && string(e.message.model)) parent.model = e.message.model
      for (const block of e.message.content) {
        if (block?.type !== 'tool_use' || !string(block.id) || !['Agent', 'Task', 'Workflow'].includes(block.name)) continue
        const enabled = block.name === 'Workflow' ? this.#request.workflows?.enabled : this.#request.agents?.enabled
        if (!enabled) this.#error ??= `disabled native ${block.name} tool was invoked`
        if (this.#calls.has(block.id)) continue
        const key = 'tool:' + block.id
        if (this.#create(key, { id: block.id, parentId: parent?.id ?? this.#root ?? null, kind: block.name,
          toolUseId: block.id, model: string(block.input?.model) ? block.input.model : null })) this.#calls.set(block.id, key)
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) for (const block of e.message.content) {
      if (block?.type !== 'tool_result') continue
      let child = this.#children.get(this.#calls.get(block.tool_use_id))
      const output = e.tool_use_result
      if (child && isPlainObject(output)) {
        if (output.error) { child.state = 'failed'; this.#emit('child-returned', child); continue }
        if (['async_launched', 'remote_launched'].includes(output.status) && string(output.taskId ?? output.agentId)) {
          child = this.#task({ task_id: output.taskId ?? output.agentId, run_id: output.runId, tool_use_id: block.tool_use_id,
            task_type: output.status === 'remote_launched' ? 'remote_agent' : output.taskType ?? (child.kind === 'Workflow' ? 'local_workflow' : 'local_agent') }, true)
          if (child) this.#emit('task-started', child)
          continue
        }
        if (output.status === 'completed') {
          if (string(output.resolvedModel)) child.model = output.resolvedModel
          child.state = 'completed'; this.#emit('child-completed', child); continue
        }
      }
      // Background submission's tool result is not task completion.
      if (child && child.turnId === null && this.#children.has('tool:' + block.tool_use_id)) {
        child.state = block.is_error === true ? 'failed' : 'returned'; this.#emit('child-returned', child)
      }
    }
    if (e.type !== 'system' || !root) return
    if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
      for (const task of e.tasks) this.#task(task)
      return
    }
    if (!['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(e.subtype)) return
    const child = this.#task(e, e.subtype === 'task_started')
    if (!child) return
    if (e.subtype === 'task_started') child.state = 'running'
    else if (e.subtype === 'task_updated' && string(e.patch?.status)) child.state = e.patch.status
    else if (e.subtype === 'task_notification' && string(e.status)) child.state = e.status
    if (isPlainObject(e.usage)) {
      const counters = ['total_tokens', 'tool_uses', 'duration_ms']
      if (counters.every(k => Number.isSafeInteger(e.usage[k]) && e.usage[k] >= 0)) {
        const current = child.usage
        const regression = current && counters.some(k => e.usage[k] < current[k])
        if (!regression) child.usage = { ...Object.fromEntries(counters.map(k => [k, e.usage[k]])),
          status: child.historical ? 'unknown' : 'observed', scope: 'task-run' }
      }
    }
    this.#emit(e.subtype.replaceAll('_', '-'), child)
  }
  report(cleanup = false) {
    const children = [...this.#children.values()].map(c => structuredClone(c))
    const pending = children.filter(c => !terminal.has(c.state) && c.state !== 'returned').map(c => c.id)
    const remote = children.filter(c => c.kind === 'remote_agent' && !terminal.has(c.state))
    return { version: 1, requested: this.#request, effective: this.#effective,
      resourceBounds: {
        hard: false,
        reservation: 'declared-native-concurrency',
        enforcement: 'provider-controls-with-exceptions',
        adapterGuard: 'cancel-on-observed-overrun',
        agents: { requested: this.#request.agents?.maxConcurrent ?? null, verified: false,
          exceptions: ['ultracode', 'in-session-fork', 'resumed-agent'] },
        workflows: { requested: this.#request.workflows?.maxConcurrent ?? null, verified: false,
          scope: 'per-workflow-worker-pool' },
        depth: { requested: this.#request.agents?.maxDepth ?? null, verified: false },
      },
      observed: { events: [...this.#events], truncated: this.#truncated }, children,
      usage: { strategy: 'root-result-only', status: 'unknown', childSnapshotsAreAdditive: false, rootResults: [...this.#rootResults] },
      completion: { confirmed: pending.length === 0 && !this.#truncated, pendingIds: pending },
      cleanup: { confirmed: cleanup && remote.length === 0, scope: remote.length ? 'remote-job' : 'local-process-group',
        pendingIds: cleanup ? remote.map(c => c.id) : children.filter(c => !terminal.has(c.state)).map(c => c.id) },
      ...(this.error ? { diagnostic: this.error } : {}),
    }
  }
}
