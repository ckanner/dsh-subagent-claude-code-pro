import { createHash } from 'node:crypto'

/** Identity of already validated input images; never retain their contents. */
export function inputImageManifest(request) {
  if (!request.images?.length) return undefined
  return { version: 1, images: request.images.map(image => {
    const bytes = Buffer.from(image.data, 'base64')
    return { mimeType: image.mimeType, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  }) }
}
