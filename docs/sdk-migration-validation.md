# Official Agent SDK migration — 2026-11-17

The original record below covers the **0.6.0 source candidate**, based on the
0.5.3 history fix at `bd748d8a4dae93f2ed090e2a4edff7dd6fda431e`. It does not assert npm
publication, an upgrade of an existing installation, or a live desktop/account test.

## Publication follow-up — 2026-11-22

The official npm registry now reports **0.7.0** as published. Its `gitHead` is
[`e8dcd1428a10572dbffb85bd199718b85a51c29a`](https://github.com/ckanner/dsh-subagent-claude-code-pro/commit/e8dcd1428a10572dbffb85bd199718b85a51c29a),
the merged source containing the SDK migration and subscription admission.
This is a later publication check, not a replacement for the original results.

Verification command:

```sh
npm view dsh-subagent-claude-code-pro@0.7.0 version gitHead dist.integrity dist.tarball time --json --registry=https://registry.npmjs.org
```

| Registry fact | Observed value |
| --- | --- |
| Package | `dsh-subagent-claude-code-pro@0.7.0` |
| Publication time (UTC) | `2026-11-22T06:33:02.374Z` |
| Integrity | `sha512-npT2lkTDtX5qBPqeEvnWYFD32zwHAL9T11VZzMH58i2O7JvHs7Hbur33u8U4nILiHZk+NynDSO7XqowX+TeeGQ==` |
| Archive | [Official npm tarball](https://registry.npmjs.org/dsh-subagent-claude-code-pro/-/dsh-subagent-claude-code-pro-0.7.0.tgz) |

The registry also reports publication dates for the earlier 0.5.0–0.6.1 releases;
the changelog now records those dates instead of presenting them as unpublished
candidates. Their original source-validation records and limits remain intact.
This check made no model request, changed no account settings and did not inspect
or upgrade a user's installation. Publication does not establish current account
eligibility, actual billed cost or new desktop/model acceptance.

## Why this boundary

The [official Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is
the programmatic interface for embedding Claude Code's agent. The SDK itself
starts a native Claude executable; using the SDK does not remove the need to own
that process, preserve history or validate trustworthy completion.

The actual released DSH `@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.3`
uses SDK **0.3.263** and omits `pathToClaudeCodeExecutable`, selecting the SDK's
pinned native package. Its published source matches upstream
[`39163dd30f70`](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-claude-code/src/run.ts).
The older `0.0.1-rc.1` package instead supplies a resolved local executable to
SDK 0.3.220. These are different runtime-selection policies, not conflicting
authentication facts. The rc.3 adapter deliberately uses `persistSession:false`
and projects mainly the terminal answer; copying that projection would discard
the Pro plugin's history, activity and recovery contracts.

## Implemented contract

Ordinary machine, foreground and background delegations now use official
`query()` inside the existing guardian. `spawnClaudeCodeProcess` starts and
records the actual detached native process group. The SDK owns its control
protocol and message stream. The adapter retains:

- Complete UTF-8/JSON/frame and SDK-consumed envelope validation before the SDK
  reader; the SDK otherwise skips malformed stdout lines or masks a corrupt tail
  with an earlier error result. Individual frames, retained images, display
  output and final answers remain separately bounded.
- Actual native PID, exit/close/stream facts and independent TERM/KILL/group
  absence checks. An SDK result, abort or iterator completion is not cleanup proof.
- Original timeout/cancellation cause, metadata-only real root/child activity,
  terminal identity and usage validation, durable dispatch ACKs, receipt journal
  and read-only recovery. Control frames and keep-alives are not activity.
- New/resume/fork/ephemeral intent, fresh readable names, exact IDs, permission
  narrowing, settings sources, native prompt/tool presets, images/PDFs, schemas,
  budget and independently configured child effort.

Private semantic descriptors are built from validated inputs rather than parsed
back out of argv. They cannot override runtime-owned executable, cwd, environment
or callbacks. SDK `agents`, `title`, `jsonSchema` and `forwardSubagentText` travel
through initialize; their regression assertions inspect that real wire request.
Interactive Team and native Review retain their separate CLI operations.

`command` remains authoritative. There is no silent fallback to a bundled
runtime or to the old ordinary print runner. The actual initialized native process
must report a stable version **2.1.325 or newer** before the task is yielded. This
is the minimum validated release, not a historical claim about upstream feature
introduction. A rejected initialization preserves the observed PID and separate
cleanup facts; the current machine contract conservatively retains unknown/possible
rather than inventing a no-process receipt. Machine/lifecycle/native versions
remain 1, and `threadReadyBeforeDispatch` remains false.

## Runtime and authentication

The SDK version is pinned to **0.3.326**. Its npm archive has SHA-256
`6ad633b9709ab2c50bf5500b206df08ab065e2acc5461e2650fceb9a2a658583` and registry
integrity
`sha512-BUTSky/4YWfL/MxC+4kV0NDbJFjbJPoQMFEk/s9G6hV9LUfYPMbsWz94bFQ7ZIo2ubj2xwJ2c2NVxkNlQhVw+Q==`.
It may install its native platform optional dependency, while this adapter
explicitly selects the configured local executable.

Environment scrubbing and explicit credential injection retain their prior
semantics. The native runtime resolves `HOME`, `CLAUDE_CONFIG_DIR` and authorized
authentication. No credential copying or new login flow was added. Technical
access to local login is not proof of permission to offer subscription-backed
third-party authentication; the official SDK guidance directs products to API
authentication unless separately approved.

Doctor now verifies the exact SDK import and compatible native version and uses
only native `auth status`. API authentication does not require a subscription
keychain entry. Doctor no longer opens macOS keychain token contents, and its
output distinguishes static checks from the per-query initialize check.

## Verification

| Check | Observed result |
| --- | --- |
| Final full plugin suite | 205 passed; zero failed/skipped, including 6 doctor regressions and the SDK-tail correction |
| Focused runtime/machine regression after final review | 28 passed, including corruption after success/failure, known failed exit, durable recovery and compatibility admission |
| DSH host gate | All 8 schema/PTC tool combinations passed; no native dispatch |
| Actual package gate | `npm pack` → clean install → public machine API with real SDK; supervisor, journal, resume, native child effort, activity, title and persistence guard passed |
| Minimum native runtime | Actual official CLI 2.1.325 + SDK 0.3.326, public machine path and loopback model fixture passed |
| SDK-paired native runtime | Actual official CLI 2.1.326 + SDK 0.3.326, same public machine and loopback acceptance passed |

The native acceptance is reproducible with an explicit installed binary:

```sh
node scripts/verify-sdk-native.mjs /absolute/path/to/claude
```

It creates isolated home/config/project directories, supplies only a synthetic
key to a loopback Anthropic fixture and uses empty filesystem setting sources.
Each version completed new persistent history, same-ID resume and ephemeral work:
the readable custom title and answers were present in the real native JSONL
history after physical cleanup; resume sent the original context; ephemeral work
created no transcript and inherited no prior context. Every returned process
group was confirmed absent. Each run used three loopback model requests and no
paid model requests. The server saw no additional loopback requests.

Native binary identities:

| CLI | SHA-256 |
| --- | --- |
| 2.1.325 | `0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf` |
| 2.1.326 | `b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37` |

Independent reviews covered the pinned SDK source, runtime ownership, semantic
mapping, doctor and native acceptance. Review corrections included preserving
the spawn/no-dispatch classification of synchronous spawn failure, preventing a
fixture from inventing a task at EOF without a user message, and checking exact
native request counts with bounded failure cleanup in the acceptance script.

The final review reproduced a valid native result followed by a malformed SDK
control response: the iterator rejected, but the initial implementation retained
completed outcome and usage in its durable receipt. The corrected adapter rejects
malformed control/result envelopes before SDK decoding and requires a clean SDK
drain for terminal trust. Only the pinned SDK's classified, expected native failed
exit is allowed to preserve an intact failed result; exception message matching
is not used. Public machine regressions cover corrupt tails after success and
failure, invalid result status/error values, recovered receipts and lifecycle
facts, as well as intact authentication, limit, empty-error and missing-resume
failures with exit 1. Corruption yields unknown outcome and usage while preserving
separately verified cleanup. Known native failures retain their measured usage.

## Limits

These checks establish adapter/protocol behavior and real local persistence.
They do not validate paid model quality, a real subscription's eligibility,
account authentication, or a macOS/Windows desktop UI. Doctor's macOS credential
trap is a simulated platform test, not a real keychain test. The official picker
still filters print/SDK histories; migration does not promise a new sidebar entry.
See [history validation](session-visibility-validation.md) for that separate boundary.
