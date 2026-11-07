/**
 * A small, fail-closed JSON Schema subset validator for `output_schema` runs.
 *
 * The CLI enforces the schema it was given, but a terminal result is not proof
 * that what the host received is valid JSON of the requested shape: the CLI can
 * be replaced, a stub can answer, and a later release can change the wire. A
 * schema keyword this validator does not understand is reported rather than
 * silently accepted, because claiming a validation that did not happen is worse
 * than refusing.
 *
 * @module dsh-subagent-claude-code-pro/structured
 */

import { isPlainObject } from './util.js'

/** Keywords this validator enforces. */
const ASSERTION_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', 'not', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems',
  'maxItems',
])

/** Keywords that carry no assertion and may be ignored. */
const ANNOTATION_KEYS = new Set([
  'title', 'description', '$schema', '$id', '$comment', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly', 'format',
])

/**
 * Deep equality for JSON values.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function equalJson(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => equalJson(item, right[index]))
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
  }
  return false
}

/**
 * Whether a JavaScript value is `type` in JSON Schema terms.
 * @param {string} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * Validate one value against a schema, collecting every violation.
 * @param {unknown} schema
 * @param {unknown} value
 * @returns {string[]}
 */
function violationsOf(schema, value) {
  /** @type {string[]} */
  const violations = []
  visit(schema, value, '$', violations)
  return violations
}

/**
 * @param {unknown} schema
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} violations
 */
function visit(schema, value, path, violations) {
  if (schema === true || schema === undefined) return
  if (schema === false) {
    violations.push(`${path}: no value is allowed here`)
    return
  }
  if (!isPlainObject(schema)) {
    violations.push(`${path}: schema is not an object`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (!ASSERTION_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
      violations.push(`${path}: unsupported schema keyword "${key}"`)
    }
  }
  if (Object.hasOwn(schema, 'const') && !equalJson(schema.const, value)) {
    violations.push(`${path}: must equal the schema const`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equalJson(candidate, value))) {
    violations.push(`${path}: must be one of the enumerated values`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(type, value))) {
      violations.push(`${path}: must be of type ${types.join(' or ')}`)
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) visit(branch, value, path, violations)
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((branch) => violationsOf(branch, value).length === 0)) {
      violations.push(`${path}: does not match any anyOf branch`)
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => violationsOf(branch, value).length === 0).length
    if (matches !== 1) violations.push(`${path}: must match exactly one oneOf branch (matched ${matches})`)
  }
  if (Object.hasOwn(schema, 'not') && violationsOf(schema.not, value).length === 0) {
    violations.push(`${path}: must not match the not schema`)
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) violations.push(`${path}.${key}: is required`)
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) visit(childSchema, value[key], `${path}.${key}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key}: is not allowed`)
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) visit(schema.additionalProperties, value[key], `${path}.${key}`, violations)
      }
    }
  }

  if (Array.isArray(value)) {
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => visit(schema.items, item, `${path}[${index}]`, violations))
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push(`${path}: must contain at least ${schema.minItems} item(s)`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push(`${path}: must contain at most ${schema.maxItems} item(s)`)
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) violations.push(`${path}: must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) violations.push(`${path}: must be <= ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) violations.push(`${path}: must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) violations.push(`${path}: must be < ${schema.exclusiveMaximum}`)
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0 && value % schema.multipleOf !== 0) {
      violations.push(`${path}: must be a multiple of ${schema.multipleOf}`)
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) violations.push(`${path}: is shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) violations.push(`${path}: is longer than ${schema.maxLength}`)
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) violations.push(`${path}: does not match pattern ${schema.pattern}`)
      } catch {
        violations.push(`${path}: the schema pattern is not a valid regular expression`)
      }
    }
  }
}

/**
 * Validate a value against an object-rooted schema.
 *
 * @param {unknown} schema
 * @param {unknown} value
 * @returns {string[]} every violation; empty means valid
 */
export function validateJsonSchemaValue(schema, value) {
  return violationsOf(schema, value)
}

/**
 * Check that a model-supplied `output_schema` argument is an object-rooted JSON
 * Schema this plugin can reason about.
 *
 * @param {unknown} schema
 * @returns {Record<string, unknown>}
 */
export function checkedOutputSchema(schema) {
  if (!isPlainObject(schema)) {
    throw new Error('claude-code-pro: output_schema must be a JSON Schema object')
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error('claude-code-pro: output_schema must be object-rooted (`type: "object"`)')
  }
  return schema
}
