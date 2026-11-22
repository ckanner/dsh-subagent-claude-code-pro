# Changelog

Release dates below use the official npm registry's UTC publication dates.
The 0.5.0–0.7.0 release status was rechecked on 2026-11-22; see the
[publication evidence](docs/sdk-migration-validation.md#publication-follow-up--2026-11-22).
Registry publication is separate from source validation, installed versions and
live account/model acceptance.

## 0.7.0 (2026-11-22)

- Persist ordered input-image SHA-256, MIME type and decoded-byte identities in
  machine receipts and pre-dispatch journals without retaining image contents;
  read-only recovery exposes the original manifest and never accepts replacements.

- Validate large canonical base64 image inputs without recursive regular-expression
  stack overflow; exercise a 4 MiB decoded attachment through the real pinned SDK.
  Keep the existing public media formats, count/encoded-size limits and text-only behavior.
- Add opt-in versioned native subscription-only admission to machine, DSH/PTC
  and background calls. The pinned official SDK checks the same initialized
  local CLI's account and public usage control before releasing any task prompt;
  explicit disabled extra usage is required, unknown/enabled status blocks.
- Expose no-prompt `inspectSubscription` and matching doctor mode. Preserve
  filtered environment, native settings, owned cleanup and lifecycle recovery;
  keep legacy explicit API authentication when the policy is absent. Refuse
  independent Review/Team dispatch that cannot satisfy this admission contract.
- Freeze subscription aliases including Fable 5.2, reject known model fallback,
  fast-mode and effort conflicts, and retain current-stream root model evidence
  separately from cumulative history/auxiliary `modelUsage` observations.
- Keep actual billed cost unknown and redact account identifiers and balances.
  Document the experimental SDK contract and pre-prompt snapshot limitations;
  no live account/model acceptance, npm publication or account-setting change
  is implied by deterministic fixture tests.

## 0.6.1 (2026-11-20)

- Accept the DSH 0.2.1-rc.5 through 0.3 compatibility window for the host
  `@deepseek-ai/dsh-home-paths` peer. Required host services remain fail-closed.

## 0.6.0 (2026-11-17)

- Use the pinned official `@anthropic-ai/claude-agent-sdk@0.3.326` for ordinary
  machine and DSH delegations, including background work. Preserve the configured
  local executable, explicit environment and native Claude Code behavior.
- Keep the SDK inside the owned guardian, with strict raw-stream validation,
  independent physical process-group cleanup, original stop causes, durable
  lifecycle receipts and read-only recovery. Preserve persistent/new/resume/fork
  semantics, names, multimodal input, schema output, child effort and real activity.
- Reject corrupted SDK control/result tails without retaining completed outcome
  or usage; keep intact native failed results and measured usage when the SDK
  reports their expected nonzero exit. Apply the same facts to recovery receipts.
- Keep native Review and interactive Team on their explicit CLI entry points.
  Document SDK installation, local configuration and authorized authentication
  as separate concerns. Source validation does not establish registry publication
  or a user-installation upgrade; publication is recorded separately above.
- Update doctor to verify the exact SDK and compatible native runtime, accept
  native API authentication, and use only `auth status` without reading macOS
  keychain tokens or credential files.

## 0.5.3 (2026-11-17)

- Reject persistent creation/resume and interactive teams before CLI dispatch
  when the forwarded `CLAUDE_CODE_SKIP_PROMPT_HISTORY` enables native history
  suppression. Match the CLI's boolean parsing, preserve explicit ephemeral
  work, and preserve the user's environment instead of marking a
  history-suppressed query resumable. Cover machine and DSH tool paths with
  no-dispatch regressions.

- Clarify that durable print-mode sessions are resumable by their exact root UUID
  but are excluded from Claude's ordinary session picker. Document the supported
  terminal and Desktop handoff, shared configuration directory, version/platform
  requirements and exclusive session ownership; readable names alone do not
  register sessions in the Desktop sidebar.
- Verify the history-suppression defect with Claude Code 2.1.325 against a local
  offline protocol fixture. The source-candidate checks did not include a
  live-model run or Desktop UI acceptance; publication is recorded separately above.

## 0.5.2 (2026-11-16)

- Add public metadata-only `onActivity` with bounded event-driven coalescing across root and child streams. Native task progress remains observable even when the durable state ledger deduplicates unchanged states.
- Exclude ambient task identities and later unmarked progress from activity and native completion. Forward startup hook activity only for a caller-established session ID; keep the first timeout/cancellation cause stable during cleanup.
- Preserve current-run activity across legacy ambient identities and replayed old starts. Ownership-ledger overflow leaves native cleanup unconfirmed while retaining independent local process cleanup evidence.
- Select the current ambient task run by the provider's plain-string run ordering, including first-seen late starts and snapshots; do not rely on arrival order or prior cache membership.
- Replace the cumulative query-stream byte cutoff with per-frame and retained-output limits; bound intermediate display memory and callbacks without cancelling a long active run. Reject conflicting root-session activity immediately while retaining native child streams and unknown-event compatibility.
- Probe the local CLI help through owned process supervision before delivering a prompt; require partial messages and foreground subagent forwarding, preserve one wall budget and reject unsupported CLIs without replay or leaked diagnostic text.
- Forward foreground, PTC and background query activity to the optional Flywheel host extension without fabricating DSH assistant messages or heartbeats.
- Name fresh persistent machine sessions and interactive teams, with readable workspace-name fallbacks that keep private prompt text out of session lists. Explicit descriptions and session names take precedence; resumes retain their existing name and ephemeral queries remain ephemeral.
- Preserve native controls, credentials, dispatch ACKs, unknown outcomes, terminal receipts and owned process cleanup. The source candidate was verified offline; those checks do not establish registry publication or real-model acceptance.

## 0.5.1 (2026-11-15)

### Fixed

- Accept and forward `native.agents.definitions[name].effort` through the desktop/PTC and public machine paths as native `--agents` JSON, with the public `Effort` type covering `low`, `medium`, `high`, `xhigh` and `max`.
- Apply the existing `modelSelection:false` protection to configured child effort values as well as models, while retaining explicit all-off behavior.
- Document separate child model/effort examples, omitted-field CLI behavior and environment/organization precedence without claiming effective child effort attestation.

## 0.5.0 (2026-11-14)

- Add the plugin's live native Config field and an actual Plugins-row browser configuration page with whole-value set/reset, revision fencing and retained drafts after conflicts.
- Expose inherited/per-call/off native controls through the existing PTC delegation path, actual CLI argv/settings/environment, native events, completion checks and configuration-aware session reuse. Preserve structured JSON in foreground and background results.
- Keep configured child/advisor model defaults under modelSelection:false, reject call-level model changes or removal while still enabled, and keep child permission choices within the root policy.
- Add the separate PTC native-job tool: explicit-consent remote review and actual interactive Teams always receive owned DSH background job ids; recover/control use private durable mapping and original machine journals, with real cancellation and truthful failed/killed outcomes.
- Match the current DSH supported schema vocabulary so PTC SDK argument and job-id types remain visible; validate actual published/current schema codegen, real serialized Config, React settings and CLI/job fixtures in CI.
- Keep the public machine import independent of optional DSH desktop peers and verify an installed consumer without those peers. These checks do not establish new paid-account acceptance; publication is recorded separately above.

- Add optional native Agent/Workflow/advisor controls and explicit process-scoped off controls while preserving protocol 1 and existing account behavior.
- Track native child/task/run identities, models and deduplicated usage metadata without confusing child results with root completion.
- Keep opaque resumed-run identities stable under late and replayed events; cancel observed concurrency overruns and report native limit exceptions without claiming a hard process bound.
- Add machine media, structured output validation and native budget forwarding.
- Add dedicated ultrareview launch/wait/JSON/recovery with explicit consent and truthful unknown remote cleanup after cancellation.
- Add actual interactive Team jobs through isolated tmux sessions, including attach/capture/send/resize/cancel and supervisor-owned cleanup.
- Keep child completion, local cleanup, cloud responsibility and structured task approval as distinct facts. See [native capabilities](docs/native-capabilities.md) for exact contracts and validation limits.

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
  contracts and bilingual lifecycle documentation. The published package does not
  update existing CLI/desktop installations automatically or establish new live testing.

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
