// The pure half of the diagram editor: turning what is on the canvas back into
// a FlowSpec, naming new boxes, deciding where Tab puts the next one (and how
// the boxes around it shuffle to stay symmetrical), and keeping a hand-made
// arrangement when Claude republishes the diagram.
// Switchboard: the branches Tab builds run right; a branch can run down as well — an
// arrow out of a box's bottom into the top of one below — and is laid out the same
// way, turned on its side (FlowBranchDirection, layoutTree).
//
// Dependency-free apart from sibling pure modules, so it is unit tested in a
// plain node environment (flow-editor.test.ts) and runs unchanged in the
// browser and in scripts/upsert-diagram.ts.
//
// The editor itself (app/dashboard/diagrams/FlowEditor.tsx) goes the other way
// with layoutDiagram(): a spec in, React Flow nodes and edges out. That is why
// flowSpecFromCanvas writes a position for every box and a side for every edge
// — a spec it produces lays out as exactly the canvas it came from, which is
// what lets undo restore a snapshot by laying it out again.

import { defaultFlowSides, foldFlow, type FlowBoxNodeData, type FlowEdgeData, type FlowFoldEdge } from "./layout"
import { normalizeFlowText } from "./validate"
import { parseFlowRichText } from "./rich-text"
import { createFlowTimer } from "./timers"
import {
  DEFAULT_FLOW_SHAPE,
  DEFAULT_FLOW_TEXT_ALIGN,
  DEFAULT_FLOW_TEXT_SIZE,
  DEFAULT_FLOW_TONE,
  DIAGRAM_TEXT_MAX_LENGTH,
  FLOW_BOX_TEXT_MAX_LENGTH,
  FLOW_SIDES,
  FLOW_TERMINAL_DEFAULT_SIZE,
  PDF_LABEL,
  SHEET_LABEL,
  TELEPORT_LABEL,
  TERMINAL_BASE_FONT,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  TERMINAL_HEADER,
  TERMINAL_MIN_FONT,
  VIDEO_LABEL,
  WIDGET_LABEL,
  isFlowBoxShape,
  isFlowSizedShape,
  type FlowEdgeSpec,
  type FlowNodeSpec,
  type FlowShape,
  type FlowSide,
  type FlowSize,
  type FlowSpec,
} from "./types"

/** What a box with no label is saved as — the spec requires one. */
export const UNTITLED_FLOW_LABEL = "Untitled"

/** The parts of a spec the canvas doesn't show, carried through untouched. */
export type FlowSpecMeta = Pick<FlowSpec, "title" | "summary" | "direction">

// Structural rather than React Flow's own Node/Edge types, so this module
// stays free of the dependency; React Flow's objects satisfy them as they are.
export type FlowCanvasNode = {
  id: string
  position: { x: number; y: number }
  data: FlowBoxNodeData
}

export type FlowCanvasEdge = {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  data?: FlowEdgeData
}

// The validator's normalization, applied on the way out so the JSON the
// editor compares (to decide whether there is anything to save) is the JSON
// the server will actually store: one line for an arrow's label, line breaks
// kept in a box's label and second line.
function clean(value: string | undefined): string | undefined {
  const text = (value ?? "").trim().replace(/\s+/g, " ")
  return text.length > 0 ? text.slice(0, DIAGRAM_TEXT_MAX_LENGTH) : undefined
}

function cleanBoxText(value: string | undefined): string | undefined {
  const text = normalizeFlowText(value ?? "")
  return text.length > 0 ? text.slice(0, FLOW_BOX_TEXT_MAX_LENGTH).trimEnd() : undefined
}

function isSide(value: string | null | undefined): value is FlowSide {
  return (FLOW_SIDES as readonly (string | null | undefined)[]).includes(value)
}

/** Whole pixels, and never -0 (which JSON.stringify would print as 0 anyway). */
function pixel(value: number): number {
  return Math.round(value) + 0
}

export function flowSpecFromCanvas(
  meta: FlowSpecMeta,
  nodes: FlowCanvasNode[],
  edges: FlowCanvasEdge[],
): FlowSpec {
  const sides = defaultFlowSides(meta.direction ?? "down")

  // A free text with no words in it is not part of the drawing — it is one
  // that was placed and never typed into (the editor removes it as soon as
  // you move on). Left out, along with any arrow to it, so neither a save nor
  // an undo snapshot taken in the meantime ever holds it.
  const blank = new Set(
    nodes
      .filter(
        (node) =>
          node.data.shape === "text" &&
          !cleanBoxText(node.data.label) &&
          !cleanBoxText(node.data.detail),
      )
      .map((node) => node.id),
  )

  // Switchboard: what a teleport may still go to — a node that is part of the drawing.
  const kept = new Set(nodes.filter((node) => !blank.has(node.id)).map((node) => node.id))

  const specNodes: FlowNodeSpec[] = nodes.filter((node) => !blank.has(node.id)).map((node) => {
    const { label, detail, labelRichText, detailRichText, shape, tone, dashed, textSize, align, bold, italic, src, documentId, size, ai, answeredIn, detached, workspace, font, minimized, teleportTo, videoId, videoSrc, videoStart, file, timer, widget } =
      node.data
    // Switchboard: a pinned terminal is labelled with its workspace, as the
    // validator labels it — a teleport "Teleport", a video with no title
    // "YouTube video", and a PDF or a spreadsheet with no name "PDF" or "Spreadsheet".
    const terminal = shape === "terminal" ? (workspace ?? label) : undefined
    const cleanLabel =
      terminal ??
      (shape === "teleport" ? TELEPORT_LABEL : undefined) ??
      cleanBoxText(label) ??
      (shape === "note"
        ? ""
        : shape === "video"
        ? VIDEO_LABEL
        : shape === "pdf"
        ? PDF_LABEL
        : shape === "sheet"
        ? SHEET_LABEL
        : shape === "timer"
        ? "Timer"
        // Switchboard: and a widget with no name of its own says its id.
        : shape === "widget"
        ? (widget ?? WIDGET_LABEL)
        : UNTITLED_FLOW_LABEL)
    const cleanDetail = cleanBoxText(detail)
    return {
      id: node.id,
      // An empty sticky note is a thing in its own right; an empty box reads
      // as one still to be named.
      label: cleanLabel,
      detail: cleanDetail,
      labelRichText: parseFlowRichText(labelRichText, cleanLabel),
      detailRichText: parseFlowRichText(detailRichText, cleanDetail ?? ""),
      // Defaults are left out, so a box saved from the canvas reads like one
      // Claude wrote rather than restating every default.
      shape: shape === DEFAULT_FLOW_SHAPE ? undefined : shape,
      tone: tone === DEFAULT_FLOW_TONE ? undefined : tone,
      dashed: dashed === true ? true : undefined,
      textSize: textSize === DEFAULT_FLOW_TEXT_SIZE ? undefined : textSize,
      align: align === DEFAULT_FLOW_TEXT_ALIGN ? undefined : align,
      bold: bold === true ? true : undefined,
      italic: italic === true ? true : undefined,
      ai: ai === true ? true : undefined,
      // Switchboard: the workspace an answer read, while its words are still the AI's.
      answeredIn: ai === true && answeredIn ? answeredIn : undefined,
      detached: detached === true ? true : undefined,
      position: { x: pixel(node.position.x), y: pixel(node.position.y) },
      // Switchboard: and a PDF's picture of its first page, when it has one.
      src: shape === "image" || (shape === "pdf" && src) ? src : undefined,
      documentId: shape === "document" ? documentId : undefined,
      size:
        isFlowSizedShape(shape) && size
          ? { width: pixel(size.width), height: pixel(size.height) }
          : undefined,
      // Switchboard: a pinned terminal's workspace, type size and folded state.
      workspace: terminal,
      font: terminal !== undefined && typeof font === "number" ? Math.round(font * 1000) / 1000 : undefined,
      minimized: terminal !== undefined && minimized === true ? true : undefined,
      // Switchboard: a teleport's destination, while it is still on the board.
      teleportTo:
        shape === "teleport" && teleportTo && teleportTo !== node.id && kept.has(teleportTo)
          ? teleportTo
          : undefined,
      // Switchboard: the video a video plays, and where it starts.
      videoId: shape === "video" && !videoSrc ? videoId : undefined,
      videoSrc: shape === "video" ? videoSrc : undefined,
      videoStart:
        shape === "video" && !videoSrc && videoStart !== undefined && Number.isInteger(videoStart) && videoStart > 0
          ? videoStart
          : undefined,
      // Switchboard: the file a PDF or a spreadsheet shows.
      file: shape === "pdf" || shape === "sheet" ? file : undefined,
      timer: shape === "timer" ? { ...(timer ?? createFlowTimer()) } : undefined,
      // Switchboard: the widget a widget draws.
      widget: shape === "widget" ? widget : undefined,
    }
  })

  const specEdges: FlowEdgeSpec[] = edges
    .filter((edge) => !blank.has(edge.source) && !blank.has(edge.target))
    .map((edge) => ({
    from: edge.source,
    to: edge.target,
    label: clean(edge.data?.label),
    dashed: edge.data?.dashed === true ? true : undefined,
    collapsed: edge.data?.collapsed === true ? true : undefined,
    fromSide: isSide(edge.sourceHandle) ? edge.sourceHandle : sides.from,
    toSide: isSide(edge.targetHandle) ? edge.targetHandle : sides.to,
  }))

  return {
    kind: "flow",
    title: meta.title,
    summary: meta.summary,
    direction: meta.direction,
    nodes: specNodes,
    edges: specEdges,
  }
}

/**
 * An id for a new box: its label as a slug ("Send invoice" → "send-invoice"),
 * numbered past any id already taken. Ids are compared case-insensitively,
 * because that is how the validator compares them.
 */
export function nextFlowNodeId(taken: Iterable<string>, label: string): string {
  const used = new Set([...taken].map((id) => id.toLowerCase()))
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "node"
  if (!used.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

// ─── Switchboard: a pinned terminal's type size ───

/** One press of a pinned terminal's Smaller text or Larger text: a tenth, at any zoom. */
export const TERMINAL_FONT_STEP = 1.1
/** The least grid Larger text leaves a pinned terminal's body room for. */
export const TERMINAL_FONT_MIN_GRID = { cols: 20, rows: 4 }
// A cell of the terminal's monospace type, in ems: SF Mono and Menlo advance 0.6 of
// the size, and the Terminal tab sets a line height of 1.4.
const TERMINAL_CELL_EMS = { width: 0.6, height: 1.4 }

/**
 * Switchboard: a pinned terminal's `font` one step smaller (-1) or larger (1), in
 * canvas units, or null when it can go no further. Its box stays the size it is, so
 * the host fits more (or fewer) rows and columns into it. Smaller stops where the
 * type would be drawn under TERMINAL_MIN_FONT at this zoom — the node would only say
 * "Zoom in to use" — and Larger where the body would no longer hold
 * TERMINAL_FONT_MIN_GRID, a little short of any font's exact cells.
 */
export function stepTerminalFont(
  font: number | undefined,
  zoom: number,
  direction: -1 | 1,
  size: FlowSize = FLOW_TERMINAL_DEFAULT_SIZE,
): number | null {
  const now = font ?? TERMINAL_BASE_FONT
  if (!(zoom > 0) || !(now > 0)) return null
  if (direction < 0) {
    const floor = Math.max(TERMINAL_FONT_MIN, Math.ceil((TERMINAL_MIN_FONT / zoom) * 1000) / 1000)
    const next = Math.max(Math.round((now / TERMINAL_FONT_STEP) * 1000) / 1000, floor)
    return next < now - 0.001 ? next : null
  }
  const room = Math.min(
    size.width / (TERMINAL_FONT_MIN_GRID.cols * TERMINAL_CELL_EMS.width),
    (size.height - TERMINAL_HEADER) / (TERMINAL_FONT_MIN_GRID.rows * TERMINAL_CELL_EMS.height),
  )
  const ceiling = Math.min(TERMINAL_FONT_MAX, Math.floor(room * 1000) / 1000)
  const next = Math.min(Math.round(now * TERMINAL_FONT_STEP * 1000) / 1000, ceiling)
  return next > now + 0.001 ? next : null
}

// ─── Tab: add the next box ───

/** A box's footprint on the canvas, in canvas pixels. */
export type FlowRect = { x: number; y: number; width: number; height: number }

/** Between a box and the one Tab adds to its right: room for a readable arrow. */
export const FLOW_TAB_GAP_X = 80
/** Between boxes Tab stacks under one another. */
export const FLOW_TAB_GAP_Y = 30
/**
 * Switchboard: between a box and one hanging off its bottom — the same room for an
 * arrow as FLOW_TAB_GAP_X leaves to the right.
 */
export const FLOW_TAB_GAP_DOWN = 80
/** Switchboard: between boxes spread side by side under the one they hang off. */
export const FLOW_TAB_GAP_ACROSS = 40
/** How close two boxes may come before one counts as landing on the other. */
const FLOW_CLEARANCE = 10

/**
 * Switchboard: which way a branch runs. "right" is Tab's — a box hangs off another's
 * right side, by an arrow from that side into its left, and its siblings stack under
 * one another. "down" is the other way an arrow is drawn in a flowchart — out of a
 * box's bottom into the top of one below — and those siblings spread side by side.
 * The user asked for the branches that go down to be laid out as the ones going right
 * are (2026-11-01): "we need auto-formatting there as well".
 */
export type FlowBranchDirection = "right" | "down"

/** The handles an arrow joining a box into a branch uses, by the branch's direction. */
export function branchHandles(direction: FlowBranchDirection): { sourceHandle: FlowSide; targetHandle: FlowSide } {
  return direction === "right"
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "bottom", targetHandle: "top" }
}

/**
 * Switchboard: the way `edge` joins `to` into a branch under `from` — right side to left
 * side onto a box further right, or bottom to top onto a box further down — or null
 * when it is no such arrow (a loop back, a side arrow, one drawn the other way round).
 */
export function branchDirection(
  edge: Pick<FlowTreeEdge, "sourceHandle" | "targetHandle">,
  from: FlowRect,
  to: FlowRect,
): FlowBranchDirection | null {
  if (edge.sourceHandle === "right" && edge.targetHandle === "left") return to.x > from.x ? "right" : null
  if (edge.sourceHandle === "bottom" && edge.targetHandle === "top") return to.y > from.y ? "down" : null
  return null
}

function overlaps(a: FlowRect, b: FlowRect): boolean {
  return (
    a.x < b.x + b.width + FLOW_CLEARANCE &&
    b.x < a.x + a.width + FLOW_CLEARANCE &&
    a.y < b.y + b.height + FLOW_CLEARANCE &&
    b.y < a.y + a.height + FLOW_CLEARANCE
  )
}

/**
 * Moves `rect` straight down until it lands on nothing in `boxes`. Each step
 * puts it under the box it hit, so it never meets that box again and the walk
 * ends within one step per box.
 */
export function clearOfBoxes(rect: FlowRect, boxes: FlowRect[]): { x: number; y: number } {
  let y = rect.y
  for (let step = 0; step <= boxes.length; step += 1) {
    const hit = boxes.find((box) => overlaps({ ...rect, y }, box))
    if (!hit) break
    y = hit.y + hit.height + FLOW_TAB_GAP_Y
  }
  return { x: rect.x, y }
}

/**
 * Where Tab puts a new box hanging off `parent`'s right side, the way
 * Whimsical does: the first one level with the parent, each one after under
 * the lowest of the parent's existing right-hand children — then down past
 * anything else it would land on.
 * Switchboard: or, for a branch going down, under the parent — the first one centred
 * on it, each one after to the right of the right-most box already hanging there.
 */
export function nextChildPosition(
  parent: FlowRect,
  children: FlowRect[],
  boxes: FlowRect[],
  size: { width: number; height: number },
  direction: FlowBranchDirection = "right",
): { x: number; y: number } {
  if (direction === "down") {
    const rightmost = children.reduce<FlowRect | null>(
      (far, child) => (far === null || child.x + child.width > far.x + far.width ? child : far),
      null,
    )
    const start =
      rightmost === null
        ? {
            x: Math.round(parent.x + (parent.width - size.width) / 2),
            y: parent.y + parent.height + FLOW_TAB_GAP_DOWN,
          }
        : { x: rightmost.x + rightmost.width + FLOW_TAB_GAP_ACROSS, y: rightmost.y }
    return clearOfBoxes({ ...start, ...size }, boxes)
  }
  const lowest = children.reduce<FlowRect | null>(
    (low, child) =>
      low === null || child.y + child.height > low.y + low.height ? child : low,
    null,
  )
  const start =
    lowest === null
      ? {
          x: parent.x + parent.width + FLOW_TAB_GAP_X,
          // Centred on the parent, so the arrow between them runs straight.
          y: Math.round(parent.y + (parent.height - size.height) / 2),
        }
      : { x: lowest.x, y: lowest.y + lowest.height + FLOW_TAB_GAP_Y }
  return clearOfBoxes({ ...start, ...size }, boxes)
}

/**
 * A box on the canvas, by id. Switchboard: `detached` is a box someone detached
 * from its branch (FlowNodeSpec.detached) — none of its arrows make a tree.
 */
export type FlowTreeBox = FlowRect & { id: string; detached?: boolean; shape?: FlowShape }

export type FlowTreeEdge = Pick<
  FlowCanvasEdge,
  "source" | "target" | "sourceHandle" | "targetHandle"
>

type FlowPoint = { x: number; y: number }

/**
 * Switchboard: what a box pushed out of a tree's way keeps from it — twice the
 * gap between the boxes Tab stacks, so it never reads as one of them.
 */
export const FLOW_ROOM_GAP = FLOW_TAB_GAP_Y * 2

// The trees Tab builds. A box hangs off another when the one arrow into it of
// the kind Tab draws — right side to left side, from a box further left — comes
// from that box. A box two branches merge into, or a loop back to an earlier
// box, hangs off nothing and is the top of a tree of its own. Switchboard: a
// detached box is in no tree — its arrows, in and out, count for nothing here —
// so it moves on its own, and what hung off it tops a tree of its own.
// Switchboard: and a box hangs off another the other way too — by an arrow out of
// that box's bottom into its top, from a box further up (branchDirection) — and
// `directionOf` says which way each box hangs. A box's children may hang both ways
// at once: the ones to its right stack under one another, the ones below it spread
// side by side (layoutTree).
type FlowTrees = {
  parentOf: Map<string, string>
  childrenOf: Map<string, string[]>
  directionOf: Map<string, FlowBranchDirection>
}

/** The boxes hanging off `id` one way, in their order. */
function childrenToward(trees: FlowTrees, id: string, direction: FlowBranchDirection): string[] {
  return (trees.childrenOf.get(id) ?? []).filter((child) => trees.directionOf.get(child) === direction)
}

function flowTrees(
  byId: Map<string, FlowTreeBox>,
  edges: FlowTreeEdge[],
  // New boxes, whose y means nothing yet: they go after their siblings, in
  // this order.
  fresh: string[] = [],
  // Folding keeps pictures where they were placed. Their children can still
  // form a branch, but an incoming arrow cannot make the picture a child of a
  // tree that will be rearranged around a different box.
  pinned: ReadonlySet<string> = new Set(),
): FlowTrees {
  const sources = new Map<string, Map<string, FlowBranchDirection>>()
  for (const edge of edges) {
    const from = byId.get(edge.source)
    const to = byId.get(edge.target)
    // Switchboard: nor is a pinned terminal ever one of a branch's boxes — it stays
    // where it was put, whatever is laid out around it.
    if (!from || !to || from.detached || to.detached || pinned.has(to.id) || to.shape === "terminal") continue
    const direction = branchDirection(edge, from, to)
    if (direction === null) continue
    const into = sources.get(to.id) ?? new Map<string, FlowBranchDirection>()
    into.set(from.id, direction)
    sources.set(to.id, into)
  }
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  const directionOf = new Map<string, FlowBranchDirection>()
  for (const [id, from] of sources) {
    if (from.size !== 1) continue
    const [[source, direction]] = from
    parentOf.set(id, source)
    directionOf.set(id, direction)
    childrenOf.set(source, [...(childrenOf.get(source) ?? []), id])
  }
  // Switchboard: a step up a tree moves strictly left or strictly up, but with both
  // ways allowed three boxes can still close a loop (right, then down, then back left
  // to a box above the first). No box may hang off something that hangs off it: the
  // box that would close the loop tops a tree of its own instead.
  const settled = new Set<string>()
  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let at: string | undefined = start
    while (at !== undefined && !settled.has(at)) {
      if (onPath.has(at)) {
        const closing = path[path.length - 1]
        parentOf.delete(closing)
        directionOf.delete(closing)
        childrenOf.set(at, (childrenOf.get(at) ?? []).filter((child) => child !== closing))
        break
      }
      onPath.add(at)
      path.push(at)
      at = parentOf.get(at)
    }
    for (const id of path) settled.add(id)
  }
  // Top to bottom as they stand, so tidying never reorders a branch — and a box
  // dragged in among its siblings takes the place it was dropped in. By their
  // middles (Switchboard), so a box dropped half over another goes before it or
  // after it as it looks; boxes stacked apart sort the same either way.
  // Switchboard: the boxes hanging below sort left to right the same way, after the
  // ones hanging to the right (childrenToward tells them apart).
  const late = new Map(fresh.map((id, index) => [id, index]))
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const lateA = late.get(a)
      const lateB = late.get(b)
      if (lateA !== undefined || lateB !== undefined) {
        return (lateA ?? -1) - (lateB ?? -1)
      }
      const directionA = directionOf.get(a)
      const directionB = directionOf.get(b)
      if (directionA !== directionB) return directionA === "right" ? -1 : 1
      const boxA = byId.get(a)!
      const boxB = byId.get(b)!
      if (directionA === "down") {
        return (
          boxA.x + boxA.width / 2 - (boxB.x + boxB.width / 2) || boxA.y - boxB.y || a.localeCompare(b)
        )
      }
      return (
        boxA.y + boxA.height / 2 - (boxB.y + boxB.height / 2) || boxA.x - boxB.x || a.localeCompare(b)
      )
    })
  }
  return { parentOf, childrenOf, directionOf }
}

/**
 * The top of the tree `id` is in: every step up moves strictly left or strictly up, and
 * flowTrees cut any loop the two together could close, so it ends.
 */
function topOf(trees: FlowTrees, id: string): string {
  let top = id
  for (let up = trees.parentOf.get(top); up !== undefined && up !== id; up = trees.parentOf.get(top)) {
    top = up
  }
  return top
}

/**
 * Switchboard: which way Tab adds the next box to `parentId` — down, when everything
 * already hanging off it hangs below it; otherwise right, as Tab has always added one.
 * So a branch someone started downwards by hand goes on downwards.
 */
export function flowTabDirection(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
): FlowBranchDirection {
  const trees = flowTrees(new Map(boxes.map((box) => [box.id, box])), edges)
  return childrenToward(trees, parentId, "down").length > 0 && childrenToward(trees, parentId, "right").length === 0
    ? "down"
    : "right"
}

/**
 * The tree under `topId` laid out the way Tab lays it out: every box level
 * with the midpoint of the first and last boxes hanging off it, those boxes
 * stacked FLOW_TAB_GAP_Y apart, and a box's whole branch moving with it. The
 * top box stays where it is and nothing moves sideways.
 * Switchboard: and the boxes hanging below a box spread side by side under it,
 * FLOW_TAB_GAP_ACROSS apart and centred on it, each keeping the height it is at —
 * so for them nothing moves up or down. Either way a box's whole branch, both the
 * boxes to its right and the ones below it, is one block, and the blocks of
 * neighbouring siblings never overlap: a sibling with boxes hanging below it is
 * that much taller, and the next one stacks under all of it.
 */
function layoutTree(
  at: Map<string, FlowTreeBox>,
  trees: FlowTrees,
  topId: string,
): Map<string, FlowTreeBox> {
  // Each box's branch as a block: how far it reaches left and right of, above and
  // below, the box's centre, and where every box in it sits relative to that centre.
  type Block = {
    left: number
    right: number
    above: number
    below: number
    centres: Map<string, FlowPoint>
  }
  function branch(id: string): Block {
    const box = at.get(id)!
    const centres = new Map([[id, { x: 0, y: 0 }]])
    let left = box.width / 2
    let right = box.width / 2
    let above = box.height / 2
    let below = box.height / 2
    // A child's block, placed with its centre `dx` across and `dy` down from this box's.
    const place = (block: Block, dx: number, dy: number) => {
      for (const [member, centre] of block.centres) centres.set(member, { x: centre.x + dx, y: centre.y + dy })
      left = Math.max(left, block.left - dx)
      right = Math.max(right, block.right + dx)
      above = Math.max(above, block.above - dy)
      below = Math.max(below, block.below + dy)
    }
    // The box this one hangs off, where it stands: a column of boxes hanging off this
    // box's right must not reach up into a parent above it, nor a row hanging under
    // it reach back into a parent to its left — the one place the two directions can
    // meet. The column (or row) is then let down (or along) just far enough.
    const parentId = trees.parentOf.get(id)
    const parent = parentId !== undefined ? at.get(parentId) : undefined
    const rights = childrenToward(trees, id, "right")
    if (rights.length > 0) {
      const blocks = rights.map(branch)
      // Stacked from 0 down, FLOW_TAB_GAP_Y between neighbouring blocks…
      const stacked: number[] = []
      let cursor = 0
      for (const block of blocks) {
        stacked.push(cursor + block.above)
        cursor += block.above + block.below + FLOW_TAB_GAP_Y
      }
      // …then shifted so this box is level with the first and last of them. Each
      // keeps the x it is at.
      let shift = (stacked[0] + stacked[stacked.length - 1]) / 2
      const offsets = rights.map((child) => {
        const kept = at.get(child)!
        return kept.x + kept.width / 2 - (box.x + box.width / 2)
      })
      if (parent && trees.directionOf.get(id) === "down") {
        const columnLeft = Math.min(...blocks.map((block, index) => box.x + box.width / 2 + offsets[index] - block.left))
        const columnRight = Math.max(...blocks.map((block, index) => box.x + box.width / 2 + offsets[index] + block.right))
        if (columnLeft < parent.x + parent.width + FLOW_CLEARANCE && parent.x < columnRight + FLOW_CLEARANCE) {
          shift = Math.min(shift, box.y + box.height / 2 - (parent.y + parent.height + FLOW_CLEARANCE))
        }
      }
      blocks.forEach((block, index) => place(block, offsets[index], stacked[index] - shift))
    }
    const downs = childrenToward(trees, id, "down")
    if (downs.length > 0) {
      const blocks = downs.map(branch)
      // Spread from 0 rightwards, FLOW_TAB_GAP_ACROSS between neighbouring blocks…
      const spread: number[] = []
      let cursor = 0
      for (const block of blocks) {
        spread.push(cursor + block.left)
        cursor += block.left + block.right + FLOW_TAB_GAP_ACROSS
      }
      // …then shifted so this box is centred on the first and last of them. Each
      // keeps the y it is at.
      let shift = (spread[0] + spread[spread.length - 1]) / 2
      const offsets = downs.map((child) => {
        const kept = at.get(child)!
        return kept.y + kept.height / 2 - (box.y + box.height / 2)
      })
      if (parent && trees.directionOf.get(id) === "right") {
        const rowTop = Math.min(...blocks.map((block, index) => box.y + box.height / 2 + offsets[index] - block.above))
        const rowBottom = Math.max(...blocks.map((block, index) => box.y + box.height / 2 + offsets[index] + block.below))
        if (rowTop < parent.y + parent.height + FLOW_CLEARANCE && parent.y < rowBottom + FLOW_CLEARANCE) {
          shift = Math.min(shift, box.x + box.width / 2 - (parent.x + parent.width + FLOW_CLEARANCE))
        }
      }
      blocks.forEach((block, index) => place(block, spread[index] - shift, offsets[index]))
    }
    return { left, right, above, below, centres }
  }

  const top = at.get(topId)!
  const centre = { x: top.x + top.width / 2, y: top.y + top.height / 2 }
  const placed = new Map<string, FlowTreeBox>()
  for (const [id, offset] of branch(topId).centres) {
    const box = at.get(id)!
    placed.set(id, {
      ...box,
      x: Math.round(centre.x + offset.x - box.width / 2),
      y: Math.round(centre.y + offset.y - box.height / 2),
    })
  }
  return placed
}

/**
 * Switchboard: the axis a tidied tree moved its boxes along — y for the branches
 * going right (whose boxes stack up and down), x for the ones going down (whose
 * boxes spread side by side) — and so the axis along which it can newly crowd a box
 * outside it, and along which that box is pushed away. A tree with no branches at
 * all is taken as Tab's kind.
 */
type FlowAxis = "x" | "y"

function treeAxes(trees: FlowTrees, tree: Iterable<string>): FlowAxis[] {
  const axes = new Set<FlowAxis>()
  for (const id of tree) {
    const direction = trees.directionOf.get(id)
    if (direction === "right") axes.add("y")
    else if (direction === "down") axes.add("x")
  }
  return axes.size === 0 ? ["y"] : [...axes]
}

/**
 * Whether two boxes share any of the canvas's width (axis y) — one could land on the
 * other going up or down — or of its height (axis x), going left or right.
 */
function sameLane(a: FlowRect, b: FlowRect, axis: FlowAxis): boolean {
  return axis === "y"
    ? a.x < b.x + b.width + FLOW_CLEARANCE && b.x < a.x + a.width + FLOW_CLEARANCE
    : a.y < b.y + b.height + FLOW_CLEARANCE && b.y < a.y + a.height + FLOW_CLEARANCE
}

/** The room between two boxes along `axis` — less than 0 when they overlap that way. */
function laneGap(a: FlowRect, b: FlowRect, axis: FlowAxis): number {
  return axis === "y"
    ? Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
    : Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
}

/** A box's start and extent along `axis`. */
function along(box: FlowRect, axis: FlowAxis): { start: number; size: number } {
  return axis === "y" ? { start: box.y, size: box.height } : { start: box.x, size: box.width }
}

/**
 * Switchboard: pushes whatever a freshly laid-out tree would now crowd up or
 * down out of its way, rather than giving up on the layout. `at` holds every
 * box where it now is (the tree already laid out) and is moved in place;
 * `was` is where they were before the change, and a box missing from it is
 * new.
 *
 * Crowding is coming within FLOW_ROOM_GAP of a box in the same column, and
 * closer than the two were before — so an arrangement someone made by hand,
 * boxes already close or overlapping, doesn't count against the tree. What is
 * crowded moves with every box its arrows hold it to, away from the box that
 * crowded it, until it is FLOW_ROOM_GAP clear of everything already settled —
 * and anything that lands on in turn moves on the same way.
 *
 * Switchboard: along `axes` — up and down for a tree whose branches go right, left
 * and right for one whose branches go down, both for a tree with both (treeAxes).
 */
function makeRoom(
  at: Map<string, FlowTreeBox>,
  was: Map<string, FlowRect>,
  tree: Set<string>,
  edges: FlowTreeEdge[],
  pinned: ReadonlySet<string> = new Set(),
  axes: FlowAxis[] = ["y"],
): void {
  // The room a pair must keep: FLOW_ROOM_GAP, or what they had before when
  // that was less.
  const needed = (a: string, b: string, axis: FlowAxis) => {
    const before = [was.get(a), was.get(b)]
    return before[0] && before[1] && sameLane(before[0], before[1], axis)
      ? Math.min(FLOW_ROOM_GAP, laneGap(before[0], before[1], axis))
      : FLOW_ROOM_GAP
  }

  // Everything outside the tree, in the pieces its arrows hold together.
  const outside = [...at.keys()].filter((id) => !tree.has(id))
  const root = new Map(outside.map((id) => [id, id]))
  const find = (id: string): string => {
    let r = id
    while (root.get(r) !== r) r = root.get(r)!
    root.set(id, r)
    return r
  }
  // Switchboard: an arrow to or from a pinned terminal holds nothing to it. The
  // terminal alone stays where it was put, and a box wired to it is pushed out of
  // the tree's way like any other (and clear of the terminal, which is settled).
  const terminal = (id: string) => at.get(id)?.shape === "terminal"
  for (const edge of edges) {
    if (terminal(edge.source) || terminal(edge.target)) continue
    if (root.has(edge.source) && root.has(edge.target)) {
      root.set(find(edge.source), find(edge.target))
    }
  }
  const pieces = new Map<string, string[]>()
  for (const id of outside) {
    const r = find(id)
    pieces.set(r, [...(pieces.get(r) ?? []), id])
  }

  // Images are placed by hand. Keep their connected pieces in place, and let
  // other pieces make room around them instead of being pushed on top of one.
  const pinnedPieces = [...pieces.values()].filter((piece) => piece.some((id) => pinned.has(id)))
  const settled = new Set([...tree, ...pinnedPieces.flat()])
  const waiting = new Set([...pieces.values()].filter((piece) => !piece.some((id) => pinned.has(id))))
  // Each pass moves one piece and settles it, so this ends.
  while (waiting.size > 0) {
    let crowded: { piece: string[]; box: FlowRect; by: FlowRect; axis: FlowAxis } | null = null
    search: for (const piece of waiting) {
      for (const id of piece) {
        const box = at.get(id)!
        for (const other of settled) {
          const by = at.get(other)!
          for (const axis of axes) {
            if (sameLane(box, by, axis) && laneGap(box, by, axis) < needed(id, other, axis)) {
              crowded = { piece, box, by, axis }
              break search
            }
          }
        }
      }
    }
    if (crowded === null) return
    waiting.delete(crowded.piece)

    // Away from the box that crowded it: down (or right) if it sits further that
    // way, up (or left) if not.
    const { axis } = crowded
    const mine = along(crowded.box, axis)
    const theirs = along(crowded.by, axis)
    const forward = mine.start + mine.size / 2 >= theirs.start + theirs.size / 2
    // Every shift that would leave a pair too close, as an open range…
    const ranges: [number, number][] = []
    for (const id of crowded.piece) {
      const box = at.get(id)!
      for (const other of settled) {
        const by = at.get(other)!
        if (!sameLane(box, by, axis)) continue
        const room = needed(id, other, axis)
        const a = along(box, axis)
        const b = along(by, axis)
        ranges.push([b.start - a.start - a.size - room, b.start + b.size + room - a.start])
      }
    }
    // …and the smallest one way that is in none of them. The furthest end of
    // them all always is, so there is one.
    const ends = forward
      ? ranges.map(([, high]) => Math.ceil(high)).filter((end) => end >= 0).sort((a, b) => a - b)
      : ranges.map(([low]) => Math.floor(low)).filter((end) => end <= 0).sort((a, b) => b - a)
    const shift =
      ends.find((end) => ranges.every(([low, high]) => end <= low || end >= high)) ?? 0
    for (const id of crowded.piece) {
      const box = at.get(id)!
      at.set(id, axis === "y" ? { ...box, y: box.y + shift } : { ...box, x: box.x + shift })
      settled.add(id)
    }
  }
}

/**
 * Switchboard: moves the boxes of a freshly laid-out tree down past any pinned
 * terminal they would land on. A terminal never moves, and the live terminal the
 * host lays over it hides whatever is under it, so a box laid out there would be
 * out of sight and out of reach — and makeRoom never moves the tree itself.
 * Going down the tree in order (top, then each branch in turn), the first box
 * that lands on a terminal moves down past it, as Tab's clearOfBoxes does, and
 * takes with it its own branch and every box laid out after it, so the tree
 * below that point keeps its order and spacing. The top of the tree never moves.
 * Boxes only ever move down, so each box passes each terminal at most once.
 */
function clearOfTerminals(
  at: Map<string, FlowTreeBox>,
  trees: FlowTrees,
  topId: string,
  terminals: FlowTreeBox[],
): void {
  if (terminals.length === 0) return
  const order: string[] = []
  const walk = (id: string) => {
    order.push(id)
    for (const child of trees.childrenOf.get(id) ?? []) walk(child)
  }
  walk(topId)
  for (let pass = 0; pass <= order.length * terminals.length; pass += 1) {
    let hit: { index: number; under: FlowTreeBox } | null = null
    search: for (let index = 1; index < order.length; index += 1) {
      const box = at.get(order[index])!
      for (const under of terminals) {
        if (under.id !== box.id && overlaps(box, under)) {
          hit = { index, under }
          break search
        }
      }
    }
    if (hit === null) return
    const first = at.get(order[hit.index])!
    const shift = hit.under.y + hit.under.height + FLOW_TAB_GAP_Y - first.y
    for (const id of order.slice(hit.index)) {
      const box = at.get(id)!
      at.set(id, { ...box, y: box.y + shift })
    }
  }
}

/**
 * Lays out again the tree each of `anchors` is in, the way Tab lays one out,
 * and makes room for it — see layoutTree and makeRoom. `boxes` and `edges`
 * are the canvas as it now is, any new boxes (`fresh`) included at their x;
 * `was` is where the boxes were before the change. Returns where every box
 * ends up.
 */
function tidyTrees(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  anchors: string[],
  fresh: string[],
  was: Map<string, FlowRect>,
  pinned: ReadonlySet<string> = new Set(),
): Map<string, FlowTreeBox> {
  const at = new Map(boxes.map((box) => [box.id, box]))
  // Switchboard: a pinned terminal is pinned in every tidy, as images are while a
  // branch folds — what would crowd it moves instead.
  const terminals = boxes.filter((box) => box.shape === "terminal")
  if (terminals.length > 0) pinned = new Set([...pinned, ...terminals.map((box) => box.id)])
  const trees = flowTrees(at, edges, fresh, pinned)
  const tops = new Set(anchors.filter((id) => at.has(id)).map((id) => topOf(trees, id)))
  for (const top of tops) {
    const placed = layoutTree(at, trees, top)
    for (const [id, box] of placed) at.set(id, box)
    // Switchboard: never onto a pinned terminal (where it is now, as it never moves).
    clearOfTerminals(at, trees, top, terminals.map((box) => at.get(box.id) ?? box))
    makeRoom(at, was, new Set(placed.keys()), edges, pinned, treeAxes(trees, placed.keys()))
  }
  return at
}

/** The boxes `after` puts somewhere other than where `boxes` has them. */
function movesFrom(
  boxes: FlowTreeBox[],
  after: Map<string, FlowTreeBox>,
  skip: Set<string> = new Set(),
): Map<string, FlowPoint> {
  const moved = new Map<string, FlowPoint>()
  for (const box of boxes) {
    const to = after.get(box.id)
    if (to && !skip.has(box.id) && (to.x !== box.x || to.y !== box.y)) {
      moved.set(box.id, { x: to.x, y: to.y })
    }
  }
  return moved
}

/**
 * Where Tab puts a new box hanging off `parentId`'s right side, and where the
 * boxes around it move so the branching stays symmetrical: every box sits
 * level with the midpoint of the first and last boxes hanging off it, those
 * boxes stack FLOW_TAB_GAP_Y apart, and a box's whole branch moves with it.
 *
 * "Hanging off" means the arrows Tab draws — right side to left side, onto a
 * box further right — and only where that is the one such arrow into the box.
 * A box two branches merge into, or a loop back to an earlier box, stays put
 * and anchors whatever hangs off it. The tidying covers the one tree the
 * parent belongs to; its top box stays where it is and nothing moves sideways.
 *
 * Switchboard: whatever the tidied tree would land on is pushed up or down out
 * of its way (makeRoom), so the tree is always laid out — where the admin's
 * gives up on the tidying and stacks the new box under whatever it would hit.
 * Switchboard: or, `direction` "down", hanging off the parent's bottom — beside the
 * boxes already hanging there, the row spread out again around the parent.
 */
export function placeTabChild(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
  child: { id: string; width: number; height: number },
  direction: FlowBranchDirection = "right",
): { position: FlowPoint; moved: Map<string, FlowPoint> } {
  const { positions, moved } = placeTabChildren(boxes, edges, parentId, [child], direction)
  return { position: positions.get(child.id)!, moved }
}

/**
 * placeTabChild for several new boxes at once — an AI answer in parts — in
 * the order given, under the boxes already hanging off the parent, so the
 * branch ends up just as it would after a Tab for each. Returns where each new
 * box goes and where any existing box moves to.
 */
export function placeTabChildren(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
  children: { id: string; width: number; height: number }[],
  direction: FlowBranchDirection = "right",
): { positions: Map<string, FlowPoint>; moved: Map<string, FlowPoint> } {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const parent = byId.get(parentId)
  if (!parent) throw new Error(`No box "${parentId}"`)

  // In the column of the boxes already hanging off the parent — the lowest of
  // them, as Tab has always lined a new one up — or FLOW_TAB_GAP_X right of it.
  // Switchboard: going down, in the row of the boxes already hanging under it — the
  // right-most of them — or FLOW_TAB_GAP_DOWN under it.
  const siblings = childrenToward(flowTrees(byId, edges), parentId, direction)
  const last = siblings.length > 0 ? byId.get(siblings[siblings.length - 1]) : undefined
  const fresh =
    direction === "right"
      ? children.map((child) => ({ ...child, x: last ? last.x : parent.x + parent.width + FLOW_TAB_GAP_X, y: parent.y }))
      : children.map((child) => ({ ...child, x: parent.x, y: last ? last.y : parent.y + parent.height + FLOW_TAB_GAP_DOWN }))
  const wired = [
    ...edges,
    ...fresh.map((child) => ({
      source: parentId,
      target: child.id,
      ...branchHandles(direction),
    })),
  ]

  const ids = fresh.map((child) => child.id)
  const after = tidyTrees(
    [...boxes, ...fresh],
    wired,
    [parentId],
    ids,
    new Map(boxes.map((box) => [box.id, box])),
  )
  const positions = new Map<string, FlowPoint>()
  for (const id of ids) {
    const spot = after.get(id)!
    positions.set(id, { x: spot.x, y: spot.y })
  }
  return { positions, moved: movesFrom(boxes, after) }
}

/**
 * Switchboard: where the boxes that are left move once `deleted` go — each
 * tree a deleted box hung off laid out again the way Tab lays it out, so the
 * boxes around the gap close up and re-centre on the box they hang off, and
 * room made for the tree as placeTabChild makes it. A deleted box that was the
 * top of its tree leaves what hung off it where it is.
 *
 * `boxes` and `edges` are the canvas before the delete; `keptEdges` the
 * arrows that stay, when the delete takes arrows of its own as well.
 */
export function tidyAfterDelete(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  deleted: ReadonlySet<string>,
  keptEdges?: FlowTreeEdge[],
): Map<string, FlowPoint> {
  const before = flowTrees(new Map(boxes.map((box) => [box.id, box])), edges)
  // The nearest box each deleted one hung off that is staying.
  const anchors: string[] = []
  for (const id of deleted) {
    let up = before.parentOf.get(id)
    while (up !== undefined && deleted.has(up)) up = before.parentOf.get(up)
    if (up !== undefined) anchors.push(up)
  }
  if (anchors.length === 0) return new Map()

  const kept = boxes.filter((box) => !deleted.has(box.id))
  const arrows = (keptEdges ?? edges).filter(
    (edge) => !deleted.has(edge.source) && !deleted.has(edge.target),
  )
  const after = tidyTrees(kept, arrows, anchors, [], new Map(kept.map((box) => [box.id, box])))
  return movesFrom(kept, after)
}

/**
 * Switchboard: the tree each of `anchors` is in laid out again the way Tab lays it
 * out, with room made for it as placeTabChild makes it — what folding and unfolding
 * a branch do to the boxes left showing. `boxes` and `edges` are what is showing;
 * `revealed` are boxes that have just come back into view, whose last positions
 * (from before they were folded away) say nothing about what they may crowd.
 * Returns where every box that moves goes.
 */
export function tidyFlowTree(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  anchors: string[],
  revealed: Iterable<string> = [],
  { pinImages = false }: { pinImages?: boolean } = {},
): Map<string, FlowPoint> {
  const unknown = new Set(revealed)
  // A video is placed as deliberately as a picture is, and stays put as one does —
  // and so is a PDF, dropped where it was wanted with its cover showing.
  const pinned = pinImages
    ? new Set(
        boxes
          .filter((box) => box.shape === "image" || box.shape === "video" || box.shape === "pdf" || box.shape === "timer" || box.shape === "widget")
          .map((box) => box.id),
      )
    : new Set<string>()
  const after = tidyTrees(
    boxes,
    edges,
    anchors,
    [],
    new Map(boxes.filter((box) => !unknown.has(box.id)).map((box) => [box.id, box])),
    pinned,
  )
  return movesFrom(boxes, after)
}

/** Everything below `id` in `trees`, all the way down. */
function branchBelow(trees: FlowTrees, id: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    for (const child of trees.childrenOf.get(at) ?? []) {
      out.push(child)
      walk(child)
    }
  }
  walk(id)
  return out
}

/**
 * Switchboard: what moves with each of `ids` when it is dragged — everything that
 * hangs off it in the trees Tab builds, all the way down, unless it is one of `ids`
 * itself or under another of them (that one carries it). A detached box carries
 * nothing.
 */
export function flowBranches(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  ids: Iterable<string>,
): Map<string, string[]> {
  const trees = flowTrees(new Map(boxes.map((box) => [box.id, box])), edges)
  const picked = new Set(ids)
  const taken = new Set(picked)
  const out = new Map<string, string[]>()
  for (const id of picked) {
    // Only from the highest of the picked boxes in each tree: a picked box under
    // another one moves with that one.
    let under = false
    for (let up = trees.parentOf.get(id); up !== undefined; up = trees.parentOf.get(up)) {
      if (picked.has(up)) under = true
    }
    if (under) continue
    const carried = branchBelow(trees, id).filter((below) => !taken.has(below))
    for (const below of carried) taken.add(below)
    if (carried.length > 0) out.set(id, carried)
  }
  return out
}

/**
 * Switchboard: boxes dragged and let go, put where they belong in the branch Tab
 * built — what reordering a branch by hand takes. A box dropped between two of its
 * siblings goes between them, one dropped past the last goes last; it goes back
 * into its siblings' column (or, the only one there, where Tab would put it), the
 * branch hanging off it comes along, and the tree is laid out again the way Tab
 * lays it out, with room made for it as placeTabChild makes it. A box dragged to
 * the left of the box it hangs off has left that branch, which closes up behind it.
 *
 * A box in no tree — nothing hangs off it and it hangs off nothing — is left
 * wherever it was dropped, and so is everything else: a drag moves nothing then.
 *
 * `boxes` and `edges` are the canvas as it is, the dragged boxes where they were
 * dropped; `from` is where every box the drag moved was when it began — the ones
 * grabbed, and any the editor carried along with them (flowBranches). What hangs
 * off a grabbed box and was not carried comes along now. Returns where every box
 * that moves goes, the dragged ones included.
 */
export function tidyAfterMove(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  from: ReadonlyMap<string, FlowPoint>,
): Map<string, FlowPoint> {
  const now = new Map(boxes.map((box) => [box.id, box]))
  const moved = new Set(
    [...from]
      .filter(([id, at]) => {
        const box = now.get(id)
        return box !== undefined && (box.x !== at.x || box.y !== at.y)
      })
      .map(([id]) => id),
  )
  if (moved.size === 0) return new Map()

  // The canvas as it was before the drag, and the trees in it then.
  const was = new Map<string, FlowTreeBox>()
  for (const box of boxes) {
    const at = moved.has(box.id) ? from.get(box.id)! : box
    was.set(box.id, { ...box, x: at.x, y: at.y })
  }
  const before = flowTrees(was, edges)
  const inTree = (id: string) =>
    before.parentOf.has(id) || (before.childrenOf.get(id)?.length ?? 0) > 0
  // The boxes the drag took somewhere new: those that moved and whose parent
  // didn't — a box carried along with its parent keeps its place under it.
  const leaders = [...moved].filter((id) => {
    const up = before.parentOf.get(id)
    return inTree(id) && (up === undefined || !moved.has(up))
  })
  if (leaders.length === 0) return new Map()

  const work = new Map(boxes.map((box) => [box.id, { ...box }]))
  const depth = (id: string) => {
    let n = 0
    for (let up = before.parentOf.get(id); up !== undefined; up = before.parentOf.get(up)) n += 1
    return n
  }
  // Higher up a tree first, so a box goes back into a column its parent has
  // already settled in.
  leaders.sort((a, b) => depth(a) - depth(b))

  // What hangs off a grabbed box and was left behind comes along; the layout
  // settles it — up and down in a branch going right, side to side in one going down.
  for (const id of leaders) {
    const dx = now.get(id)!.x - from.get(id)!.x
    const dy = now.get(id)!.y - from.get(id)!.y
    if (dx === 0 && dy === 0) continue
    for (const below of branchBelow(before, id)) {
      if (!moved.has(below)) {
        work.get(below)!.x += dx
        work.get(below)!.y += dy
      }
    }
  }
  // Back into its column — its siblings' that stayed, or where Tab would put it —
  // with its whole branch. Switchboard: or, hanging below its parent, back into its
  // siblings' row; dragged above the box it hangs off, it has left that branch, as a
  // box dragged left of its parent has.
  for (const id of leaders) {
    const parentId = before.parentOf.get(id)
    if (parentId === undefined) continue
    const direction = before.directionOf.get(id) ?? "right"
    const parent = work.get(parentId)!
    const box = work.get(id)!
    const stayed = childrenToward(before, parentId, direction).find((sibling) => !moved.has(sibling))
    if (direction === "right") {
      if (box.x <= parent.x) continue
      const x = stayed !== undefined ? work.get(stayed)!.x : parent.x + parent.width + FLOW_TAB_GAP_X
      const dx = x - box.x
      box.x = x
      if (dx !== 0) for (const below of branchBelow(before, id)) work.get(below)!.x += dx
    } else {
      if (box.y <= parent.y) continue
      const y = stayed !== undefined ? work.get(stayed)!.y : parent.y + parent.height + FLOW_TAB_GAP_DOWN
      const dy = y - box.y
      box.y = y
      if (dy !== 0) for (const below of branchBelow(before, id)) work.get(below)!.y += dy
    }
  }

  const anchors = [...leaders, ...leaders.flatMap((id) => before.parentOf.get(id) ?? [])]
  const after = tidyTrees([...work.values()], edges, anchors, [], was)
  return movesFrom(boxes, after)
}

// Switchboard: nodes fold their outgoing branches by setting the existing edge
// flags; layout.ts foldFlow also serves the read-only canvas.
export { foldFlow, flowNodeFoldEdges, flowNodeFoldGroups, toggleFlowNodeFold, type FlowFoldEdge } from "./layout"

/**
 * Carry an already folded branch by the same distance as its visible source.
 * Folding can rearrange that source, but its hidden descendants do not take
 * part in the layout until they are opened again.
 */
export function carryFoldedPositions<NodeWithPosition extends { id: string; position: FlowPoint }>(
  before: NodeWithPosition[],
  after: NodeWithPosition[],
  edges: ReadonlyArray<FlowFoldEdge & { data?: unknown }>,
): NodeWithPosition[] {
  const collapsed = (edge: FlowFoldEdge & { data?: unknown }) =>
    edge.collapsed === true ||
    (typeof edge.data === "object" && edge.data !== null &&
      (edge.data as { collapsed?: unknown }).collapsed === true)
  if (!edges.some(collapsed)) return after
  const { hidden, folded } = foldFlow(
    after.map((node) => node.id),
    edges.map((edge) => ({ source: edge.source, target: edge.target, collapsed: collapsed(edge) })),
  )
  if (hidden.size === 0) return after
  const was = new Map(before.map((node) => [node.id, node.position]))
  const now = new Map(after.map((node) => [node.id, node.position]))
  const shift = new Map<string, FlowPoint>()
  for (const [index, boxes] of folded) {
    const source = edges[index].source
    const from = was.get(source)
    const to = now.get(source)
    if (hidden.has(source) || !from || !to || (from.x === to.x && from.y === to.y)) continue
    for (const id of boxes) {
      if (!shift.has(id)) shift.set(id, { x: to.x - from.x, y: to.y - from.y })
    }
  }
  if (shift.size === 0) return after
  return after.map((node) => {
    const by = shift.get(node.id)
    return by
      ? { ...node, position: { x: node.position.x + by.x, y: node.position.y + by.y } }
      : node
  })
}

/**
 * Keeps a hand-made arrangement across a republish. Claude writes flow specs
 * with no positions; when it rewrites a diagram someone has already arranged
 * in the editor, every box whose id survives keeps the position it was
 * dragged to, the size it was given and the styling the toolbar gave it, and
 * every edge between the same two boxes keeps its sides. Only what is
 * genuinely new is left for the layout to place.
 *
 * Anything `next` states itself wins — carrying over only fills gaps.
 */
export function carryOverFlowLayout(
  previous: FlowSpec,
  next: FlowSpec,
): { spec: FlowSpec; carried: number } {
  const before = new Map(previous.nodes.map((node) => [node.id.toLowerCase(), node]))
  const edgeKey = (from: string, to: string) =>
    `${from.toLowerCase()}\u0000${to.toLowerCase()}`
  const sides = new Map(
    previous.edges.map((edge) => [
      edgeKey(edge.from, edge.to),
      { fromSide: edge.fromSide, toSide: edge.toSide, collapsed: edge.collapsed },
    ]),
  )

  let carried = 0
  const nodes = next.nodes.map((node) => {
    const old = before.get(node.id.toLowerCase())
    if (!old) return node
    if (!node.position && old.position) carried += 1
    // The AI's mark survives only while the words are still the AI's — and with
    // it (Switchboard) the workspace that answer read.
    const aiWords = old.ai === true && old.label === node.label && old.detail === node.detail
    const ai = node.ai ?? (aiWords ? true : undefined)
    const terminal = node.shape === "terminal" && old.shape === "terminal"
    const teleport = node.shape === "teleport" && old.shape === "teleport"
    // A box's shape is left out when it is the default one.
    const shape = node.shape ?? DEFAULT_FLOW_SHAPE
    const oldShape = old.shape ?? DEFAULT_FLOW_SHAPE
    return {
      ...node,
      position: node.position ?? old.position,
      // Only onto the same shape it was given for: a size means something
      // different on each (a note's least height, a text's width alone, an
      // image's proportions). Switchboard: every box's means the same, so it
      // carries from one outline to another.
      size:
        node.size ??
        (isFlowSizedShape(shape) &&
        (shape === oldShape || (isFlowBoxShape(shape) && isFlowBoxShape(oldShape)))
          ? old.size
          : undefined),
      dashed: node.dashed ?? old.dashed,
      textSize: node.textSize ?? old.textSize,
      align: node.align ?? old.align,
      bold: node.bold ?? old.bold,
      italic: node.italic ?? old.italic,
      labelRichText: node.labelRichText ?? (node.label === old.label ? old.labelRichText : undefined),
      detailRichText: node.detailRichText ?? (node.detail === old.detail ? old.detailRichText : undefined),
      ai,
      answeredIn: node.answeredIn ?? (ai === true && aiWords ? old.answeredIn : undefined),
      detached: node.detached ?? old.detached,
      // Switchboard: a pinned terminal keeps its type size and whether it is folded.
      font: node.font ?? (terminal ? old.font : undefined),
      minimized: node.minimized ?? (terminal ? old.minimized : undefined),
      // Switchboard: a teleport keeps where it goes, while that node is still there.
      teleportTo:
        node.teleportTo ??
        (teleport && old.teleportTo && next.nodes.some((other) => other.id === old.teleportTo)
          ? old.teleportTo
          : undefined),
      // Switchboard: a video's start is not carried. Like its id, it is what the
      // video is, not how the board was arranged: a spec that leaves it out plays
      // from the beginning.
      // Switchboard: nor is a PDF's or a spreadsheet's file — but a PDF still showing
      // the same file keeps the picture of its cover. Only the app makes one, as the
      // file is dropped, so a spec that leaves it out has lost it, not taken it away.
      src:
        node.src ??
        (node.shape === "pdf" && old.shape === "pdf" && node.file === old.file ? old.src : undefined),
    }
  })
  const edges = next.edges.map((edge) => {
    const old = sides.get(edgeKey(edge.from, edge.to))
    if (!old) return edge
    return {
      ...edge,
      fromSide: edge.fromSide ?? old.fromSide,
      toSide: edge.toSide ?? old.toSide,
      // Switchboard: a branch folded away stays folded.
      collapsed: edge.collapsed ?? old.collapsed,
    }
  })

  return { spec: { ...next, nodes, edges }, carried }
}

// ─── Arrow keys: move the selection between boxes ───

export type FlowDirection = "left" | "right" | "up" | "down"

export const OPPOSITE_DIRECTION: Record<FlowDirection, FlowDirection> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
}

/**
 * The box an arrow key moves the selection to from `from`: the nearest one
 * that way, where being off to the side counts double — so Right from a box
 * with a column of boxes hanging off it lands on the one most level with it,
 * and Down from one of those lands on the next one down. A box further to the
 * side than twice its distance ahead isn't "that way" at all. Ties go to the
 * higher box, then the one further left.
 */
export function boxInDirection(
  from: FlowTreeBox,
  boxes: FlowTreeBox[],
  direction: FlowDirection,
): FlowTreeBox | null {
  const centre = (box: FlowRect) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  const start = centre(from)
  let best: { box: FlowTreeBox; score: number } | null = null
  for (const box of boxes) {
    if (box.id === from.id) continue
    const at = centre(box)
    const dx = at.x - start.x
    const dy = at.y - start.y
    const along =
      direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy
    const across = Math.abs(direction === "left" || direction === "right" ? dy : dx)
    if (along <= 0 || across > along * 2) continue
    const score = along + across * 2
    if (
      best === null ||
      score < best.score ||
      (score === best.score &&
        (box.y < best.box.y || (box.y === best.box.y && box.x < best.box.x)))
    ) {
      best = { box, score }
    }
  }
  return best?.box ?? null
}
