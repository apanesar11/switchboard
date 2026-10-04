// Condense works on exactly the boxes the user selected. The model only writes
// the replacement text; graph boundaries, ids and placement stay local.

import {
  clearOfBoxes,
  FLOW_ROOM_GAP,
  FLOW_TAB_GAP_X,
  flowBranches,
  nextFlowNodeId,
  placeTabChildren,
  tidyFlowTree,
  type FlowTreeBox,
  type FlowTreeEdge,
} from "./flow-editor"
import { defaultFlowSides, flowNodeSize, layoutDiagram } from "./layout"
import { normalizeFlowText } from "./validate"
import {
  DIAGRAM_TEXT_MAX_LENGTH,
  type FlowEdgeSpec,
  type FlowNodeSpec,
  type FlowPosition,
  type FlowSpec,
} from "./types"

export type FlowCondensePart = { label: string; detail?: string }

export type FlowCondenseSelection = {
  /** In graph order, with original spec order breaking ties and cycles. */
  nodes: FlowNodeSpec[]
  edges: FlowEdgeSpec[]
  incoming: FlowEdgeSpec[]
  outgoing: FlowEdgeSpec[]
  anchor: FlowNodeSpec
  /** Content, styling and boundary wiring; dragging alone does not change it. */
  fingerprint: string
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`
}

function withoutPosition(node: FlowNodeSpec): Omit<FlowNodeSpec, "position"> {
  const { position: _position, ...content } = node
  return content
}

/** A selection can span connected boxes or sibling branches under one parent. */
export function inspectFlowCondenseSelection(
  spec: FlowSpec,
  selectedIds: readonly string[],
): FlowCondenseSelection {
  const picked = new Set(selectedIds)
  if (picked.size < 2) throw new Error("Select at least two nodes to condense.")
  const selected = spec.nodes.filter((node) => picked.has(node.id))
  if (selected.length !== picked.size) {
    throw new Error("Some selected nodes are no longer in the diagram. Select them again.")
  }
  if (selected.some((node) => node.shape === "image")) {
    throw new Error("Condense supports text nodes. Leave images out of the selection.")
  }
  if (selected.some((node) => !(node.label.trim() || node.detail?.trim()))) {
    throw new Error("Every selected node needs text before it can be condensed.")
  }

  const edges = spec.edges.filter((edge) => picked.has(edge.from) && picked.has(edge.to))
  const incoming = spec.edges.filter((edge) => !picked.has(edge.from) && picked.has(edge.to))
  const outgoing = spec.edges.filter((edge) => picked.has(edge.from) && !picked.has(edge.to))
  const neighbours = new Map(selected.map((node) => [node.id, new Set<string>()]))
  const indegree = new Map(selected.map((node) => [node.id, 0]))
  const children = new Map(selected.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    neighbours.get(edge.from)!.add(edge.to)
    neighbours.get(edge.to)!.add(edge.from)
    indegree.set(edge.to, indegree.get(edge.to)! + 1)
    children.get(edge.from)!.push(edge.to)
  }
  const componentOf = new Map<string, number>()
  let componentCount = 0
  for (const node of selected) {
    if (componentOf.has(node.id)) continue
    const walk = [node.id]
    while (walk.length > 0) {
      const id = walk.pop()!
      if (componentOf.has(id)) continue
      componentOf.set(id, componentCount)
      for (const neighbour of neighbours.get(id)!) walk.push(neighbour)
    }
    componentCount += 1
  }
  if (componentCount > 1) {
    // A marquee around siblings naturally leaves their shared parent outside.
    // Let that one parent connect the selected components for condensation.
    const parentComponents = new Map<string, Set<number>>()
    for (const edge of incoming) {
      const components = parentComponents.get(edge.from) ?? new Set<number>()
      components.add(componentOf.get(edge.to)!)
      parentComponents.set(edge.from, components)
    }
    if (![...parentComponents.values()].some((components) => components.size === componentCount)) {
      throw new Error("Select connected nodes or branches with the same parent.")
    }
  }

  const order = new Map(selected.map((node, index) => [node.id, index]))
  const ready = selected.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered: string[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!)
    const id = ready.shift()!
    ordered.push(id)
    for (const child of children.get(id)!) {
      const left = indegree.get(child)! - 1
      indegree.set(child, left)
      if (left === 0) ready.push(child)
    }
  }
  // A flow can contain a loop. Its boxes still belong in the supplied context.
  const seen = new Set(ordered)
  for (const node of selected) if (!seen.has(node.id)) ordered.push(node.id)
  const byId = new Map(selected.map((node) => [node.id, node]))
  const nodes = ordered.map((id) => byId.get(id)!)
  const anchor = byId.get(incoming[0]?.to) ?? nodes[0]

  const touching = [...edges, ...incoming, ...outgoing]
  const endpoints = new Set(touching.flatMap((edge) => [edge.from, edge.to]))
  const boundaryNodes = spec.nodes.filter((node) => !picked.has(node.id) && endpoints.has(node.id))
  const fingerprint = stable({
    direction: spec.direction,
    nodes: selected.map(withoutPosition).sort((a, b) => a.id.localeCompare(b.id)),
    boundaryNodes: boundaryNodes.map(withoutPosition).sort((a, b) => a.id.localeCompare(b.id)),
    edges: touching.map((edge) => stable(edge)).sort(),
  })
  return { nodes, edges, incoming, outgoing, anchor, fingerprint }
}

function treeEdges(edges: FlowEdgeSpec[], spec: FlowSpec): FlowTreeEdge[] {
  const sides = defaultFlowSides(spec.direction ?? "down")
  return edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.fromSide ?? sides.from,
    targetHandle: edge.toSide ?? sides.to,
  }))
}

function applyMoves(boxes: FlowTreeBox[], moved: ReadonlyMap<string, FlowPosition>): FlowTreeBox[] {
  return boxes.map((box) => {
    const position = moved.get(box.id)
    return position ? { ...box, ...position } : box
  })
}

/** Replace exactly the selection, keeping every unselected box and its arrows. */
export function replaceFlowSelection(
  spec: FlowSpec,
  selectedIds: readonly string[],
  parts: readonly FlowCondensePart[],
  reservedIds: Iterable<string> = [],
): { spec: FlowSpec; addedIds: string[] } {
  const selection = inspectFlowCondenseSelection(spec, selectedIds)
  if (parts.length === 0) throw new Error("Condense returned no summary nodes. Try again.")
  if (parts.length > 6 || parts.length >= selection.nodes.length) {
    throw new Error("Condense must return one to six nodes, fewer than the selection. Try again.")
  }
  // Include deleted ids: an old selection must never accidentally name a new box.
  // The editor can also reserve ids of unsaved blank text boxes, which are
  // deliberately absent from its serialized spec.
  const taken = new Set([...spec.nodes.map((node) => node.id), ...reservedIds])
  const added: FlowNodeSpec[] = parts.map((part) => {
    const label = normalizeFlowText(part.label)
    const detail = part.detail === undefined ? undefined : normalizeFlowText(part.detail)
    if (!label || label.length > DIAGRAM_TEXT_MAX_LENGTH || (detail?.length ?? 0) > DIAGRAM_TEXT_MAX_LENGTH) {
      throw new Error("Condense returned an empty or overly long node. Try again.")
    }
    const id = nextFlowNodeId(taken, label)
    taken.add(id)
    return { id, label, detail: detail || undefined, shape: "rounded", ai: true }
  })
  const addedIds = added.map((node) => node.id)
  const picked = new Set(selectedIds)
  const keptEdges = spec.edges.filter((edge) => !picked.has(edge.from) && !picked.has(edge.to))
  const boundaryEdges = [
    ...selection.incoming.flatMap((edge) => addedIds.map((id) => ({ ...edge, to: id }))),
    // Surviving continuations follow the final concept in the model's reading order.
    ...selection.outgoing.map((edge) => ({ ...edge, from: addedIds[addedIds.length - 1] })),
  ]
  const boundarySeen = new Set<string>()
  const edges = [...keptEdges, ...boundaryEdges.filter((edge) => {
    const key = stable(edge)
    if (boundarySeen.has(key)) return false
    boundarySeen.add(key)
    return true
  })]

  // Start from the actual canvas even for authored nodes with implicit positions.
  // Otherwise deleting a deep branch would silently relayout unrelated boxes.
  const canvas = layoutDiagram(spec)
  const originalNodes = new Map(spec.nodes.map((node) => [node.id, node]))
  const originalBoxes: FlowTreeBox[] = canvas.nodes.map((node) => ({
    id: node.id,
    ...node.position,
    width: node.width!,
    height: node.height!,
    detached: originalNodes.get(node.id)?.detached,
  }))
  const anchor = originalBoxes.find((box) => box.id === selection.anchor.id)!
  let keptBoxes = originalBoxes.filter((box) => !picked.has(box.id))
  const sides = defaultFlowSides(spec.direction ?? "down")
  const parents = new Set(selection.incoming.map((edge) => edge.from))
  const primary = selection.incoming[0]
  const parent = primary && keptBoxes.find((box) => box.id === primary.from)
  const tabBranch = parents.size === 1 && parent && !parent.detached && !selection.anchor.detached &&
    anchor.x > parent.x &&
    (primary.fromSide ?? sides.from) === "right" &&
    (primary.toSide ?? sides.to) === "left"
  let boxes: FlowTreeBox[]
  if (tabBranch) {
    const children = added.map((node) => ({ id: node.id, ...flowNodeSize(node) }))
    const placement = placeTabChildren(keptBoxes, treeEdges(keptEdges, spec), parent.id, children)
    keptBoxes = applyMoves(keptBoxes, placement.moved)
    boxes = [...keptBoxes, ...children.map((child) => ({ ...child, ...placement.positions.get(child.id)! }))]
    const last = boxes.find((box) => box.id === addedIds[addedIds.length - 1])!
    const byId = new Map(boxes.map((box) => [box.id, box]))
    const continuations = [...new Set(selection.outgoing.filter((edge) => {
      const target = byId.get(edge.to)!
      return (edge.fromSide ?? sides.from) === "right" &&
        (edge.toSide ?? sides.to) === "left" && !target.detached && target.x > last.x &&
        !edges.some((other) => other.to === target.id && other.from !== last.id)
    }).map((edge) => edge.to))]
    const branches = flowBranches(boxes, treeEdges(edges, spec), continuations)
    const relocated = new Set<string>()
    for (const id of continuations) {
      const target = byId.get(id)!
      const dx = last.x + last.width + FLOW_TAB_GAP_X - target.x
      if (dx === 0) continue
      for (const child of [id, ...(branches.get(id) ?? [])]) {
        const box = byId.get(child)!
        byId.set(child, { ...box, x: box.x + dx })
        relocated.add(child)
      }
    }
    boxes = boxes.map((box) => byId.get(box.id)!)
    // Relocated branches, like fresh summaries, need room where they land.
    boxes = applyMoves(boxes, tidyFlowTree(boxes, treeEdges(edges, spec), [parent.id], [...addedIds, ...relocated]))
  } else {
    // Hand-drawn sides and vertical flows do not form the editor's Tab trees.
    // Keep the replacement beside the old anchor and clear each new rectangle.
    // A parentless first summary is the new root, exactly at the old root.
    const firstSize = flowNodeSize(added[0])
    if (parents.size === 0) {
      const root = { id: added[0].id, x: anchor.x, y: anchor.y, ...firstSize }
      const room = tidyFlowTree([...keptBoxes, root], [], [root.id], [root.id])
      keptBoxes = applyMoves(keptBoxes, room)
    }
    boxes = [...keptBoxes]
    let cursor = 0
    for (const node of added) {
      const size = flowNodeSize(node)
      const start = spec.direction === "right"
        ? { x: anchor.x, y: anchor.y + cursor }
        : { x: anchor.x + cursor, y: anchor.y }
      const position = parents.size === 0 && node.id === addedIds[0]
        ? start
        : clearOfBoxes({ ...start, ...size }, boxes)
      boxes.push({ id: node.id, ...position, ...size })
      cursor += spec.direction === "right" ? size.height + FLOW_ROOM_GAP : size.width + FLOW_TAB_GAP_X
    }
  }
  const positions = new Map(boxes.map((box) => [box.id, { x: box.x, y: box.y }]))
  const kept = spec.nodes.filter((node) => !picked.has(node.id)).map((node) => {
    const position = positions.get(node.id)!
    return node.position?.x === position.x && node.position?.y === position.y
      ? node
      : { ...node, position }
  })
  return {
    spec: { ...spec, nodes: [...kept, ...added.map((node) => ({ ...node, position: positions.get(node.id)! }))], edges },
    addedIds,
  }
}
