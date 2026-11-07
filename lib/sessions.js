/**
 * Claude Code session lifetime decisions.
 *
 * A Claude Code session is a UUID persisted by the CLI under
 * `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`. This plugin owns only the
 * bookkeeping a one-shot provider never needed: which session a call should
 * continue, which session an Agent session remembers, and when a remembered
 * session must not be reused.
 *
 * @module dsh-subagent-claude-code-pro/sessions
 */

/** @typedef {'ephemeral' | 'persistent' | 'session'} ConfigSessionMode */

/**
 * Decide one call's session shape.
 *
 * Rules, in order:
 * 1. An explicit `session_id` always continues that session (never silently
 *    replaced by a different one).
 * 2. A per-call `session_mode` overrides the configured default.
 * 3. A remembered session is reused only in `session`-configured runs, only
 *    for a durable call, only from the directory it was created in, and only
 *    when no other delegation is using it.
 *
 * @param {{
 *   explicitSessionId?: string,
 *   requestedMode?: 'ephemeral' | 'persistent',
 *   configuredMode: ConfigSessionMode,
 *   remembered?: { sessionId: string, cwd: string, name?: string },
 *   cwd: string,
 *   busy: boolean,
 * }} input
 * @returns {{ kind: 'resume', resumeId: string, runtimeMode: 'persistent', explicit: boolean }
 *   | { kind: 'new', runtimeMode: 'persistent' }
 *   | { kind: 'ephemeral', runtimeMode: 'ephemeral' }}
 */
export function chooseSession(input) {
  if (typeof input.explicitSessionId === 'string' && input.explicitSessionId !== '') {
    return { kind: 'resume', resumeId: input.explicitSessionId, runtimeMode: 'persistent', explicit: true }
  }
  const runtimeMode = input.requestedMode ?? (input.configuredMode === 'ephemeral' ? 'ephemeral' : 'persistent')
  if (runtimeMode === 'ephemeral') return { kind: 'ephemeral', runtimeMode: 'ephemeral' }
  if (
    input.configuredMode === 'session'
    && input.requestedMode === undefined
    && input.remembered !== undefined
    && input.busy !== true
    && input.remembered.cwd === input.cwd
  ) {
    return { kind: 'resume', resumeId: input.remembered.sessionId, runtimeMode: 'persistent', explicit: false }
  }
  return { kind: 'new', runtimeMode: 'persistent' }
}

/** Whether a durable run's session id may be remembered for later calls. */
export function shouldRemember(runtimeMode) {
  return runtimeMode === 'persistent'
}

/**
 * Name a durable session so a person can find it in `claude --resume` and the
 * Claude application. The model's short description is the best label there is.
 * @param {string} label
 * @returns {string}
 */
export function sessionNameFor(label) {
  const trimmed = typeof label === 'string' ? label.trim() : ''
  return trimmed === '' ? 'DSH · Claude Code delegation' : `DSH · ${trimmed}`
}

/**
 * The marker appended to a human-text answer so the model can continue this
 * session explicitly on a later call.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionMarker(sessionId) {
  return `[claude-code session ${sessionId} · persistent · pass it as session_id to continue]`
}

/**
 * Whether a failure means the resumed session itself is gone, so a remembered
 * session may be repaired by starting a fresh one. An explicit id is never
 * repaired: continuing it was the whole request.
 * @param {{ category: string } | undefined} facts
 * @returns {boolean}
 */
export function isStaleSessionFailure(facts) {
  return facts?.category === 'resume' && facts.cleanupConfirmed === true && facts.terminalReceived === true
}
