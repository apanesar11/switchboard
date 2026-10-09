// Switchboard's ai-client — in place of the admin's, which keeps the person's model
// and effort in localStorage and posts to /api/diagrams/answer. Here both live in
// main (src/main/answer.js): who answers and how is a property of this Mac, shared by
// the ✦ Answer menu and the Settings screen, and the asking is a CLI or an API call
// that only main can make. This module is the editor's way to both.
//
//   useAnswerStatus()            who can answer on this Mac, and the settings
//   updateAnswerSettings(patch)  change them (the menu; Settings uses the bridge too)
//   requestFlowAnswer(…)         ask, with every step a CLI takes reported as it goes
//   requestFlowCondense(…)       summarize a selection before the editor replaces it

import { useSyncExternalStore } from "react"
import { call, listen, type AnswerStatus, type AnswerStep, type ProviderId, type ProviderStatus } from "../bridge"
import { parseFlowAiAnswer, type FlowAiPart } from "./ai"
import {
  answerPrompt,
  condensePrompt,
  parseFlowCondenseAnswer,
  FLOW_ANSWER_SCHEMA,
  type FlowCondenseRequest,
  type FlowQuestion,
} from "./answer"

// ─── who can answer ───

let status: AnswerStatus | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function adopt(next: unknown) {
  if (next && typeof next === "object" && (next as { ok?: unknown }).ok === true) {
    status = next as AnswerStatus
    emit()
  }
}

/** Ask main again — `fresh` looks for the CLIs again rather than trusting the last look. */
export function refreshAnswerStatus(fresh = false): Promise<void> {
  if (loading && !fresh) return loading
  loading = call("answerStatus", { fresh }).then(adopt, () => {}).finally(() => {
    loading = null
  })
  return loading
}

// Main announces every change, wherever it was made — the Settings screen included.
let subscribed = false
function subscribe(listener: () => void): () => void {
  if (!subscribed) {
    subscribed = true
    listen("onAnswerStatus", adopt)
  }
  listeners.add(listener)
  if (status === null) void refreshAnswerStatus()
  return () => listeners.delete(listener)
}

/** Who can answer, and the settings; null until main has said. */
export function useAnswerStatus(): AnswerStatus | null {
  return useSyncExternalStore(subscribe, () => status, () => null)
}

export function providerStatus(id: ProviderId): ProviderStatus | null {
  return status?.providers.find((provider) => provider.id === id) ?? null
}

export async function updateAnswerSettings(patch: Partial<AnswerStatus["settings"]>): Promise<void> {
  // Applied here first, so the menu answers the click at once.
  if (status) {
    status = { ...status, settings: { ...status.settings, ...patch } }
    emit()
  }
  adopt(await call("answerSetSettings", patch))
}

// ─── the asking ───

/** A failed answer, with what main said about why (bridge.ts AnswerResult). */
export class AnswerError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Ask `provider` the question, from workspace `wsId` — the whiteboard's, which a CLI
 * reads; null when the whiteboard has none (main then refuses a CLI with
 * "no-workspace", and an API never reads one anyway). Resolves to the boxes, and how
 * many files a CLI read on the way; rejects with an AnswerError — or with an AbortError
 * when `signal` (the editor's Stop) cancels it, which stops the CLI or the request in
 * main too.
 */
export async function requestFlowAnswer(
  ask: { provider: ProviderStatus; wsId: string | null; question: FlowQuestion },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ parts: FlowAiPart[]; files: number | null }> {
  const result = await requestAnswer(ask, answerPrompt(ask.question, ask.provider.kind), signal, onStep)
  return {
    parts: parseFlowAiAnswer(result.text, ask.question.split, ask.question.subtext !== false),
    files: result.files,
  }
}

/**
 * Reject malformed output before the editor receives replacement boxes. Condense
 * reads nothing, so `wsId` may be null even for a CLI: main runs it in a scratch
 * folder then.
 */
export async function requestFlowCondense(
  ask: { provider: ProviderStatus; wsId: string | null; selection: FlowCondenseRequest },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ parts: FlowAiPart[]; files: number | null }> {
  const result = await requestAnswer({ ...ask, operation: "condense" }, condensePrompt(ask.selection, ask.provider.kind), signal, onStep)
  return { parts: parseFlowCondenseAnswer(result.text, ask.selection), files: result.files }
}

/** Both operations share request ids, provider errors, progress, and Stop cleanup. */
async function requestAnswer(
  ask: { provider: ProviderStatus; wsId: string | null; operation?: "condense" },
  prompt: { system: string; user: string },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ text: string; files: number | null }> {
  if (signal.aborted) throw new DOMException("Stopped", "AbortError")
  const id = newId()
  const off = listen("onAnswerStep", (from, step) => {
    if (from === id && !signal.aborted) onStep(step)
  })
  const stop = () => void call("answerStop", id)
  signal.addEventListener("abort", stop, { once: true })
  try {
    const result = await call("answerStart", id, {
      provider: ask.provider.id,
      wsId: ask.wsId,
      ...(ask.operation ? { operation: ask.operation } : {}),
      ...prompt,
      schema: FLOW_ANSWER_SCHEMA,
    })
    if (signal.aborted) throw new DOMException("Stopped", "AbortError")
    if (!result.ok) throw new AnswerError(result.error, "code" in result ? result.code : undefined)
    return {
      text: result.text,
      files: "files" in result && typeof result.files === "number" ? result.files : null,
    }
  } finally {
    off()
    signal.removeEventListener("abort", stop)
  }
}
