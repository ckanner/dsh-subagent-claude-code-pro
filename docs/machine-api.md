# Machine API v1

The `dsh-subagent-claude-code-pro/machine` package export was introduced in the
0.3.2 machine API and extended by **0.4.0**. It is a public, dependency-free ESM interface for an
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
`runMachine`. 0.4.0 also exports `MACHINE_LIFECYCLE_VERSION`,
`MACHINE_LIFECYCLE_CAPABILITIES`, and `recoverMachine`; see the
[lifecycle contract](machine-lifecycle.md). Node.js 22.18.0 or newer and macOS/Linux are required. The caller
must supply an installed, authenticated local Claude Code CLI; this package
neither bundles Claude nor handles login.

## Request and identity

Every request supplies `protocol: 1`, a nonempty `requestId`, an existing
absolute `cwd`, a self-contained `prompt`, an explicit native `permissionMode`,
and `sessionMode: 'ephemeral' | 'persistent'`. Optional fields are `command`,
`model`, `effort`, `sessionId`, `sessionName`, `timeoutMs`, `disposeGraceMs`, `maxOutputBytes`,
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
- From 0.5.2, a new persistent query is named with `-n`. `sessionName` accepts an explicit single-line name of at most 512 UTF-8 bytes; otherwise the workspace directory name becomes a bounded `Claude · …` title. Task instructions never become an automatic session-list title. The DSH tool prefers its explicit description and otherwise uses the workspace name; interactive teams use the same safe fallback. Supplying `sessionName` with `sessionId` or ephemeral mode is rejected before spawn. Resumes never rename an existing user session, and ephemeral queries never add persistence for naming.

The default deadline is 600,000 ms; `timeoutMs: 0` disables it. The default
termination grace is 3,000 ms, followed by a bounded SIGKILL/reaping attempt.
The default final-text limit is 1 MiB (configurable up to 16 MiB). Each NDJSON
frame, including an unterminated frame, is limited to 16 MiB. Streamed activity
does not consume a cumulative byte allowance. Intermediate display text retains
only a 65,536-character tail, and optional display callbacks stop after 4 MiB or
4,096 events with one omission notice; activity and the complete terminal answer
remain separate. Retained image output is limited to 64 MiB and 1,024 images;
exceeding a receipt or frame limit fails explicitly, with owned cleanup.
Raw ultrareview JSON remains limited to 64 MiB and capability help to 256 KiB.
`settingSources` defaults to `user`, `project`, `local`;
an explicit empty array is forwarded as `--setting-sources ''`.

## Observed activity and CLI compatibility (0.5.2)

The query path first runs only `claude --help` through the same owned guardian.
It sends no task prompt during this probe and requires the advertised
`--include-partial-messages` and `--forward-subagent-text` flags, plus `--name`
(or `-n`) when naming a session. The subagent flag requires Claude Code 2.1.211
or newer; the actual help surface, rather than a guessed version string,
establishes support. Unsupported flags produce a `not-dispatched` failure;
there is no fallback dispatch or automatic replay. Probe time counts against
the invocation wall deadline, its output is bounded to 256 KiB, and its text
is never returned in a receipt. `npm run doctor` checks the required flags.
See the [official CLI flags](https://code.claude.com/docs/en/cli-reference) and
[streaming contract](https://code.claude.com/docs/en/headless#stream-responses).

The public export advertises `MACHINE_ACTIVITY_VERSION: 1` and
`MACHINE_ACTIVITY_CAPABILITIES: { version: 1, metadataOnly: true, coalesced: true,
rootAndChildren: true }` for machine queries. Pass `onActivity(event)` and,
optionally, `activityIntervalMs` (integer 1–60,000, default 250 ms):

```js
const receipt = await runMachine(request, {
  onActivity(event) { observeOwnedInvocationActivity(request.requestId, event) },
  activityIntervalMs: 250,
})
```

An event has exactly `version`, `sequence`, `kind: 'provider-progress'`,
`source: 'claude-code-pro'`, `scope: 'root' | 'child' | 'mixed'`, `eventTypes`
(at most 16 known labels), and `observedEvents`. Sequence is monotonic for the
query. Labels describe assistant text/thinking, tool use/results/progress,
partial stream events, task lifecycle/progress, API retries, hook events,
initialization, compaction or the terminal result. They contain no raw text,
reasoning, tool arguments/results, private IDs, credentials or usage counters.
One coalescer covers the whole observed tree. Only newly received provider
events trigger callbacks; time passing alone never emits a heartbeat.
Repeated task progress remains activity even when the native state ledger
correctly deduplicates its unchanged state. A callback exception cannot change
execution, and callbacks stop after cancellation or settlement.

Ambient tasks are not session work. Their identities remain excluded when later
progress omits the `ambient` flag, and they cannot leave a phantom pending child
in the native completion ledger. Background task-list snapshots update this
identity bookkeeping without generating activity. The task identity cache is
bounded to 4,096 runs and 1 MiB of keys; overflow suppresses task activity and,
when native tracking is enabled, leaves native completion and cleanup unconfirmed.
The same rule applies if the child ownership ledger fills: an unrecorded task may
own remote work, even when no retained child identifies it. The separate local
process-group cleanup receipt can still be confirmed. Truncating event history
alone does not discard otherwise complete ownership evidence.
Explicit run IDs select their exact recorded run; events without a run ID use
the current run, including after a legacy unversioned run. A repeated old start
cannot replace a newer current run. Stored child state still uses its exact run
identity, so an old ambient child cannot become pending work again.
Positive `thinking_tokens` increments also count as observed thinking activity.
These rules follow the official [task-message contract](https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage).

Root activity normally follows a valid owned session initialization; a conflicting
session ID on a known root frame fails immediately, before progress is emitted.
An exception is a startup hook: its start, output and completion can arrive before
`system/init`, so a new persistent or resumed call accepts matching hook events
for the session ID the caller already chose. Ephemeral calls still require init;
an arbitrary observed ID cannot establish ownership. See the official
[hook-message timing](https://code.claude.com/docs/en/agent-sdk/typescript#sdkhookstartedmessage).
The dedicated CLI may forward child transcripts with different session IDs and
its `parent_tool_use_id` marker, regardless of whether a native profile was
requested. Missing-ID and unknown event types never supply activity.

`onProgress` remains optional display text. Neither channel is a dispatch ACK,
terminal result, usage receipt, proof of model quality or permission to retry.
Activity does not become part of a durable receipt. A long tool can still be
quiet between its start and completion: callers must treat an idle deadline as
an explicit resource policy, not proof of a dead provider. Independent
`ultrareview` and interactive tmux jobs use different protocols and do **not**
inherit the machine query's streaming-activity capability.

The first stop cause is fixed before process-group cleanup starts. A later
cancellation cannot overwrite an already-triggered wall timeout, and a deadline
that expires while cleaning up a cancelled invocation cannot relabel it as a
timeout. Cleanup retains its own bounded grace period and evidence.

For desktop/PTC foreground and background queries, an optional Flywheel host
extension can expose `ctx.get('flywheelProviderActivity')` with
`{ version: 1, intervalMs, report(agent, event) }`. The plugin supplies the real
DSH Agent and activity metadata plus a per-call `invocationId`; the host owns
lineage checks. This is an explicit plugin extension, not a DSH assistant
stream API. Without that service, desktop behavior is unchanged.

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

[0.5.2 offline activity and naming validation](activity-validation.md).
