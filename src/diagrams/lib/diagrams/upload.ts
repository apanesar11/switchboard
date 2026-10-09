// The admin's lib/diagrams/upload.ts for Switchboard. A picture dropped, pasted or
// picked onto a whiteboard is kept on this Mac rather than in Vercel Blob: main stores
// the bytes once, by content, in ~/.switchboard/whiteboards/images/, and the image node
// points at it as sbimg://image/<file> — a scheme index.js serves from that folder
// and nothing else (src/main/whiteboards.js). The checks and the sizing are the admin's.

import { call } from "../bridge"

// lib/social/constants.ts in the admin.
export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

function isImageMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime)
}

/** Why `file` can't go on a whiteboard, or null when it can. */
export function diagramImageProblem(file: File): string | null {
  if (!isImageMime(file.type)) {
    return `${file.name || "That file"} isn't a PNG, JPEG or WebP image`
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name || "That image"} is over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
  }
  return null
}

// Switchboard: no second argument. The admin uploads into a per-product blob folder;
// pictures here are shared by every whiteboard — stored by content, so the same one is
// never kept twice, and a board moved to another folder keeps every picture it shows.
export async function uploadDiagramImage(
  file: File,
  abortSignal?: AbortSignal,
): Promise<string> {
  const problem = diagramImageProblem(file)
  if (problem) throw new Error(problem)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError")
  const result = await call("diagramsSaveImage", bytes, file.type)
  if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError")
  if (!result.ok) throw new Error(result.error)
  return result.src
}

/**
 * The size a picture goes onto the canvas at: its own, scaled down to fit
 * `max` on its longer side. Null when the browser can't read it as an image.
 */
export async function imageDisplaySize(
  file: File,
  max = 360,
): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height) return null
    const scale = Math.min(1, max / Math.max(width, height))
    return {
      width: Math.max(24, Math.round(width * scale)),
      height: Math.max(24, Math.round(height * scale)),
    }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * What is on the clipboard as a picture file, or null. Edit ▸ Paste is a menu item in
 * Switchboard — the keystroke never reaches the page as a paste event — so a
 * screenshot pasted onto the canvas is fetched from main instead (views/whiteboards.js).
 */
export async function clipboardImageFile(): Promise<File | null> {
  const result = await call("diagramsClipboardImage")
  if (!result.ok) return null
  const ext = result.type === "image/jpeg" ? "jpg" : result.type === "image/webp" ? "webp" : "png"
  return new File([result.bytes as BlobPart], `Pasted image.${ext}`, { type: result.type })
}
