// The layout compiler: turns an authored DiagramSpec into React Flow nodes and
// edges with every coordinate already decided.
//
// A spec Claude writes has no coordinates in it — the boxes are ranked by the
// edges and laid out in rows (or columns) here, which is what lets Claude
// author a diagram it will never see rendered. A diagram someone arranged by
// hand in the editor carries a position (and, for notes, text and images, a
// size) on every node, and those are used as they are.
//
// PURE, and dependency-free apart from React Flow's *types* (erased at compile
// time), so it is unit tested in a plain node environment — see layout.test.ts.
// Everything it returns is plain data; the components in
// app/dashboard/diagrams/ only read it.

import type { Edge, Node } from "@xyflow/react"
import {
  DEFAULT_FLOW_SHAPE,
  DEFAULT_FLOW_TEXT_ALIGN,
  DEFAULT_FLOW_TEXT_SIZE,
  DEFAULT_FLOW_TONE,
  type DiagramSpec,
  type FlowNodeSpec,
  type FlowPosition,
  type FlowShape,
  type FlowSide,
  type FlowSize,
  type FlowSpec,
  type FlowTextAlign,
  type FlowTextSize,
  type FlowTone,
  type FlowRichText,
} from "./types"
import { FLOW_BULLET_INDENT, FLOW_CHECKLIST_INDENT, plainTextParagraphs, richTextVisualLines } from "./rich-text"

// ─────────────────────────────────────────────────────────────────────
// Geometry constants. All in canvas pixels at zoom 1. Exported so the tests
// can assert against the same numbers the compiler uses rather than copies.
// ─────────────────────────────────────────────────────────────────────

export const CANVAS_PAD_X = 40
export const CANVAS_PAD_TOP = 24
export const CANVAS_PAD_BOTTOM = 48

export const FLOW_NODE_WIDTH = 200
export const FLOW_NODE_MIN_HEIGHT = 52
export const FLOW_DIAMOND_HEIGHT = 92
export const FLOW_RANK_GAP = 96
export const FLOW_SIBLING_GAP = 40
/** A sticky note, square until someone resizes it or its text needs more. */
export const FLOW_NOTE_SIZE = 176
/** An image with no size of its own — one Claude wrote without measuring it. */
export const FLOW_IMAGE_DEFAULT_SIZE: FlowSize = { width: 240, height: 180 }
/** Free text runs as wide as its words, wrapping at this until resized. */
export const FLOW_TEXT_AUTO_MAX_WIDTH = 320
export const FLOW_TEXT_MIN_WIDTH = 40
/**
 * Padding inside a note, and across and down a text — what DiagramNodes.tsx
 * draws them with (p-3.5; px-1 py-[3px]), so what is measured is what fits.
 */
export const FLOW_NOTE_PAD = 14
export const FLOW_TEXT_PAD_X = 4
export const FLOW_TEXT_PAD_Y = 3
/** A second line's type: 11px on a 16px line, 2px under the label. */
const FLOW_DETAIL_FONT_SIZE = 11
const FLOW_DETAIL_LINE_HEIGHT = 16
const FLOW_DETAIL_GAP = 2

/**
 * A box label's font size and line height for each text size, in pixels.
 * "medium" is what every box was before sizes existed. Exported for the
 * renderer (DiagramNodes.tsx), which has to draw exactly what was measured.
 */
export const FLOW_TEXT_METRICS: Record<
  FlowTextSize,
  { fontSize: number; lineHeight: number }
> = {
  small: { fontSize: 11, lineHeight: 15 },
  medium: { fontSize: 13, lineHeight: 18 },
  large: { fontSize: 17, lineHeight: 24 },
}

// ─────────────────────────────────────────────────────────────────────
// Text measurement
// ─────────────────────────────────────────────────────────────────────

// Character-width weights, as a fraction of the font size, for the UI stack
// (Geist / system sans). The layout is a pure function, run in tests and
// scripts as well as the browser, so this table is what measures text by
// default. It is deliberately a slight OVER-estimate for the common case: a
// box that is a few pixels too wide reads fine, one that is a few too narrow
// clips its own text. In the browser, setFlowTextMeasure() swaps in real
// measurement (lib/diagrams/measure.ts), so a box is exactly as tall as the
// lines its text actually wraps to.
const HAIRLINE = new Set("ijlI.,:;'`|! ")
const NARROW = new Set("ftr()[]{}-/\\")
const WIDE = new Set("mwMW@%")

/** Above this weight the glyphs are visibly wider; 6% covers 600 and 700. */
const BOLD_FACTOR = 1.06

export function estimateTextWidth(
  text: string,
  fontSize: number,
  weight = 400,
): number {
  let units = 0
  for (const char of text) {
    if (HAIRLINE.has(char)) units += 0.3
    else if (NARROW.has(char)) units += 0.42
    else if (WIDE.has(char)) units += 0.95
    else if (char >= "A" && char <= "Z") units += 0.7
    else if (char >= "0" && char <= "9") units += 0.58
    else units += 0.56
  }
  return Math.ceil(units * fontSize * (weight >= 600 ? BOLD_FACTOR : 1))
}

/** How wide `text` is drawn at `fontSize` and `weight`, in pixels. */
export type FlowTextMeasure = (text: string, fontSize: number, weight: number) => number

let measureText: FlowTextMeasure = estimateTextWidth

/**
 * Swaps the estimate for real measurement (or back, with null). The browser
 * installs one before any diagram is laid out — see lib/diagrams/measure.ts.
 */
export function setFlowTextMeasure(measure: FlowTextMeasure | null): void {
  measureText = measure ?? estimateTextWidth
}

// One word as the browser can break it: after a hyphen ("problem-" /
// "solving"), a question or exclamation mark ("northgate?" / "page=42"), a
// dash or an ellipsis, as well as at the spaces between words.
function segments(word: string): string[] {
  return word.match(/[^-?!–—…]+[-?!–—…]*|[-?!–—…]+/g) ?? [word]
}

// A segment too wide for any line, cut into pieces that each fit — what the
// boxes' CSS (overflow-wrap: anywhere) does to a long URL or a run of letters.
function breakSegment(segment: string, maxWidth: number, fontSize: number, weight: number): string[] {
  const pieces: string[] = []
  let piece = ""
  for (const char of segment) {
    if (piece && measureText(piece + char, fontSize, weight) > maxWidth) {
      pieces.push(piece)
      piece = char
    } else {
      piece += char
    }
  }
  if (piece) pieces.push(piece)
  return pieces
}

// Greedy wrap, the way the boxes' CSS wraps: at spaces and after hyphens, each
// "\n" a line of its own, and a word too long for a line broken wherever it
// has to be — the boxes are a fixed width, so a word left whole would only run
// out of its box.
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  weight = 400,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ").filter(Boolean)
    if (words.length === 0) {
      // A blank line is intentional spacing — keep it.
      lines.push("")
      continue
    }
    let line = ""
    for (const word of words) {
      segments(word).forEach((segment, index) => {
        // A space between words; none between the pieces of one.
        const joined = line && index === 0 ? `${line} ${segment}` : line + segment
        if (!line || measureText(joined, fontSize, weight) <= maxWidth) {
          line = joined
        } else {
          lines.push(line)
          line = segment
        }
        if (measureText(line, fontSize, weight) > maxWidth) {
          const pieces = breakSegment(line, maxWidth, fontSize, weight)
          lines.push(...pieces.slice(0, -1))
          line = pieces[pieces.length - 1] ?? ""
        }
      })
    }
    if (line) lines.push(line)
  }
  return lines.length > 0 ? lines : [""]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ─────────────────────────────────────────────────────────────────────
// Node + edge data shapes. Written as `type` (not `interface`) so they satisfy
// React Flow's Record<string, unknown> constraint on node/edge data.
// ─────────────────────────────────────────────────────────────────────

export type FlowBoxNodeData = {
  label: string
  detail?: string
  labelRichText?: FlowRichText
  detailRichText?: FlowRichText
  shape: FlowShape
  tone: FlowTone
  dashed: boolean
  textSize: FlowTextSize
  align: FlowTextAlign
  bold: boolean
  italic: boolean
  /** An image's picture. */
  src?: string
  /** The size someone gave a note, text or image — see FlowNodeSpec.size. */
  size?: FlowSize
  /** Written by ✦ Answer and not edited since — see FlowNodeSpec.ai. */
  ai?: boolean
  /** Switchboard: in no branch, moving on its own — see FlowNodeSpec.detached. */
  detached?: boolean
}

/** What a flow edge carries, so the editor can read an edge back into a spec. */
export type FlowEdgeData = {
  label?: string
  dashed: boolean
  /** Switchboard: what the edge points at is folded away — see foldFlow. */
  collapsed?: boolean
}

export type DiagramLayout = {
  nodes: Node[]
  edges: Edge[]
  /** Canvas extents, used for the "fit" control and the PNG-ish export bounds. */
  width: number
  height: number
  title?: string
  summary?: string
}

// ─────────────────────────────────────────────────────────────────────
// flow
// ─────────────────────────────────────────────────────────────────────

// Edges that close a cycle, found by a depth-first walk: an edge landing on a
// node still open on the DFS stack is a BACK edge.
//
// They have to be found before ranking, not ranked around. A "send it back for
// another look" edge is exactly the kind a real flow has, and feeding it to the
// longest-path pass below would push the node it returns to further and further
// down on every pass — the review step ends up UNDER the decision that sends
// work to it, which is the opposite of what the diagram says. Excluded from
// ranking, it simply draws as an arrow pointing back up the page.
function backEdges(spec: FlowSpec): Set<number> {
  const outgoing = new Map<string, number[]>()
  for (const [index, edge] of spec.edges.entries()) {
    const list = outgoing.get(edge.from) ?? []
    list.push(index)
    outgoing.set(edge.from, list)
  }

  // white = unvisited, grey = on the current stack, black = finished.
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map(spec.nodes.map((node) => [node.id, WHITE]))
  const back = new Set<number>()

  // Iterative rather than recursive: the depth is the graph's, and a 60-node
  // chain is not worth risking the call stack over.
  for (const start of spec.nodes) {
    if (colour.get(start.id) !== WHITE) continue
    colour.set(start.id, GREY)
    const stack = [{ id: start.id, cursor: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const edges = outgoing.get(frame.id) ?? []

      if (frame.cursor >= edges.length) {
        colour.set(frame.id, BLACK)
        stack.pop()
        continue
      }

      const index = edges[frame.cursor]
      frame.cursor += 1
      const to = spec.edges[index].to

      // GREY means `to` is an ancestor of this frame — including `to === from`,
      // the self-loop. Anything BLACK is already finished, so it is a forward
      // or cross edge and safe to rank against.
      if (colour.get(to) === GREY) back.add(index)
      else if (colour.get(to) === WHITE) {
        colour.set(to, GREY)
        stack.push({ id: to, cursor: 0 })
      }
    }
  }

  return back
}

// Longest-path layering over the graph with its back edges removed: a node sits
// one rank below its deepest predecessor. That leaves a DAG, so the relaxation
// converges; the pass cap is only a backstop.
function rankNodes(spec: FlowSpec): Map<string, number> {
  const rank = new Map(spec.nodes.map((node) => [node.id, 0]))
  const ignore = backEdges(spec)
  const passes = Math.min(spec.nodes.length, 64)

  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false
    for (const [index, edge] of spec.edges.entries()) {
      if (ignore.has(index)) continue
      const from = rank.get(edge.from)
      const to = rank.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (to < from + 1) {
        rank.set(edge.to, from + 1)
        moved = true
      }
    }
    if (!moved) break
  }

  return rank
}

/**
 * Width of the label column inside a box — the box less its padding. A
 * diamond pads further in (px-8 in DiagramNodes.tsx's SHAPE_STYLES), to keep
 * its label off the clipped corners.
 */
const FLOW_LABEL_WIDTH = FLOW_NODE_WIDTH - 28
const FLOW_DIAMOND_LABEL_WIDTH = FLOW_NODE_WIDTH - 64

type FlowSizing = Pick<
  FlowNodeSpec,
  "label" | "detail" | "labelRichText" | "detailRichText" | "shape" | "textSize" | "bold" | "size"
>

/**
 * The weight a label is drawn at: a box's at 500, a note's and free text's at
 * 400 — reading text rather than a name — and any of them at 700 when bold.
 */
export function flowLabelWeight(node: Pick<FlowNodeSpec, "shape" | "bold" | "labelRichText">): number {
  if (node.bold && !node.labelRichText) return 700
  return node.shape === "note" || node.shape === "text" ? 400 : 500
}

// The second line wrapped to `width`, and the height it adds under a label.
function detailLines(detail: string | undefined, width: number, rich?: FlowRichText): string[] {
  return detail ? richTextLines(detail, rich, width, FLOW_DETAIL_FONT_SIZE, 400).map((line) => line.text) : []
}

/** Measure mixed weights and the list's hanging indent, including wrapped items. */
function richTextLines(text: string, rich: FlowRichText | undefined, width: number, fontSize: number, weight: number): { text: string; width: number }[] {
  if (!rich) return wrapText(text, width, fontSize, weight).map((text) => ({ text, width: measureText(text, fontSize, weight) }))
  const indents: number[] = []
  return richTextVisualLines(rich.length ? rich : plainTextParagraphs(text)).flatMap((paragraph) => {
    const text = paragraph.runs.map((run) => run.text).join("")
    indents.length = paragraph.level ?? 0
    indents.push(paragraph.checked !== undefined ? FLOW_CHECKLIST_INDENT : paragraph.bullet ? FLOW_BULLET_INDENT : 0)
    const indent = fontSize * indents.reduce((total, padding) => total + padding, 0)
    const available = Math.max(1, width - indent)
    const measure = (start: number, end: number) => {
      let offset = 0, measured = 0
      for (const run of paragraph.runs) {
        const part = run.text.slice(Math.max(0, start - offset), Math.max(0, end - offset))
        if (part) measured += measureText(part, fontSize, run.bold ? 700 : weight)
        offset += run.text.length
      }
      return measured
    }
    const lines: { text: string; width: number }[] = []
    let start = 0
    while (start < text.length) {
      let end = start
      while (end < text.length && (end === start || measure(start, end + 1) <= available)) end += 1
      if (end < text.length) {
        const prefix = text.slice(start, end)
        const boundary = Math.max(prefix.lastIndexOf(" ") + 1, ...[...prefix.matchAll(/[-?!–—…]/g)].map((match) => match.index + 1))
        if (boundary > 0) end = start + boundary
      }
      lines.push({ text: text.slice(start, end).trimEnd(), width: measure(start, end) + indent })
      start = end
      while (text[start] === " ") start += 1
    }
    return lines.length ? lines : [{ text: "", width: indent }]
  })
}

function detailHeight(lines: string[]): number {
  return lines.length > 0 ? lines.length * FLOW_DETAIL_LINE_HEIGHT + FLOW_DETAIL_GAP : 0
}

/**
 * A node's width and height. A box is FLOW_NODE_WIDTH wide and as tall as
 * its text; a note, a text and an image are sized as FlowNodeSpec.size says.
 * Exported because the editor re-sizes a node as its text is
 * typed, and it has to land on exactly the size the read-only canvas would
 * give the same node.
 */
export function flowNodeSize(node: FlowSizing): FlowSize {
  const shape = node.shape ?? DEFAULT_FLOW_SHAPE
  if (shape === "image") return node.size ?? FLOW_IMAGE_DEFAULT_SIZE

  const { fontSize, lineHeight } =
    FLOW_TEXT_METRICS[node.textSize ?? DEFAULT_FLOW_TEXT_SIZE]
  const weight = flowLabelWeight(node)

  if (shape === "note") {
    const width = node.size?.width ?? FLOW_NOTE_SIZE
    const inner = width - FLOW_NOTE_PAD * 2
    const lines = richTextLines(node.label, node.labelRichText, inner, fontSize, weight)
    const needed =
      lines.length * lineHeight +
      detailHeight(detailLines(node.detail, inner, node.detailRichText)) +
      FLOW_NOTE_PAD * 2
    return { width, height: Math.max(node.size?.height ?? FLOW_NOTE_SIZE, needed) }
  }

  if (shape === "text") {
    const wrapAt = (node.size?.width ?? FLOW_TEXT_AUTO_MAX_WIDTH) - FLOW_TEXT_PAD_X * 2
    const lines = richTextLines(node.label, node.labelRichText, wrapAt, fontSize, weight)
    const details = richTextLines(node.detail ?? "", node.detailRichText, wrapAt, FLOW_DETAIL_FONT_SIZE, 400)
    const width =
      node.size?.width ??
      clamp(
        Math.max(
          Math.max(0, ...lines.map((line) => line.width)),
          node.detail ? Math.max(0, ...details.map((line) => line.width)) : 0,
        ) +
          FLOW_TEXT_PAD_X * 2 +
          // A caret's worth, so the last letter typed never wraps early.
          2,
        FLOW_TEXT_MIN_WIDTH,
        FLOW_TEXT_AUTO_MAX_WIDTH,
      )
    return {
      width,
      height: lines.length * lineHeight + detailHeight(node.detail ? details.map((line) => line.text) : []) + FLOW_TEXT_PAD_Y * 2,
    }
  }

  const labelWidth = shape === "diamond" ? FLOW_DIAMOND_LABEL_WIDTH : FLOW_LABEL_WIDTH
  const lines = richTextLines(node.label, node.labelRichText, labelWidth, fontSize, weight)
  return {
    width: FLOW_NODE_WIDTH,
    height: Math.max(
      // A diamond is clipped out of its box, so a box the height of every
      // other node leaves a sliver with its label poking out of the points.
      shape === "diamond" ? FLOW_DIAMOND_HEIGHT : FLOW_NODE_MIN_HEIGHT,
      // Every line the second line wraps to, not just its first.
      lines.length * lineHeight + detailHeight(detailLines(node.detail, labelWidth, node.detailRichText)) + 22,
    ),
  }
}

/** A node's height — flowNodeSize's, for callers that only need that. */
export function flowNodeHeight(node: FlowSizing): number {
  return flowNodeSize(node).height
}

/**
 * The sides an edge attaches to when the spec doesn't say: out of the bottom
 * and into the top of the next box down, or right-to-left across a "right"
 * diagram. Exported for the editor, which writes sides for every edge.
 */
export function defaultFlowSides(direction: "down" | "right"): {
  from: FlowSide
  to: FlowSide
} {
  return direction === "down"
    ? { from: "bottom", to: "top" }
    : { from: "right", to: "left" }
}

/**
 * The closed arrowhead every flow edge ends in — a flow edge has a direction,
 * and a line without a head leaves the reader to guess it. Exported so the
 * editor's new edges match the ones laid out here.
 */
export const FLOW_ARROWHEAD = {
  type: "arrowclosed",
  width: 16,
  height: 16,
} as const

/**
 * How a flow edge is drawn, from what it means. Shared with the editor, which
 * re-derives it whenever an edge's label or dashing is changed on the canvas.
 */
export function flowEdgeAppearance(data: FlowEdgeData) {
  const labelBgPadding: [number, number] = [6, 3]
  return {
    label: data.label,
    labelStyle: { fontSize: 11, fontWeight: 500 },
    labelBgPadding,
    labelBgBorderRadius: 4,
    markerEnd: FLOW_ARROWHEAD,
    style: data.dashed ? { strokeDasharray: "5 4" } : undefined,
  }
}

// The automatic placement: rank by the edges, one rank per row (or column),
// each rank centred against the widest.
function autoFlowPositions(
  spec: FlowSpec,
  direction: "down" | "right",
  sizeOf: Map<string, FlowSize>,
): Map<string, FlowPosition> {
  const rank = rankNodes(spec)

  // Group by rank, keeping each rank in the order the nodes were authored —
  // the author's order is the best crossing heuristic available without a
  // proper Sugiyama pass, and it is at least predictable.
  const rows = new Map<number, string[]>()
  for (const node of spec.nodes) {
    const r = rank.get(node.id) ?? 0
    const row = rows.get(r) ?? []
    row.push(node.id)
    rows.set(r, row)
  }

  // How much room a node takes along the flow and across it. Never less than
  // a box's width across (or along, in a "right" diagram, where a rank is a
  // column) — so a diagram of boxes lays out exactly as it always has, and
  // only a wider note or image widens its slot.
  const down = direction === "down"
  const sizeOfId = (id: string) =>
    sizeOf.get(id) ?? { width: FLOW_NODE_WIDTH, height: FLOW_NODE_MIN_HEIGHT }
  const alongOf = (id: string) =>
    down ? sizeOfId(id).height : Math.max(FLOW_NODE_WIDTH, sizeOfId(id).width)
  const acrossOf = (id: string) =>
    Math.max(FLOW_NODE_WIDTH, down ? sizeOfId(id).width : sizeOfId(id).height)
  const spanOf = (ids: string[]) =>
    ids.reduce((sum, id) => sum + acrossOf(id), 0) +
    Math.max(0, ids.length - 1) * FLOW_SIBLING_GAP

  const orderedRanks = [...rows.keys()].sort((a, b) => a - b)
  const widestSpan = Math.max(0, ...[...rows.values()].map(spanOf))

  const position = new Map<string, FlowPosition>()
  let along = CANVAS_PAD_X
  for (const r of orderedRanks) {
    const ids = rows.get(r) ?? []
    const band = ids.reduce((max, id) => Math.max(max, alongOf(id)), 0)
    // Centre each rank against the widest one, so the graph reads as a column
    // (or a row) rather than drifting left.
    let across = CANVAS_PAD_X + (widestSpan - spanOf(ids)) / 2

    for (const id of ids) {
      // Centred across its slot, so a narrower note, text or image still sits
      // on the line through the boxes above and below it. (A box fills its
      // slot exactly in a "down" diagram, so there this changes nothing.)
      const size = sizeOfId(id)
      const offset = (acrossOf(id) - (down ? size.width : size.height)) / 2
      position.set(
        id,
        down ? { x: across + offset, y: along } : { x: along, y: across + offset },
      )
      across += acrossOf(id) + FLOW_SIBLING_GAP
    }

    along += band + FLOW_RANK_GAP
  }

  return position
}

// Where every box goes. A box someone dragged keeps its `position`; the rest
// are laid out automatically. When a diagram has BOTH — a hand-arranged one
// that Claude has since added a node to — the automatic ones keep their own
// arrangement but move as a group into a band past the arranged ones, so a new
// node lands somewhere visible instead of on top of one that was put there
// deliberately.
function flowPositions(
  spec: FlowSpec,
  direction: "down" | "right",
  sizeOf: Map<string, FlowSize>,
): Map<string, FlowPosition> {
  const auto = autoFlowPositions(spec, direction, sizeOf)
  const placed = spec.nodes.filter((node) => node.position !== undefined)
  const floating = spec.nodes.filter((node) => node.position === undefined)
  if (placed.length === 0) return auto

  const position = new Map<string, FlowPosition>()
  for (const node of placed) {
    if (node.position) position.set(node.id, node.position)
  }
  if (floating.length === 0) return position

  const down = direction === "down"
  const alongOf = (p: FlowPosition) => (down ? p.y : p.x)
  const acrossOf = (p: FlowPosition) => (down ? p.x : p.y)
  const extentOf = (node: FlowNodeSpec) => {
    const size = sizeOf.get(node.id)
    return down
      ? (size?.height ?? FLOW_NODE_MIN_HEIGHT)
      : (size?.width ?? FLOW_NODE_WIDTH)
  }

  const placedEnd = Math.max(
    ...placed.map((node) => alongOf(node.position!) + extentOf(node)),
  )
  const placedStart = Math.min(...placed.map((node) => acrossOf(node.position!)))
  const autoOf = (node: FlowNodeSpec) =>
    auto.get(node.id) ?? { x: CANVAS_PAD_X, y: CANVAS_PAD_TOP }
  const floatingStart = Math.min(...floating.map((node) => alongOf(autoOf(node))))
  const floatingAcross = Math.min(
    ...floating.map((node) => acrossOf(autoOf(node))),
  )

  const shiftAlong = placedEnd + FLOW_RANK_GAP - floatingStart
  const shiftAcross = placedStart - floatingAcross
  for (const node of floating) {
    const p = autoOf(node)
    position.set(
      node.id,
      down
        ? { x: p.x + shiftAcross, y: p.y + shiftAlong }
        : { x: p.x + shiftAlong, y: p.y + shiftAcross },
    )
  }
  return position
}

function layoutFlow(spec: FlowSpec): DiagramLayout {
  const direction = spec.direction ?? "down"

  const sizeOf = new Map<string, FlowSize>()
  for (const node of spec.nodes) sizeOf.set(node.id, flowNodeSize(node))

  const position = flowPositions(spec, direction, sizeOf)

  // Switchboard: boxes folded away behind a collapsed edge are not drawn, nor any
  // edge to or from them.
  const { hidden } = foldFlow(
    spec.nodes.map((node) => node.id),
    spec.edges.map((edge) => ({ source: edge.from, target: edge.to, collapsed: edge.collapsed })),
  )

  const nodes: Node[] = spec.nodes.map((node) => ({
    id: node.id,
    type: "flowBox",
    position: position.get(node.id) ?? { x: CANVAS_PAD_X, y: CANVAS_PAD_TOP },
    width: sizeOf.get(node.id)?.width ?? FLOW_NODE_WIDTH,
    height: sizeOf.get(node.id)?.height ?? FLOW_NODE_MIN_HEIGHT,
    data: {
      label: node.label,
      detail: node.detail,
      labelRichText: node.labelRichText,
      detailRichText: node.detailRichText,
      shape: node.shape ?? DEFAULT_FLOW_SHAPE,
      tone: node.tone ?? DEFAULT_FLOW_TONE,
      dashed: node.dashed === true,
      textSize: node.textSize ?? DEFAULT_FLOW_TEXT_SIZE,
      align: node.align ?? DEFAULT_FLOW_TEXT_ALIGN,
      bold: node.bold === true,
      italic: node.italic === true,
      src: node.src,
      size: node.size,
      ai: node.ai === true ? true : undefined,
      detached: node.detached === true ? true : undefined,
    } satisfies FlowBoxNodeData,
    draggable: false,
    selectable: false,
    hidden: hidden.has(node.id) || undefined,
  }))

  // The flow kind uses React Flow's OWN routing: real handles on the boxes and
  // the built-in smoothstep edge. A free-form graph has no rigid geometry to
  // derive, which is exactly the case React Flow's own edge router is for.
  //
  // Every box has one handle per side, named after the side, and the edge
  // names the pair it uses — stated even when it is the default, because
  // React Flow falls back to a node's FIRST handle for an edge that names none,
  // which would hang every default edge off the top of its box.
  const sides = defaultFlowSides(direction)
  const edges: Edge[] = spec.edges.map((edge, index) => {
    const data: FlowEdgeData = {
      label: edge.label,
      dashed: edge.dashed === true,
      collapsed: edge.collapsed === true ? true : undefined,
    }
    return {
      id: `flow-edge-${index}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.fromSide ?? sides.from,
      targetHandle: edge.toSide ?? sides.to,
      type: "smoothstep",
      selectable: false,
      focusable: false,
      hidden: edge.collapsed === true || hidden.has(edge.from) || hidden.has(edge.to) || undefined,
      data,
      ...flowEdgeAppearance(data),
    }
  })

  // Extents from the boxes themselves rather than from the ranks, because a
  // dragged box can sit anywhere — including left of or above the origin.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    if (node.hidden) continue
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + (node.width ?? FLOW_NODE_WIDTH))
    maxY = Math.max(maxY, node.position.y + (node.height ?? 0))
  }
  const empty = !nodes.some((node) => !node.hidden)

  return {
    nodes,
    edges,
    width: empty ? 0 : maxX - minX + CANVAS_PAD_X * 2,
    height: empty ? 0 : maxY - minY + CANVAS_PAD_TOP + CANVAS_PAD_BOTTOM,
    title: spec.title,
    summary: spec.summary,
  }
}

// ─────────────────────────────────────────────────────────────────────

// ─── Switchboard: folding a branch away behind its edge ───

/** An arrow as folding sees it: where it goes, and whether it is collapsed. */
export type FlowFoldEdge = { source: string; target: string; collapsed?: boolean }

/** The same loop-closing arrows and outgoing order used by `foldFlow`. */
function flowFoldGraph(ids: Iterable<string>, edges: ReadonlyArray<FlowFoldEdge>) {
  const order = [...ids]
  const known = new Set(order)
  const out = new Map<string, number[]>()
  edges.forEach((edge, index) => {
    if (!known.has(edge.source) || !known.has(edge.target)) return
    const list = out.get(edge.source)
    if (list) list.push(index)
    else out.set(edge.source, [index])
  })

  // An arrow landing on a box still open on the walk closes a loop. Folding
  // that arrow cannot hide the box, so a new node-level fold leaves it alone.
  const back = new Set<number>()
  const state = new Map<string, number>() // 1 open, 2 done
  for (const start of order) {
    if (state.has(start)) continue
    state.set(start, 1)
    const stack = [{ id: start, next: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const leaving = out.get(frame.id) ?? []
      if (frame.next >= leaving.length) {
        state.set(frame.id, 2)
        stack.pop()
        continue
      }
      const index = leaving[frame.next++]
      const to = edges[index].target
      if (state.get(to) === 1) back.add(index)
      else if (!state.has(to)) {
        state.set(to, 1)
        stack.push({ id: to, next: 0 })
      }
    }
  }
  return { order, out, back }
}

/**
 * Every node's outgoing foldable arrows, by index in `edges`, in one graph walk.
 * A new fold skips arrows that close a loop, because their target stays visible.
 * Already-collapsed loop arrows from older diagrams remain in the group so a
 * node click can reopen them.
 */
export function flowNodeFoldGroups(
  ids: Iterable<string>,
  edges: ReadonlyArray<FlowFoldEdge>,
): Map<string, number[]> {
  const { out, back } = flowFoldGraph(ids, edges)
  const groups = new Map<string, number[]>()
  for (const [source, outgoing] of out) {
    const foldable = outgoing.filter((index) => !back.has(index) || edges[index].collapsed === true)
    if (foldable.length > 0) groups.set(source, foldable)
  }
  return groups
}

/** One node's outgoing foldable arrows, by index in `edges`. */
export function flowNodeFoldEdges(
  ids: Iterable<string>,
  edges: ReadonlyArray<FlowFoldEdge>,
  source: string,
): number[] {
  return flowNodeFoldGroups(ids, edges).get(source) ?? []
}

/**
 * Close every outgoing branch if any is open; otherwise reopen them all. The
 * fold still lives on its edges in saved diagrams, so partially folded older
 * drawings and nested folds need no migration. Reachability before and after
 * tells the editor which boxes actually disappeared or came back; a shared
 * target may stay visible through another open route.
 */
export function toggleFlowNodeFold(
  ids: Iterable<string>,
  edges: FlowFoldEdge[],
  source: string,
): {
  edges: FlowFoldEdge[]
  changed: boolean
  collapsed: boolean
  edgeIndexes: number[]
  hiddenBefore: Set<string>
  hiddenAfter: Set<string>
  newlyHidden: Set<string>
  newlyShown: Set<string>
} {
  const order = [...ids]
  const edgeIndexes = flowNodeFoldEdges(order, edges, source)
  const hiddenBefore = foldFlow(order, edges).hidden
  const collapsed = edgeIndexes.length > 0 && edgeIndexes.some((index) => edges[index].collapsed !== true)
  if (edgeIndexes.length === 0) {
    return {
      edges,
      changed: false,
      collapsed: false,
      edgeIndexes,
      hiddenBefore,
      hiddenAfter: hiddenBefore,
      newlyHidden: new Set(),
      newlyShown: new Set(),
    }
  }
  const selected = new Set(edgeIndexes)
  const next = edges.map((edge, index) =>
    selected.has(index) ? { ...edge, collapsed: collapsed || undefined } : edge,
  )
  const hiddenAfter = foldFlow(order, next).hidden
  return {
    edges: next,
    changed: true,
    collapsed,
    edgeIndexes,
    hiddenBefore,
    hiddenAfter,
    newlyHidden: new Set([...hiddenAfter].filter((id) => !hiddenBefore.has(id))),
    newlyShown: new Set([...hiddenBefore].filter((id) => !hiddenAfter.has(id))),
  }
}

/**
 * What the collapsed arrows fold away: the box each one points at and
 * everything beyond it — every box that can no longer be reached from the
 * diagram's starting boxes without crossing a collapsed arrow. A box something
 * still showing points at stays, and so does everything upstream of the fold.
 *
 * "Starting boxes" are the ones nothing points at, once the arrows that close a
 * loop are set aside (found as the layout finds them, by a walk in the boxes'
 * order) — so an arrow from deep in a branch back to an earlier box never drags
 * that box, or what leads to the fold, in with the branch.
 *
 * `folded` is, for each collapsed arrow (by its index in `edges`), the boxes
 * it hides; `hidden` is all of them.
 */
export function foldFlow(
  ids: Iterable<string>,
  edges: FlowFoldEdge[],
): { hidden: Set<string>; folded: Map<number, Set<string>> } {
  const hidden = new Set<string>()
  const folded = new Map<number, Set<string>>()
  if (!edges.some((edge) => edge.collapsed)) return { hidden, folded }

  const { order, out, back } = flowFoldGraph(ids, edges)

  // Showing: the starting boxes, and whatever they reach along arrows that
  // neither close a loop nor are collapsed.
  const pointedAt = new Set<string>()
  for (const [, leaving] of out) {
    for (const index of leaving) if (!back.has(index)) pointedAt.add(edges[index].target)
  }
  const showing = new Set(order.filter((id) => !pointedAt.has(id)))
  const stack = [...showing]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const index of out.get(id) ?? []) {
      if (back.has(index) || edges[index].collapsed) continue
      const to = edges[index].target
      if (!showing.has(to)) {
        showing.add(to)
        stack.push(to)
      }
    }
  }
  for (const id of order) if (!showing.has(id)) hidden.add(id)

  // What each collapsed arrow hides: the hidden boxes beyond it.
  edges.forEach((edge, index) => {
    if (!edge.collapsed || back.has(index) || !hidden.has(edge.target)) return
    const mine = new Set<string>()
    const walk = [edge.target]
    while (walk.length > 0) {
      const id = walk.pop()!
      if (mine.has(id) || !hidden.has(id)) continue
      mine.add(id)
      for (const next of out.get(id) ?? []) if (!back.has(next)) walk.push(edges[next].target)
    }
    folded.set(index, mine)
  })
  return { hidden, folded }
}

/** The entry point: a validated spec in, a drawable canvas out. */
export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
  return layoutFlow(spec)
}
