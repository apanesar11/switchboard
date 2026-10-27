// A recording is addressed by its generated filename, never by a local path or
// an arbitrary URL. Keep this in step with main/recordings.js.
const LOCAL_VIDEO_SRC = /^sbvideo:\/\/recording\/(Recording-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webm|mp4))$/

export function parseLocalVideoSrc(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = LOCAL_VIDEO_SRC.exec(value)
  return match?.[0] === value ? match[1] : null
}
