/**
 * Model-native input attachments for one delegation.
 *
 * Images and PDFs travel as Anthropic Messages API content blocks inside the
 * stream-json user message, so Claude receives them as pictures/documents
 * instead of being told to open a file. Every path is checked before anything
 * is spawned: a delegation must not start and then silently lack the
 * attachment its task was about.
 *
 * @module dsh-subagent-claude-code-pro/inputs
 */

import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

/** One image the CLI will receive as an image content block. */
const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** One document the CLI will receive as a document content block. */
const DOCUMENT_MEDIA_TYPES = {
  '.pdf': 'application/pdf',
}

/** Per-attachment and per-call bounds. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_IMAGES = 20
export const MAX_DOCUMENTS = 5

/**
 * @typedef {{ path: string, mimeType: string, data: string }} EncodedAttachment
 */

/**
 * Read and base64-encode one attachment.
 *
 * @param {string} label
 * @param {unknown} path
 * @param {Record<string, string>} mediaTypes
 * @returns {EncodedAttachment}
 */
function readAttachment(label, path, mediaTypes) {
  if (typeof path !== 'string' || path === '') {
    throw new Error(`claude-code-pro: ${label} entries must be non-empty absolute paths`)
  }
  if (!isAbsolute(path)) throw new Error(`claude-code-pro: ${label} path must be absolute: ${path}`)
  const mimeType = mediaTypes[extname(path).toLowerCase()]
  if (mimeType === undefined) {
    throw new Error(`claude-code-pro: unsupported ${label} type: ${path} (supported: ${Object.keys(mediaTypes).join(', ')})`)
  }
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`claude-code-pro: ${label} does not exist: ${path}`)
  }
  if (!stat.isFile()) throw new Error(`claude-code-pro: ${label} is not a file: ${path}`)
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`claude-code-pro: ${label} is larger than ${MAX_ATTACHMENT_BYTES} bytes: ${path}`)
  }
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw new Error(`claude-code-pro: could not read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path, mimeType, data: bytes.toString('base64') }
}

/**
 * Read images for one delegation.
 * @param {readonly string[] | undefined} paths
 * @returns {EncodedAttachment[]}
 */
export function readImages(paths) {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) throw new Error('claude-code-pro: images must be an array of absolute paths')
  if (paths.length > MAX_IMAGES) throw new Error(`claude-code-pro: at most ${MAX_IMAGES} images may be attached`)
  return paths.map((path) => readAttachment('image', path, IMAGE_MEDIA_TYPES))
}

/**
 * Read PDF documents for one delegation.
 * @param {readonly string[] | undefined} paths
 * @returns {EncodedAttachment[]}
 */
export function readDocuments(paths) {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) throw new Error('claude-code-pro: documents must be an array of absolute paths')
  if (paths.length > MAX_DOCUMENTS) throw new Error(`claude-code-pro: at most ${MAX_DOCUMENTS} documents may be attached`)
  return paths.map((path) => readAttachment('document', path, DOCUMENT_MEDIA_TYPES))
}
