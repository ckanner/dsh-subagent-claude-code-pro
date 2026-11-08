# Machine API v1

The `dsh-subagent-claude-code-pro/machine` package export was introduced in the
0.3.2 source candidate and extended by the **0.4.0 source candidate**. It is a public, dependency-free ESM interface for an
orchestrator such as Flywheel. Adding this source change does not publish a new
npm version or upgrade an existing desktop installation.

```js
import { parseMachineRequest, runMachine } from 'dsh-subagent-claude-code-pro/machine'

const controller = new AbortController()
const request = parseMachineRequest({
  protocol: 1,
  requestId: 'task-42-execute-attempt-1',
  cwd: '/absolute/task/worktree',
  prompt: 'Complete this self-contained task and return the requested report.',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'bypassPermissions', // explicit native CLI approval policy
  sessionMode: 'persistent',
  timeoutMs: 600000,
})

const receipt = await runMachine(request, { signal: controller.signal })
// Persist the entire correlated receipt before advancing orchestration state.
if (receipt.ok && receipt.session.resumable) {
  // The same task and role may later pass receipt.session.id as sessionId.
}
```

The complete TypeScript contract is shipped in
[`lib/machine.d.ts`](../lib/machine.d.ts). Runtime exports are
`MACHINE_PROTOCOL_VERSION`, `MachineInputError`, `parseMachineRequest`, and
`runMachine`. The 0.4.0 source candidate also exports `MACHINE_LIFECYCLE_VERSION`,
`MACHINE_LIFECYCLE_CAPABILITIES`, and `recoverMachine`; see the
[lifecycle contract](machine-lifecycle.md). Node.js 22.18.0 or newer and macOS/Linux are required. The caller
must supply an installed, authenticated local Claude Code CLI; this package
neither bundles Claude nor handles login.

## Request and identity

Every request supplies `protocol: 1`, a nonempty `requestId`, an existing
absolute `cwd`, a self-contained `prompt`, an explicit native `permissionMode`,
and `sessionMode: 'ephemeral' | 'persistent'`. Optional fields are `command`,
`model`, `effort`, `sessionId`, `timeoutMs`, `disposeGraceMs`, `maxOutputBytes`,
and `settingSources`. Unknown fields, invalid combinations and invalid runtime
options fail before spawning with `MachineInputError`.

- `cwd` is resolved to its physical directory before invocation.
- A new persistent invocation gets its own UUID. There is no hidden remembered
  session, shared global context or automatic retry in this API.
- `sessionId` explicitly resumes that UUID and requires persistent mode. A
  missing session returns the failure; it never becomes a new session.
- Ephemeral invocations use `--no-session-persistence` and never offer a
  resumable checkpoint.
- `session.resumed` means a matching CLI `system/init` event was observed;
  merely requesting a resume does not set it. `session.resumable` requires a
  successful terminal receipt and confirmed cleanup.
- `requestId` correlates the caller's invocation; `runId` is a fresh UUID for
  the actual machine call. Neither is a provider-side idempotency key.

The default deadline is 600,000 ms; `timeoutMs: 0` disables it. The default
termination grace is 3,000 ms, followed by a bounded SIGKILL/reaping attempt.
The default final-text limit is 1 MiB (configurable up to 16 MiB). Independently,
stdout is capped at 64 MiB with a 16 MiB maximum NDJSON frame, including an
unterminated frame. `settingSources` defaults to `user`, `project`, `local`;
an explicit empty array is forwarded as `--setting-sources ''`.

## Configuration evidence

`requested` records CLI parameters; `configuration.observed` records only
fields actually reported in `system/init`. Success requires the physical
working directory, native permission mode and session identity to match.
An explicitly requested full model ID must match exactly. The aliases
`sonnet`, `opus`, and `haiku` may match their corresponding `claude-<family>-…`
canonical IDs without hardcoding a model version. Other aliases require an
exact reported match; use a full ID when an alias cannot be verified.

The requested effort is forwarded as `--effort`, including `low`, `medium`,
`high`, `xhigh`, or `max`. The CLI owns model/effort availability; unsupported
settings fail explicitly. Its init event does not expose an effective effort,
so the receipt does not invent one.

Native `plan`, `dontAsk`, `acceptEdits`, `auto`, and `bypassPermissions` control
Claude Code's tool approvals. **They do not prove an OS filesystem sandbox.**
An integration must not advertise `plan` as equivalent to a read-only
sandbox, or `acceptEdits` as confined workspace writes. Flywheel's initial
integration maps its explicit full-access policy to `bypassPermissions` and
rejects unsupported sandbox expectations before dispatch.

## Completion, failure, and cleanup

The receipt separates `execution`, `cleanup`, `session`, `configuration`,
`output`, `usage`, and `failure`:

| Evidence | Meaning |
| --- | --- |
| `dispatch: 'not-dispatched'` | No CLI process accepted work: for example, cancellation before spawn or a missing executable. No requested session is claimed as opened. |
| `dispatch: 'dispatched'` | A CLI process was spawned. This is conservative and does not claim that a model request was sent. |
| `outcome: 'completed'` | A unique, session-consistent successful terminal result and normal process exit were observed. |
| `outcome: 'failed'` | An intact failed terminal result and a compatible process exit were observed. |
| `outcome: 'unknown'` | There is no trustworthy terminal outcome, including partial/corrupt streams and abnormal exits. |
| `cleanup.confirmed: true` | The owned POSIX process group was observed absent, or no process was started. |
| `ok: true` | Completion, requested configuration, output and cleanup all passed. |

Every post-spawn path waits for process-group cleanup, including terminal
errors, cancellation, deadlines, output limits, and a leader that exits while
descendants survive. A probe error other than `ESRCH` cannot prove absence.
Unconfirmed cleanup fails closed. A worker killed before it can return a
receipt may still have an unknown outcome; 0.4.0 offers opt-in durable pre-prompt
intent acknowledgements and read-only recovery, described in the
[lifecycle contract](machine-lifecycle.md).

Physical supervision is established **before** native spawn: an independently
grouped guardian starts and owns the CLI, and monitors an IPC lifeline to the
caller. Killing the caller or its process group disconnects that lifeline;
the guardian aborts the CLI, waits for group cleanup, and exits. Normal API
completion waits for both the guardian response and its exit. If the guardian
itself exits unexpectedly after reporting its native process group, the live
caller attempts bounded cleanup of that group and returns an unknown outcome.
Losing both supervisors or killing a guardian before its identity report can
still leave no complete cleanup evidence; that case must remain blocked.

Progress is display-only. Missing `is_error`, missing/malformed/truncated
results, duplicate terminal/init frames, conflicting session IDs, and
post-terminal assistant output cannot become a recoverable success. Unknown
event types remain forward compatible. A failed resume is never repaired by
the machine API. The existing desktop tool retains its explicit remembered
session repair, now only after a trusted failed terminal and confirmed cleanup.

Callers must persist correlated receipts and keep their own task/role boundary,
candidate checks, budgets and replay policy. A new session does not make an
unknown previous execution safe to repeat. A rejected `runMachine` call without
a receipt is not evidence that nothing was dispatched; only input-validation
errors are guaranteed to occur before spawn.

## Consumption and credentials

Usage is per CLI invocation. `inputTokens` is the CLI's uncached input count;
`cacheReadTokens` and `cacheCreationTokens` are separate. A complete
`totalTokens` sums those three counters plus `outputTokens`. Missing counters
stay `null`, and completeness is `partial` or `unknown`; they do not become
zero. Corrupt or abnormal terminal streams discard untrustworthy usage.
An intact terminal may preserve usage even when its result cannot be accepted
because of configuration, output or cleanup failure.

`reportedCostUSD` preserves the CLI's `total_cost_usd` API-equivalent estimate.
It is **not** a subscription bill. `costUSD` remains `null` and `costStatus`
remains `unknown`. A CLI max-turn/output limit is not proof of an account quota
or authorization to switch to a paid provider.

The ambient child environment strips `DSH_*` and credential-shaped names.
`runtime.credentialEnv` may explicitly pass `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_BASE_URL`.
Values are never included in the receipt. No credential file or keychain entry
is inspected or rewritten by this API.

## Validation boundary

`npm test` runs deterministic tests against a real spawned fixture process,
covering normal/persistent/resumed calls, model and permission evidence,
credential boundaries, cancellation/deadlines, malformed streams, token
completeness, and surviving descendants. Package export and installation checks
use the actual candidate tarball. These are offline contract tests; they do not
claim real Claude model inference, account validity, or macOS-specific runtime
acceptance for the new machine interface.
