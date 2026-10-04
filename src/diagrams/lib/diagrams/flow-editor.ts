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
    const { label, detail, shape, tone, dashed, textSize, align, bold, italic, src, size, ai, detached } =
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
      detached: detached === true ? true : undefined,
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

/**
 * A box on the canvas, by id. Switchboard: `detached` is a box someone detached
 * from its branch (FlowNodeSpec.detached) — none of its arrows make a tree.
 */
export type FlowTreeBox = FlowRect & { id: string; detached?: boolean }

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
type FlowTrees = {
  parentOf: Map<string, string>
  childrenOf: Map<string, string[]>
}

function flowTrees(
  byId: Map<string, FlowTreeBox>,
  edges: FlowTreeEdge[],
  // New boxes, whose y means nothing yet: they go after their siblings, in
  // this order.
  fresh: string[] = [],
): FlowTrees {
  const sources = new Map<string, Set<string>>()
  for (const edge of edges) {
    const from = byId.get(edge.source)
    const to = byId.get(edge.target)
    if (!from || !to || to.x <= from.x || from.detached || to.detached) continue
    if (edge.sourceHandle !== "right" || edge.targetHandle !== "left") continue
    sources.set(to.id, (sources.get(to.id) ?? new Set()).add(from.id))
  }
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const [id, from] of sources) {
    if (from.size !== 1) continue
    const [source] = from
    parentOf.set(id, source)
    childrenOf.set(source, [...(childrenOf.get(source) ?? []), id])
  }
  // Top to bottom as they stand, so tidying never reorders a branch — and a box
  // dragged in among its siblings takes the place it was dropped in. By their
  // middles (Switchboard), so a box dropped half over another goes before it or
  // after it as it looks; boxes stacked apart sort the same either way.
  const late = new Map(fresh.map((id, index) => [id, index]))
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const lateA = late.get(a)
      const lateB = late.get(b)
      if (lateA !== undefined || lateB !== undefined) {
        return (lateA ?? -1) - (lateB ?? -1)
      }
      const boxA = byId.get(a)!
      const boxB = byId.get(b)!
      return (
        boxA.y + boxA.height / 2 - (boxB.y + boxB.height / 2) || boxA.x - boxB.x || a.localeCompare(b)
      )
    })
  }
  return { parentOf, childrenOf }
}

/** The top of the tree `id` is in: every step up moves strictly left, so it ends. */
function topOf(trees: FlowTrees, id: string): string {
  let top = id
  for (let up = trees.parentOf.get(top); up !== undefined; up = trees.parentOf.get(top)) {
    top = up
  }
  return top
}

/**
 * The tree under `topId` laid out the way Tab lays it out: every box level
 * with the midpoint of the first and last boxes hanging off it, those boxes
 * stacked FLOW_TAB_GAP_Y apart, and a box's whole branch moving with it. The
 * top box stays where it is and nothing moves sideways.
 */
function layoutTree(
  at: Map<string, FlowTreeBox>,
  trees: FlowTrees,
  topId: string,
): Map<string, FlowTreeBox> {
  // Each box's branch as a block: how far it reaches above and below the
  // box's centre, and where every box in it sits relative to that centre.
  type Block = { above: number; below: number; centres: Map<string, number> }
  function branch(id: string): Block {
    const box = at.get(id)!
    const centres = new Map([[id, 0]])
    let above = box.height / 2
    let below = box.height / 2
    const blocks = (trees.childrenOf.get(id) ?? []).map(branch)
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
      for (const [child, centre] of block.centres) centres.set(child, centre + offset)
      above = Math.max(above, block.above - offset)
      below = Math.max(below, block.below + offset)
    })
    return { above, below, centres }
  }

  const top = at.get(topId)!
  const centre = top.y + top.height / 2
  const placed = new Map<string, FlowTreeBox>()
  for (const [id, offset] of branch(topId).centres) {
    const box = at.get(id)!
    placed.set(id, { ...box, y: Math.round(centre + offset - box.height / 2) })
  }
  return placed
}

/** Whether two boxes share any of the canvas's width — one could land on the other going up or down. */
function sameColumn(a: FlowRect, b: FlowRect): boolean {
  return a.x < b.x + b.width + FLOW_CLEARANCE && b.x < a.x + a.width + FLOW_CLEARANCE
}

/** The room between two boxes in one column, top to bottom — less than 0 when they overlap. */
function gapBetween(a: FlowRect, b: FlowRect): number {
  return Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
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
 */
function makeRoom(
  at: Map<string, FlowTreeBox>,
  was: Map<string, FlowRect>,
  tree: Set<string>,
  edges: FlowTreeEdge[],
): void {
  // The room a pair must keep: FLOW_ROOM_GAP, or what they had before when
  // that was less.
  const needed = (a: string, b: string) => {
    const before = [was.get(a), was.get(b)]
    return before[0] && before[1] && sameColumn(before[0], before[1])
      ? Math.min(FLOW_ROOM_GAP, gapBetween(before[0], before[1]))
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
  for (const edge of edges) {
    if (root.has(edge.source) && root.has(edge.target)) {
      root.set(find(edge.source), find(edge.target))
    }
  }
  const pieces = new Map<string, string[]>()
  for (const id of outside) {
    const r = find(id)
    pieces.set(r, [...(pieces.get(r) ?? []), id])
  }

  const settled = new Set(tree)
  const waiting = new Set(pieces.values())
  // Each pass moves one piece and settles it, so this ends.
  while (waiting.size > 0) {
    let crowded: { piece: string[]; box: FlowRect; by: FlowRect } | null = null
    search: for (const piece of waiting) {
      for (const id of piece) {
        const box = at.get(id)!
        for (const other of settled) {
          const by = at.get(other)!
          if (sameColumn(box, by) && gapBetween(box, by) < needed(id, other)) {
            crowded = { piece, box, by }
            break search
          }
        }
      }
    }
    if (crowded === null) return
    waiting.delete(crowded.piece)

    // Away from the box that crowded it: down if it sits lower, up if higher.
    const down =
      crowded.box.y + crowded.box.height / 2 >= crowded.by.y + crowded.by.height / 2
    // Every shift that would leave a pair too close, as an open range…
    const ranges: [number, number][] = []
    for (const id of crowded.piece) {
      const box = at.get(id)!
      for (const other of settled) {
        const by = at.get(other)!
        if (!sameColumn(box, by)) continue
        const room = needed(id, other)
        ranges.push([by.y - box.y - box.height - room, by.y + by.height + room - box.y])
      }
    }
    // …and the smallest one way that is in none of them. The furthest end of
    // them all always is, so there is one.
    const ends = down
      ? ranges.map(([, high]) => Math.ceil(high)).filter((end) => end >= 0).sort((a, b) => a - b)
      : ranges.map(([low]) => Math.floor(low)).filter((end) => end <= 0).sort((a, b) => b - a)
    const shift =
      ends.find((end) => ranges.every(([low, high]) => end <= low || end >= high)) ?? 0
    for (const id of crowded.piece) {
      const box = at.get(id)!
      at.set(id, { ...box, y: box.y + shift })
      settled.add(id)
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
): Map<string, FlowTreeBox> {
  const at = new Map(boxes.map((box) => [box.id, box]))
  const trees = flowTrees(at, edges, fresh)
  const tops = new Set(anchors.filter((id) => at.has(id)).map((id) => topOf(trees, id)))
  for (const top of tops) {
    const placed = layoutTree(at, trees, top)
    for (const [id, box] of placed) at.set(id, box)
    makeRoom(at, was, new Set(placed.keys()), edges)
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
 */
export function placeTabChild(
  boxes: FlowTreeBox[],
  edges: FlowTreeEdge[],
  parentId: string,
  child: { id: string; width: number; height: number },
): { position: FlowPoint; moved: Map<string, FlowPoint> } {
  const { positions, moved } = placeTabChildren(boxes, edges, parentId, [child])
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
): { positions: Map<string, FlowPoint>; moved: Map<string, FlowPoint> } {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const parent = byId.get(parentId)
  if (!parent) throw new Error(`No box "${parentId}"`)

  // In the column of the boxes already hanging off the parent — the lowest of
  // them, as Tab has always lined a new one up — or FLOW_TAB_GAP_X right of it.
  const siblings = flowTrees(byId, edges).childrenOf.get(parentId) ?? []
  const last = siblings.length > 0 ? byId.get(siblings[siblings.length - 1]) : undefined
  const x = last ? last.x : parent.x + parent.width + FLOW_TAB_GAP_X
  const fresh = children.map((child) => ({ ...child, x, y: parent.y }))
  const wired = [
    ...edges,
    ...fresh.map((child) => ({
      source: parentId,
      target: child.id,
      sourceHandle: "right",
      targetHandle: "left",
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
): Map<string, FlowPoint> {
  const unknown = new Set(revealed)
  const after = tidyTrees(
    boxes,
    edges,
    anchors,
    [],
    new Map(boxes.filter((box) => !unknown.has(box.id)).map((box) => [box.id, box])),
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

  // What hangs off a grabbed box and was left behind comes along sideways; the
  // layout settles it up and down.
  for (const id of leaders) {
    const dx = now.get(id)!.x - from.get(id)!.x
    if (dx === 0) continue
    for (const below of branchBelow(before, id)) {
      if (!moved.has(below)) work.get(below)!.x += dx
    }
  }
  // Back into its column — its siblings' that stayed, or where Tab would put it —
  // with its whole branch.
  for (const id of leaders) {
    const parentId = before.parentOf.get(id)
    if (parentId === undefined) continue
    const parent = work.get(parentId)!
    const box = work.get(id)!
    if (box.x <= parent.x) continue
    const stayed = (before.childrenOf.get(parentId) ?? []).find((sibling) => !moved.has(sibling))
    const x = stayed !== undefined ? work.get(stayed)!.x : parent.x + parent.width + FLOW_TAB_GAP_X
    const dx = x - box.x
    box.x = x
    if (dx !== 0) for (const below of branchBelow(before, id)) work.get(below)!.x += dx
  }

  const anchors = [...leaders, ...leaders.flatMap((id) => before.parentOf.get(id) ?? [])]
  const after = tidyTrees([...work.values()], edges, anchors, [], was)
  return movesFrom(boxes, after)
}

// Switchboard: folding a branch away behind its arrow lives with the layout
// (layout.ts foldFlow), which the read-only canvas draws through too.
export { foldFlow, type FlowFoldEdge } from "./layout"

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
      detached: node.detached ?? old.detached,
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
