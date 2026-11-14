# Native capabilities (0.5.0 source candidate)

The public `dsh-subagent-claude-code-pro/machine` entry now exposes native Agent,
Workflow, advisor, media and structured-output controls, plus independent native
review and interactive Team jobs. The package drives the locally installed,
logged-in `claude` CLI. It does not install the Agent SDK, change authentication,
write global user settings, or enable another billing provider.

Protocol 1 requests without `native` retain their previous behavior. Explicit
controls configure full native workers with the caller's native permission mode,
tools, project definitions and model choices. Workers are not reduced to a
read-only helper tool set. Claude permission modes remain tool-approval policies,
not operating-system sandboxes; a root `bypassPermissions` can override a child's
plan permission mode under Claude's own rules.

## Normal machine queries

```js
import { runMachine } from 'dsh-subagent-claude-code-pro/machine'

const receipt = await runMachine({
  protocol: 1, requestId: 'migration-1', cwd: '/repo/worktree',
  prompt: 'Implement the migration. Use a workflow for the independent modules.',
  model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', sessionMode: 'persistent',
  native: {
    version: 1,
    agents: {
      enabled: true, maxConcurrent: 4, maxDepth: 2,
      definitions: {
        implementer: { description: 'Implement one module', prompt: 'Complete and validate the assigned module.', model: 'sonnet' },
      },
    },
    workflows: { enabled: true, maxConcurrent: 8 },
    advisor: { enabled: false },
  },
  maxBudgetUsd: 10,
  outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false },
}, {
  recoveryDirectory: '/repo/run-evidence/migration-1',
  onLifecycle: async event => { /* persist checkpoint before resolving */ },
  onNativeEvent: event => { /* display metadata, not a dispatch ACK */ },
})
```

`agents.definitions` uses native `--agents` definitions: description, prompt,
tools, disallowedTools, model, permissionMode and maxTurns. Installed project/user
agent definitions remain available. Root model and effort retain their existing
per-invocation controls. Advisor activation additionally requires an explicit
model (`{enabled:true, model:'opus'}`); native account/model eligibility and any
existing usage-credit consent still apply. The package never accepts that consent
on the user's behalf.

With a present native object, an omitted capability is off. Agent off adds native
`--disallowedTools Agent,Task`; Workflow off uses `disableWorkflows`,
`CLAUDE_CODE_DISABLE_WORKFLOWS=1` and the Workflow tool deny rule. Advisor off uses
`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. Print queries explicitly disable Agent Teams
and their creation tools; the real Team interface is described below.

Controls are scoped argv/settings/environment, not prompt hints. Concurrency maps
to `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and
`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`; depth maps to
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. These are different native limits. The
ordinary Agent cap is not a universal process cap: ultracode and some fork/resume
paths have native exceptions, and workflow agents use their own cap. `maxBudgetUsd`
passes the CLI's USD budget; it is not proof of a subscription invoice or a hard
bound on unrelated/cloud work. Timeouts and measured usage remain separate.

`system/init.tools` and `agents` are checked against requested tool availability.
Mismatches stop the run and remain failures. Print mode has no verified pre-prompt
configuration handshake, so dispatch may already be possible when init arrives.
`native.effective.verification` is `tools-only`: concurrency/depth limits, actual
advisor activation/model and child permission precedence are explicitly listed as
unverified. Passing an environment variable is not claimed as runtime introspection.

`native.resourceBounds.hard` is consequently `false`. The declared concurrency
can reserve host scheduling slots, but does not certify a global upper bound.
The adapter cancels and settles the local process group when observed ordinary
Agent or per-workflow worker counts exceed their requested limits. This is an
observation after native dispatch, not a pre-dispatch semaphore; missing child
events cannot establish exact concurrency. A host with a strict budget must keep
unknown usage unresolved before admitting additional work.

## Media and structured output

Machine requests accept up to 20 base64 image objects `{data, mimeType}` with a
32 MiB total encoded limit. Supported MIME types are PNG, JPEG, GIF and WebP. They
become real user-message image blocks. `outputSchema` passes `--json-schema`, and
the returned object is checked with the same explicit schema validator used by
the desktop integration. An unsupported schema assertion is a validation failure,
not silently accepted. `receipt.structured` retains the validated value; returned
image blocks are in `receipt.images`, preserving the old text-only `output` shape.

## Child events, usage and recovery

The metadata ledger associates native tool calls, parent_tool_use_id transcripts,
task IDs, parent task IDs and task run IDs. Native run IDs are opaque and are never
sorted to decide which run is current. Unversioned completion events cannot end a
versioned resumed run. Nested transcripts never become root
completion or contaminate root session identity. A resumed task with a new run ID
is a new ledger entry; a late old-run completion cannot end the new run. Progress
usage is a high-water snapshot, not an increment. Ambient tasks are excluded.
Structured native tool results can establish background/remote launches; model
prose cannot. Workflow task-notification follow-up turns are accepted only with
native provenance; duplicate/unrelated root results still fail.

Root result usage remains the public root report. Child task snapshots and a
foreground Agent's last-request counters are not added to it. Native usage reports
`strategy:'root-result-only'` and `childSnapshotsAreAdditive:false`; when native
children exist, `aggregateFamilyStatus` is unknown. Multiple root results retain
their separate observed usage records, and the run total remains unknown rather
than guessing whether session snapshots are additive. API-equivalent cost
estimates remain distinct from the user's charge.

The existing guardian stops owned local process groups on cancellation, timeout
or caller death. `native.completion` separates child task completion from physical
cleanup. A root that exits with observed workers still pending is not a successful
machine task merely because cleanup killed them. A pending `remote_agent` is not
confirmed cleaned by killing the local CLI. Terminal native evidence is persisted
with the original lifecycle journal. Recovery never replays prompts. Workflow
resume can rerun completed writes under native replay rules; a host must validate
scope and reconciliation before explicitly choosing a new invocation.

## Independent cloud review

```js
import { runNativeReview, recoverNativeJob } from 'dsh-subagent-claude-code-pro/machine'

const review = await runNativeReview({
  protocol: 1, requestId: 'cloud-review-1', cwd: '/repo/reviewer-worktree',
  target: 'main', consent: true, trustWorkspace: true, timeoutMinutes: 45,
}, { recoveryDirectory: '/repo/run-evidence/cloud-review-1' })
```

This starts the actual `claude ultrareview [target] --json --no-post` command,
with optional explicit `--trust-workspace`. It does not use `claude -p` with a slash
command, since that can exit before findings arrive. `consent:true` is an explicit
machine policy choice to start this remote operation, including native upload and
charging behavior; a previously approved host profile may supply it without an
additional interactive approval. No review is started merely by enabling Agents
or by importing the package. Posting is disabled on this interface.

The dedicated request has no prompt/model/permission fields the native command
would silently ignore. It has its own fresh identity and mandatory recovery
directory. A clean exit 0 plus complete JSON findings proves the command completed;
the payload is preserved as `structured`. This is supporting review evidence,
not an automatic structured approval of a separate task.

`validateNativeReviewRequest(request)` and `validateInteractiveTeamRequest(request)`
provide public preflight validation without launching a process or creating a
journal. They return no internal normalized envelope; pass the original validated
request to the corresponding run method.

The public CLI does not expose a guaranteed job-ID, status-query or cloud-cancel
interface. Accordingly `remote.jobId` may be null, `querySupported` and
`cancelSupported` are false, and timeout/abort/exit 1/130 leave `remote.state` unknown
after dispatch. Local cleanup remains separately reported. `recoverNativeJob`
reads the durable original result only; it never reruns the command. Starting it
again creates another review and can bill again. The same recovery directory is
never reused. This provides real launch/wait/findings/recovery semantics without
claiming that local cancellation stopped an unobserved cloud session.

## Actual interactive Agent Teams

Native Team spawning requires an interactive Claude session; `-p` and Agent SDK
queries spawn ordinary subagents instead. `runInteractiveTeam` therefore starts
the CLI in an isolated tmux terminal with `--teammate-mode in-process`, a fresh
session UUID, the requested working directory/model/permission mode, and scoped
Team enablement. An installed tmux executable is required. The ordinary query API
does not emulate a Team by giving a set of helper calls that name.

```js
import { runInteractiveTeam, controlInteractiveTeam } from 'dsh-subagent-claude-code-pro/machine'

let identity
const done = runInteractiveTeam({
  protocol: 1, requestId: 'team-1', cwd: '/repo/team-worktree',
  prompt: 'Form a team to implement and cross-review the independent components.',
  permissionMode: 'acceptEdits', model: 'sonnet', timeoutMs: 30 * 60_000,
}, {
  recoveryDirectory: '/repo/run-evidence/team-1',
  onLifecycle: event => { identity = { protocol: 1, requestId: event.requestId, runId: event.runId, recoveryDirectory: '/repo/run-evidence/team-1' } },
  onNativeEvent: event => { /* interactive-ready means terminal controls can connect */ },
})
// After interactive-ready:
const attach = await controlInteractiveTeam({ ...identity, action: 'attach' })
// Run attach.command with attach.args in the user's terminal.
// Other explicit actions: capture, send (+text/enter), resize (+columns/rows), cancel.
const terminalReceipt = await done
```

Controls require the exact request ID, run ID and owned journal. They never search
for someone else's sessions or accept an arbitrary PID/socket. Literal input uses
tmux buffers, not shell interpolation. `capture` returns bounded display text;
`attach` supplies the exact terminal command. Cancel signals the living supervisor
to settle the isolated native group and tmux server; accepting cancel is not itself
cleanup confirmation. Caller disconnect also triggers settlement and durable
receipt persistence.

Team output is an interactive terminal, not a stable native child/usage protocol.
A clean pane exit can set job `ok:true`, but
`completion.businessOutcome:'unknown'` always makes the limit explicit: it does
not certify a code change or a Reviewer verdict. No unreliable automatic Team
session/teammate resume is promised. Use ordinary native Agent/Workflow queries
when an unattended structured loop needs a machine result.

## Validation and primary references

Offline tests use real local processes for child/session separation, resume-run
ordering, usage deduplication, config mismatch, media/schema/budget forwarding,
Workflow follow-ups, dedicated review JSON/timeout/recovery, and the interactive
terminal command/control/cancel lifecycle. A tmux protocol fixture exercises the
actual argv contract with independently owned native process groups. Neither a
logged-in Claude cloud review nor a real installed tmux/Claude Team session was
run in this environment. This package is a source candidate, not a claim of an npm
release or live-account acceptance.

Primary native references, checked 2026-11-14:

- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Dynamic workflows, limits and off controls](https://code.claude.com/docs/en/workflows)
- [Agent Teams and interactive-only spawning](https://code.claude.com/docs/en/agent-teams)
- [Advisor model and disable control](https://code.claude.com/docs/en/advisor)
- [Ultrareview command and unresolved cloud work after timeout](https://code.claude.com/docs/en/ultrareview)
- [Public stream/task/origin/result protocol](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Anthropic workflow implementation example](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)
