// The Google Images panel's pure half (app/dashboard/diagrams/ImageSearchPanel.tsx):
// which page it opens at, what a page is searching for, and which picture a drag
// out of it carries. Switchboard's own — the admin has no such panel. Pure and
// dependency-free, so scripts/test-image-search.js runs it in plain node.
//
// The page is Google's own, in a <webview> that main fences in (src/main/index.js,
// will-attach-webview): it attaches only in the partition below, and only when it
// starts on https at www.google.com or images.google.com. A picture dragged out of
// a <webview> never reaches the canvas as a file — Chromium hands over its address
// as text/uri-list, text/html and text/plain instead — so the canvas reads the
// address back out of those, and main fetches the bytes (diagramsFetchImage).

/** The session the panel's page runs in: the one partition main lets a <webview> use. */
export const GOOGLE_IMAGES_PARTITION = "persist:sb-images"

/** Google Images' own first page, for a panel with nothing to search for. */
export const GOOGLE_IMAGES_HOME = "https://www.google.com/imghp"

/** Where main lets the panel start (with no port, so `host` rather than `hostname`). */
const PANEL_HOSTS = new Set(["www.google.com", "images.google.com"])

/** The Google hosts whose /search is a search whose words the field can show. */
const SEARCH_HOSTS = new Set(["google.com", "www.google.com", "images.google.com"])

/** What a drag out of a web page brings: an address, the markup, and plain text. */
const PAGE_DRAG_TYPES = ["text/uri-list", "text/html", "text/plain"]

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * The results page for `query` — udm=2 is Google's Images tab — or Google Images'
 * first page when there is nothing to search for. A run of whitespace, a line break
 * included (a box's label can have them), is one space.
 */
export function googleImagesUrl(query: string): string {
  const words = query.replace(/\s+/g, " ").trim()
  if (!words) return GOOGLE_IMAGES_HOME
  return `https://www.google.com/search?udm=2&q=${encodeURIComponent(words)}`
}

/** The words a Google search page is searching for, or null for any other page. */
export function queryFromUrl(url: string): string | null {
  const parsed = parse(url)
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null
  if (!SEARCH_HOSTS.has(parsed.hostname) || parsed.pathname !== "/search") return null
  return parsed.searchParams.get("q")
}

/**
 * Whether the panel can open at `url`: main refuses a <webview> that starts anywhere
 * but https on www.google.com or images.google.com. A site followed out of the
 * results can be browsed to, but it is no page to open the panel at again.
 */
export function opensInPanel(url: string): boolean {
  const parsed = parse(url)
  return (
    parsed !== null &&
    parsed.protocol === "https:" &&
    PANEL_HOSTS.has(parsed.host) &&
    !parsed.username &&
    !parsed.password
  )
}

/**
 * Whether a drag might be a picture out of a web page. Until the drop only the KINDS
 * of data are known — a page can't read a drag's contents before then — so this is
 * any drag that carries an address, markup or text; imageUrlFromDrop decides.
 */
export function isUrlDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).some((type) => PAGE_DRAG_TYPES.includes(type))
}

/** A drop's data, as DataTransfer.getData() reads it for each kind. */
export type DroppedData = { uriList?: string; html?: string; plain?: string }

/**
 * The address of the picture in a drop, or null when there is none to fetch.
 *
 * A picture dragged out of a page carries its own <img> as text/html, and as
 * text/uri-list the link round it when it sits in one (as each of Google's results
 * does) — so the markup's src comes first, then the list's first address (a line
 * starting "#" is a comment), then plain text. Only an absolute http(s) address or
 * a data:image/ one will do: Chromium writes the markup's src already resolved, so
 * a relative one is not the page's, and javascript:, file: and the rest are never
 * fetched.
 *
 * But a data: src beside a srcset is a lazy loader's placeholder — a 1px GIF, an
 * empty SVG — and the picture on screen is the srcset's choice. Chromium writes
 * the srcset unresolved, and lists that choice as the address only when the
 * picture is in no link. So: the listed address when it is one of the srcset's
 * absolute ones, else the largest of those, else on to the list as usual. Google's
 * own thumbnails are data: srcs with no srcset, and stay as they are.
 */
export function imageUrlFromDrop({ uriList = "", html = "", plain = "" }: DroppedData): string | null {
  const first = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"))
  const listed = first ? fetchable(first) : null
  for (const { src, srcset } of imageTags(html)) {
    const url = fetchable(src)
    if (!url) continue
    if (srcset === null || !url.startsWith("data:")) return url
    const choices = srcsetChoices(srcset)
    if (listed !== null && choices.includes(listed)) return listed
    if (choices.length > 0) return choices[0]
  }
  return listed ?? fetchable(plain)
}

/** Google's own hosts, as main's isGoogleHost has them (src/main/images.js). */
const GOOGLE_HOST = /^(?:www\.|images\.)?google\.(?:com|com?\.[a-z]{2}|[a-z]{2,3})$/

/**
 * Every address worth trying for the picture in a drop, the best first. A drag out of
 * Google's results carries the result's thumbnail — a couple of hundred pixels across —
 * as its <img>, and as its address the result's link: /imgres?imgurl=<the full
 * picture>, measured on Google's page in this Electron. So that link comes first (main
 * fetches the picture inside it), and the thumbnail next, for when the full picture's
 * host refuses it or takes too long. Anything else is imageUrlFromDrop's one address.
 */
export function imageUrlsFromDrop(data: DroppedData): string[] {
  const first = (data.uriList ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"))
  const urls: string[] = []
  const original = first ? googleOriginal(first) : null
  if (original) urls.push(original)
  const picked = imageUrlFromDrop(data)
  if (picked && !urls.includes(picked)) urls.push(picked)
  return urls
}

/** A Google /imgres link whose imgurl is a web address, as fetchable(); else null. */
function googleOriginal(candidate: string): string | null {
  const url = fetchable(candidate)
  const parsed = url && !url.startsWith("data:") ? parse(url) : null
  if (!parsed || !GOOGLE_HOST.test(parsed.hostname) || parsed.pathname !== "/imgres") return null
  const inner = parse(parsed.searchParams.get("imgurl") ?? "")
  return inner && (inner.protocol === "https:" || inner.protocol === "http:") ? url : null
}

/** An address the canvas may ask main to fetch, as it should be asked, or null. */
function fetchable(candidate: string): string | null {
  const text = candidate.trim()
  if (!text) return null
  // Main decodes these itself, base64 and all; one that isn't a picture it refuses.
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(text)) return text
  // A run of words that happens to start with an address is not an address.
  if (/\s/.test(text)) return null
  const parsed = parse(text)
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null
  return parsed.href
}

// How much of a drop's markup is read. Generous — a thumbnail's data: src runs to
// some KB — but the drag's source writes the markup, and it can be anything.
const MARKUP_MAX = 1 << 20
// <img followed by its attributes, a quoted value free to hold a ">" or a "<".
// Never a bare "<": with one allowed, a run of "<img " and no ">" took time
// growing with the square of its length, on the thread the whole window runs on.
const IMG_TAG_RE = /<img\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi
// One attribute: its name, and its value — double-quoted, single-quoted or bare.
const ATTRIBUTE_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g

/**
 * Every <img>'s src and srcset in `html`, in order, character references decoded:
 * src "" when it has none, srcset null.
 */
function imageTags(html: string): { src: string; srcset: string | null }[] {
  const tags: { src: string; srcset: string | null }[] = []
  for (const tag of html.slice(0, MARKUP_MAX).matchAll(IMG_TAG_RE)) {
    let src: string | null = null
    let srcset: string | null = null
    // By attribute, not by searching the tag for "src=": that would find the
    // one in data-src, or in an alt that mentions it. The first of a name counts,
    // as it does in HTML.
    for (const attribute of tag[1].matchAll(ATTRIBUTE_RE)) {
      const name = attribute[1].toLowerCase()
      const value = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "")
      if (name === "src" && src === null) src = value
      else if (name === "srcset" && srcset === null) srcset = value
    }
    tags.push({ src: src ?? "", srcset })
  }
  return tags
}

// A srcset, a candidate at a time: the whitespace and commas before one, its
// address (up to whitespace), then its descriptors (up to the next comma).
const SRCSET_GAP = /[\s,]*/y
const SRCSET_ADDRESS = /\S+/y
const SRCSET_DESCRIPTORS = /[^,]*/y

/**
 * The absolute http(s) addresses a srcset offers, the largest first by its "800w"
 * or "2x" (none is 1x). Split as HTML splits one: an address runs to whitespace, and
 * only the commas at its very end aren't part of it — a CDN's "w_400,h_300" is.
 */
function srcsetChoices(srcset: string): string[] {
  const choices: { url: string; size: number }[] = []
  let at = 0
  for (;;) {
    SRCSET_GAP.lastIndex = at
    SRCSET_GAP.exec(srcset)
    at = SRCSET_GAP.lastIndex
    if (at >= srcset.length) break
    SRCSET_ADDRESS.lastIndex = at
    const found = SRCSET_ADDRESS.exec(srcset)
    if (!found) break
    let address = found[0]
    at += address.length
    let descriptors = ""
    if (address.endsWith(",")) {
      let end = address.length
      while (end > 0 && address[end - 1] === ",") end -= 1
      address = address.slice(0, end)
    } else {
      SRCSET_DESCRIPTORS.lastIndex = at
      descriptors = SRCSET_DESCRIPTORS.exec(srcset)?.[0] ?? ""
      at += descriptors.length
    }
    const url = /^https?:/i.test(address) ? fetchable(address) : null
    if (url) choices.push({ url, size: parseFloat(descriptors) || 1 })
  }
  return choices.sort((a, b) => b.size - a.size).map((choice) => choice.url)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
}

/**
 * The character references an attribute value is serialized with — "&amp;" between
 * the parts of every query string, mostly. Any other named one is left as written:
 * it doesn't turn up in an address.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);/gi, (whole, ref: string) => {
    const name = ref.toLowerCase()
    if (!name.startsWith("#")) return NAMED_ENTITIES[name]
    const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}
