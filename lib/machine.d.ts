/** Terminal-only public machine contract. Native permissions are not OS sandboxes. */
export const MACHINE_PROTOCOL_VERSION: 1
export class MachineInputError extends Error {}
export type PermissionMode = 'plan' | 'dontAsk' | 'acceptEdits' | 'auto' | 'bypassPermissions'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SettingSource = 'user' | 'project' | 'local'
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
  timeoutMs?: number
  disposeGraceMs?: number
  maxOutputBytes?: number
  settingSources?: readonly SettingSource[]
}
export interface MachineRuntime {
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  /** Explicit secrets for the child; never copied into a receipt. */
  credentialEnv?: Partial<Record<'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_BASE_URL', string>>
  onProgress?: (text: string) => void
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
    settingSources: SettingSource[]
  }
  execution: {
    pid: number | null
    processGroupId: number | null
    ownership: 'process-group' | 'none'
    dispatch: 'not-dispatched' | 'dispatched'
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
  }
  output: Array<{ type: 'text'; text: string }>
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
