# Changelog

## 0.4.0 (2026-11-12)

- Add lifecycle v1 with awaited pre-prompt dispatch-intent and dispatch-possible
  checkpoints, independent from display-only progress. Expose the explicit
  threadReadyBeforeDispatch:false capability: stream-json does not prove the
  effective init configuration before prompt delivery.
- Add a separately grouped machine supervisor that outlives caller death,
  completes native guardian cleanup and durably saves the original receipt.
  Lost terminal delivery does not relabel completed work as cancelled.
- Add private exclusive fsynced journals and read-only recoverMachine; no CLI
  spawn, resume, history scan, automatic fresh run or exactly-once claim.
- Preserve native process dispatch and add execution.turnDispatch for the
  model-request boundary. Costs and incomplete usage keep their original meaning.
- Add real process-group SIGKILL and ACK rejection regression tests, typed public
  contracts and bilingual lifecycle documentation. This remains unpublished
  source; it does not update installed CLI/desktop accounts or claim live testing.

## 0.3.2 (machine API precursor, shipped in 0.4.0)

- Add public `dsh-subagent-claude-code-pro/machine` protocol v1 with TypeScript
  declarations, strict request admission, explicit ephemeral/persistent/resumed
  invocation identity, real CLI init observations, per-run usage completeness,
  and separately reported API-equivalent cost. No runtime dependencies.
- Settle the entire owned POSIX process group on every exit path, including
  failed results, aborts, output errors, and a leader that exits first. Only
  ESRCH proves absence; unconfirmed cleanup blocks success and session reuse.
- Establish an independent guardian and IPC lifeline before starting the CLI.
  Caller death, including process-group SIGKILL, disconnects that lifeline and
  makes the guardian clean up the native group. The caller waits for the
  guardian's terminal response and exit before returning a receipt.
- Reject malformed/truncated/duplicate terminal frames, conflicting session
  identities, missing explicit status, abnormal success exits, and mismatched
  cwd/model/native permissions. Progress never proves completion.
- Preserve the desktop tool's text, image/PDF, structured-output, and background
  interfaces. Limit remembered-session repair to confirmed terminal/cleanup
  evidence, and honor independent `persistent` calls instead of implicitly
  reusing an Agent session. Explicit empty setting sources remain empty.
- Add bilingual machine-contract documentation and offline fault/process tests.
  No new real-account or macOS acceptance is claimed for the machine API, and
  no npm release or existing installation update is performed by this change.

## 0.3.1

DSH plugin metadata and bilingual documentation.

- `locale/{de,en,es,fr,ja,pt,ru,zh}.json`: localized title/description for the
  Plugins page; the Chinese and English locales point `meta.detail` at the
  matching README so the plugin detail page follows the UI language.
- `icon.svg` + `package.json` `icon`, so the bundle carries its own original
  artwork instead of default plugin art.
- Root `README.zh.md` (Chinese) beside `README.md` (English), plus
  `docs/live-verification.zh.md`.
- Package description/keywords aligned with DSH plugin conventions
  (`dsh-plugin`, `deepseek-harness`, `dsh`, `cordis`, …).
- Install documentation: registry install (no local `link:`), plugin manager
  adds the package by name.

## 0.3.0

First fully live-verified release.

- Live DSH-session verification completed: text, session reuse, `fork_session`
  (new id, history inherited), image input, image output (real attachment block
  delivered to the caller), PDF document input, `output_schema`, and background
  job — all passed against the local `claude` CLI 2.1.319.
- `docs/live-verification.md` records commands, evidence, and the CLI credential
  caveat.
- GitHub repository + CI added; release tarball attached to the GitHub release.

## 0.2.2

- Doctor: read the macOS keychain password entry correctly (never printed) and
  report token lengths/expiry; `CLAUDE CODE DOCTOR OK` on a healthy login.
- README/中文文档：记录 OAuth 刷新竞态导致 CLI 清空 token 的现象，以及
  `claude setup-token` + `env.CLAUDE_CODE_OAUTH_TOKEN` 的静态凭据方案.
- Verified live in a real DSH session: text, session reuse, image input,
  instruction reading, `output_schema`, and background job (see README).

## 0.2.1

- `scripts/doctor.mjs`: local CLI diagnose (version, login, required flags,
  macOS keychain token lengths) with actionable next steps; `npm run doctor`.
- README/中文文档补充排障入口。
- Packaging verified with `npm pack --dry-run` (lib, patch, docs, license).

## 0.2.0

Multimodal and machine-readable delegations.

- Model-native input: `images` (PNG/JPEG/GIF/WebP) and `documents` (PDF) become
  Anthropic `image` / `document` content blocks; every path is validated before
  the CLI is spawned.
- Image output: base64 images from `tool_result` frames are saved through the
  DSH attachment store and returned as image blocks, gated by the parent model
  route's declared input modalities; failures become text notes.
- `output_schema` via `--json-schema`, with a fail-closed local validator and
  pure-JSON delivery (no session marker).
- Background runs through the DSH jobs service: `run_in_background` returns a
  job id, `job_output`/`job_kill` work as with Codex Pro; background images are
  written to `$DSH_HOME/claude-code-pro-images/` and named in the job text.
- 51 deterministic tests.

## 0.1.0

Initial text + session core.

- Registers `subagent_claude_code` per Agent (Codex Pro / LCU registration path).
- Drives the user's local `claude` CLI over the stream-json protocol; no bundled
  Agent SDK payload and no host-CLI fallback.
- Per-call `model`, `reasoning_effort`, `permission_mode`, `cwd`, `timeout_ms`.
- Session lifetime: `ephemeral` / `persistent` / `session` (default), explicit
  `session_id` resume, `fork_session`, remembered-session repair.
- Deadline, caller cancellation, POSIX process-group cleanup, auth/resume/
  protocol failure classification.
- Diagnostic log `~/.dsh/claude-code-pro.log`.
- Deterministic test suite with a fake `claude` CLI.

Planned next milestone: model-native image and document input, image output
(attachment store + parent-route gating), `output_schema`, background jobs.
