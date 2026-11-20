/** Public machine and lifecycle contracts. Native permissions are not OS sandboxes. */
export const MACHINE_PROTOCOL_VERSION: 1
export const MACHINE_LIFECYCLE_VERSION: 1
export const MACHINE_LIFECYCLE_CAPABILITIES: Readonly<{
  version: 1; durableJournal: true; readOnlyRecovery: true; threadReadyBeforeDispatch: false
}>
export class MachineInputError extends Error {}
export type PermissionMode = 'plan' | 'dontAsk' | 'acceptEdits' | 'auto' | 'bypassPermissions'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SettingSource = 'user' | 'project' | 'local'
export const MACHINE_SUBSCRIPTION_VERSION: 1
export const MACHINE_SUBSCRIPTION_CAPABILITIES: Readonly<{ version: 1; nativePreflight: true;
  sameProcessBeforePrompt: true; extraUsageEvidence: 'sdk-usage-0.3.326'; callerAttestation: false }>
export interface SubscriptionRequest { version: 1; mode: 'subscription-only' }
export interface SubscriptionReceipt {
  version: 1; mode: 'subscription-only'; status: 'verified' | 'blocked' | 'unknown'
  source: 'sdk-usage-0.3.326'; checkedAt: string | null; apiProvider: 'firstParty' | null
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
  extraUsageEnabled: boolean | null; resolvedModel: string | null
  /** Observation immediately before dispatch, not a lock on account billing settings. */
  scope: 'pre-prompt-snapshot'; diagnostic: string | null
}
export interface ModelEvidence {
  version: 1; rootModels: string[]; usageModels: string[]; rootMatched: boolean | null
  source: 'assistant.message.model' | null; usageSource: 'result.modelUsage' | null
  usageScope: 'native-cumulative-including-history-and-auxiliary' | 'unknown'; wholeRunVerified: false
}
export interface MachineRequest {
  protocol: 1
  requestId: string
  cwd: string
  prompt: string
  command?: string
  model?: string
  effort?: Effort
  permissionMode: PermissionMode
  sessionMode: 'ephemeral' | 'persistent'
  sessionId?: string
  /** Optional readable name for a new persistent session; never renames a resume. */
  sessionName?: string
  timeoutMs?: number
  disposeGraceMs?: number
  maxOutputBytes?: number
  settingSources?: readonly SettingSource[]
  native?: NativeRequest
  images?: Array<{ data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }>
  outputSchema?: Record<string, unknown>
  maxBudgetUsd?: number
  subscription?: SubscriptionRequest
}
export const MACHINE_ACTIVITY_VERSION: 1
export const MACHINE_ACTIVITY_CAPABILITIES: Readonly<{ version: 1; metadataOnly: true; coalesced: true; rootAndChildren: true }>
export interface MachineActivity {
  version: 1; sequence: number; kind: 'provider-progress'; source: 'claude-code-pro'
  scope: 'root' | 'child' | 'mixed'; eventTypes: string[]; observedEvents: number
}
export interface MachineRuntime {
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  /** Explicit secrets for the child; never copied into a receipt. */
  credentialEnv?: Partial<Record<'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_BASE_URL', string>>
  onProgress?: (text: string) => void
  /** Metadata from observed CLI activity, independent of display text and receipts. */
  onActivity?: (event: MachineActivity) => void
  /** Event-driven coalescing interval, integer 1..60000; default 250 ms. */
  activityIntervalMs?: number
  /** Advisory metadata; does not authorize or ACK dispatch. */
  onNativeEvent?: (event: NativeEvent) => void
  /** Resolve only after durably saving this checkpoint; rejection stops dispatch. */
  onLifecycle?: (event: MachineLifecycleEvent) => Promise<void> | void
  /** New private directory below an existing canonical parent; never reused. */
  recoveryDirectory?: string
}
/** Ordered input identities computed from decoded bytes, without paths or image contents. */
export interface MachineInputImageManifest {
  version: 1
  images: Array<{ mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; sha256: string; bytes: number }>
}
export interface MachineReceipt {
  protocol: 1
  type: 'result'
  requestId: string
  runId: string
  ok: boolean
  requested: {
    cwd: string
    model: string | null
    effort: Effort | null
    permissionMode: PermissionMode
    sessionMode: 'ephemeral' | 'persistent'
    sessionId: string | null
    sessionName?: string
    inputImages?: MachineInputImageManifest
    settingSources: SettingSource[]
  }
  execution: {
    pid: number | null
    processGroupId: number | null
    ownership: 'process-group' | 'none'
    dispatch: 'not-dispatched' | 'dispatched'
    /** Prompt boundary, separate from whether a native CLI process was spawned. */
    turnDispatch: 'not-dispatched' | 'possible' | 'accepted'
    outcome: 'not-started' | 'completed' | 'failed' | 'unknown'
    terminalReceived: boolean
    exitCode: number | null
    signal: string | null
    cancelled: boolean
    timedOut: boolean
    truncated: boolean
  }
  cleanup: { confirmed: boolean; method: 'not-started' | 'process-group' }
  session: { mode: 'ephemeral' | 'persistent'; id: string | null; resumed: boolean; resumable: boolean }
  configuration: {
    source: 'cli-init' | null
    observed: { cwd: string | null; model: string | null; permissionMode: string | null; cliVersion: string | null } | null
    matched: boolean
    modelEvidence?: ModelEvidence
  }
  native?: NativeReceipt
  subscription?: SubscriptionReceipt
  structured?: unknown
  output: Array<{ type: 'text'; text: string }>
  images?: Array<{ data: string; mimeType: string }>
  usage: {
    status: 'complete' | 'partial' | 'unknown'
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cacheCreationTokens: number | null
    totalTokens: number | null
  }
  /** CLI API-equivalent estimate; not the user's subscription charge. */
  reportedCostUSD: number | null
  costUSD: null
  costStatus: 'unknown'
  failure: null | {
    stage: 'input' | 'start' | 'run' | 'query-run' | 'process' | 'cleanup' | 'configuration'
    category: 'invalid-request' | 'unsupported-runtime' | 'spawn' | 'cancelled' | 'timeout' | 'protocol'
      | 'auth' | 'resume' | 'limit' | 'product-error' | 'process' | 'cleanup-unconfirmed'
      | 'configuration-mismatch' | 'invalid-result' | 'unknown'
    detail: string
  }
}
export function parseMachineRequest(input: unknown): Readonly<MachineRequest>
export function runMachine(input: MachineRequest, runtime?: MachineRuntime): Promise<MachineReceipt>
export type SubscriptionInspectionRequest = Pick<MachineRequest, 'protocol' | 'requestId' | 'cwd' | 'command' | 'model' | 'effort' | 'settingSources' | 'timeoutMs' | 'disposeGraceMs'>
export interface SubscriptionInspectionReceipt {
  protocol: 1; type: 'subscription-inspection'; requestId: string; ok: boolean
  subscription: SubscriptionReceipt; promptDispatched: false; cleanup: { confirmed: boolean }
  failure: MachineReceipt['failure']
}
export function inspectSubscription(input: SubscriptionInspectionRequest,
  runtime?: Pick<MachineRuntime, 'env' | 'credentialEnv' | 'signal'>): Promise<SubscriptionInspectionReceipt>
export interface MachineLifecycleEvent {
  lifecycleVersion: 1
  type: 'lifecycle'
  requestId: string
  runId: string
  sequence: number
  event: 'dispatch-intent' | 'dispatch-possible' | 'terminal' | 'cleanup-confirmed'
  /** Proposed session before dispatch; only configuration/receipt prove it opened. */
  threadId: string | null
  /** Claude stream-json exposes no stable per-turn identity. */
  turnId: null
  /** Requested persistence, not independent proof of resumability. */
  persistent: boolean
  configuration: MachineReceipt['configuration'] | null
  dispatch: 'not-dispatched' | 'possible' | 'accepted'
  outcome: 'unknown' | 'completed' | 'failed' | 'cancelled'
  cleanupConfirmed: boolean
}
export interface MachineRecoveryRequest {
  protocol: 1
  requestId: string
  runId: string
  recoveryDirectory: string
}
export interface MachineRecoveryReceipt {
  protocol: 1
  type: 'recovery'
  requestId: string
  runId: string
  status: 'terminal' | 'pending' | 'unknown'
  receipt: MachineReceipt | null
  lifecycle: MachineLifecycleEvent | null
  reason: string
  /** Present for image queries from initial journal creation, including pending recovery. */
  context?: { inputImages: MachineInputImageManifest }
}
/** Read only the explicitly identified journal; never spawns, resumes or replays. */
export function recoverMachine(input: MachineRecoveryRequest): Promise<MachineRecoveryReceipt>

/** Optional native controls preserve protocol 1 and absent-native behavior. */
export const MACHINE_NATIVE_VERSION: 1
export const MACHINE_NATIVE_CAPABILITIES: Readonly<{
  version: 1; agents: true; workflows: true; advisor: true; images: true; structuredOutput: true;
  childEvents: true; teams: 'interactive-job'; remoteReview: 'ultrareview-command'; cleanup: 'local-process-group'
}>
export interface NativeRequest {
  version: 1
  agents?: { enabled: boolean; maxConcurrent?: number; maxDepth?: number;
    definitions?: Record<string, { description: string; prompt: string; tools?: string[]; disallowedTools?: string[];
      model?: string;
      /** Forwarded in --agents; omission follows the CLI's model-specific effort rules. */
      effort?: Effort;
      permissionMode?: PermissionMode | 'default'; maxTurns?: number }> }
  workflows?: { enabled: boolean; maxConcurrent?: number }
  advisor?: { enabled: boolean; model?: string }
}
export interface NativeEvent {
  version: 1; sequence: number; kind: string; id: string; parentId: string | null; state: string;
  turnId?: string; model?: string
}
export interface NativeReceipt {
  version: 1
  requested: NativeRequest | { operation: 'native-review' | 'interactive-team' }
  effective: { source: string | null; matched: boolean; verification?: 'tools-only'; config: Record<string, unknown> | null }
  /** Native concurrency requests reserve resources; provider exceptions prevent a global hard bound. */
  resourceBounds?: {
    hard: false; reservation: 'declared-native-concurrency'; enforcement: 'provider-controls-with-exceptions'
    adapterGuard: 'cancel-on-observed-overrun'
    agents: { requested: number | null; verified: false; exceptions: string[] }
    workflows: { requested: number | null; verified: false; scope: 'per-workflow-worker-pool' }
    depth: { requested: number | null; verified: false }
  }
  observed: { events: NativeEvent[]; truncated: boolean }
  children: Array<{ id: string; parentId: string | null; ownerId?: string | null; kind: string; state: string;
    model: string | null; turnId: string | null; toolUseId?: string | null; historical?: boolean;
    usage: { total_tokens: number; tool_uses: number; duration_ms: number; status: string; scope: string } | null }>
  usage: { strategy: string; status: string; childSnapshotsAreAdditive?: false; root?: MachineReceipt['usage'];
    aggregateFamilyStatus?: string; rootResults?: Array<{ id: string | null; usage: unknown; origin: string | null }> }
  completion?: { confirmed: boolean; pendingIds: string[] }
  cleanup: { confirmed: boolean; scope: 'local-process-group' | 'remote-job'; pendingIds: string[] }
  diagnostic?: string
}
export interface NativeReviewRequest {
  protocol: 1; requestId: string; cwd: string; command?: string; target?: string;
  /** Existing host policy may grant this; no additional per-run UI confirmation is required. */
  consent: true
  trustWorkspace?: boolean; timeoutMinutes?: number; timeoutMs?: number; disposeGraceMs?: number; maxOutputBytes?: number
}
export interface InteractiveTeamRequest {
  protocol: 1; requestId: string; cwd: string; command?: string; tmuxCommand?: string; prompt: string; sessionName?: string;
  permissionMode: PermissionMode; model?: string; effort?: Effort; native?: NativeRequest;
  settingSources?: SettingSource[]; timeoutMs?: number; disposeGraceMs?: number; columns?: number; rows?: number
}
export interface NativeJobReceipt {
  protocol: 1; type: 'result'; operation: 'native-review' | 'interactive-team'; requestId: string; runId: string; ok: boolean;
  requested: Record<string, unknown>; execution: MachineReceipt['execution'];
  cleanup: { confirmed: boolean; method: 'not-started' | 'process-group' | 'tmux-server+process-group' };
  native: NativeReceipt; output: Array<{ type: 'text'; text: string }>; structured?: unknown;
  costUSD: null; costStatus: 'unknown'; failure: { stage: string; category: string; detail: string } | null;
  remote?: { state: 'not-dispatched' | 'completed' | 'unknown'; jobId: null; querySupported: false; cancelSupported: false; replaySafe: boolean };
  completion?: { kind: 'interactive-session'; businessOutcome: 'unknown' }
}
export function runNativeReview(request: NativeReviewRequest, runtime: MachineRuntime & { recoveryDirectory: string }): Promise<NativeJobReceipt>
export function runInteractiveTeam(request: InteractiveTeamRequest, runtime: MachineRuntime & { recoveryDirectory: string }): Promise<NativeJobReceipt>
/** Preflight only; never launches a process or creates a recovery journal. */
export function validateNativeReviewRequest(request: NativeReviewRequest): void
export function validateInteractiveTeamRequest(request: InteractiveTeamRequest): void
export function recoverNativeJob(request: MachineRecoveryRequest): Promise<Omit<MachineRecoveryReceipt, 'receipt' | 'context'> & {
  receipt: NativeJobReceipt | null; context?: Record<string, unknown>
}>
export function controlInteractiveTeam(request: MachineRecoveryRequest & {
  action: 'capture' | 'send' | 'resize' | 'cancel' | 'attach'; text?: string; enter?: boolean; columns?: number; rows?: number
}): Promise<{ ok?: boolean; text?: string; displayOnly?: true; command?: string; args?: string[]; requested?: true; cleanupConfirmed?: false }>
