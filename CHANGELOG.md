# Changelog

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
