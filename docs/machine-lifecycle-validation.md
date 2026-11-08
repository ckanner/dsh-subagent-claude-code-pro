# Lifecycle 1 validation record

Validated on 2026-11-08 against the **0.4.0 unreleased source candidate**,
based on repository commit `28483f8aafc15463c6d365100b64c04480cb56b5`.
The local environment was Linux with Node 24.22.1 and npm 12.2.1. This does
not claim an npm release, a local macOS run, or a new live Claude account test.

## Commands and results

| Check | Result |
| --- | --- |
| `npm test` | 91 tests passed, 0 failed, 0 skipped. |
| `npm run test:package` | Packed the actual package, installed it in a clean consumer, imported its public machine export and exercised lifecycle, read-only recovery and explicit resume. Passed. |
| Standalone strict TypeScript consumer | The public declarations compiled with TypeScript 5.9 (`--noEmit --strict --module nodenext --target ES2022 --lib ES2022,DOM`). The consumer also checked that Claude's turn ID is `null`, unsupported readiness events are rejected, and recovery accepts no prompt. |

All 11 new lifecycle/recovery tests ran. The existing machine validation,
permissions, environment, process ownership, configuration, result parsing and
schema tests also ran. No live inference request was made. CI is configured to
run the installed-package check on its existing Linux/macOS and Node 22/24
matrix; that configuration is not a claim that remote CI has already passed.

## What was exercised

Tests use real subprocesses running a controlled native CLI fixture. Its
invocation capture provides direct evidence of whether the CLI was started.

- The capability explicitly reports `threadReadyBeforeDispatch:false`.
  Pre-prompt events carry no invented effective configuration or turn ID.
- Intent and possible-send callbacks await durable acknowledgement while the
  native invocation count remains zero. Rejection prevents prompt submission;
  the possible-send checkpoint remains conservatively typed `possible`.
- A complete receipt is persisted before the terminal callback. Rejection or
  loss of final delivery preserves the observed successful native result.
- The supervisor preserves explicit environment replacement and credential
  allowlisting. Credentials are not copied into journal fields.
- Recovery returns the exact original receipt without another native process
  or a journal write. Missing, corrupted, mismatched and symlinked journals
  remain unknown; an existing journal refuses a new invocation.
- Whole caller-group SIGKILL before dispatch, during native execution, at
  terminal delivery and at cleanup delivery allows the independent supervisor
  to save the original cleanup and outcome observations.
- Killing the machine supervisor itself leaves the journal `pending`, even
  though the native guardian later removes its process group. Recovery does
  not infer a terminal result from PID absence or start replacement work.

The installed-package test imports only
`dsh-subagent-claude-code-pro/machine`. It verifies the four supported events,
the actual packaged supervisor, read-only receipt equality and an explicitly
requested second turn on the same fixture session. Recovery itself never
resumes the session. Existing desktop and machine entry points retain their
separate contracts.

## Limits of this evidence

This is local protocol and process validation, not new account, billing,
cache, output-quality or desktop-host evidence. Claude's supported stream-json
mode observes init after prompt submission, so the implementation does not
claim pre-prompt effective-configuration readiness or a stable per-turn ID.
The permission-mode mapping is still native Claude approval behavior, not
proof of an OS filesystem sandbox. Reported CLI cost is retained separately;
the adapter does not turn it into a confirmed account charge.

Unknown execution after simultaneous supervisor loss remains unknown, and
request IDs do not create provider idempotency. The complete recovery and
retention rules are in the [lifecycle contract](machine-lifecycle.md).
