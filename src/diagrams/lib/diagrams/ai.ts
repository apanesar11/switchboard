// AI answers on the Flow editor: write a question in a box, press ✦ Answer in
// its toolbar, and the answer comes back as one box — or one per part, when it
// has parts — hanging off the question's right side, laid out the way Tab
// lays out boxes.
// Switchboard: no cap of four (six repos are six boxes), and the line of detail
// under each box only when Subtext is on.
//
// This is the pure half, shared by the editor (app/dashboard/diagrams/
// FlowEditor.tsx), the route that calls OpenAI (app/api/diagrams/answer) and
// the tests: which models are offered and which reasoning efforts each takes,
// the person's settings and how a stored copy is sanitised, the request the
// editor sends and how the route checks it, the prompt, and how the model's
// JSON is read back into boxes. Dependency-free apart from sibling pure
// modules, so it runs unchanged in the browser, the route and vitest.

import type { FlowCanvasEdge, FlowCanvasNode } from "./flow-editor"
import { DIAGRAM_TEXT_MAX_LENGTH } from "./types"

// ─── models and effort ───

/** OpenAI's reasoning efforts, least to most. Not every model takes all six. */
export const FLOW_AI_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const

export type FlowAiEffort = (typeof FLOW_AI_EFFORTS)[number]

export const FLOW_AI_EFFORT_NAMES: Record<FlowAiEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
}

/**
 * The models on offer, newest family first. Each one's `efforts` is what the
 * Responses API accepted for it when probed (2026-10-03): Astra and Sol refuse
 * "none"; none of them take "minimal", which is why it isn't offered at all.
 */
export const FLOW_AI_MODELS = [
  { id: "gpt-6-astra", name: "Astra", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
  {
    id: "gpt-5.6-terra",
    name: "Terra",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-6-luna",
    name: "Luna",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
] as const satisfies readonly {
  id: string
  name: string
  efforts: readonly FlowAiEffort[]
}[]

export type FlowAiModelId = (typeof FLOW_AI_MODELS)[number]["id"]

export const DEFAULT_FLOW_AI_MODEL: FlowAiModelId = "gpt-5.6-terra"
export const DEFAULT_FLOW_AI_EFFORT: FlowAiEffort = "medium"

export function flowAiModel(id: string) {
  return FLOW_AI_MODELS.find((model) => model.id === id)
}

export function isFlowAiModelId(value: unknown): value is FlowAiModelId {
  return typeof value === "string" && flowAiModel(value) !== undefined
}

export function isFlowAiEffort(value: unknown): value is FlowAiEffort {
  return typeof value === "string" && (FLOW_AI_EFFORTS as readonly string[]).includes(value)
}

export function modelTakesEffort(model: FlowAiModelId, effort: FlowAiEffort): boolean {
  return (flowAiModel(model)?.efforts as readonly FlowAiEffort[] | undefined)?.includes(effort) ?? false
}

/**
 * `effort` if `model` takes it, otherwise the nearest level it does — so
 * switching from Terra at None to Astra lands on Low rather than failing.
 */
export function effortFor(model: FlowAiModelId, effort: FlowAiEffort): FlowAiEffort {
  if (modelTakesEffort(model, effort)) return effort
  const wanted = FLOW_AI_EFFORTS.indexOf(effort)
  const offered = (flowAiModel(model)?.efforts ?? []) as readonly FlowAiEffort[]
  let best: FlowAiEffort = DEFAULT_FLOW_AI_EFFORT
  let distance = Infinity
  for (const option of offered) {
    const gap = Math.abs(FLOW_AI_EFFORTS.indexOf(option) - wanted)
    if (gap < distance) {
      best = option
      distance = gap
    }
  }
  return best
}

// ─── settings ───

/** "auto": the model splits an answer into a box per part when it has parts. */
export const FLOW_AI_SPLITS = ["auto", "one"] as const

export type FlowAiSplit = (typeof FLOW_AI_SPLITS)[number]

export type FlowAiSettings = {
  model: FlowAiModelId
  effort: FlowAiEffort
  split: FlowAiSplit
  /** Send the boxes leading up to the question along with it. */
  context: boolean
}

export const DEFAULT_FLOW_AI_SETTINGS: FlowAiSettings = {
  model: DEFAULT_FLOW_AI_MODEL,
  effort: DEFAULT_FLOW_AI_EFFORT,
  split: "auto",
  context: true,
}

/** Where the editor keeps them: this browser, for every diagram. */
// Switchboard: unused here (ai-client.ts keeps the settings in main), and renamed
// so the admin's name is not in this repository.
export const FLOW_AI_SETTINGS_KEY = "diagrams.ai-settings.v1"

/**
 * Settings read back from storage, made safe: anything missing or no longer
 * valid (a model since retired, an effort the model doesn't take) falls back
 * to the default, or the nearest level that model does take.
 */
export function sanitizeFlowAiSettings(raw: unknown): FlowAiSettings {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const model = isFlowAiModelId(value.model) ? value.model : DEFAULT_FLOW_AI_SETTINGS.model
  const effort = isFlowAiEffort(value.effort) ? value.effort : DEFAULT_FLOW_AI_SETTINGS.effort
  return {
    model,
    effort: effortFor(model, effort),
    split: value.split === "one" ? "one" : "auto",
    context: typeof value.context === "boolean" ? value.context : DEFAULT_FLOW_AI_SETTINGS.context,
  }
}

// ─── the request ───

/**
 * Switchboard: not a cap on the answer — the prompt asks for a part per item, however
 * many that is — only a backstop against a runaway list from a confused model.
 */
export const FLOW_AI_MAX_PARTS = 40
/** How many boxes leading up to the question go along as context. */
export const FLOW_AI_MAX_CONTEXT = 12
/**
 * How many boxes already hanging off the question are named, so they aren't repeated.
 * Switchboard: as many as one answer can add, now that it can add more than four.
 */
export const FLOW_AI_MAX_EXISTING = FLOW_AI_MAX_PARTS

/** One box on the way to the question, and the label of the arrow out of it. */
export type FlowAiStep = { label: string; detail?: string; arrow?: string }

export type FlowAiRequest = {
  productId: string
  question: string
  detail?: string
  /** The boxes leading up to the question, the first one first. */
  context: FlowAiStep[]
  /** What already hangs off the question's right side. */
  existing: string[]
  /** The diagram's title, when it has one. */
  title?: string
  model: FlowAiModelId
  effort: FlowAiEffort
  split: FlowAiSplit
  /** Switchboard: a line of detail under each box. Unset is the admin's: yes. */
  subtext?: boolean
}

export type FlowAiPart = { label: string; detail?: string }

/** What the route answers with. */
export type FlowAiResponse = { parts: FlowAiPart[] } | { error: string }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function tidy(value: unknown, max = DIAGRAM_TEXT_MAX_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  return text.length > 0 ? text.slice(0, max) : undefined
}

/** The route's check on what the editor sent. Anything malformed is refused, not repaired. */
export function parseFlowAiRequest(raw: unknown): Parsed<FlowAiRequest> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Invalid request" }
  const body = raw as Record<string, unknown>

  const productId = typeof body.productId === "string" ? body.productId : ""
  if (!productId) return { ok: false, error: "Missing product" }
  const question = tidy(body.question)
  if (!question) return { ok: false, error: "Write a question in the box first" }
  if (!isFlowAiModelId(body.model)) return { ok: false, error: "Unknown model" }
  if (!isFlowAiEffort(body.effort) || !modelTakesEffort(body.model, body.effort)) {
    return { ok: false, error: "That model doesn't take that effort" }
  }
  if (body.split !== "auto" && body.split !== "one") {
    return { ok: false, error: "Invalid answer shape" }
  }

  const rawContext = Array.isArray(body.context) ? body.context : []
  if (rawContext.length > FLOW_AI_MAX_CONTEXT) return { ok: false, error: "Too much context" }
  const context: FlowAiStep[] = []
  for (const entry of rawContext) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "Invalid context" }
    const step = entry as Record<string, unknown>
    const label = tidy(step.label)
    if (!label) return { ok: false, error: "Invalid context" }
    context.push({ label, detail: tidy(step.detail), arrow: tidy(step.arrow) })
  }

  const rawExisting = Array.isArray(body.existing) ? body.existing : []
  if (rawExisting.length > FLOW_AI_MAX_EXISTING) return { ok: false, error: "Too much context" }
  const existing = rawExisting.map((entry) => tidy(entry)).filter((entry) => entry !== undefined)

  return {
    ok: true,
    value: {
      productId,
      question,
      detail: tidy(body.detail),
      context,
      existing,
      title: tidy(body.title),
      model: body.model,
      effort: body.effort,
      split: body.split,
    },
  }
}

// ─── the prompt ───

// Switchboard: the detail line depends on Subtext, and there is no "at most 4" — a part
// for every separate thing, so a question with six answers gets six boxes.
function systemPrompt(subtext: boolean): string {
  return `You help someone think through a flowchart. They wrote a question in one box and want the answer as the next box or boxes, drawn to the right of it with an arrow from the question.

Each part of your answer becomes one box:
- "label": the answer itself, at most 8 words. Plain and specific. No trailing full stop.
${
  subtext
    ? `- "detail": one short supporting line, at most 12 words, or "" when the label says it all.`
    : `- "detail": always "". The boxes have no second line, so the label has to stand on its own.`
}

When the answer has separate parts — items, reasons, options, steps or outcomes — give one part for each of them, as many as there are: a list of six things is six parts. Never put two of them in one part. Keep their natural order, or put the most important first. When the answer is a single thing, give exactly one part.

If the box isn't a question, treat it as a topic and give what follows from it, or its main parts.

Use the boxes leading up to the question as context: the arrow labels say which way the flow went. Don't repeat anything already hanging off the question.

Plain text only — no markdown, numbering, emoji or surrounding quotes.`
}

/** The system and user messages for one request. */
export function flowAiPrompt(request: FlowAiRequest): { system: string; user: string } {
  const lines: string[] = []
  if (request.title) lines.push(`Diagram: ${request.title}`)
  if (request.context.length > 0) {
    lines.push("Boxes leading to the question, first to last:")
    for (const step of request.context) {
      lines.push(`- ${step.label}${step.detail ? ` (${step.detail})` : ""}`)
      if (step.arrow) lines.push(`  then, via the arrow "${step.arrow}":`)
    }
  }
  // The question straight after the last box's arrow, which leads into it.
  lines.push(`The question box: ${request.question}`)
  if (request.detail) lines.push(`Its second line: ${request.detail}`)
  if (request.existing.length > 0) {
    lines.push(`Already hanging off the question: ${request.existing.join("; ")}`)
  }
  lines.push(
    request.split === "one"
      ? "Answer in exactly one part."
      : "Answer in as many parts as the answer has: one for each separate thing.",
  )
  return { system: systemPrompt(request.subtext !== false), user: lines.join("\n") }
}

/** The Responses API structured-output format the answer must come back in. */
export const FLOW_AI_TEXT_FORMAT = {
  type: "json_schema",
  name: "flow_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      parts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            detail: { type: "string" },
          },
          required: ["label", "detail"],
        },
      },
    },
    required: ["parts"],
  },
} as const

/**
 * Switchboard: a box's text without the links a model that went on the web may leave
 * in it despite being told not to — a citation "([site](https://…))" goes, and a link
 * "[words](https://…)" keeps its words.
 */
function unlinked(value: unknown): unknown {
  if (typeof value !== "string") return value
  // An address may hold one level of brackets of its own: …/wiki/Rust_(programming_language).
  return value
    .replace(/\s*\(\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*\)\)/g, "")
    .replace(/\[([^\]]*)\]\((?:https?:)?\/\/(?:[^()\s]|\([^()\s]*\))*\)/g, "$1")
}

/**
 * The model's JSON read back into boxes: text tidied the way the spec
 * validator would, empty parts dropped, at most FLOW_AI_MAX_PARTS (one for
 * "one"). Throws when nothing usable came back.
 * Switchboard: without `subtext`, no detail line, whatever the model wrote there.
 */
export function parseFlowAiAnswer(text: string, split: FlowAiSplit, subtext = true): FlowAiPart[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("The model's answer wasn't readable — try again.")
  }
  const raw =
    typeof data === "object" && data !== null && Array.isArray((data as { parts?: unknown }).parts)
      ? ((data as { parts: unknown[] }).parts)
      : []
  const parts: FlowAiPart[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const part = entry as Record<string, unknown>
    const label = tidy(unlinked(part.label))
    if (!label) continue
    parts.push({ label, detail: subtext ? tidy(unlinked(part.detail)) : undefined })
  }
  if (parts.length === 0) throw new Error("The model came back without an answer — try again.")
  return parts.slice(0, split === "one" ? 1 : FLOW_AI_MAX_PARTS)
}

// ─── reading the canvas ───

/**
 * The arrows that loop back — "try again" from further on to a box before it.
 * Found the way a depth-first walk finds them: walking forward from where the
 * flow starts (boxes nothing points into), an arrow into a box still being
 * walked from is one that goes back. A flow with no such start (one big loop)
 * is walked from its left-most, then top-most box. Arrows are followed in
 * the same layout order, so the answer doesn't depend on which was drawn first.
 */
function loopBacks(
  nodes: Pick<FlowCanvasNode, "id" | "position">[],
  edges: Pick<FlowCanvasEdge, "source" | "target">[],
): Set<Pick<FlowCanvasEdge, "source" | "target">> {
  const ids = new Set(nodes.map((node) => node.id))
  const out = new Map<string, Pick<FlowCanvasEdge, "source" | "target">[]>()
  const into = new Set<string>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    out.set(edge.source, [...(out.get(edge.source) ?? []), edge])
    if (edge.source !== edge.target) into.add(edge.target)
  }
  // Walked in layout order — left to right, then top to bottom — so which
  // arrow counts as the loop-back doesn't depend on which was drawn first.
  const at = new Map(nodes.map((node) => [node.id, node.position]))
  const byPlace = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x - b.x || a.y - b.y
  for (const list of out.values()) {
    list.sort((a, b) => byPlace(at.get(a.target)!, at.get(b.target)!))
  }
  const sorted = [...nodes].sort((a, b) => byPlace(a.position, b.position))
  const roots = [...sorted.filter((node) => !into.has(node.id)), ...sorted]
  const state = new Map<string, "walking" | "done">()
  const back = new Set<Pick<FlowCanvasEdge, "source" | "target">>()
  function walk(id: string) {
    state.set(id, "walking")
    for (const edge of out.get(id) ?? []) {
      const next = state.get(edge.target)
      if (next === "walking") back.add(edge)
      else if (next === undefined) walk(edge.target)
    }
    state.set(id, "done")
  }
  for (const root of roots) if (!state.has(root.id)) walk(root.id)
  return back
}

/**
 * The boxes leading up to `id`, the first one first: back along the arrow
 * that comes into each box's left side (the one Tab draws), or failing that
 * any arrow in — the same way Shift+Tab steps back — but never along an arrow
 * that loops back (see loopBacks), so what comes after the question isn't
 * sent as what led to it. Stops at the start of the flow, where only a loop
 * comes in, or after FLOW_AI_MAX_CONTEXT boxes.
 */
export function flowQuestionPath(
  nodes: Pick<FlowCanvasNode, "id" | "data" | "position">[],
  edges: Pick<FlowCanvasEdge, "source" | "target" | "targetHandle" | "data">[],
  id: string,
): FlowAiStep[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const back = loopBacks(nodes, edges)

  const path: FlowAiStep[] = []
  const seen = new Set([id])
  // The label of an arrow out of a box that was passed over, kept for the
  // next box that is sent, so "No" isn't lost along with a picture.
  let carried: string | undefined
  let current = id
  while (path.length < FLOW_AI_MAX_CONTEXT) {
    const incoming = edges.filter(
      (edge) =>
        edge.target === current &&
        !back.has(edge) &&
        !seen.has(edge.source) &&
        byId.has(edge.source),
    )
    const edge = incoming.find((candidate) => candidate.targetHandle === "left") ?? incoming[0]
    if (!edge) break
    const from = byId.get(edge.source)!
    seen.add(from.id)
    const arrow = [tidy(edge.data?.label), carried].filter(Boolean).join(" → ") || undefined
    const label = tidy(from.data.label)
    // An image or an empty note says nothing, but the walk goes on past it.
    if (label && from.data.shape !== "image" && from.data.shape !== "document") {
      path.push({ label, detail: tidy(from.data.detail), arrow })
      carried = undefined
    } else {
      carried = arrow
    }
    current = from.id
  }
  return path.reverse()
}
