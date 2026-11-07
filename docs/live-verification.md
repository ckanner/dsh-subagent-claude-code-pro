# Live verification record

What was exercised against the real products, when, and what it proved. This is
evidence, not a promise: the fake-CLI suite covers the remaining branches
deterministically, and entries under **Not yet verified live** say so explicitly.

Environment at the time of these runs:

- DSH `0.2.2-rc.1`, desktop profile, plugin installed from this checkout.
- `claude` CLI `2.1.319` (local install, native account login).
- Model used for delegations: `haiku`.

## Deterministic suite

```
$ npm test
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

Covers: session lifetime decisions and stale-session repair, explicit resume,
fork argv, model/effort forwarding, permission narrowing, image/PDF encoding,
tool-result image delivery and parent-route gating, structured-output
validation, background job settlement, timeout, cancellation, spawn failure,
auth failure classification, and protocol garbage.

## Real CLI smoke test (`scripts/probe-live.mjs`)

```
PASS  new session + text  cli=2.1.319 model=claude-haiku-5-5 text="LIVE_OK"
PASS  session resume + recall  text="8642" cacheRead=12134
LIVE PROBE OK
```

Proves: a real Claude Code session is created with a caller-chosen session id,
the session is resumable from a fresh CLI process in the same working directory,
and the resumed turn reuses the prompt cache (`cache_read_input_tokens` > 0).

## DSH-session E2E (installed plugin, through `subagent_claude_code`)

A probe sub-agent in a real DSH session called the installed tool five times
sequentially. Diagnostic evidence from `~/.dsh/claude-code-pro.log` in brackets.

| # | Capability | Result | Evidence |
|---|---|---|---|
| 1 | Text delegation | PASS — `PROBE_ONE` | `run: ... session=new ...`; `run done: ... session=6a947f18-... cacheRead=9076` |
| 2 | Session reuse (default `session` mode) | PASS — answered `8642` | second run `session=resume resume=6a947f18-...`, `cacheRead=11940` |
| 3 | Image input (`images`) | PASS — answered "red" from the injected PNG | `run: ... images=1 ...` |
| 4 | `output_schema` | PASS — exact `{"ok":true}`, no prose, no session suffix | `schema=yes` |
| 5 | Background job (`run_in_background`) | PASS — job id returned, `job_output` → `completed`, result `BG_OK` | `serve: background job subagent-... started` |

Additionally: an unknown image path is rejected before any process starts
(`claude-code-pro: image does not exist: ...`), verified in a live DSH session.

## Not yet verified live

These are implemented and covered by the fake-CLI suite, but the last live pass
was interrupted by the CLI credential issue below before they could run:

- **Image output**: a `tool_result` image (for example, Claude Code reading an
  image file) is saved through the DSH attachment store and returned as an image
  block, gated by the parent model route. The live run's `Read` was denied by
  `dontAsk` because the file was outside the workspace, so no image was produced.
  `tests/plugin.spec.mjs` covers the delivery path end to end.
- **PDF document input**: `documents` becomes an Anthropic `document` content
  block. `tests/plugin.spec.mjs` asserts the stdin block; the real CLI's
  acceptance of the block still needs one live call.
- **`fork_session`**: argv is covered; a live fork needs one resumed call.

## Local CLI credential caveat (measured)

The local Claude Code CLI keeps its OAuth session in the system keychain. During
repeated fresh-process runs (including this plugin's own live verification), the
CLI twice cleared the stored tokens and then reported:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

The plugin never reads or writes credentials; this is CLI-owned state. Recovery:
`claude auth login` (verify with `node scripts/doctor.mjs`). For unattended or
high-frequency use, a static child credential (`claude setup-token` →
`env.CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` in the plugin `env`) avoids
the keychain refresh path.
