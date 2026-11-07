/**
 * Hand a delegation's images to the model that asked for the work.
 *
 * Claude Code can look at pictures and can take screenshots with its own tools;
 * those arrive as base64 image blocks inside `tool_result` messages. This module
 * turns them into DSH attachment references so the parent model sees images
 * instead of a description of images.
 *
 * Nothing here may fail the delegation: a missing attachment store, a route
 * that declares no image input, or an unreadable payload all become a text note,
 * because the answer the run produced matters more than the picture beside it.
 * A background run's result is a string by contract, so its images become host
 * paths in that text instead of model-visible blocks.
 *
 * @module dsh-subagent-claude-code-pro/deliver
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { errorMessage } from './util.js'

const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Stable text for an image the model could not be handed. */
export function imageNote(count, reason) {
  const label = count === 1 ? 'image' : 'images'
  return `[${String(count)} ${label} not delivered: ${reason}]`
}

function extensionFor(mimeType) {
  return IMAGE_EXTENSIONS[mimeType] ?? 'png'
}

/**
 * Whether the calling Agent's model route refuses image input.
 *
 * The rule is the harness's own, deliberately loose: an image is withheld only
 * when the route **declares** input modalities and `image` is not among them. An
 * undeclared route is left to the harness, which rejects an image it cannot
 * deliver anyway.
 *
 * @param {any} ctx
 * @param {any} agent
 * @returns {Promise<boolean>}
 */
async function routeRefusesImages(ctx, agent) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false
  const header = agent?.session?.requestHeader?.()
  const options = agent?.options
  const provider = header?.config?.provider ?? options?.provider
  const model = header?.config?.model ?? options?.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const modalities = info?.inputModalities
    return Array.isArray(modalities) && !modalities.includes('image')
  } catch {
    return false
  }
}

/** Directory background delegations write their images into. */
export function backgroundImageDirectory() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-code-pro-images')
}

/**
 * Deliver one run's images.
 *
 * @param {{
 *   ctx: any,
 *   agent: any,
 *   images: readonly { data: string, mimeType: string }[],
 *   background?: boolean,
 *   runId?: string,
 * }} options
 * @returns {Promise<{ blocks: { type: 'image', attachment: unknown }[], note: string }>}
 */
export async function deliverImages(options) {
  const images = options.images ?? []
  if (images.length === 0) return { blocks: [], note: '' }

  if (options.background === true) {
    const runId = options.runId ?? String(Date.now())
    try {
      const directory = backgroundImageDirectory()
      mkdirSync(directory, { recursive: true })
      const paths = images.map((image, index) => {
        const path = join(directory, `${runId}-${String(index)}.${extensionFor(image.mimeType)}`)
        writeFileSync(path, Buffer.from(image.data, 'base64'))
        return path
      })
      const label = images.length === 1 ? 'image' : 'images'
      return { blocks: [], note: `[${String(images.length)} ${label}: ${paths.join(', ')}]` }
    } catch (error) {
      return { blocks: [], note: imageNote(images.length, `could not save them: ${errorMessage(error).slice(0, 200)}`) }
    }
  }

  const store = options.ctx.get?.('attachments')
  if (store === undefined || typeof store.saveImages !== 'function') {
    return { blocks: [], note: imageNote(images.length, 'no attachment store is mounted') }
  }
  if (await routeRefusesImages(options.ctx, options.agent)) {
    return { blocks: [], note: imageNote(images.length, 'this model route declares no image input') }
  }
  try {
    const refs = await store.saveImages(images.map((image) => ({
      data: Buffer.from(image.data, 'base64'),
      mediaType: image.mimeType,
    })))
    return { blocks: refs.map((ref) => ({ type: 'image', attachment: ref })), note: '' }
  } catch (error) {
    return { blocks: [], note: imageNote(images.length, `the attachment store refused them: ${errorMessage(error).slice(0, 200)}`) }
  }
}
