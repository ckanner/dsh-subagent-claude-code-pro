import test from 'node:test'
import assert from 'node:assert/strict'

import { checkedOutputSchema, validateJsonSchemaValue } from '../lib/structured.js'

const schema = {
  type: 'object',
  properties: {
    answer: { type: 'integer' },
    kind: { type: 'string', enum: ['ok', 'bad'] },
    items: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['answer', 'kind'],
  additionalProperties: false,
}

test('a conforming object has no violations', () => {
  assert.deepEqual(validateJsonSchemaValue(schema, { answer: 42, kind: 'ok', items: ['a'] }), [])
})

test('missing required, wrong types and extra keys are all reported', () => {
  const violations = validateJsonSchemaValue(schema, { answer: 'x', extra: true })
  assert.ok(violations.some((item) => item.includes('$.answer: must be of type integer')))
  assert.ok(violations.some((item) => item.includes('$.kind: is required')))
  assert.ok(violations.some((item) => item.includes('$.extra: is not allowed')))
})

test('enum, arrays and oneOf are enforced', () => {
  assert.ok(validateJsonSchemaValue(schema, { answer: 1, kind: 'nope' }).some((item) => item.includes('enumerated')))
  assert.ok(validateJsonSchemaValue(schema, { answer: 1, kind: 'ok', items: [] }).some((item) => item.includes('at least 1')))
  const union = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.deepEqual(validateJsonSchemaValue(union, 'x'), [])
  assert.ok(validateJsonSchemaValue(union, true).length > 0)
})

test('unsupported schema keywords fail closed', () => {
  const violations = validateJsonSchemaValue({ type: 'object', patternProperties: {} }, {})
  assert.ok(violations.some((item) => item.includes('unsupported schema keyword')))
})

test('output_schema must be an object-rooted JSON Schema object', () => {
  assert.throws(() => checkedOutputSchema([]), /must be a JSON Schema object/)
  assert.throws(() => checkedOutputSchema({ type: 'array' }), /object-rooted/)
  assert.deepEqual(checkedOutputSchema({ type: 'object', additionalProperties: false }), {
    type: 'object',
    additionalProperties: false,
  })
})
