// Switchboard: a YouTube link read as the video it is — what a pasted, dropped or
// typed link becomes on a whiteboard (a "video" node, types.ts) — and the addresses
// built back from one: the poster, the player and the video's page on YouTube.
// Switchboard's own — the admin has no videos. Pure and dependency-free apart from
// types.ts, so the validator (which the whiteboard CLI bundles) and
// scripts/test-youtube.js run it in plain node.
//
// A board keeps only a video's id and where it starts. Every address is built here
// from an id the validator checked and a fixed host, so nothing a board file says
// reaches an <img> or an <iframe> as a URL.

import { VIDEO_START_MAX } from "./types"

/** A video as a whiteboard keeps it: its id, and where it starts. */
export type YouTubeVideo = {
  videoId: string
  /** Whole seconds, more than 0. Absent: from the beginning. */
  start?: number
  /** Linked as /shorts/ID, so it is first drawn standing up (9:16). Never stored. */
  short?: true
}

/** Every id YouTube has issued: 11 characters of base64url. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
/** Words after /embed/ that are 11 characters long and are not videos. */
const NOT_VIDEO_IDS = new Set(["videoseries", "live_stream"])
/** Longer than any link anyone pastes: text past it is never read as one. */
const TEXT_MAX = 2_048
/** Redirect wrappers followed, at most — as main's unwrapImageUrl (src/main/images.js). */
const WRAPPER_DEPTH = 3

const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
])
/** The path words whose next segment is the id: /shorts/ID, /live/ID, /embed/ID … */
const ID_PATHS = new Set(["shorts", "live", "embed", "v", "e", "watch"])
/** google.com and its country domains, as main's isGoogleHost (src/main/images.js). */
const GOOGLE_HOST = /^(?:www\.|images\.)?google\.(?:com|com?\.[a-z]{2}|[a-z]{2,3})$/

// What a link is pasted wrapped in: <…> from mail and Slack, quotes, brackets.
const PAIRS: Record<string, string> = {
  "<": ">", "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`",
  "“": "”", "‘": "’", "«": "»",
}
// Prose punctuation a link picks up ("… watch https://youtu.be/ID."). None of it can
// end a video id, so stripping it never shortens one. Past ASCII, these regular
// expressions spell their characters as escapes (… ’ ” » here, ‘ “ « below): esbuild
// copies a regular expression into the bundle as written, and a page that read the
// bundle as anything but UTF-8 would find INVISIBLE's range out of order and load
// none of it.
const TRAILING = /[.,;:!?\u2026'"\u2019\u201d\u00bb)\]}>]+$/
const LEADING = /^[(<\[{'"\u2018\u201c\u00ab]+/
// Invisible characters copied along with a link: zero-width space, non-joiner and
// joiner, word joiner, byte order mark.
const INVISIBLE = /^[\u200b-\u200d\u2060\ufeff]+|[\u200b-\u200d\u2060\ufeff]+$/g
const MARKDOWN_LINK = /^\[[^\]\n]*\]\(\s*<?([^\s<>()]+)>?\s*\)$/

/** Whether `value` is a video's id as YouTube spells it — case and all. */
export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value) && !NOT_VIDEO_IDS.has(value)
}

/**
 * The video a piece of text IS, or null. The whole text, trimmed, must be ONE link —
 * possibly in <…>, quotes or brackets, possibly a Markdown [words](link), possibly
 * with a sentence's full stop after it. A link in a sentence, two links, a bare id,
 * or any page of YouTube's but a video's is null: that text stays text.
 */
export function youTubeVideoFromText(text: string): YouTubeVideo | null {
  if (typeof text !== "string" || text.length > TEXT_MAX) return null
  let link = text.trim().replace(INVISIBLE, "").trim()
  const markdown = MARKDOWN_LINK.exec(link)
  if (markdown) link = markdown[1]
  const close = PAIRS[link[0]]
  if (close !== undefined && link.length > 1 && link[link.length - 1] === close) {
    link = link.slice(1, -1).trim()
  }
  link = link.replace(TRAILING, "").replace(LEADING, "")
  if (link === "" || /\s/.test(link)) return null
  return videoFromLink(link)
}

/**
 * The video a drop is: the first address in its text/uri-list (a link, or a thumbnail
 * dragged out of a browser — whose <img> is only the thumbnail), else its plain text
 * (a link dragged out of an editor, Notes, a terminal). A Google Images result
 * (/imgres?imgurl=…) stays a picture: only Google's /url wrappers are followed.
 */
export function youTubeVideoFromDrop({ uriList = "", plain = "" }: { uriList?: string; plain?: string }): YouTubeVideo | null {
  const first = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"))
  return youTubeVideoFromText(first ?? plain)
}

/**
 * Seconds from a YouTube time: "90", "90s", "1m30s", "1m30", "1h2m3s", "2m", "1h", or
 * a fraction ("90.5", floored). Null for anything else — "1:30", "-5", "abc", "" — and
 * past VIDEO_START_MAX. "0" is 0, which the caller drops.
 */
export function parseYouTubeTime(raw: string): number | null {
  const time = raw.trim().toLowerCase()
  const plain = /^(\d{1,7})(?:\.\d+)?s?$/.exec(time)
  let seconds: number
  if (plain) seconds = Number(plain[1])
  else {
    const units = /^(?:(\d{1,4})h)?(?:(\d{1,6})m)?(?:(\d{1,7})s?)?$/.exec(time)
    if (!units || (units[1] ?? units[2] ?? units[3]) === undefined) return null
    seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0)
  }
  return seconds <= VIDEO_START_MAX ? seconds : null
}

/**
 * The player a click on the poster mounts: the privacy-enhanced host, which sets no
 * cookie just by loading; playing at once, since the click was the gesture; from
 * `start`; related videos from the same channel only. No enablejsapi or origin: a
 * file:// page has no origin to give.
 */
export function youTubeEmbedUrl(video: { videoId: string; start?: number }): string {
  const params = new URLSearchParams({ autoplay: "1" })
  if (video.start) params.set("start", String(video.start))
  params.set("rel", "0")
  params.set("playsinline", "1")
  return `https://www.youtube-nocookie.com/embed/${video.videoId}?${params}`
}

/**
 * The still a poster draws. hqdefault (480×360) is there for every video: a 16:9 one
 * letterboxed, a Short in the middle of blurred sides — drawn object-fit: cover, either
 * crops to the picture. A video that does not exist still LOADS one: a 120×90 grey
 * placeholder, sent with HTTP 404, so the poster checks naturalWidth.
 */
export function youTubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

/** The video on YouTube itself — Open on YouTube, and the words ⌘C copies a video as. */
export function youTubeWatchUrl(video: { videoId: string; start?: number }): string {
  const start = video.start ? `&t=${video.start}s` : ""
  return `https://www.youtube.com/watch?v=${video.videoId}${start}`
}

// ─── reading a link ───

/** The video one link (no prose round it) leads to, or null. The scheme is optional. */
function videoFromLink(link: string): YouTubeVideo | null {
  let url = parseLink(link)
  for (let depth = 0; url && depth <= WRAPPER_DEPTH; depth++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const host = url.hostname.replace(/\.$/, "")
    if (host === "youtu.be") return fromSegments(["watch", ...segments(url)], url)
    if (WATCH_HOSTS.has(host)) {
      const parts = segments(url)
      if (parts[0] === "attribution_link") {
        url = inner(url.searchParams.get("u"), "https://www.youtube.com")
        continue
      }
      if (parts[0] === "watch" && parts.length === 1) {
        const id = url.searchParams.get("v")
        return id === null ? null : video(id, url, undefined, false)
      }
      return fromSegments(parts, url)
    }
    if (host === "consent.youtube.com") {
      url = inner(url.searchParams.get("continue"))
      continue
    }
    if (GOOGLE_HOST.test(host) && url.pathname === "/url") {
      url = inner(url.searchParams.get("url") ?? url.searchParams.get("q"))
      continue
    }
    return null
  }
  return null
}

function parseLink(link: string): URL | null {
  let text = link
  if (text.startsWith("//")) text = `https:${text}`
  else if (!/^https?:\/\//i.test(text)) {
    // mailto:, javascript:, file: … are never videos; "youtube.com:443/…" is a port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null
    text = `https://${text}`
  }
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** The link inside a wrapper's parameter — relative to `base`, for attribution_link. */
function inner(value: string | null, base?: string): URL | null {
  if (!value) return null
  try {
    return base ? new URL(value, base) : parseLink(value.trim())
  } catch {
    return null
  }
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter((part) => part !== "")
}

/**
 * /<word>/<id>, exactly two segments — and a youtu.be link, read as /watch/<id>. An id
 * can have "&…" straight after it, as old embed codes (/v/ID&hl=en&fs=1) and a
 * hand-typed youtu.be/ID&t=30 do: those parameters count as the query's.
 */
function fromSegments(parts: string[], url: URL): YouTubeVideo | null {
  if (parts.length !== 2 || !ID_PATHS.has(parts[0])) return null
  const at = parts[1].indexOf("&")
  const id = at < 0 ? parts[1] : parts[1].slice(0, at)
  const tail = at < 0 ? undefined : new URLSearchParams(parts[1].slice(at + 1))
  return video(id, url, tail, parts[0] === "shorts")
}

// A playlist's list= and index= are left behind: the node is the one video.
function video(id: string, url: URL, tail: URLSearchParams | undefined, short: boolean): YouTubeVideo | null {
  if (!isYouTubeVideoId(id)) return null
  const found: YouTubeVideo = { videoId: id }
  const start = startOf(url, tail)
  if (start) found.start = start
  if (short) found.short = true
  return found
}

/** t, then start, then time_continue — in the query, then "&…" after the id, then #t=. */
function startOf(url: URL, tail: URLSearchParams | undefined): number | undefined {
  const fragment = new URLSearchParams(url.hash.replace(/^#!?/, ""))
  for (const params of [url.searchParams, tail, fragment]) {
    if (!params) continue
    for (const key of ["t", "start", "time_continue"]) {
      const value = params.get(key)
      if (value === null) continue
      const seconds = parseYouTubeTime(value)
      if (seconds !== null) return seconds > 0 ? seconds : undefined
    }
  }
  return undefined
}
