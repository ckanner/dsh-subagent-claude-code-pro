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
import { NativeTracker } from './native.js'

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
  if (typeof result.is_error !== 'boolean' || typeof result.subtype !== 'string') {
    return { kind: 'failure', facts: { stage: 'query-run', category: 'invalid-result', detail: 'the CLI result omitted its explicit status' } }
  }
  const text = typeof result.result === 'string' ? result.result
    : Array.isArray(result.errors) ? result.errors.filter(error => typeof error === 'string').join('; ') : ''
  if (result.is_error === true) {
    const category = /authenticate|oauth|login|credential/i.test(text)
      ? 'auth'
      : /No conversation found/i.test(text)
        ? 'resume'
        : result.subtype === 'success' ? 'product-error' : classifyFailureSubtype(result.subtype)
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
  const structuredText = result.structured_output !== undefined && result.structured_output !== null && typeof result.structured_output === 'object' ? JSON.stringify(result.structured_output) : undefined
  if ((typeof result.result !== 'string' || result.result.trim() === '') && structuredText === undefined) {
    return { kind: 'failure', facts: { stage: 'query-run', category: 'invalid-result', detail: 'the CLI returned an empty answer' } }
  }
  return {
    kind: 'success',
    text: typeof result.result === 'string' && result.result.trim() !== '' ? result.result : structuredText,
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
 */
export function createCollector(options = {}) {
  const native = options.native === undefined ? undefined : new NativeTracker(options.native, options.onNativeEvent)
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
  let protocolError
  let terminalCount = 0
  let followup = false
  let initCount = 0
  const sessionIds = new Set()

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
    native?.observe(event)
    if (native?.error) protocolError ??= native.error
    // Nested transcripts have their own session identity and cannot become the root result.
    if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== '') return
    if (['system', 'assistant', 'user', 'result'].includes(event.type) && event.session_id !== undefined) {
      if (typeof event.session_id !== 'string' || event.session_id.trim() === '') {
        protocolError ??= 'a CLI event carried an invalid session id'
      } else {
        sessionIds.add(event.session_id)
      }
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          initCount += 1
          if (initCount > 1 || terminalCount > 0) protocolError ??= 'the CLI produced more than one initialization or initialized after completion'
          init = {
            sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
            model: typeof event.model === 'string' ? event.model : undefined,
            cliVersion: typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined,
            cwd: typeof event.cwd === 'string' ? event.cwd : undefined,
            permissionMode: typeof event.permissionMode === 'string' ? event.permissionMode : undefined,
            apiKeySource: typeof event.apiKeySource === 'string' ? event.apiKeySource : undefined,
            tools: Array.isArray(event.tools) ? event.tools.filter(item => typeof item === 'string') : undefined,
            agents: Array.isArray(event.agents) ? event.agents.filter(item => typeof item === 'string') : undefined,
            capabilities: Array.isArray(event.capabilities) ? event.capabilities.filter((item) => typeof item === 'string') : [],
          }
        }
        return
      case 'assistant': {
        if (terminalCount > 0 && !followup) protocolError ??= 'the CLI produced assistant content after its terminal result'
        const content = event?.message?.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') assistantTexts.push(block.text)
        }
        return
      }
      case 'user':
        if (terminalCount > 0 && native?.acceptsOrigin(event.origin)) followup = true
        collectUserMessage(event)
        return
      case 'result':
        terminalCount += 1
        if (terminalCount > 1 && !(native?.acceptsOrigin(event.origin) && followup)) protocolError ??= 'the CLI produced more than one terminal result'
        native?.recordRootResult(event)
        followup = false
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
        init,
        terminalReceived: false,
        facts: {
          stage: 'query-run',
          category: 'invalid-result',
          detail: malformed > 0
            ? `the CLI produced ${malformed} unparseable line(s) and no result message`
            : 'the CLI exited without a result message',
        },
      }
    }
    if (malformed > 0 || protocolError !== undefined || sessionIds.size > 1) {
      return {
        kind: 'failure',
        facts: { stage: 'query-run', category: 'protocol', detail: protocolError
          ?? (sessionIds.size > 1 ? 'the CLI stream contains conflicting session ids' : 'the CLI stream contains malformed events') },
        init,
        terminalReceived: false,
      }
    }
    const classified = classifyResultMessage(result)
    const terminalReceived = typeof result.is_error === 'boolean' && typeof result.subtype === 'string' && result.subtype !== ''
      && (result.is_error === true || result.subtype === 'success')
      && typeof result.session_id === 'string' && result.session_id.trim() !== ''
    return { ...classified, init, images, malformed, terminalReceived,
      sessionId: typeof result.session_id === 'string' ? result.session_id : undefined,
      ...(terminalReceived ? { usage: terminalCount === 1 ? result.usage : undefined, reportedCostUSD: result.total_cost_usd } : {}) }
  }

  return {
    accept,
    malformed() { malformed += 1 },
    finish,
    /** Assistant text seen so far, for background progress only. */
    progressText() {
      return assistantTexts.join('')
    },
    nativeReport(cleanup = false) { return native?.report(cleanup) },
    get invalid() { return protocolError !== undefined },
    get init() {
      return init
    },
  }
}
