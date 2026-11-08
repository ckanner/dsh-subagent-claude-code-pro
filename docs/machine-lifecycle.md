# Typed lifecycle and read-only recovery (lifecycle 1)

The **0.4.0 unreleased source candidate** extends the public
`dsh-subagent-claude-code-pro/machine` JavaScript API. Result protocol 1 and the
existing DSH desktop tool remain compatible. No npm publication or live account
upgrade is implied by a source change.

## Enable the evidence channel

`runMachine(request, runtime)` accepts an awaited `onLifecycle(event)` callback
and a `recoveryDirectory`. The directory must be a **new** canonical absolute
path below an already existing physical parent. The supervisor creates it with
mode 0700; existing directories, aliases and symlinks are refused. One engine
invocation owns one directory. Reusing a directory never starts another attempt.

```js
import {
  runMachine, recoverMachine, MACHINE_LIFECYCLE_VERSION,
  MACHINE_LIFECYCLE_CAPABILITIES,
} from 'dsh-subagent-claude-code-pro/machine'

const receipt = await runMachine(request, {
  recoveryDirectory,
  signal: controller.signal,
  // Resolve only after the engine's correlated evidence is atomic and fsynced.
  onLifecycle: event => engine.persistCheckpointAndFsync(event),
})
const recovered = await recoverMachine({
  protocol: 1, requestId: request.requestId,
  runId: savedCheckpoint.runId, recoveryDirectory,
})
```

This is a programmatic persistence ACK, not another human permission prompt.
The caller owns task/role state, its original candidate/guard proof and budgets.
The plugin records invocation evidence and never changes the engine's state.
`onProgress` remains display-only and cannot be used as a checkpoint.

## Claude's actual capability boundary

The exported `MACHINE_LIFECYCLE_VERSION` is 1. The capability declaration is
`{version:1, durableJournal:true, readOnlyRecovery:true,
threadReadyBeforeDispatch:false}`.

The supported stream-json invocation observes `system/init` only after prompt
submission. It has no verified pre-prompt configuration handshake or stable
per-turn ID in this adapter. Consequently this API does **not** emit
`thread-ready` or `turn-accepted`, invent a control request, or claim that a
proposed session UUID proves a history was opened. Effective cwd/model/native
permission/session identity are still checked against actual init evidence in
the terminal receipt. A mismatch fails the run.

Every lifecycle event contains `lifecycleVersion:1`, `type:'lifecycle'`,
`requestId`, `runId`, `sequence` starting at 1, `event`, `threadId`, `turnId:null`,
`persistent`, `configuration`, `dispatch`, `outcome` and `cleanupConfirmed`.
Before prompt submission, `threadId` is the proposed/requested UUID, or null for
an ephemeral request. `persistent` is the requested history mode and
`configuration` is null. These fields do not prove that the CLI accepted work or
that a rollout can be resumed.

| Event | Meaning |
| --- | --- |
| `dispatch-intent` | The prompt has not been submitted. The awaited ACK must be durably saved by the engine. |
| `dispatch-possible` | Saved and ACKed before handing the invocation to the native runner. A subsequent send/ack crash window remains possible. |
| `terminal` | Actual native result/cleanup observations have been collected; the original full receipt has already been fsynced when a journal was requested. |
| `cleanup-confirmed` | Sent only after actual group cleanup is confirmed and the receipt is durable. The engine can save original candidate/guard/report evidence before ACK. |

The final notifications are delivered after native settlement, not as an early
streaming terminal. They contain the same final facts. Lost terminal delivery or
a rejected final ACK never relabels an already completed native run as cancelled.
A failure can go directly to terminal if no prompt was submitted.

`execution.dispatch` retains its original process meaning:
`not-dispatched | dispatched` describes whether a native process was spawned.
The additive `execution.turnDispatch` and lifecycle `dispatch` describe the
request boundary: `not-dispatched | possible | accepted`. A trusted CLI terminal
can prove acceptance; merely spawning a PID cannot. Rejection at the
possible-send barrier remains possible, even if a test observes no CLI spawn.
A fully observed missing-executable failure can instead prove not-dispatched.

## Supervision and durable recovery

Opting into either lifecycle or the journal creates an independent, detached
machine supervisor before work starts. Its IPC connection is the caller's
lifeline. The existing native guardian remains responsible for the CLI process
group. Killing the caller or its whole group rejects a pending ACK and aborts
the original invocation; the machine supervisor waits for native cleanup and
persists the observed receipt even when nobody can receive it anymore.

Final persistence happens **before** terminal/cleanup notifications. Each journal
record is bounded to 64 MiB, mode 0600, written to an exclusive temporary file,
fsynced, atomically renamed, and followed by directory fsync. The new directory's
parent is fsynced too. Exact request/run identity and a SHA-256 checksum detect
mismatched or damaged evidence. The journal is never used as an automatic retry
instruction or a second orchestration state machine.

Admission and each ACK have a 10-second supervisor limit; the configured
invocation deadline also bounds pre-prompt checkpoints and the remaining native
run. Disconnect immediately rejects the active waiter. Final callback delivery
failure is separate from already observed native success, usage and cleanup.

`recoverMachine({protocol:1,requestId,runId,recoveryDirectory})` reads exactly the
known invocation's journal. It never starts a CLI, contacts the model, resumes a
session, scans user history, kills a process, writes files or replays an action.
A known run ID is required. It does not treat PID presence as ownership or PID
absence as a reconstructed cleanup receipt.

| `status` | Evidence and permitted interpretation |
| --- | --- |
| `terminal` | Returns the original stored receipt. It may still be a failed/unknown run or have unconfirmed cleanup; consumers must validate the independent facts. |
| `pending` | A matching journal exists but there is no durable complete receipt. This is not a liveness claim and does not authorize replay. |
| `unknown` | Missing, inaccessible, corrupt or identity-mismatched evidence; no execution facts are invented. |

The recovery response contains the latest stored `lifecycle` event, the original
`receipt` when present, and a reason. A lifecycle event was saved before caller
delivery: its presence does not prove the engine ACKed it. The engine's own
checkpoint must bind the original candidate/guard/report snapshot. If the caller
dies before saving that proof, the receipt can establish attributable usage but
must not cause current files to be recaptured as old verification evidence.

If the machine supervisor itself is also killed before final persistence, its
native guardian may clean up while the journal remains pending. Unknown run IDs,
missing sessions, escaped process groups, simultaneous supervisor loss and power
loss beyond filesystem fsync guarantees are not exactly-once execution. The
engine must keep both fresh replay and resume blocked when outcome or cleanup
cannot be established. `requestId` is not a provider idempotency key.

## Retention and validation

The engine owns retention. Keep unresolved journals; delete a completed one only
after its receipt has been applied/accounted once and audit retention expires.
Importing the package does not scan history, prune old journals or change desktop
settings. Env credentials are never copied into journal fields, while the raw
model output may itself contain sensitive user content. Keep that evidence in
the intended private task area with the caller's retention policy.

Offline tests use actual processes to verify pre-prompt ACKs, rejection,
credential propagation, exclusive admission, corruption, read-only recovery and
caller-group SIGKILL before dispatch, during execution, and after durable native
completion. They verify that final delivery loss preserves the real completed
receipt and costs remain unknown. This is not new live Claude/account/desktop,
quality, cache or billing validation. See the
[validation record](machine-lifecycle-validation.md) and
[terminal machine contract](machine-api.md).
