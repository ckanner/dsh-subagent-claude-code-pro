/**
 * The stream-json wire the local `claude` CLI speaks in `--print` mode.
 *
 * Input is one user message per delegation today (the same envelope later
 * carries model-native image and document blocks); output is one JSON object
 * per line, whose only completion proof is a terminal `result` message.
 *
 * Strictness is deliberate and mirrors the official provider: a `result` with
 * `subtype: "success"` is not enough. The run must also carry
 * `is_error: false` and non-blank text, because an authentication failure is
 * reported as `subtype: "success"` with `is_error: true`.
 *
 * @module dsh-subagent-claude-code-pro/protocol
 */

import { isPlainObject } from './util.js'

/**
 * Build one `--input-format stream-json` line.
 *
 * The content array is Anthropic's user-message shape, so the same envelope
 * carries text today and image / document blocks for multimodal delegations.
 *
 * @param {{
 *   text: string,
 *   images?: readonly { data: string, mimeType: string }[],
 *   documents?: readonly { data: string, mimeType: string }[],
 * }} message
 * @returns {string}
 */
export function userMessageLine(message) {
  const content = [{ type: 'text', text: message.text }]
  for (const image of message.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.data },
    })
  }
  for (const document of message.documents ?? []) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: document.mimeType, data: document.data },
    })
  }
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  })}\n`
}

/**
 * Map an SDK result subtype that is not a success to a safe category.
 * @param {string | undefined} subtype
 * @returns {string}
 */
function classifyFailureSubtype(subtype) {
  switch (subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return 'limit'
    case 'error_during_execution':
      return 'product-error'
    default:
      return 'unknown'
  }
}

/**
 * Classify a terminal result message.
 *
 * @param {any} result
 * @returns {{ kind: 'success', text: string, sessionId?: string, structuredOutput?: unknown, usage?: unknown, init?: any }
 *   | { kind: 'failure', facts: { stage: string, category: string, detail?: string } }}
 */
export function classifyResultMessage(result) {
  if (!isPlainObject(result)) {
    return { kind: 'failure', facts: { stage: 'query-run', category: 'invalid-result', detail: 'the CLI produced no result object' } }
  }
  const text = typeof result.result === 'string' ? result.result : ''
  if (result.is_error === true) {
    const category = /authenticate|oauth|login|credential/i.test(text)
      ? 'auth'
      : /No conversation found/i.test(text)
        ? 'resume'
        : 'product-error'
    return {
      kind: 'failure',
      facts: {
        stage: 'query-run',
        category,
        detail: text.trim() === '' ? 'the CLI reported an error without a message' : text.trim(),
      },
    }
  }
  if (result.subtype !== 'success') {
    return {
      kind: 'failure',
      facts: {
        stage: 'query-run',
        category: classifyFailureSubtype(result.subtype),
        detail: typeof result.subtype === 'string' ? `result subtype: ${result.subtype}` : undefined,
      },
    }
  }
  if (text.trim() === '') {
    return { kind: 'failure', facts: { stage: 'query-run', category: 'invalid-result', detail: 'the CLI returned an empty answer' } }
  }
  return {
    kind: 'success',
    text: result.result,
    sessionId: typeof result.session_id === 'string' ? result.session_id : undefined,
    structuredOutput: result.structured_output,
    usage: result.usage,
  }
}

/**
 * Collect the events of one run and decide its completion.
 *
 * Unknown events are ignored on purpose: the CLI protocol gains message types
 * between releases, and an unknown type must never fail a delegation.
 *
 * @param {{ maxMalformed?: number }} [options]
 */
export function createCollector(options = {}) {
  const maxMalformed = options.maxMalformed ?? 20
  /** @type {any} */
  let init
  /** @type {any} */
  let result
  /** @type {string[]} */
  const assistantTexts = []
  /** @type {{ data: string, mimeType: string }[]} */
  const images = []
  /** @type {Set<string>} */
  const unknownTypes = new Set()
  let malformed = 0

  /**
   * Extract base64 image blocks a tool returned. A Read of an image or a
   * computer-use screenshot arrives as a `tool_result` content block; those are
   * the only assistant-side images this product produces today.
   * @param {any} event
   */
  function collectUserMessage(event) {
    const content = event?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isPlainObject(block) || block.type !== 'tool_result') continue
      const inner = block.content
      if (!Array.isArray(inner)) continue
      for (const item of inner) {
        if (!isPlainObject(item) || item.type !== 'image') continue
        const source = item.source
        if (!isPlainObject(source) || source.type !== 'base64' || typeof source.data !== 'string') continue
        images.push({ data: source.data, mimeType: typeof source.media_type === 'string' ? source.media_type : 'image/png' })
      }
    }
  }

  /** @param {any} event */
  function accept(event) {
    if (!isPlainObject(event)) {
      malformed += 1
      return
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          init = {
            sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
            model: typeof event.model === 'string' ? event.model : undefined,
            cliVersion: typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined,
            cwd: typeof event.cwd === 'string' ? event.cwd : undefined,
            permissionMode: typeof event.permissionMode === 'string' ? event.permissionMode : undefined,
            apiKeySource: typeof event.apiKeySource === 'string' ? event.apiKeySource : undefined,
            capabilities: Array.isArray(event.capabilities) ? event.capabilities.filter((item) => typeof item === 'string') : [],
          }
        }
        return
      case 'assistant': {
        const content = event?.message?.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') assistantTexts.push(block.text)
        }
        return
      }
      case 'user':
        collectUserMessage(event)
        return
      case 'result':
        result = event
        return
      default:
        if (typeof event.type === 'string') unknownTypes.add(event.type)
    }
  }

  /**
   * Decide the run's completion from the terminal message.
   * @returns {ReturnType<typeof classifyResultMessage> & { init?: any, images?: { data: string, mimeType: string }[], malformed?: number }}
   */
  function finish() {
    if (result === undefined) {
      return {
        kind: 'failure',
        facts: {
          stage: 'query-run',
          category: 'invalid-result',
          detail: malformed > 0
            ? `the CLI produced ${malformed} unparseable line(s) and no result message`
            : 'the CLI exited without a result message',
        },
      }
    }
    const classified = classifyResultMessage(result)
    return { ...classified, init, images, malformed }
  }

  return {
    accept,
    finish,
    /** Assistant text seen so far, for background progress only. */
    progressText() {
      return assistantTexts.join('')
    },
    get init() {
      return init
    },
  }
}
