# Native session history validation — 2026-11-17

Source base: `4f5d1de` (Claude Code Pro 0.5.2, merged PR #8).
Candidate: `dsh-subagent-claude-code-pro` 0.5.3. No registry publication or
existing desktop installation was changed.

## Confirmed history-suppression defect

The adapter forwarded `CLAUDE_CODE_SKIP_PROMPT_HISTORY` from its effective
child environment. A successful persistent query was then marked resumable
from its terminal result, matched session identity and cleanup, although this
native setting prevented Claude from saving any transcript.

The reproduction used the official Linux x64 `@anthropic-ai/claude-code` native
binary, version 2.1.325, SHA-256
`0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf`.
Two isolated temporary projects each used a separate `CLAUDE_CONFIG_DIR` and
a newly generated `--session-id`, with `-n`, print mode, stream-json input and
output, an empty setting-source list, disabled tools and one turn. The only
model endpoint was a loopback HTTP fixture returning a valid Anthropic text
stream. Exactly two requests reached that local fixture; no real credentials
or paid model endpoint were used.

| Native CLI case | Exit and terminal result | Saved root transcript |
| --- | --- | --- |
| History opt-out absent | Exit 0, successful result | UUID `.jsonl` under the isolated project history |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` | Exit 0, successful result | None |

The exact native binary also implements the setting with its boolean parser:
trim and lowercase the value, then accept `1`, `true`, `yes` or `on`. False and
unrecognized strings do not enable suppression. The adapter now rejects the
conflict before the read-only CLI probe or task dispatch, instead of changing
the user's history preference. This applies to new and resumed machine
queries, DSH tool queries and persistent interactive teams. Explicit ephemeral
queries keep the setting and remain non-resumable.

This check covers the adapter's forwarded environment. It does not inspect or
rewrite native transcripts, prove every possible native storage failure, or
attest additional settings loaded inside the CLI.

## Discovery and supported continuation

The official [session guide](https://code.claude.com/docs/en/sessions#where-the-session-picker-looks)
excludes print and Agent SDK sessions from the normal picker and latest-session
continuation. It supports explicit root UUID resume. Names alone do not remove
that native filter. The [Desktop guide](https://code.claude.com/docs/en/desktop#coming-from-the-cli)
documents direct CLI handoff to the app, including a saved session via
`claude --desktop --resume <UUID>` on a supported installation.

The installed native binary's handoff implementation was inspected and its
noninteractive rejection was executed offline with an isolated configuration.
It rejected redirected output before opening an application. The code also
requires an interactive terminal, macOS or x64 Windows, a subscription sign-in,
a valid saved UUID, no additional prompt or print/SDK mode, and no other live
terminal or background holder for the target session. Desktop requires its own
installed app and supported version; direct handoff starts at CLI 2.1.285.

The bilingual machine guides now distinguish persistent history, client
discovery and exclusive permission to continue; they provide exact UUID CLI
and Desktop handoff commands, configuration-directory requirements and cleanup
rules. Native child task IDs are not independent root session checkpoints.

No live Claude model, real account, macOS/Windows Desktop UI, or native picker
acceptance test was performed. The adapter does not launch the app on the
user's behalf or rewrite headless transcripts to impersonate interactive ones.

## Regression checks

The candidate checks cover new and resumed persistent requests, all native
truthy boolean spellings, false/unrecognized strings, unchanged ephemeral
environment, the DSH tool's session and persistent modes, independent team
rejection before tmux, and the actual installed package's public machine API.
Self-review also reproduced a candidate guard bypass when a legal session name
equaled `--no-session-persistence`. Session intent now travels separately from
argv values, so a label cannot disable the guard; the failing regression passes.

- `npm test`: 181 tests passed, zero failed or skipped. The six history tests
  exercise the paths and values above through public machine/tool entry points.
- `npm run test:package`: passed with an actual 0.5.3 npm pack and installation,
  including fresh/resumed conflict rejection and allowed ephemeral work through
  the installed public machine export; no model requests.
- `npm run test:host`: passed all eight tool schema/PTC combinations against
  published DSH dependencies and pinned upstream
  `39163dd30f703a79079e2d2446545cff3c453738`; no native dispatch.
- `git diff --check`: passed.
