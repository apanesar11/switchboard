// AI answers on the Flow editor: write a question in a box, press ✦ Answer in
// its toolbar, and the answer comes back as one box — or one per part, when it
// has parts — hanging off the question's right side, laid out the way Tab
// lays out boxes.
// Switchboard: no cap of four (six repos are six boxes), and how much each box
// says is the person's Details: Low (the admin's short box), Medium or High.
//
// This is the pure half, shared by the editor (app/dashboard/diagrams/
// FlowEditor.tsx), the route that calls OpenAI (app/api/diagrams/answer) and
// the tests: which models are offered and which reasoning efforts each takes,
// the person's settings and how a stored copy is sanitised, the request the
// editor sends and how the route checks it, the prompt, and how the model's
// JSON is read back into boxes. Dependency-free apart from sibling pure
// modules, so it runs unchanged in the browser, the route and vitest.

import type { FlowCanvasEdge, FlowCanvasNode } from "./flow-editor"
import { DIAGRAM_TEXT_MAX_LENGTH, FLOW_BOX_TEXT_MAX_LENGTH, type FlowShape } from "./types"

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

/**
 * Switchboard: how much each answer box says. Low is the admin's box — a few
 * words and a short line under them; Medium and High explain under the label.
 */
export const FLOW_AI_DETAILS = ["low", "medium", "high"] as const

export type FlowAiDetails = (typeof FLOW_AI_DETAILS)[number]

export const FLOW_AI_DETAILS_NAMES: Record<FlowAiDetails, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
}

export const DEFAULT_FLOW_AI_DETAILS: FlowAiDetails = "low"

export function isFlowAiDetails(value: unknown): value is FlowAiDetails {
  return typeof value === "string" && (FLOW_AI_DETAILS as readonly string[]).includes(value)
}

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
  /** Switchboard: how much each box says. Unset is the admin's box: Low. */
  details?: FlowAiDetails
}

/**
 * One box of an answer. Switchboard: its label alone — the admin's `detail`, the second
 * line, is never written by an answer here (see BOX_RULES).
 */
export type FlowAiPart = { label: string }

/** What the route answers with. */
export type FlowAiResponse = { parts: FlowAiPart[] } | { error: string }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function tidy(value: unknown, max = DIAGRAM_TEXT_MAX_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  return text.length > 0 ? text.slice(0, max) : undefined
}

/** Switchboard: a box's words, whole — they can run past an arrow's label's length. */
function tidyBox(value: unknown): string | undefined {
  return tidy(value, FLOW_BOX_TEXT_MAX_LENGTH)
}

/** The route's check on what the editor sent. Anything malformed is refused, not repaired. */
export function parseFlowAiRequest(raw: unknown): Parsed<FlowAiRequest> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Invalid request" }
  const body = raw as Record<string, unknown>

  const productId = typeof body.productId === "string" ? body.productId : ""
  if (!productId) return { ok: false, error: "Missing product" }
  const question = tidyBox(body.question)
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
    const label = tidyBox(step.label)
    if (!label) return { ok: false, error: "Invalid context" }
    context.push({ label, detail: tidyBox(step.detail), arrow: tidy(step.arrow) })
  }

  const rawExisting = Array.isArray(body.existing) ? body.existing : []
  if (rawExisting.length > FLOW_AI_MAX_EXISTING) return { ok: false, error: "Too much context" }
  const existing = rawExisting.map((entry) => tidyBox(entry)).filter((entry) => entry !== undefined)

  return {
    ok: true,
    value: {
      productId,
      question,
      detail: tidyBox(body.detail),
      context,
      existing,
      title: tidy(body.title),
      model: body.model,
      effort: body.effort,
      split: body.split,
      details: isFlowAiDetails(body.details) ? body.details : undefined,
    },
  }
}

// ─── the prompt ───

// Switchboard: what a box holds depends on Details, and there is no "at most 4" — a
// part for every separate thing, so a question with six answers gets six boxes.
// Switchboard: a box is its "label" alone. The admin's answers write a second line
// under the label ("detail"); the user found that line unreadable on a board and asked
// that the AI never write one (2026-11-01) — a box an answer writes has one text, and at
// Medium and High that text is the explanation itself. The second line a person adds
// by hand is still drawn, and still goes to the model as part of a question.
const BOX_RULES: Record<FlowAiDetails, string> = {
  low: `- "label": the answer itself, at most 8 words. Plain and specific. No trailing full stop.`,
  medium: `- "label": the answer itself, in two or three full sentences, about 30 to 60 words: what it is, and how it works or why it holds, with the specifics that make it useful.`,
  high: `- "label": the answer itself, in one thorough paragraph of five to eight full sentences, about 90 to 160 words: what it is, how it works or why it holds, the specifics (names, numbers, examples), and any caveat or trade-off that matters.`,
}

// Switchboard: said again with each question, since a CLI's answers on a board are
// one conversation and a level changed since its last answer must win over it.
const BOX_REMINDER: Record<FlowAiDetails, string> = {
  low: "Details: Low. Keep every box short: a label of at most 8 words, and nothing else.",
  medium: "Details: Medium. Every box's label is two or three sentences that explain it (about 30 to 60 words).",
  high: "Details: High. Every box's label is a thorough paragraph that explains it (about 90 to 160 words).",
}

function systemPrompt(details: FlowAiDetails): string {
  return `You help someone think through a flowchart. They wrote a question in one box and want the answer as the next box or boxes, drawn beside it with an arrow from the question.

Each part of your answer becomes one box, whose only text is its "label":
${BOX_RULES[details]}

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
  const details = request.details ?? DEFAULT_FLOW_AI_DETAILS
  lines.push(BOX_REMINDER[details])
  return { system: systemPrompt(details), user: lines.join("\n") }
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
          // Switchboard: no "detail" — an answer's box is its label alone (BOX_RULES).
          properties: {
            label: { type: "string" },
          },
          required: ["label"],
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
 * Switchboard: a box's words whole, as long as a box holds — High's paragraph
 * runs well past an arrow's label's length. And only the label: a "detail" a model
 * writes anyway (a CLI carrying on an older conversation) is left out, never drawn.
 */
export function parseFlowAiAnswer(text: string, split: FlowAiSplit): FlowAiPart[] {
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
    const label = tidyBox(unlinked(part.label))
    if (!label) continue
    parts.push({ label })
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

/** Switchboard: the boxes whose label is none of the flow's words — see flowQuestionPath. */
const FLOW_AI_WORDLESS_SHAPES: ReadonlySet<FlowShape> = new Set<FlowShape>([
  "image",
  "document",
  "terminal",
  "teleport",
  "video",
  "pdf",
  "sheet",
  "timer",
  "widget",
])

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
    const label = tidyBox(from.data.label)
    // An image or an empty note says nothing, but the walk goes on past it.
    // Switchboard: nor does a pinned terminal, whose label is only its workspace, nor a
    // teleport, whose label is only "Teleport", nor a video, whose title is a
    // stranger's words and never part of the question — nor a PDF or a spreadsheet,
    // whose label is only a file's name.
    if (label && !FLOW_AI_WORDLESS_SHAPES.has(from.data.shape)) {
      path.push({ label, detail: tidyBox(from.data.detail), arrow })
      carried = undefined
    } else {
      carried = arrow
    }
    current = from.id
  }
  return path.reverse()
}
