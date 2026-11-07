/**
 * Small shared helpers: diagnostics, structured failures, and input checks.
 *
 * A plugin has no log surface a running session can read, so every decision
 * that can fail quietly is written to `$DSH_HOME/claude-code-pro.log` as well.
 * Diagnostics must never affect what they describe.
 *
 * @module dsh-subagent-claude-code-pro/util
 */

import { appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Absolute path of this plugin's diagnostic log. */
export function diagnosticLogPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-code-pro.log')
}

/**
 * Append one line to the plugin's diagnostic log.
 * @param {string} message
 */
export function diag(message) {
  try {
    appendFileSync(diagnosticLogPath(), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never affect what they describe.
  }
}

/** Stable fact record for one failed run. */
export class ClaudeCodeProFailure extends Error {
  /**
   * @param {{ stage: string, category: string, detail?: string, exitCode?: number | null, signal?: string | null }} facts
   * @param {unknown} [cause]
   */
  constructor(facts, cause) {
    super(describeFailure(facts), cause === undefined ? undefined : { cause })
    this.name = 'ClaudeCodeProFailure'
    this.facts = facts
  }
}

/**
 * Human-readable one-line diagnostic for a failure record.
 * @param {{ stage: string, category: string, detail?: string, exitCode?: number | null, signal?: string | null }} facts
 * @returns {string}
 */
export function describeFailure(facts) {
  const fields = [`stage: ${facts.stage}`, `category: ${facts.category}`]
  if (typeof facts.exitCode === 'number') fields.push(`exit code: ${facts.exitCode}`)
  if (typeof facts.signal === 'string' && facts.signal.length > 0) fields.push(`signal: ${facts.signal}`)
  const head = `claude-code-pro: delegation failed (${fields.join('; ')})`
  return facts.detail === undefined || facts.detail === '' ? head : `${head}: ${facts.detail}`
}

/**
 * Read a message out of an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether a value is a plain object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a required non-empty string.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export function checkedString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`claude-code-pro: ${name} must be a non-empty string`)
  }
  return value
}

/**
 * Validate an optional non-empty string.
 * @param {string} name
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function optionalString(name, value) {
  if (value === undefined || value === null) return undefined
  return checkedString(name, value)
}

/**
 * Validate a non-negative finite number.
 * @param {string} name
 * @param {unknown} value
 * @returns {number}
 */
export function checkedNonNegativeNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`claude-code-pro: ${name} must be a non-negative finite number`)
  }
  return value
}

/**
 * Resolve an absolute working directory and prove it can be entered.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export function checkedDirectory(name, value) {
  const path = checkedString(name, value)
  if (!isAbsolute(path)) throw new Error(`claude-code-pro: ${name} must be an absolute path: ${path}`)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`claude-code-pro: ${name} does not exist: ${path}`)
  }
  if (!stat.isDirectory()) throw new Error(`claude-code-pro: ${name} is not a directory: ${path}`)
  return path
}

/**
 * Validate an absolute path to an existing regular file.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export function checkedFile(name, value) {
  const path = checkedString(name, value)
  if (!isAbsolute(path)) throw new Error(`claude-code-pro: ${name} must be an absolute path: ${path}`)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`claude-code-pro: ${name} does not exist: ${path}`)
  }
  if (!stat.isFile()) throw new Error(`claude-code-pro: ${name} is not a file: ${path}`)
  return path
}

/**
 * Promise resolved after a delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  // Awaited cleanup must keep a worker alive long enough to deliver its receipt.
  return new Promise((resolve) => setTimeout(resolve, ms))
}
