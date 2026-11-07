# Changelog

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
