# Live verification record

English | [中文](live-verification.zh.md)

What was exercised against the real products, when, and what it proved. The
fake-CLI suite complements this: it covers the deterministic branches, while the
entries below are evidence from the actual `claude` CLI and a real DSH session.

Environment:

- DSH `0.2.2-rc.1`, desktop profile, plugin installed from this checkout
  (`dsh-subagent-claude-code-pro` v0.3.0).
- `claude` CLI `2.1.319` (local install, native account login).
- Delegations used model `haiku`; parent sessions used the `cordis` preset.

## Deterministic suite

```
$ npm test
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

Covers: session lifetime decisions and stale-session repair, explicit resume,
fork argv, model/effort forwarding, permission narrowing, image/PDF encoding,
tool-result image delivery and parent-route gating, structured-output validation,
background job settlement, timeout, cancellation, spawn failure, auth failure
classification, and protocol garbage.

## Real CLI smoke test (`scripts/probe-live.mjs`)

```
PASS  new session + text  cli=2.1.319 model=claude-haiku-5-5 text="LIVE_OK"
PASS  session resume + recall  text="8642" cacheRead=12134
LIVE PROBE OK
```

Proves: a real Claude Code session is created with a caller-chosen session id,
it is resumable from a fresh CLI process in the same working directory, and the
resumed turn reuses the prompt cache (`cache_read_input_tokens` > 0).

## DSH-session E2E, pass 1 (installed plugin, through `subagent_claude_code`)

A probe sub-agent in a real DSH session called the installed tool five times
sequentially. Diagnostic evidence from `~/.dsh/claude-code-pro.log` in brackets.

| # | Capability | Result | Evidence |
|---|---|---|---|
| 1 | Text delegation | PASS — `PROBE_ONE` | `run: ... session=new ...`; `cacheRead=9076` |
| 2 | Session reuse (default `session` mode) | PASS — answered `8642` | second run `session=resume resume=6a947f18-...`, `cacheRead=11940` |
| 3 | Image input (`images`) | PASS — answered "red" from the injected PNG | `run: ... images=1 ...` |
| 4 | `output_schema` | PASS — exact `{"ok":true}`, no prose, no session suffix | `schema=yes` |
| 5 | Background job (`run_in_background`) | PASS — job id returned, `job_output` → `completed`, result `BG_OK` | `serve: background job subagent-... started` |

An unknown image path is rejected before any process starts
(`claude-code-pro: image does not exist: ...`), verified in a live DSH session.

## DSH-session E2E, pass 2 (fork, image output, PDF)

After re-authenticating the local CLI, a second probe run completed all five
sequential calls with no retries.

| # | Call | Result | Evidence |
|---|---|---|---|
| 1 | New durable session | PASS — `SEQ_ONE`, session `671c4f61-198d-4a5e-ab71-0db8ecb3e4b0` | `run: ... session=new` |
| 2 | `fork_session: true` on that id | PASS — new id `30a1cdf3-3201-4307-a5fb-9cf349fef501`, recalled `2468` (history inherited) | `session=resume resume=671c4f61-...` → `run done: session=30a1cdf3-...` |
| 3 | Image output (Claude Code `Read` of a cwd image, `ephemeral`) | PASS — answered "Red"; the tool result carried a real `image/png` attachment block the caller could see (`~/.dsh/attachments/...`) | `run done: ... images=1 delivered=1` |
| 4 | PDF input (`documents`) | PASS — extracted `CCPRO-PDF-42` from the attached PDF | `run: ... documents=1` |
| 5 | Explicit resume of the original session after the fork | PASS — recalled `2468`; marker id equals the original `671c4f61-...` | `session=resume resume=671c4f61-...` |

## Local CLI credential caveat (measured)

The local Claude Code CLI keeps its OAuth session in the system keychain. During
repeated fresh-process runs the CLI twice cleared the stored tokens and reported
`Failed to authenticate: OAuth session expired and could not be refreshed`.
The plugin never reads or writes credentials; this is CLI-owned state. Recovery:
`claude auth login` (verify with `node scripts/doctor.mjs`). For unattended or
high-frequency use, a static child credential (`claude setup-token` →
`env.CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` in the plugin `env`) avoids
the keychain refresh path.
