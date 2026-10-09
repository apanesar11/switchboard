// Shared types + limits for the Diagrams feature. A diagram is a name, a kind
// and a SPEC: one JSON document describing the diagram the way a person would
// describe it out loud. Kept dependency-free so the server actions, the layout
// compiler and the client components can all import it.
//
// The spec deliberately carries NO coordinates, sizes or ids-you-have-to-invent.
// Everything visual is derived by layoutDiagram() in ./layout.ts. That is the
// whole point of the format: Claude authors a diagram blind — it never sees the
// rendered canvas — so anything the author could get wrong about placement has
// to be something the author is never asked about.
//
// The one exception is the OPTIONAL `position`, `size` and edge sides, which
// only the drag-and-drop editor on the Diagrams page writes, along
// with the text and outline styling its toolbar sets. They are extra
// information about a drawing a person arranged by hand, never something an
// author is asked for: a flow spec without them still lays itself out.
//
// The feature is product-scoped: every product gets its own diagrams, exactly
// like mockups.
// Switchboard: whiteboards live in one store, apart from any workspace; a box an
// answer wrote names the workspace it read (`answeredIn`), and a terminal pinned
// to the board is a node of its own ("terminal"), with its workspace and size.

export type ServerActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// What the spec describes. Only "flow" now — the box-and-arrow diagram drawn
// on the Diagrams page. (There was a "sequence" kind; it was removed, and any
// rows of it still in the table are left out of every list.)
export const DIAGRAM_KINDS = ["flow"] as const

export type DiagramKind = (typeof DIAGRAM_KINDS)[number]

export const DEFAULT_DIAGRAM_KIND: DiagramKind = "flow"

// ─────────────────────────────────────────────────────────────────────
// The authored spec
// ─────────────────────────────────────────────────────────────────────

export type DiagramSpec = FlowSpec

// ─── flow ───

// What a node is drawn as. The first four are boxes: "diamond" is the
// decision, "pill" the start/end of a flow, "rounded"/"box" everything else.
// The rest aren't boxes at all — a sticky "note", free-floating "text" with
// no outline, and an "image" (which needs `src`).
// Switchboard: and a "terminal" — a workspace's live terminal pinned to the
// whiteboard (it needs `workspace`). Only the editor makes one; it is never
// asked of an author, and no answer, condense or copy ever writes one.
export const FLOW_SHAPES = [
  "box",
  "rounded",
  "pill",
  "diamond",
  "note",
  "text",
  "image",
  "document",
  "terminal",
] as const

export type FlowShape = (typeof FLOW_SHAPES)[number]

export const DEFAULT_FLOW_SHAPE: FlowShape = "rounded"

/** The shapes that are boxes — the ones a box can be switched between. */
export const FLOW_BOX_SHAPES = ["box", "rounded", "pill", "diamond"] as const

export type FlowBoxShape = (typeof FLOW_BOX_SHAPES)[number]

export function isFlowBoxShape(shape: FlowShape): shape is FlowBoxShape {
  return (FLOW_BOX_SHAPES as readonly FlowShape[]).includes(shape)
}

/**
 * The shapes sized by hand in the editor, which keep that size in `size`.
 * A box is always as wide as every other box and as tall as its text.
 * Switchboard: a pinned terminal is sized by hand too.
 */
export const FLOW_SIZED_SHAPES = ["note", "text", "image", "terminal"] as const

export function isFlowSizedShape(shape: FlowShape): boolean {
  return (FLOW_SIZED_SHAPES as readonly FlowShape[]).includes(shape)
}

// Colour without asking the author for a colour: a small vocabulary of meanings
// the renderer maps onto the palette.
export const FLOW_TONES = [
  "default",
  "accent",
  "muted",
  "success",
  "warning",
  "danger",
] as const

export type FlowTone = (typeof FLOW_TONES)[number]

export const DEFAULT_FLOW_TONE: FlowTone = "default"

// How big a box's label is drawn. Set from the editor's text toolbar.
export const FLOW_TEXT_SIZES = ["small", "medium", "large"] as const

export type FlowTextSize = (typeof FLOW_TEXT_SIZES)[number]

export const DEFAULT_FLOW_TEXT_SIZE: FlowTextSize = "medium"

// Where a box's text sits across it. Set from the editor's text toolbar.
export const FLOW_TEXT_ALIGNS = ["left", "center", "right"] as const

export type FlowTextAlign = (typeof FLOW_TEXT_ALIGNS)[number]

export const DEFAULT_FLOW_TEXT_ALIGN: FlowTextAlign = "center"

// Which side of a box an edge leaves or lands on. Only the editor writes these
// — an edge without them attaches along the diagram's direction (bottom → top
// for "down", right → left for "right").
export const FLOW_SIDES = ["top", "right", "bottom", "left"] as const

export type FlowSide = (typeof FLOW_SIDES)[number]

/** Top-left corner of a box, in canvas pixels at zoom 1. */
export type FlowPosition = { x: number; y: number }

/** A node's width and height, in canvas pixels at zoom 1. */
export type FlowSize = { width: number; height: number }

/** Safe, structured text: paragraphs with optional bullets and inline marks. */
/** A newline within a run is a soft break inside the same paragraph/list item. */
export type FlowTextRun = { text: string; bold?: boolean; italic?: boolean }
export type FlowTextParagraph = {
  runs: FlowTextRun[]
  bullet?: boolean
  /** Defined for a checklist item, including an unchecked item (false). */
  checked?: boolean
  /** List nesting depth; omitted for top-level items and ordinary paragraphs. */
  level?: number
}
export type FlowRichText = FlowTextParagraph[]

// A box. `id` is what edges point at; it is the one place the format asks for a
// key, and a short human word ("checkout") is the intended value.
export type FlowNodeSpec = {
  id: string
  /** Required — except on a "note", which may be blank (""). */
  label: string
  detail?: string
  /** Formatting for the corresponding plain text, kept for AI and older specs. */
  labelRichText?: FlowRichText
  detailRichText?: FlowRichText
  shape?: FlowShape
  tone?: FlowTone
  /** Dashes the outline — the optional or not-built-yet box. */
  dashed?: boolean
  // Label defaults for older diagrams. Rich text carries its own inline marks.
  textSize?: FlowTextSize
  align?: FlowTextAlign
  bold?: boolean
  italic?: boolean
  /**
   * Written by the editor's ✦ Answer (lib/diagrams/ai.ts) and drawn as a small
   * sparkle in the box's corner. Editing the box's text by hand clears it: the
   * mark says the words are still the AI's.
   */
  ai?: boolean
  /**
   * Switchboard: the workspace a CLI answer read to write this box — a rail
   * workspace id, drawn as a small tag under the box. Kept only while `ai` is
   * true: it says whose words these are, so it goes when they stop being the
   * AI's. Absent for an answer from an API, which reads no workspace.
   */
  answeredIn?: string
  /**
   * Switchboard: detached from its branch, by the editor's toolbar. A box normally
   * drags what hangs off it along, and settles into the branch it hangs off when
   * let go; a detached one is in no branch — it moves on its own, nothing it is
   * joined to moves with it, and laying out a branch leaves it where it is.
   */
  detached?: boolean
  /**
   * Where someone dragged the box, written by the Diagrams page's editor. Absent
   * means "lay it out for me", which is what every Claude-authored node is.
   */
  position?: FlowPosition
  /**
   * The picture an "image" node shows: an https URL. Required for an image,
   * and only kept on one. `label` is its alt text.
   */
  src?: string
  /** Stable UUID of a plain Markdown file beside the local diagrams. */
  documentId?: string
  /**
   * How big someone made a note, a text or an image in the editor. Only kept
   * for those shapes. A note grows past it to fit its text, and a text uses
   * only the width — its height always follows its lines. Absent means the
   * default size (a note, an image) or as wide as the words (a text).
   * Switchboard: a terminal's outer size, header included.
   */
  size?: FlowSize
  /**
   * Switchboard: the rail workspace a "terminal" node shows the shell of.
   * Required on a terminal, and only kept on one. Its `label` is the same id.
   */
  workspace?: string
  /**
   * Switchboard: a terminal's type size in canvas units — 12.5 over the zoom it
   * was pinned at, so pinning keeps the text exactly the size it was on screen.
   * Drawn at `font × zoom` pixels. Only kept on a terminal; absent means 12.5.
   */
  font?: number
  /** Switchboard: a terminal folded to its title bar, in place. */
  minimized?: boolean
}

export type FlowEdgeSpec = {
  from: string
  to: string
  label?: string
  /** Dashes the line — the "only sometimes" or "async" edge. */
  dashed?: boolean
  /** The side of `from` the edge leaves by. Editor-written; see FLOW_SIDES. */
  fromSide?: FlowSide
  /** The side of `to` the edge lands on. Editor-written; see FLOW_SIDES. */
  toSide?: FlowSide
  /**
   * Switchboard: folds away what the edge points at and everything beyond it
   * (lib/diagrams/flow-editor.ts foldFlow). Editor-written.
   */
  collapsed?: boolean
}

export type FlowSpec = {
  kind: "flow"
  title?: string
  summary?: string
  /** "down" (the default) stacks layers vertically; "right" runs left to right. */
  direction?: "down" | "right"
  nodes: FlowNodeSpec[]
  edges: FlowEdgeSpec[]
}

// ─────────────────────────────────────────────────────────────────────
// Database rows
// ─────────────────────────────────────────────────────────────────────

// List row — without the spec: a list of specs is a lot of JSON to send for a
// dropdown.
//
// archivedAt is an ISO string when the diagram is archived, null when it is
// active. Archiving is reversible; deleting (archived or not) is not.
export type DiagramSummary = {
  id: string
  name: string
  kind: DiagramKind
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

// A diagram WITH its spec — what the canvas and the editor both need. Unlike a
// mockup deck this is small enough to just send, so there is no separate
// summary/detail fetch dance.
export type DiagramDetail = DiagramSummary & {
  spec: DiagramSpec
}

export const DIAGRAM_NAME_MAX_LENGTH = 120

// Switchboard: no ceiling on how many boxes or arrows a diagram has, nor on its size.
// The admin caps a flow at 60 boxes, 120 arrows and 512 KB of JSON — to keep its
// database rows and Server Action bodies small, and the diagrams Claude writes without
// coordinates legible once laid out. Here a diagram is a file on this Mac, grown by
// hand and by ✦ Answer, and the user asked to be able to keep working on one
// (2026-10-04). A diagram past those caps carried into the admin by hand is refused
// there.
/**
 * How far from the origin a dragged box may sit. Far beyond anything a person
 * drags to; it exists so a hand-edited 1e308 can't reach the canvas.
 */
export const FLOW_COORDINATE_LIMIT = 100_000
/** The smallest and largest a note, text or image may be sized to. */
export const FLOW_SIZE_MIN = 16
export const FLOW_SIZE_MAX = 4_000
/** An image node's URL, at most. */
export const FLOW_IMAGE_SRC_MAX_LENGTH = 2_048

export const DIAGRAM_TEXT_MAX_LENGTH = 200
export const DIAGRAM_SUMMARY_MAX_LENGTH = 400

// ─────────────────────────────────────────────────────────────────────
// Switchboard: workspaces and pinned terminals
// ─────────────────────────────────────────────────────────────────────

/**
 * A rail workspace id, at most — what `answeredIn` and a terminal's `workspace`
 * hold. The same rule main applies to a whiteboard's own workspace.
 */
export const FLOW_WORKSPACE_ID_MAX_LENGTH = 200

/** The type size a terminal is drawn at on screen, in pixels — the Terminal tab's. */
export const TERMINAL_BASE_FONT = 12.5
/**
 * Below this rendered size (node.font × zoom, in pixels) the live terminal is
 * taken off the board and the node shows "Zoom in to use": text that small is
 * unreadable, and xterm's cells stop lining up with the pointer.
 */
export const TERMINAL_MIN_FONT = 7
/** What a terminal's stored `font` is clamped to, in canvas units. */
export const TERMINAL_FONT_MIN = 4
export const TERMINAL_FONT_MAX = 80
/** The header strip of a pinned terminal, in canvas units — what drags it. */
export const TERMINAL_HEADER = 30
/** A terminal pinned with no size of its own, and the least its resize handles go to. */
export const FLOW_TERMINAL_DEFAULT_SIZE: FlowSize = { width: 560, height: 340 }
export const FLOW_TERMINAL_MIN_SIZE: FlowSize = { width: 280, height: 140 }
/**
 * The least a pinned terminal's frame is ever drawn at, whatever size it holds: its
 * header's buttons and a sliver of body. Pinning keeps the floating panel's size on
 * screen, so a terminal pinned at a high zoom is smaller in canvas units than the
 * resize handles allow (FLOW_TERMINAL_MIN_SIZE binds a hand resize only) — and must
 * open again at the size it was pinned at.
 */
export const FLOW_TERMINAL_FLOOR: FlowSize = { width: 96, height: TERMINAL_HEADER + 16 }

/** A rectangle on screen, in client (window) pixels. */
export type ClientRect = { left: number; top: number; width: number; height: number }

/**
 * Switchboard: where a pinned terminal's live xterm goes, as the editor reports it
 * to its host (FlowEditor's onTerminalSlots). The host lays the xterm over `body`
 * itself — never inside the canvas, whose CSS transform would blur the text and
 * throw its mouse coordinates off.
 */
export type TerminalSlot = {
  wsId: string
  nodeId: string
  /**
   * Client pixels under the header, inset a few pixels from the node's left,
   * right and bottom edges so its resize handles stay clickable.
   */
  body: ClientRect
  /** Client pixels of the React Flow pane: nothing outside it is on the board. */
  clip: { left: number; top: number; right: number; bottom: number }
  zoom: number
  /** The COMMITTED size in canvas units — it changes only once a resize ends. */
  size: FlowSize
  /** The rendered type size in pixels: node.font × zoom. */
  font: number
  /**
   * The node's own type size in canvas units (node.font). A zoom never changes it;
   * Smaller text and Larger text do, and the host then fits a new grid to the box.
   */
  nodeFont: number
  minimized: boolean
  selected: boolean
  /** From a resize handle's press until the new size is committed. */
  resizing: boolean
  /** Some of the canvas's own floating UI (a toolbar, a menu, a panel) is over `body`. */
  covered: boolean
  /**
   * The canvas's own chrome over `body` — every React Flow panel (the tool rail, the
   * undo bar, the zoom controls) that overlaps it, cut to `body` — in client pixels.
   * The host leaves these out of the live terminal, so the chrome stays visible and
   * clickable above it, as it does above every other node. [] when none overlaps.
   */
  holes: { left: number; top: number; right: number; bottom: number }[]
  /**
   * False when minimized, folded away, its workspace is gone, or the type would
   * be drawn under TERMINAL_MIN_FONT — the node then shows a card of its own.
   */
  live: boolean
}
