// Pure validation for diagram specs. NOTHING in here may import from lib/db,
// lib/auth0, lib/auth-guard, or next/* — this module is unit tested in a plain
// node environment (see validate.test.ts), in the publish script and in the
// browser.
//
// parseDiagramSpec is the single gate every spec passes through: the server
// action before writing, the publish script before upserting, and every read
// on the way back out. It does two jobs at once —
//
//   1. REJECT anything the layout compiler could not draw, with a message that
//      names the node or edge it is complaining about ("Node 4: ...") so an
//      author who never sees the canvas can fix it from the error alone.
//   2. NORMALIZE what survives: whitespace collapsed, edge references resolved
//      to the exact spelling of the node ids they name. After this, the layout
//      compiler can look every reference up and never miss.
//
// Optional fields are deliberately left optional rather than defaulted here —
// what gets stored should read like what the author wrote, and the layout
// compiler applies DEFAULT_* itself.

import {
  DIAGRAM_KINDS,
  DIAGRAM_NAME_MAX_LENGTH,
  DIAGRAM_SUMMARY_MAX_LENGTH,
  DIAGRAM_TEXT_MAX_LENGTH,
  FLOW_COORDINATE_LIMIT,
  FLOW_IMAGE_SRC_MAX_LENGTH,
  FLOW_SHAPES,
  FLOW_SIDES,
  FLOW_SIZE_MAX,
  FLOW_SIZE_MIN,
  FLOW_TEXT_ALIGNS,
  FLOW_TEXT_SIZES,
  FLOW_TONES,
  isFlowSizedShape,
  type DiagramKind,
  type DiagramSpec,
  type FlowEdgeSpec,
  type FlowNodeSpec,
  type FlowPosition,
  type FlowShape,
  type FlowSide,
  type FlowSize,
  type FlowSpec,
  type FlowTextAlign,
  type FlowTextSize,
  type FlowTone,
} from "./types"

export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

export type SpecResult =
  | { ok: true; value: DiagramSpec }
  | { ok: false; error: string }

// Strict 8-4-4-4-12 hex, case-insensitive.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Any run of whitespace (including newlines pasted from elsewhere) collapses to
// a single space, so a name or an arrow's label stays one line.
const WHITESPACE_RUN_RE = /\s+/g

/**
 * A box's label or second line, which may run over several lines (Shift+Enter
 * in the editor): spaces collapse as everywhere else, but each line break is
 * kept — with at most one blank line in a row, and none at either end.
 * Exported for flowSpecFromCanvas, which saves text exactly as this keeps it.
 */
export function normalizeFlowText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

type Normalize = (raw: string) => string

function singleLine(raw: string): string {
  return raw.trim().replace(WHITESPACE_RUN_RE, " ")
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

// UTF-8 byte length, matching Postgres' octet_length(). TextEncoder rather than
// Buffer so this module runs unchanged in the browser.
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

export function normalizeDiagramName(raw: string): ValidationResult {
  const value = raw.trim().replace(WHITESPACE_RUN_RE, " ")
  if (value.length === 0) return { ok: false, error: "Name is required" }
  // Length is checked AFTER collapsing so a name that is only long because of
  // stray whitespace isn't rejected.
  if (value.length > DIAGRAM_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Name must be ${DIAGRAM_NAME_MAX_LENGTH} characters or fewer`,
    }
  }
  return { ok: true, value }
}

export function parseDiagramKind(raw: unknown): DiagramKind | null {
  return typeof raw === "string" &&
    (DIAGRAM_KINDS as readonly string[]).includes(raw)
    ? (raw as DiagramKind)
    : null
}

// ─────────────────────────────────────────────────────────────────────
// Small readers. Each returns the cleaned value or throws SpecError, which
// parseDiagramSpec turns into { ok: false }. Throwing (rather than threading a
// result type through every reader) keeps the parsers below reading straight
// down.
// ─────────────────────────────────────────────────────────────────────

class SpecError extends Error {}

function fail(where: string, message: string): never {
  throw new SpecError(where ? `${where}: ${message}` : message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A required string — one line, unless `normalize` keeps line breaks.
function text(
  raw: unknown,
  where: string,
  field: string,
  max = DIAGRAM_TEXT_MAX_LENGTH,
  normalize: Normalize = singleLine,
): string {
  if (typeof raw !== "string") fail(where, `"${field}" must be text`)
  const value = normalize(raw)
  if (value.length === 0) fail(where, `"${field}" is empty`)
  if (value.length > max) {
    fail(where, `"${field}" must be ${max} characters or fewer`)
  }
  return value
}

// An optional single-line string. Absent, null, and empty all mean "omitted",
// which is what lets an author leave a key in with an empty value.
function optionalText(
  raw: unknown,
  where: string,
  field: string,
  max = DIAGRAM_TEXT_MAX_LENGTH,
  normalize: Normalize = singleLine,
): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") fail(where, `"${field}" must be text`)
  const value = normalize(raw)
  if (value.length === 0) return undefined
  if (value.length > max) {
    fail(where, `"${field}" must be ${max} characters or fewer`)
  }
  return value
}

// An optional value from a fixed vocabulary. The error lists the whole
// vocabulary, because the only useful reply to "unknown arrow" is the list.
function optionalEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  where: string,
  field: string,
): T | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    fail(
      where,
      `"${field}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`,
    )
  }
  return raw as T
}

function array(raw: unknown, where: string, field: string): unknown[] {
  if (!Array.isArray(raw)) fail(where, `"${field}" must be a list`)
  return raw
}

// ─────────────────────────────────────────────────────────────────────
// flow
// ─────────────────────────────────────────────────────────────────────

// An optional box position. Rounded to whole pixels on the way in: the editor
// hands over whatever sub-pixel value a drag ended on, and storing 312.4999 is
// noise in the JSON that nobody can see on the canvas.
function optionalPosition(raw: unknown, where: string): FlowPosition | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) fail(where, '"position" must be an object like { "x": 0, "y": 0 }')
  const coordinate = (value: unknown, axis: "x" | "y"): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(where, `"position.${axis}" must be a number`)
    }
    if (Math.abs(value) > FLOW_COORDINATE_LIMIT) {
      fail(where, `"position.${axis}" must be within ±${FLOW_COORDINATE_LIMIT}`)
    }
    // `+ 0` folds the -0 that Math.round(-0.4) produces back into 0.
    return Math.round(value) + 0
  }
  return { x: coordinate(raw.x, "x"), y: coordinate(raw.y, "y") }
}

// An on/off flag. Anything but a real boolean means "not stated".
function optionalFlag(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined
}

// An optional size, in whole pixels — rounded on the way in for the same
// reason as a position.
function optionalSize(raw: unknown, where: string): FlowSize | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    fail(where, '"size" must be an object like { "width": 240, "height": 160 }')
  }
  const side = (value: unknown, field: "width" | "height"): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(where, `"size.${field}" must be a number`)
    }
    if (value < FLOW_SIZE_MIN || value > FLOW_SIZE_MAX) {
      fail(where, `"size.${field}" must be between ${FLOW_SIZE_MIN} and ${FLOW_SIZE_MAX}`)
    }
    return Math.round(value)
  }
  return { width: side(raw.width, "width"), height: side(raw.height, "height") }
}

// An image's address. https only: the canvas puts it straight into an <img>
// on an https page, and a picture there has no business arriving unencrypted.
// Switchboard: or sbimg://image/<file>, a picture kept on this Mac (upload.ts).
function imageSrc(raw: unknown, where: string): string {
  if (raw === undefined || raw === null || raw === "") {
    fail(where, 'an "image" node needs "src", the https URL of the picture')
  }
  if (typeof raw !== "string") fail(where, '"src" must be text')
  const value = raw.trim()
  if (value.length > FLOW_IMAGE_SRC_MAX_LENGTH) {
    fail(where, `"src" must be ${FLOW_IMAGE_SRC_MAX_LENGTH} characters or fewer`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(where, '"src" must be a full URL starting with https://')
  }
  if (url.protocol === "sbimg:" && url.host === "image") return value
  if (url.protocol !== "https:") fail(where, '"src" must start with https://')
  return value
}

// A flow with no nodes is allowed: it is what a brand-new diagram is before
// anything has been put on it, and what is left after deleting every box to
// start over.
function parseFlow(raw: Record<string, unknown>): FlowSpec {
  // Switchboard: as many as you like — see types.ts.
  const rawNodes = array(raw.nodes, "", "nodes")

  const byKey = new Map<string, string>()
  const nodes: FlowNodeSpec[] = rawNodes.map((entry, index) => {
    const where = `Node ${index + 1}`
    if (!isRecord(entry)) fail(where, "must be an object")

    const id = text(entry.id, where, "id", 60)
    const key = id.toLowerCase()
    if (byKey.has(key)) fail(where, `id "${id}" is used by an earlier node`)
    byKey.set(key, id)

    const shape = optionalEnum<FlowShape>(entry.shape, FLOW_SHAPES, where, "shape")
    return {
      id,
      // A sticky note can be left blank; everything else needs words.
      label:
        shape === "note"
          ? (optionalText(entry.label, where, "label", undefined, normalizeFlowText) ?? "")
          : text(entry.label, where, "label", undefined, normalizeFlowText),
      detail: optionalText(entry.detail, where, "detail", undefined, normalizeFlowText),
      shape,
      tone: optionalEnum<FlowTone>(entry.tone, FLOW_TONES, where, "tone"),
      // An explicit `false` is kept rather than dropped: it is how a
      // republished spec turns off styling the editor set, which the publish
      // script would otherwise carry over (carryOverFlowLayout).
      dashed: optionalFlag(entry.dashed),
      textSize: optionalEnum<FlowTextSize>(
        entry.textSize,
        FLOW_TEXT_SIZES,
        where,
        "textSize",
      ),
      align: optionalEnum<FlowTextAlign>(entry.align, FLOW_TEXT_ALIGNS, where, "align"),
      bold: optionalFlag(entry.bold),
      italic: optionalFlag(entry.italic),
      // Kept when false, like `dashed`: that is how a republish clears a mark
      // carryOverFlowLayout would otherwise carry over.
      ai: optionalFlag(entry.ai),
      position: optionalPosition(entry.position, where),
      // Each kept only on the shapes it means something for, so a box turned
      // from an image doesn't carry a dead URL around.
      src: shape === "image" ? imageSrc(entry.src, where) : undefined,
      size:
        shape !== undefined && isFlowSizedShape(shape)
          ? optionalSize(entry.size, where)
          : undefined,
    }
  })

  const rawEdges = array(raw.edges, "", "edges")

  const edges: FlowEdgeSpec[] = rawEdges.map((entry, index) => {
    const where = `Edge ${index + 1}`
    if (!isRecord(entry)) fail(where, "must be an object")

    const resolve = (value: unknown, field: string): string => {
      const wanted = text(value, where, field, 60)
      const found = byKey.get(wanted.toLowerCase())
      if (found === undefined) {
        fail(where, `"${field}" is "${wanted}", which is not one of the node ids`)
      }
      return found
    }

    return {
      from: resolve(entry.from, "from"),
      to: resolve(entry.to, "to"),
      label: optionalText(entry.label, where, "label"),
      dashed: entry.dashed === true ? true : undefined,
      // Switchboard: a branch folded away behind this edge.
      collapsed: entry.collapsed === true ? true : undefined,
      fromSide: optionalEnum<FlowSide>(entry.fromSide, FLOW_SIDES, where, "fromSide"),
      toSide: optionalEnum<FlowSide>(entry.toSide, FLOW_SIDES, where, "toSide"),
    }
  })

  return {
    kind: "flow",
    title: optionalText(raw.title, "", "title"),
    summary: optionalText(raw.summary, "", "summary", DIAGRAM_SUMMARY_MAX_LENGTH),
    direction:
      optionalEnum<"down" | "right">(
        raw.direction,
        ["down", "right"] as const,
        "",
        "direction",
      ) ?? undefined,
    nodes,
    edges,
  }
}

// ─────────────────────────────────────────────────────────────────────

// The single gate. Takes whatever came out of a textarea, a JSON file, or a
// jsonb column and either hands back a spec the layout compiler can draw, or
// one sentence saying why it can't.
export function parseDiagramSpec(raw: unknown): SpecResult {
  try {
    if (typeof raw === "string") {
      fail("", "expected a JSON object, not a string of JSON")
    }
    if (!isRecord(raw)) fail("", "the spec must be a JSON object")

    if (raw.kind === "sequence") {
      fail("", 'sequence diagrams are no longer supported — write a "flow" diagram')
    }
    if (parseDiagramKind(raw.kind) === null) {
      fail(
        "",
        `"kind" must be one of ${DIAGRAM_KINDS.map((k) => `"${k}"`).join(", ")}`,
      )
    }

    // Switchboard: no size limit either — see types.ts.
    return { ok: true, value: parseFlow(raw) }
  } catch (err) {
    if (err instanceof SpecError) return { ok: false, error: err.message }
    // A non-SpecError here is a bug in this module, not bad input — surface it
    // rather than dressing it up as a validation message.
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid diagram spec",
    }
  }
}

// Convenience for the publish script, which reads the spec as text: report a
// JSON syntax error and a spec error through the same channel.
export function parseDiagramSpecJson(source: string): SpecResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    return {
      ok: false,
      error: `That isn't valid JSON — ${
        err instanceof Error ? err.message : "parse failed"
      }`,
    }
  }
  return parseDiagramSpec(parsed)
}
