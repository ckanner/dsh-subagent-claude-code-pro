/** Advisory activity is separate from answers, native state and durable receipts. */
export const MACHINE_ACTIVITY_VERSION = 1
export const MACHINE_ACTIVITY_CAPABILITIES = Object.freeze({
  version: 1, metadataOnly: true, coalesced: true, rootAndChildren: true,
})
export const DEFAULT_ACTIVITY_INTERVAL_MS = 250

const systemTypes = new Map([
  ['init', 'session-init'], ['api_retry', 'api-retry'], ['compact_boundary', 'compaction'],
  ['task_started', 'task-started'], ['task_progress', 'task-progress'],
  ['task_updated', 'task-updated'], ['task_notification', 'task-notification'],
  ['background_tasks_changed', 'task-progress'], ['hook_started', 'hook-started'],
  ['hook_progress', 'hook-progress'], ['hook_response', 'hook-response'],
])
const streamTypes = new Map([
  ['message_start', 'stream-start'], ['content_block_start', 'stream-start'],
  ['content_block_delta', 'stream-delta'], ['message_delta', 'stream-delta'],
  ['content_block_stop', 'stream-stop'], ['message_stop', 'stream-stop'],
])
export const ACTIVITY_EVENT_TYPES = Object.freeze([
  'session-init', 'api-retry', 'compaction', 'task-started', 'task-progress',
  'task-updated', 'task-notification', 'hook-started', 'hook-progress', 'hook-response',
  'assistant-text', 'assistant-thinking', 'tool-use', 'tool-result', 'tool-progress',
  'stream-start', 'stream-delta', 'stream-stop', 'result',
])
const allowedTypes = new Set(ACTIVITY_EVENT_TYPES)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** No provider text, reasoning, tool arguments/results, identifiers or usage escape. */
export function claudeActivity(event) {
  if (!plain(event)) return undefined
  let scope = typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== '' ? 'child' : 'root'
  const types = new Set()
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') types.add('assistant-text')
      else if (['thinking', 'redacted_thinking'].includes(block?.type)) types.add('assistant-thinking')
      else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') types.add('tool-use')
    }
  } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
    if (event.message.content.some(block => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')) types.add('tool-result')
  } else if (event.type === 'stream_event' && plain(event.event)) {
    const kind = streamTypes.get(event.event.type)
    if (kind) types.add(kind)
  } else if (event.type === 'system') {
    const kind = systemTypes.get(event.subtype)
    if (kind) {
      types.add(kind)
      if (kind.startsWith('task-')) scope = 'child'
    }
  } else if (event.type === 'tool_progress' && typeof event.tool_use_id === 'string') types.add('tool-progress')
  else if (event.type === 'result' && typeof event.is_error === 'boolean') types.add('result')
  return types.size ? { scope, eventTypes: [...types], terminal: event.type === 'result' } : undefined
}

export function validActivity(value) {
  return plain(value) && Object.keys(value).every(k => ['version', 'sequence', 'kind', 'source', 'scope', 'eventTypes', 'observedEvents'].includes(k))
    && value.version === 1 && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && value.kind === 'provider-progress' && value.source === 'claude-code-pro'
    && ['root', 'child', 'mixed'].includes(value.scope)
    && Array.isArray(value.eventTypes) && value.eventTypes.length > 0 && value.eventTypes.length <= 16
    && value.eventTypes.every(t => allowedTypes.has(t)) && new Set(value.eventTypes).size === value.eventTypes.length
    && Number.isSafeInteger(value.observedEvents) && value.observedEvents > 0
}

/** One bounded coalescer for the whole owned tree. No timer generates activity. */
export function createActivityReporter(report, intervalMs = DEFAULT_ACTIVITY_INTERVAL_MS, { now = () => performance.now(), signal } = {}) {
  let sequence = 0, last = -Infinity, count = 0, scope, closed = false
  const kinds = new Set()
  return {
    observe(event) {
      if (closed || signal?.aborted || typeof report !== 'function') return
      const observed = claudeActivity(event)
      if (!observed) return
      count = Math.min(Number.MAX_SAFE_INTEGER, count + 1)
      scope = scope === undefined ? observed.scope : scope === observed.scope ? scope : 'mixed'
      for (const kind of observed.eventTypes) if (kinds.size < 16) kinds.add(kind)
      const time = now()
      if (!observed.terminal && time - last < intervalMs) return
      const value = { version: 1, sequence: ++sequence, kind: 'provider-progress', source: 'claude-code-pro',
        scope, eventTypes: [...kinds], observedEvents: count }
      count = 0; scope = undefined; kinds.clear(); last = time
      try { report(value) } catch { /* Advisory activity never changes dispatch or completion. */ }
    },
    close() { closed = true; kinds.clear(); count = 0; scope = undefined },
  }
}
