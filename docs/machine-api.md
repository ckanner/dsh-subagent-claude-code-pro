# Machine API v1

The `dsh-subagent-claude-code-pro/machine` package export was introduced in the
0.3.2 machine API and extended by **0.4.0**. It is a public ESM interface for an
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
must supply a compatible local Claude Code executable and authorized authentication.
From 0.6.0, ordinary calls use the exact official Agent SDK 0.3.326 runtime
dependency. The machine entry remains independent of optional DSH desktop peers.
`command` selects the native executable; there is no silent bundled-runtime fallback.
The SDK may install an optional platform binary as a dependency, but the configured
local executable is the one used. Authentication remains with the native runtime;
see [runtime, settings and authentication](../README.md#runtime-settings-and-authentication).

SDK `query()` runs inside the existing guardian with a custom process-spawn hook.
The adapter still validates complete output frames, root-session identity, native
exit and process-group disappearance before producing a successful receipt. An
SDK result or iterator completion alone is not cleanup evidence. Machine protocol,
lifecycle version and read-only recovery semantics remain unchanged; native
`system/init` observations continue to use `configuration.source: "cli-init"`.

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

## Native CLI and Desktop history

Persistence, discovery and permission to continue are separate facts. A persistent
query uses the installed Claude CLI's own history in its active configuration
directory. The plugin preserves `CLAUDE_CONFIG_DIR` and does not copy transcripts,
change their native session type, or register a second conversation. Use the same
OS user and configuration directory when opening that history later; another
machine or profile does not automatically share it.

From 0.5.3, persistent creation, resume and interactive teams reject a forwarded
`CLAUDE_CODE_SKIP_PROMPT_HISTORY` that enables Claude's native history opt-out.
The failure is `invalid-request`, before any CLI capability probe or task
dispatch, with confirmed `not-started` cleanup. The plugin follows the native
boolean parser: `1`, `true`, `yes` and `on` enable the setting, ignoring case and
surrounding whitespace; `0`, `false`, `no`, `off` and other values do not. It
does not clear or override this preference. Unset the setting to request durable
history, or explicitly choose ephemeral mode; ephemeral calls remain permitted
and keep the original environment. This check covers the environment forwarded
by the adapter, and does not attest history storage or client discovery by itself.

The [official session guide](https://code.claude.com/docs/en/sessions#where-the-session-picker-looks)
excludes `claude -p` and Agent SDK sessions from the ordinary `/resume` picker and
`claude --continue`. This plugin's machine and delegation queries use print mode.
A readable name helps identify an opened session, but does not remove that native
filter. Open the exact root session UUID returned in the receipt:

```sh
cd /absolute/project
claude --resume 11111111-1111-4111-8111-111111111111
```

Desktop keeps its own session list. On a supported installation, its
[documented CLI handoff](https://code.claude.com/docs/en/desktop#coming-from-the-cli)
opens the saved conversation with its original history:

```sh
cd /absolute/project
claude --desktop --resume 11111111-1111-4111-8111-111111111111
```

Replace the example UUID with the receipt's `session.id`; if the original run used
a custom `CLAUDE_CONFIG_DIR`, keep that setting for either command. The Desktop
command requires Claude Code 2.1.285 or newer, macOS or x64 Windows, an installed
Claude Desktop app, and a Claude subscription sign-in. Run it in an interactive
terminal, without `-p`, a prompt, piped input or redirected output. It opens the
application; it is not a machine query or a background registration operation.
On an older CLI, use explicit-ID CLI resume and the supported `/desktop` command
from that interactive session. The native app may still require its own version,
platform and sign-in prerequisites.

Wait for confirmed cleanup and pause or take over the session in the orchestrator
before continuing it manually. A saved UUID alone does not permit concurrent
writers or resolve an unknown invocation. Ephemeral calls have no saved history;
native child task identifiers refer to their parent's execution and must not be
presented as independently resumable root sessions. These commands describe the
provider's supported handoff, not a claim that a desktop UI acceptance test ran.

See the [0.5.3 history validation record](session-visibility-validation.md) for
the real CLI offline reproduction and the regression boundaries.

## Observed activity and CLI compatibility (0.5.2)

The query path first runs only `claude --help` through the same owned guardian.
It sends no task prompt during this probe and requires the advertised
`--include-partial-messages` and `--forward-subagent-text` flags, plus `--name`
(or `-n`) when naming a session. The help surface establishes advertised flag
support, followed by the separate SDK version check described below.
Unsupported flags produce a `not-dispatched` failure;
there is no fallback dispatch or automatic replay. Probe time counts against
the invocation wall deadline, its output is bounded to 256 KiB, and its text
is never returned in a receipt. `npm run doctor` checks the required flags.
See the [official CLI flags](https://code.claude.com/docs/en/cli-reference) and
[streaming contract](https://code.claude.com/docs/en/headless#stream-responses).

From 0.6.0, those help checks precede official SDK execution. The SDK additionally
waits for the same process's initialize response to report a stable
`claude_code_version >= 2.1.325` before yielding task input. This is the adapter's
minimum validated runtime, not the earliest upstream version of every feature.
Missing, older and prerelease versions fail closed. Since the process has already
started, this rejection preserves its real PID/dispatch and independent cleanup
evidence; the existing receipt contract conservatively reports unknown/possible
rather than inventing a no-process receipt. `threadReadyBeforeDispatch` remains
false: SDK initialization is not verified effective task configuration.

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
the current run, including after a legacy unversioned run. Current run selection
uses the provider's plain-string ordering of one task's run IDs: an older start
or snapshot cannot replace a newer run, even when that old run is first observed
late. A legacy entry without a run ID cannot replace an established versioned
current run. Stored child state still uses its exact run
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
`sonnet`, `opus`, `haiku`, `fable` and `best` (Opus) may match their corresponding `claude-<family>-…`
canonical IDs on the compatible path. Other aliases require an
exact reported match; use a full ID when an alias cannot be verified.

The optional `subscription: {version: 1, mode: 'subscription-only'}` policy
freezes aliases to reviewed canonical IDs and checks native subscription and
extra-usage evidence in the initialized SDK process **before** releasing its
user message. It returns a sanitized `subscription` receipt and rejects unknown
or enabled extra usage. `inspectSubscription` exposes the same preflight without
a task prompt. See [subscription request, doctor and evidence](subscription.md)
for its exported types, exact SDK contract, model catalog and limitations.

`configuration.modelEvidence` records root assistant model observations and the
separate cumulative `result.modelUsage` model set. A root switch fails the run;
cumulative history/subagent/internal model entries do not prove a current-turn
fallback. `wholeRunVerified` remains false. Strict-policy success requires a root
observation matching the frozen target.

The requested effort is forwarded as `--effort`, including `low`, `medium`,
`high`, `xhigh`, or `max`. The CLI owns model/effort availability; unsupported
settings fail explicitly. Its init event does not expose an effective effort,
so the receipt does not invent one. A conflicting environment effort override,
or unsupported effort explicitly reported by the initialized native model
catalog, is rejected before sending a prompt; subscription preflight also checks
selected native settings for effort caps.

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
