import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionNameFor } from '../lib/sessions.js'

test('session names are readable, single-line and bounded by UTF-8 bytes', () => {
  assert.equal(sessionNameFor('  # Investigate alert latency\nsecond line  '), 'DSH · Investigate alert latency')
  assert.equal(sessionNameFor(''), 'DSH · Claude Code delegation')
  assert.equal(sessionNameFor('title\u0000with\u0007controls'), 'DSH · title with controls')

  const long = sessionNameFor('🚨'.repeat(1_000))
  assert.ok(Buffer.byteLength(long) <= 512)
  assert.ok(long.startsWith('DSH · 🚨'))
  assert.equal(long.includes('\n'), false)

  const custom = sessionNameFor('scope', 'Flywheel')
  assert.equal(custom, 'Flywheel · scope')
})
