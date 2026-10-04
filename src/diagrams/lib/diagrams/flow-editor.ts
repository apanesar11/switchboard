// The pure half of the diagram editor: turning what is on the canvas back into
// a FlowSpec, naming new boxes, deciding where Tab puts the next one (and how
// the boxes around it shuffle to stay symmetrical), and keeping a hand-made
// arrangement when Claude republishes the diagram.
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

import { defaultFlowSides, type FlowBoxNodeData, type FlowEdgeData } from "./layout"
import { normalizeFlowText } from "./validate"
import {
  DEFAULT_FLOW_SHAPE,
  DEFAULT_FLOW_TEXT_ALIGN,
  DEFAULT_FLOW_TEXT_SIZE,
  DEFAULT_FLOW_TONE,
  DIAGRAM_TEXT_MAX_LENGTH,
  FLOW_SIDES,
  isFlowSizedShape,
  type FlowEdgeSpec,
  type FlowNodeSpec,
  type FlowSide,
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
  return text.length > 0 ? text.slice(0, DIAGRAM_TEXT_MAX_LENGTH).trimEnd() : undefined
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

  const specNodes: FlowNodeSpec[] = nodes.filter((node) => !blank.has(node.id)).map((node) => {
    const { label, detail, shape, tone, dashed, textSize, align, bold, italic, src, size, ai } =
      node.data
    return {
      id: node.id,
      // An empty sticky note is a thing in its own right; an empty box reads
      // as one still to be named.
      label: cleanBoxText(label) ?? (shape === "note" ? "" : UNTITLED_FLOW_LABEL),
      detail: cleanBoxText(detail),
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
      position: { x: pixel(node.position.x), y: pixel(node.position.y) },
      src: shape === "image" ? src : undefined,
      size:
        isFlowSizedShape(shape) && size
          ? { width: pixel(size.width), height: pixel(size.height) }
          : undefined,
    }
  })

  const specEdges: FlowEdgeSpec[] = edges
    .filter((edge) => !blank.has(edge.source) && !blank.has(edge.target))
    .map((edge) => ({
    from: edge.source,
    to: edge.target,
    label: clean(edge.data?.label),
    dashed: edge.data?.dashed === true ? true : undefined,
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

// ─── Tab: add the next box ───

/** A box's footprint on the canvas, in canvas pixels. */
export type FlowRect = { x: number; y: number; width: number; height: number }

/** Between a box and the one Tab adds to its right: room for a readable arrow. */
export const FLOW_TAB_GAP_X = 80
/** Between boxes Tab stacks under one another. */
export const FLOW_TAB_GAP_Y = 30
/** How close two boxes may come before one counts as landing on the other. */
const FLOW_CLEARANCE = 10

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
 */
export function nextChildPosition(
  parent: FlowRect,
  children: FlowRect[],
  boxes: FlowRect[],
  size: { width: number; height: number },
): { x: number; y: number } {
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

/** A box on the canvas, by id. */
export type FlowTreeBox = FlowRect & { id: string }

export type FlowTreeEdge = Pick<
  FlowCanvasEdge,
  "source" | "target" | "sourceHandle" | "targetHandle"
>

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
 * If the tidied tree would land on a box outside it, nothing moves and the new
 * box goes where nextChildPosition puts it instead.
 */
export function placeTabChild(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
  child: { id: string; width: number; height: number },
): { position: { x: number; y: number }; moved: Map<string, { x: number; y: number }> } {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const parent = byId.get(parentId)
  if (!parent) throw new Error(`No box "${parentId}"`)

  const sources = new Map<string, Set<string>>()
  for (const edge of edges) {
    const from = byId.get(edge.source)
    const to = byId.get(edge.target)
    if (!from || !to || to.x <= from.x) continue
    if (edge.sourceHandle !== "right" || edge.targetHandle !== "left") continue
    sources.set(to.id, (sources.get(to.id) ?? new Set()).add(from.id))
  }
  const treeParent = new Map<string, string>()
  const children = new Map<string, FlowTreeBox[]>()
  for (const [id, from] of sources) {
    if (from.size !== 1) continue
    const [source] = from
    treeParent.set(id, source)
    children.set(source, [...(children.get(source) ?? []), byId.get(id)!])
  }
  // Top to bottom as they stand, so tidying never reorders a branch.
  for (const list of children.values()) {
    list.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  }

  const siblings = children.get(parentId) ?? []
  const last = siblings[siblings.length - 1]
  const fresh: FlowTreeBox = {
    id: child.id,
    x: last ? last.x : parent.x + parent.width + FLOW_TAB_GAP_X,
    y: 0,
    width: child.width,
    height: child.height,
  }
  children.set(parentId, [...siblings, fresh])
  treeParent.set(fresh.id, parentId)

  // Ends: every step up moves strictly left.
  let top = parent
  for (let up = treeParent.get(top.id); up !== undefined; up = treeParent.get(top.id)) {
    top = byId.get(up)!
  }

  // Each box's branch as a block: how far it reaches above and below the
  // box's centre, and where every box in it sits relative to that centre.
  type Block = { above: number; below: number; centres: Map<string, number> }
  function branch(box: FlowTreeBox): Block {
    const centres = new Map([[box.id, 0]])
    let above = box.height / 2
    let below = box.height / 2
    const blocks = (children.get(box.id) ?? []).map(branch)
    if (blocks.length === 0) return { above, below, centres }
    // Stacked from 0 down, FLOW_TAB_GAP_Y between neighbouring blocks…
    const stacked: number[] = []
    let cursor = 0
    for (const block of blocks) {
      stacked.push(cursor + block.above)
      cursor += block.above + block.below + FLOW_TAB_GAP_Y
    }
    // …then shifted so this box is level with the first and last of them.
    const shift = (stacked[0] + stacked[stacked.length - 1]) / 2
    blocks.forEach((block, index) => {
      const offset = stacked[index] - shift
      for (const [id, centre] of block.centres) centres.set(id, centre + offset)
      above = Math.max(above, block.above - offset)
      below = Math.max(below, block.below + offset)
    })
    return { above, below, centres }
  }

  const tree = branch(top).centres
  const centre = top.y + top.height / 2
  const placed = new Map<string, FlowTreeBox>()
  for (const [id, offset] of tree) {
    const box = id === fresh.id ? fresh : byId.get(id)!
    placed.set(id, { ...box, y: Math.round(centre + offset - box.height / 2) })
  }

  // Only what tidying itself would cause: a box already overlapping one
  // outside the tree doesn't count against it.
  const outside = boxes.filter((box) => !tree.has(box.id))
  const collides = [...placed.values()].some((rect) =>
    outside.some(
      (other) =>
        overlaps(rect, other) &&
        (rect.id === fresh.id || !overlaps(byId.get(rect.id)!, other)),
    ),
  )
  if (collides) {
    return {
      position: nextChildPosition(parent, siblings, boxes, child),
      moved: new Map(),
    }
  }

  const moved = new Map<string, { x: number; y: number }>()
  for (const rect of placed.values()) {
    if (rect.id !== fresh.id && rect.y !== byId.get(rect.id)!.y) {
      moved.set(rect.id, { x: rect.x, y: rect.y })
    }
  }
  const spot = placed.get(fresh.id)!
  return { position: { x: spot.x, y: spot.y }, moved }
}

/**
 * placeTabChild for several new boxes at once — an AI answer in parts — added
 * one after another as Tab would add them, so the branch ends up just as
 * symmetrical. Returns where each new box goes and where any existing box
 * moves to (its final place, after every new box has gone in).
 */
export function placeTabChildren(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
  children: { id: string; width: number; height: number }[],
): { positions: Map<string, { x: number; y: number }>; moved: Map<string, { x: number; y: number }> } {
  let current = [...boxes]
  const wired = [...edges]
  const positions = new Map<string, { x: number; y: number }>()
  const moved = new Map<string, { x: number; y: number }>()
  for (const child of children) {
    const step = placeTabChild(current, wired, parentId, child)
    for (const [id, to] of step.moved) (positions.has(id) ? positions : moved).set(id, to)
    current = current.map((box) => {
      const to = step.moved.get(box.id)
      return to ? { ...box, ...to } : box
    })
    current.push({ ...child, ...step.position })
    positions.set(child.id, step.position)
    wired.push({ source: parentId, target: child.id, sourceHandle: "right", targetHandle: "left" })
  }
  return { positions, moved }
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
      { fromSide: edge.fromSide, toSide: edge.toSide },
    ]),
  )

  let carried = 0
  const nodes = next.nodes.map((node) => {
    const old = before.get(node.id.toLowerCase())
    if (!old) return node
    if (!node.position && old.position) carried += 1
    return {
      ...node,
      position: node.position ?? old.position,
      // Only onto the same shape it was given for: a size means something
      // different on each (a note's least height, a text's width alone, an
      // image's proportions), and a box keeps none at all.
      size:
        node.size ??
        (node.shape !== undefined && isFlowSizedShape(node.shape) && node.shape === old.shape
          ? old.size
          : undefined),
      dashed: node.dashed ?? old.dashed,
      textSize: node.textSize ?? old.textSize,
      align: node.align ?? old.align,
      bold: node.bold ?? old.bold,
      italic: node.italic ?? old.italic,
      // The AI's mark survives only while the words are still the AI's.
      ai: node.ai ?? (old.ai && old.label === node.label && old.detail === node.detail ? true : undefined),
    }
  })
  const edges = next.edges.map((edge) => {
    const old = sides.get(edgeKey(edge.from, edge.to))
    if (!old) return edge
    return {
      ...edge,
      fromSide: edge.fromSide ?? old.fromSide,
      toSide: edge.toSide ?? old.toSide,
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
