/** Independent native CLI jobs. Neither terminal text nor local abort proves cloud completion. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, existsSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMachineRequest, MachineInputError } from './machine.js'
import { runtimeEnvironment } from './machine-local.js'
import { recoverMachine, validateRecoveryDirectory } from './machine-recovery.js'
import { superviseMachine } from './machine-supervision.js'
import { resolveCommand } from './cli.js'
import { runClaude } from './run.js'
import { nativeControls } from './native.js'
import { isPlainObject, delay } from './util.js'

const fields = (v, allowed) => isPlainObject(v) && Object.keys(v).every(k => allowed.includes(k))
const text = v => typeof v === 'string' && v.trim() !== '' && !v.includes('\0') && Buffer.byteLength(v) <= 65536
function integer(v, fallback, min, max) { if (v === undefined) return fallback; if (!Number.isSafeInteger(v) || v < min || v > max) throw new MachineInputError('native job numeric control is out of range'); return v }
const baseFields = ['protocol', 'requestId', 'cwd', 'command', 'timeoutMs', 'disposeGraceMs']

function parseReview(v) {
  if (!fields(v, [...baseFields, 'target', 'consent', 'trustWorkspace', 'timeoutMinutes', 'maxOutputBytes']) || v.protocol !== 1 || v.consent !== true) throw new MachineInputError('native review requires protocol 1 and explicit consent:true')
  if (v.target !== undefined && (!text(v.target) || v.target.startsWith('-'))) throw new MachineInputError('invalid native review target')
  if (v.trustWorkspace !== undefined && typeof v.trustWorkspace !== 'boolean') throw new MachineInputError('trustWorkspace must be boolean')
  const minutes = integer(v.timeoutMinutes, 45, 1, 1440)
  const query = parseMachineRequest({ protocol: v.protocol, requestId: v.requestId, cwd: v.cwd, command: v.command,
    prompt: 'native review', permissionMode: 'plan', sessionMode: 'ephemeral',
    timeoutMs: v.timeoutMs ?? minutes * 60000 + 30000, disposeGraceMs: v.disposeGraceMs, maxOutputBytes: v.maxOutputBytes })
  return { protocol: 1, operation: 'native-review', requestId: query.requestId, cwd: query.cwd, command: query.command,
    timeoutMs: query.timeoutMs, disposeGraceMs: query.disposeGraceMs, maxOutputBytes: query.maxOutputBytes,
    target: v.target ?? null, timeoutMinutes: minutes, consent: true, trustWorkspace: v.trustWorkspace === true }
}
function parseTeam(v) {
  if (!fields(v, [...baseFields, 'tmuxCommand', 'prompt', 'permissionMode', 'model', 'effort', 'native', 'settingSources', 'columns', 'rows']) || v.protocol !== 1) throw new MachineInputError('invalid interactive team request')
  const query = parseMachineRequest({ protocol: v.protocol, requestId: v.requestId, cwd: v.cwd, command: v.command,
    prompt: v.prompt, permissionMode: v.permissionMode, model: v.model, effort: v.effort, sessionMode: 'persistent',
    timeoutMs: v.timeoutMs, disposeGraceMs: v.disposeGraceMs, settingSources: v.settingSources,
    native: v.native ?? { version: 1, agents: { enabled: true } } })
  if (query.native.agents?.enabled !== true) throw new MachineInputError('interactive teams require native.agents.enabled:true')
  return { ...query, operation: 'interactive-team', sessionId: randomUUID(),
    tmuxCommand: resolveCommand(v.tmuxCommand ?? 'tmux'), columns: integer(v.columns, 120, 20, 500), rows: integer(v.rows, 40, 10, 200) }
}
function runtimeForJob(runtime) {
  runtimeEnvironment(runtime)
  if (runtime.recoveryDirectory === undefined) throw new MachineInputError('independent native jobs require recoveryDirectory')
  validateRecoveryDirectory(runtime.recoveryDirectory)
  if (!['linux', 'darwin'].includes(process.platform)) throw new MachineInputError('native jobs require POSIX process supervision')
}
/** Preflight only: validate the public shape without launching or creating a journal. */
export function validateNativeReviewRequest(request) { parseReview(request) }
export function validateInteractiveTeamRequest(request) { parseTeam(request) }
export async function runNativeReview(request, runtime = {}) { const parsed = parseReview(request); runtimeForJob(runtime); return superviseMachine(parsed, runtime) }
export async function runInteractiveTeam(request, runtime = {}) { const parsed = parseTeam(request); runtimeForJob(runtime); return superviseMachine(parsed, runtime) }

/** Public recovery is read-only; the CLI offers no guaranteed cloud status/cancel API. */
export async function recoverNativeJob(request) {
  const recovered = await recoverMachine(request)
  if (recovered.status !== 'unknown' && !['native-review', 'interactive-team'].includes(recovered.context?.operation)) {
    return { ...recovered, status: 'unknown', receipt: null, reason: 'journal is not an independent native job' }
  }
  return recovered
}
export function nativeJobContext(request, runId) {
  if (!['native-review', 'interactive-team'].includes(request.operation)) return undefined
  return { operation: request.operation, cwd: request.cwd,
    ...(request.operation === 'interactive-team' ? { socketName: 'ccpro-' + runId, tmuxCommand: request.tmuxCommand, sessionId: request.sessionId } : {}) }
}

/** Bounded argv subprocess; callers never pass a shell command. */
async function command(executable, args, env, input = '', timeoutMs = 10000) {
  return new Promise(resolve => {
    let proc, stdout = '', stderr = '', settled = false, overflow = false
    const finish = (code, error) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, error, overflow }) }
    try { proc = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (error) { resolve({ code: null, stdout, stderr, error }); return }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(null, new Error('native control command timed out')) }, timeoutMs)
    for (const name of ['stdout', 'stderr']) proc[name].on('data', chunk => {
      if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { overflow = true; proc.kill('SIGKILL') }
    })
    proc.on('error', error => finish(null, error)); proc.on('close', code => finish(code))
    proc.stdin.on('error', () => {}); proc.stdin.end(input)
  })
}
function absentGroup(pid) { if (!pid) return true; try { process.kill(-pid, 0); return false } catch (e) { return e.code === 'ESRCH' } }
async function settleGroup(pid, grace) {
  if (!pid || absentGroup(pid)) return true
  for (const [signal, wait] of [['SIGTERM', grace], ['SIGKILL', 2000]]) {
    try { process.kill(-pid, signal) } catch {}
    const deadline = Date.now() + wait
    while (!absentGroup(pid) && Date.now() < deadline) await delay(25)
    if (absentGroup(pid)) return true
  }
  return false
}

function baseReceipt(request, runId) {
  return { protocol: 1, type: 'result', operation: request.operation, requestId: request.requestId, runId, ok: false,
    requested: { cwd: request.cwd, ...(request.operation === 'native-review' ? { target: request.target, consent: true, trustWorkspace: request.trustWorkspace }
      : { sessionId: request.sessionId, permissionMode: request.permissionMode, model: request.model ?? null, effort: request.effort ?? null }) },
    execution: { pid: null, processGroupId: null, ownership: 'none', dispatch: 'not-dispatched', turnDispatch: 'not-dispatched',
      outcome: 'not-started', terminalReceived: false, exitCode: null, signal: null, cancelled: false, timedOut: false, truncated: false },
    cleanup: { confirmed: true, method: 'not-started' }, output: [], costUSD: null, costStatus: 'unknown', failure: null,
    native: { version: 1, requested: request.native ?? { operation: request.operation }, effective: { source: null, matched: false, config: null },
      observed: { events: [], truncated: false }, children: [], usage: { strategy: 'unknown', status: 'unknown' },
      cleanup: { confirmed: true, scope: request.operation === 'native-review' ? 'remote-job' : 'local-process-group', pendingIds: [] } },
    ...(request.operation === 'native-review' ? { remote: { state: 'not-dispatched', jobId: null, querySupported: false, cancelSupported: false, replaySafe: true } }
      : { completion: { kind: 'interactive-session', businessOutcome: 'unknown' } }),
  }
}

export async function runNativeJobLocal(request, runtime, runId, persist) {
  const receipt = baseReceipt(request, runId), env = runtimeEnvironment(runtime)
  const started = Date.now(); let sequence = 0, dispatch = 'not-dispatched'
  const event = async (name, patch = {}) => runtime.onLifecycle?.({ lifecycleVersion: 1, type: 'lifecycle', requestId: request.requestId, runId,
    sequence: ++sequence, event: name, threadId: request.sessionId ?? null, turnId: null,
    persistent: request.operation === 'interactive-team', configuration: null, dispatch, outcome: 'unknown', cleanupConfirmed: false, ...patch })
  const checkpoint = async name => {
    let timer, onAbort
    const stop = new Promise((_, reject) => {
      onAbort = () => reject(new Error('native job checkpoint cancelled'))
      runtime.signal?.addEventListener('abort', onAbort, { once: true }); if (runtime.signal?.aborted) onAbort()
      if (request.timeoutMs > 0) timer = setTimeout(() => reject(new Error('native job deadline expired before dispatch')), Math.max(0, request.timeoutMs - (Date.now() - started)))
    })
    try { await Promise.race([event(name), stop]) } finally { if (timer) clearTimeout(timer); runtime.signal?.removeEventListener('abort', onAbort) }
  }
  try {
    if (runtime.signal?.aborted) throw new Error('native job was cancelled before dispatch')
    await checkpoint('dispatch-intent')
    if (runtime.signal?.aborted) throw new Error('native job was cancelled before dispatch')
    dispatch = 'possible'; await checkpoint('dispatch-possible')
    if (runtime.signal?.aborted || (request.timeoutMs > 0 && Date.now() - started >= request.timeoutMs)) throw new Error('native job expired before process dispatch')
    if (request.operation === 'native-review') await runReviewLocal(request, runtime, receipt, env, started)
    else await runTeamLocal(request, runtime, receipt, env)
  } catch (error) {
    receipt.failure ??= { stage: 'start', category: runtime.signal?.aborted ? 'cancelled' : 'native-job', detail: String(error.message ?? error).slice(0, 4096) }
  }
  receipt.execution.turnDispatch = receipt.execution.dispatch === 'not-dispatched' ? 'not-dispatched' : receipt.execution.terminalReceived ? 'accepted' : dispatch
  persist?.(receipt)
  try { await event('terminal', { outcome: receipt.ok ? 'completed' : receipt.execution.cancelled ? 'cancelled' : 'unknown', cleanupConfirmed: receipt.cleanup.confirmed }) } catch {}
  if (receipt.cleanup.confirmed) { try { await event('cleanup-confirmed', { cleanupConfirmed: true }) } catch {} }
  return receipt
}

async function runReviewLocal(request, runtime, receipt, env, started) {
  const args = ['ultrareview', ...(request.target === null ? [] : [request.target]), '--json', '--no-post', '--timeout', String(request.timeoutMinutes), ...(request.trustWorkspace ? ['--trust-workspace'] : [])]
  let run
  try {
    run = await runClaude({ command: request.command, args, cwd: request.cwd, env, input: '', outputFormat: 'native-review-json',
      timeoutMs: request.timeoutMs === 0 ? 0 : Math.max(1, request.timeoutMs - (Date.now() - started)),
      disposeGraceMs: request.disposeGraceMs, maxOutputBytes: request.maxOutputBytes, signal: runtime.signal })
  } catch (error) {
    if (!error.run?.execution) {
      receipt.execution.dispatch = 'dispatched'; receipt.execution.outcome = 'unknown'; receipt.cleanup.confirmed = false
      receipt.remote = { state: 'unknown', jobId: null, querySupported: false, cancelSupported: false, replaySafe: false }
      receipt.native.cleanup = { confirmed: false, scope: 'remote-job', pendingIds: [receipt.runId] }
      throw error
    }
    run = error.run
    receipt.failure = { stage: error.facts?.stage ?? 'run', category: error.facts?.category ?? 'native-job', detail: String(error.facts?.detail ?? error.message).slice(0, 4096) }
  }
  receipt.execution = { ...run.execution }
  receipt.cleanup = { confirmed: run.cleanupConfirmed === true, method: run.execution.pid === null ? 'not-started' : 'process-group' }
  receipt.native.effective = { source: 'ultrareview-cli-invocation', matched: run.execution.pid !== null, config: { target: request.target, noPost: true, timeoutMinutes: request.timeoutMinutes, trustWorkspace: request.trustWorkspace } }
  const completed = run.stopReason === 'completed' && run.terminalReceived === true && receipt.cleanup.confirmed
  receipt.remote = { state: completed ? 'completed' : run.execution.dispatch === 'not-dispatched' ? 'not-dispatched' : 'unknown',
    jobId: null, querySupported: false, cancelSupported: false, replaySafe: run.execution.dispatch === 'not-dispatched' }
  receipt.native.cleanup = { confirmed: receipt.remote.state !== 'unknown', scope: 'remote-job', pendingIds: receipt.remote.state === 'unknown' ? [receipt.runId] : [] }
  receipt.ok = completed
  if (completed) { receipt.structured = run.structuredOutput; receipt.output = [{ type: 'text', text: run.text }] }
  else receipt.failure ??= { stage: 'run', category: run.execution.cancelled ? 'cancelled' : 'native-job', detail: 'local review command ended without proven cloud completion; do not replay this job' }
}

async function runTeamLocal(request, runtime, receipt, env) {
  const controls = nativeControls(request.native)
  const teamEnv = { ...env, ...controls.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  const settings = { ...controls.settings, env: { ...controls.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }
  const args = ['--teammate-mode', 'in-process', '--permission-mode', request.permissionMode,
    '--session-id', request.sessionId, '--setting-sources', request.settingSources.join(','), '--settings', JSON.stringify(settings)]
  if (request.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  if (request.model !== undefined) args.push('--model', request.model)
  if (request.effort !== undefined) args.push('--effort', request.effort)
  if (request.native.agents.definitions !== undefined) args.push('--agents', JSON.stringify(request.native.agents.definitions))
  if (request.native.workflows?.enabled !== true) args.push('--disallowedTools', 'Workflow')
  if (request.native.advisor?.enabled) args.push('--advisor', request.native.advisor.model)
  args.push('--', request.prompt)
  const socket = 'ccpro-' + receipt.runId, configPath = join(runtime.recoveryDirectory, 'tmux.conf')
  writeFileSync(configPath, 'set -g remain-on-exit on\n', { flag: 'wx', mode: 0o600 })
  const tmux = (argv, input) => command(request.tmuxCommand, ['-L', socket, ...argv], teamEnv, input)
  let pid, serverPid, socketPath, nativeStarted = false, terminalExit = null
  const start = Date.now()
  try {
    if (runtime.signal?.aborted) { receipt.execution.cancelled = true; return }
    const launched = await tmux(['-f', configPath, 'new-session', '-d', '-s', 'ccpro', '-x', String(request.columns), '-y', String(request.rows), '-c', request.cwd, request.command, ...args])
    if (launched.error?.code === 'ENOENT') throw new Error('interactive teams require an installed tmux executable')
    // A failed startup may still have created a server; final cleanup always addresses our unique socket.
    nativeStarted = true
    receipt.execution.dispatch = 'dispatched'; receipt.execution.outcome = 'unknown'; receipt.cleanup.confirmed = false
    if (launched.code !== 0) throw new Error('tmux could not start the isolated interactive team session')
    const identity = await tmux(['display-message', '-p', '-t', 'ccpro:0.0', '#{pid} #{pane_pid} #{socket_path}'])
    const match = /^(\d+) (\d+) (.+)$/.exec(identity.stdout.trim())
    if (identity.code !== 0 || !match) throw new Error('tmux did not confirm its server, pane and socket ownership')
    serverPid = Number(match[1]); pid = Number(match[2]); socketPath = match[3]
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error('invalid tmux process ownership')
    receipt.execution.pid = pid; receipt.execution.processGroupId = pid; receipt.execution.ownership = 'process-group'
    receipt.native.effective = { source: 'tmux-pane+invocation', matched: true, config: { socketName: socket, sessionId: request.sessionId, mode: 'in-process', pid, serverPid, settings, observedTools: null } }
    const ready = { version: 1, sequence: 1, kind: 'interactive-ready', id: receipt.runId, parentId: null, state: 'running' }
    receipt.native.observed.events.push(ready); try { runtime.onNativeEvent?.(ready) } catch {}
    while (true) {
      let cancelRequested = false
      try { const marker = JSON.parse(readFileSync(join(runtime.recoveryDirectory, 'team-cancel.json'), 'utf8')); cancelRequested = marker.requestId === request.requestId && marker.runId === receipt.runId } catch {}
      if (runtime.signal?.aborted || cancelRequested) { receipt.execution.cancelled = true; break }
      if (request.timeoutMs > 0 && Date.now() - start >= request.timeoutMs) { receipt.execution.timedOut = true; break }
      const state = await tmux(['display-message', '-p', '-t', 'ccpro:0.0', '#{pane_dead} #{pane_dead_status}'])
      if (state.code !== 0) throw new Error('interactive team pane disappeared without a terminal status')
      const dead = /^1 (\d+)$/.exec(state.stdout.trim())
      if (dead) { terminalExit = Number(dead[1]); break }
      await delay(200)
    }
    receipt.execution.exitCode = terminalExit
    receipt.execution.terminalReceived = terminalExit !== null
    receipt.execution.outcome = terminalExit === 0 ? 'completed' : terminalExit !== null ? 'failed' : 'unknown'
  } finally {
    const groupStopped = await settleGroup(pid, request.disposeGraceMs)
    const killed = await tmux(['kill-server'])
    // Killing a missing executable is not proof of a dispatched server disappearing.
    const serverStopped = socketPath !== undefined ? !existsSync(socketPath) : !nativeStarted || killed.code === 0
    // Without pane identity, a successful kill-server response cannot prove
    // that the pane's separately grouped descendants stopped.
    const ownedGroupKnown = !nativeStarted || (pid !== undefined && serverPid !== undefined && socketPath !== undefined)
    receipt.cleanup = { confirmed: ownedGroupKnown && groupStopped && serverStopped, method: nativeStarted ? 'tmux-server+process-group' : 'not-started' }
    receipt.native.cleanup = { confirmed: receipt.cleanup.confirmed, scope: 'local-process-group', pendingIds: receipt.cleanup.confirmed ? [] : [receipt.runId] }
  }
  receipt.ok = terminalExit === 0 && receipt.cleanup.confirmed
  if (!receipt.ok) receipt.failure = { stage: 'run', category: receipt.execution.timedOut ? 'timeout' : receipt.execution.cancelled ? 'cancelled' : 'interactive-session',
    detail: 'interactive session ended without a clean native exit; terminal text is not a structured task verdict' }
}

/** Controls never search for sessions or accept arbitrary PIDs/socket names. */
export async function controlInteractiveTeam(request) {
  if (!fields(request, ['protocol', 'requestId', 'runId', 'recoveryDirectory', 'action', 'text', 'enter', 'columns', 'rows'])
    || !['capture', 'send', 'resize', 'cancel', 'attach'].includes(request.action)) throw new MachineInputError('invalid interactive team control')
  const { protocol, requestId, runId, recoveryDirectory } = request
  const recovered = await recoverNativeJob({ protocol, requestId, runId, recoveryDirectory })
  if (recovered.status !== 'pending' || recovered.context?.operation !== 'interactive-team') throw new MachineInputError('the explicitly identified interactive team job is not pending')
  const { socketName, tmuxCommand } = recovered.context
  if (socketName !== 'ccpro-' + runId || !text(tmuxCommand)) throw new MachineInputError('invalid interactive team ownership evidence')
  const prefix = ['-L', socketName]
  if (request.action === 'attach') return { command: tmuxCommand, args: [...prefix, 'attach-session', '-t', 'ccpro'], displayOnly: true }
  if (request.action === 'cancel') {
    const path = join(recoveryDirectory, 'team-cancel.json')
    try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { writeFileSync(fd, JSON.stringify({ requestId, runId })) } finally { closeSync(fd) } }
    catch (e) { if (e.code !== 'EEXIST') throw e }
    return { requested: true, cleanupConfirmed: false }
  }
  const env = runtimeEnvironment({})
  let result
  if (request.action === 'capture') result = await command(tmuxCommand, [...prefix, 'capture-pane', '-p', '-t', 'ccpro:0.0', '-S', '-200'], env)
  else if (request.action === 'resize') result = await command(tmuxCommand, [...prefix, 'resize-window', '-t', 'ccpro:0', '-x', String(integer(request.columns, 120, 20, 500)), '-y', String(integer(request.rows, 40, 10, 200))], env)
  else {
    if (!text(request.text) || (request.enter !== undefined && typeof request.enter !== 'boolean')) throw new MachineInputError('send requires bounded literal text')
    const buffer = 'input-' + randomUUID()
    result = await command(tmuxCommand, [...prefix, 'load-buffer', '-b', buffer, '-'], env, request.text)
    if (result.code === 0) result = await command(tmuxCommand, [...prefix, 'paste-buffer', '-d', '-p', '-b', buffer, '-t', 'ccpro:0.0'], env)
    if (result.code === 0 && request.enter !== false) result = await command(tmuxCommand, [...prefix, 'send-keys', '-t', 'ccpro:0.0', 'Enter'], env)
  }
  if (result.code !== 0 || result.overflow) throw new Error('native interactive team control failed; no task completion is implied')
  return { ok: true, ...(request.action === 'capture' ? { text: result.stdout, displayOnly: true } : {}) }
}
