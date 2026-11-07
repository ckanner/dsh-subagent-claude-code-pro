import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyResultMessage, createCollector, userMessageLine } from '../lib/protocol.js'

test('a text-only message is one user content block', () => {
  const line = JSON.parse(userMessageLine({ text: 'hello' }))
  assert.equal(line.type, 'user')
  assert.equal(line.message.role, 'user')
  assert.deepEqual(line.message.content, [{ type: 'text', text: 'hello' }])
  assert.equal(line.parent_tool_use_id, null)
})

test('images and documents travel as model-native content blocks', () => {
  const line = JSON.parse(userMessageLine({
    text: 'look',
    images: [{ data: 'AQ==', mimeType: 'image/png' }],
    documents: [{ data: 'JVBERi0=', mimeType: 'application/pdf' }],
  }))
  const content = line.message.content
  assert.equal(content[0].type, 'text')
  assert.deepEqual(content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AQ==' },
  })
  assert.deepEqual(content[2], {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
  })
})

test('a success subtype with is_error true is not a success', () => {
  const collector = createCollector()
  collector.accept({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', claude_code_version: '2.1.0' })
  collector.accept({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired', session_id: 's-1' })
  const finished = collector.finish()
  assert.equal(finished.kind, 'failure')
  assert.equal(finished.facts.category, 'auth')
})

test('an empty successful answer fails closed', () => {
  assert.equal(classifyResultMessage({ subtype: 'success', is_error: false, result: '   ' }).kind, 'failure')
  assert.equal(classifyResultMessage({ subtype: 'success', is_error: false, result: '' }).facts.category, 'invalid-result')
})

test('collector extracts image blocks from tool results', () => {
  const collector = createCollector()
  collector.accept({ type: 'system', subtype: 'init', session_id: 's-1' })
  collector.accept({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    },
  })
  collector.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
  collector.accept({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-1' })
  const finished = collector.finish()
  assert.equal(finished.kind, 'success')
  assert.equal(finished.images.length, 1)
  assert.equal(finished.images[0].mimeType, 'image/png')
})

test('unknown event types are ignored without failing the run', () => {
  const collector = createCollector()
  collector.accept({ type: 'future_event', payload: {} })
  collector.accept({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' })
  assert.equal(collector.finish().kind, 'success')
})

test('a missing result fails closed', () => {
  const collector = createCollector()
  collector.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } })
  const finished = collector.finish()
  assert.equal(finished.kind, 'failure')
  assert.equal(finished.facts.category, 'invalid-result')
})
