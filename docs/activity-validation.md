# Query activity and session naming validation — 2026-11-16

Source base: `f560162d3bca6de8a76072729b0bffb57c543bfa` (0.5.1).
Candidate: `dsh-subagent-claude-code-pro` 0.5.2. This record does not claim a registry release.

The previous implementation dropped root tool/reasoning/stream activity and deduplicated successive native task-progress notifications. Two supervisors now forward a separate bounded metadata channel. The CLI capability probe runs without a task prompt, through owned process supervision, and shares the request deadline. New persistent queries receive a readable name; resume and ephemeral semantics remain unchanged.

## Executed checks

- `npm test`: 153 tests passed, zero failed or skipped. Real fixture processes cover root tools, child-only thinking, repeated native progress, 100,000 streamed deltas, more than 64 MiB of raw activity, a genuinely oversized frame, bounded high-volume display, immediate foreign-root rejection, silence without heartbeat, cancellation and group cleanup, callback cessation, durable recovery, CLI capability rejection, capability-probe cancellation/deadline, shared wall budget, fresh/resumed/ephemeral names, and DSH foreground/PTC/background host reporting.
- `npm run test:package`: actual npm pack/install through the public machine export, without optional DSH peers. Validates lifecycle/recovery/resume, native child effort, supervised child activity, readable names and required streaming argv.
- `npm run test:host`: eight public tool-schema combinations against published DSH dependencies and upstream schema/PTC generation at `39163dd30f703a79079e2d2446545cff3c453738`.
- `git diff --check`: passed.

The SIGKILL regression retains all its assertions and gives the complete invocation 2 seconds so the new capability probe cannot consume the previous 200 ms startup window before the fake CLI installs its SIGTERM handler. The burst fixture drains its final stdout writes before exiting; a truncated fixture stream is not accepted as success.

Follow-up review reproduced two additional defects in the first 0.5.2 candidate: 1,100 valid 64-KiB thinking deltas exhausted the old cumulative 64-MiB stdout budget, and eight conflicting root stream/tool events produced activity despite belonging to another session ID. The revised candidate completes the first workload with a small intact final answer and rejects the latter before forwarding progress. Intermediate display and retained images remain bounded independently of activity. Workspace-name fallbacks keep private task instructions out of session-list titles; explicit labels still take precedence.

## Limits

All model responses were deterministic fixtures. No paid model requests, real Claude account/login, desktop UI, macOS acceptance or npm publication was performed. Activity labels establish observed transport work, not successful task completion. Long tools can be quiet; independent ultrareview and interactive tmux jobs do not use the query streaming protocol. The optional Flywheel host extension requires host-side Agent ownership checks.
