# Query activity and session naming validation — 2026-11-16

Source base: `f560162d3bca6de8a76072729b0bffb57c543bfa` (0.5.1).
Independent follow-up review base: `ab9d52b322bd53cc10f45bb3cb03735ed170ef91` (PR #8).
Ownership follow-up review base: `2d6c549eaeb48f07c481e148d905de789d57dcf5`.
Candidate: `dsh-subagent-claude-code-pro` 0.5.2. This record does not claim a registry release.

The previous implementation dropped root tool/reasoning/stream activity and deduplicated successive native task-progress notifications. Two supervisors now forward a separate bounded metadata channel. The CLI capability probe runs without a task prompt, through owned process supervision, and shares the request deadline. New persistent queries receive a readable name; resume and ephemeral semantics remain unchanged.

## Executed checks

- `npm test`: 169 tests passed, zero failed or skipped. Real fixture processes cover root tools, child-only thinking, repeated native progress, 100,000 streamed deltas, more than 64 MiB of raw activity, a genuinely oversized frame, bounded high-volume display, immediate foreign-root rejection, silence without heartbeat, cancellation and group cleanup, callback cessation, durable recovery, CLI capability rejection, capability-probe cancellation/deadline, shared wall budget, fresh/resumed/ephemeral names, and DSH foreground/PTC/background host reporting. Follow-up checks cover ambient task exclusion, resumed task identities, bounded tracking overflow, pre-init startup hook ownership and both timeout/cancel cleanup orderings.
- `npm run test:package`: actual npm pack/install through the public machine export, without optional DSH peers. Validates lifecycle/recovery/resume, native child effort, supervised child activity, readable names and required streaming argv.
- `npm run test:host`: eight public tool-schema combinations against published DSH dependencies and upstream schema/PTC generation at `39163dd30f703a79079e2d2446545cff3c453738`.
- `git diff --check`: passed.

The SIGKILL regression retains all its assertions and gives the complete invocation 2 seconds so the new capability probe cannot consume the previous 200 ms startup window before the fake CLI installs its SIGTERM handler. The burst fixture drains its final stdout writes before exiting; a truncated fixture stream is not accepted as success.

Follow-up review reproduced two additional defects in the first 0.5.2 candidate: 1,100 valid 64-KiB thinking deltas exhausted the old cumulative 64-MiB stdout budget, and eight conflicting root stream/tool events produced activity despite belonging to another session ID. The revised candidate completes the first workload with a small intact final answer and rejects the latter before forwarding progress. Intermediate display and retained images remain bounded independently of activity. Workspace-name fallbacks keep private task instructions out of session-list titles; explicit labels still take precedence.

An independent review of PR #8 reproduced three further failures before changing production code:

- An ambient watcher emitted ordinary task progress after an ambient start. The adapter forwarded that activity and recreated a pending native child; even its complete successful root result became `product-error`. A bounded task/run registry now preserves the ambient exclusion through progress and notifications without hiding a later non-ambient run.
- Eight session-matched startup hook frames arrived before `system/init`; all were dropped. Caller-chosen persistent/resume IDs now permit matching startup hook activity, while uninitialized ephemeral and foreign sessions remain excluded.
- A wall timeout initiated SIGTERM cleanup, then a caller cancellation arrived. The runner returned `aborted` and lost the timeout failure. Deadline/cancel observation now stops when work settles, before cleanup; both cause orderings retain the original reason.

A further independent ownership review first reproduced six failing cases: a legacy
unversioned ambient identity or replayed old start hid the current run's progress;
the identity cache's count and byte bounds, and the child ledger's count bound,
discarded ownership while still attesting native cleanup; the identity-cache case
also failed through the real process/supervisor/machine receipt path. All six now
pass. Exact run IDs retain their own ambient status, missing run IDs use the
current run, and a repeated old start cannot move it backwards. Losing ownership
records leaves native cleanup unconfirmed because omitted work may be remote,
while independently verified local process cleanup remains confirmed. A seventh
control verifies that truncating event history alone does not erase cleanup
evidence when all task identities are still known. An eighth check keeps a stored
legacy ambient child excluded after a newer ordinary run begins: persistent
state uses exact run identity, while incoming unversioned progress uses the
current run. That state/event distinction was also verified with a failing
regression before its final correction.

The [official task contract](https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage) explicitly excludes ambient work from activity indicators, and the [official hook contract](https://code.claude.com/docs/en/agent-sdk/typescript#sdkhookstartedmessage) describes delivery before startup hooks finish. Provider-originated tool progress remains distinct from any locally generated heartbeat: this adapter still generates none.

## Limits

All model responses were deterministic fixtures. No paid model requests, real Claude account/login, desktop UI, macOS acceptance or npm publication was performed. Activity labels establish observed transport work, not successful task completion. Long tools can be quiet; independent ultrareview and interactive tmux jobs do not use the query streaming protocol. The optional Flywheel host extension requires host-side Agent ownership checks.
