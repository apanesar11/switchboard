// Switchboard's ai-client — in place of the admin's, which keeps the person's model
// and effort in localStorage and posts to /api/diagrams/answer. Here both live in
// main (src/main/answer.js): who answers and how is a property of this Mac, shared by
// the ✦ Answer menu and the Settings screen, and the asking is a CLI or an API call
// that only main can make. This module is the editor's way to both.
//
//   useAnswerStatus()            who can answer on this Mac, and the settings
//   updateAnswerSettings(patch)  change them (the menu; Settings uses the bridge too)
//   useBoardConversation(id)     a whiteboard's conversation with each CLI
//   resetBoardConversation(…)    New conversation: the next answer starts one
//   requestFlowAnswer(…)         ask, with every step a CLI takes reported as it goes
//   requestFlowCondense(…)       summarize a selection before the editor replaces it

import { useSyncExternalStore } from "react"
import {
  call,
  listen,
  type AnswerStatus,
  type AnswerStep,
  type ConversationInfo,
  type ConversationProvider,
  type ProviderId,
  type ProviderStatus,
} from "../bridge"
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

// ─── the whiteboard's conversation ───

// A CLI's answers on one whiteboard are one conversation: main keeps one with Claude
// Code and one with Codex for each board, and every answer after the first resumes
// it, so the CLI knows the branches already explored. An API's answers each stand
// alone, and condense is never part of one. What main last said about a board's, for
// the who-answers menu: asked again as the menu opens, after a CLI's answer on the
// board, and after New conversation.

// `alone`: a CLI that answers each question on its own on this Mac — a Codex too old to
// resume a conversation — whose answers keep none.
export type BoardConversations = Record<ConversationProvider, ConversationInfo | null> & {
  alone?: ConversationProvider[]
}

// By board id: missing until main has been asked, null when it couldn't say.
const conversations = new Map<string, BoardConversations | null>()
// Counts each board's askings and changes, so only the newest word on a board is
// kept — main's reply to an older asking never undoes New conversation.
const conversationEpochs = new Map<string, number>()
const conversationListeners = new Set<() => void>()

function nextEpoch(boardId: string): number {
  const epoch = (conversationEpochs.get(boardId) ?? 0) + 1
  conversationEpochs.set(boardId, epoch)
  return epoch
}

function adoptConversations(boardId: string, next: BoardConversations | null) {
  conversations.set(boardId, next)
  for (const listener of conversationListeners) listener()
}

function subscribeConversations(listener: () => void): () => void {
  conversationListeners.add(listener)
  return () => conversationListeners.delete(listener)
}

/** Ask main again about `boardId`'s conversations. */
export function refreshBoardConversation(boardId: string): Promise<void> {
  const epoch = nextEpoch(boardId)
  return call("answerConversation", boardId).then((result) => {
    if (conversationEpochs.get(boardId) !== epoch) return
    adoptConversations(
      boardId,
      result.ok && result.data
        ? {
            "claude-code": result.data["claude-code"] ?? null,
            codex: result.data.codex ?? null,
            ...(Array.isArray(result.alone) && result.alone.length ? { alone: result.alone } : {}),
          }
        : null,
    )
  })
}

/**
 * A board's conversation with each CLI: undefined until main has said, null when it
 * couldn't (a build without conversations). Asks nothing itself — the menu refreshes
 * as it opens.
 */
export function useBoardConversation(boardId: string): BoardConversations | null | undefined {
  return useSyncExternalStore(subscribeConversations, () => conversations.get(boardId), () => undefined)
}

/** New conversation: the board's next answer from `provider` (from either, left out) starts one. */
export async function resetBoardConversation(
  boardId: string,
  provider?: ConversationProvider,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Gone here first, so the menu answers the click at once; main's word follows.
  nextEpoch(boardId)
  const known = conversations.get(boardId)
  if (known) adoptConversations(boardId, { ...known, ...(provider ? { [provider]: null } : { "claude-code": null, codex: null }) })
  const result = provider
    ? await call("answerResetConversation", boardId, provider)
    : await call("answerResetConversation", boardId)
  void refreshBoardConversation(boardId)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
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

/** The board's conversation an answer went into (bridge.ts AnswerResult). */
export type AnswerConversation = { turns: number; resumed: boolean }

/**
 * Ask `provider` the question, from workspace `wsId` — the whiteboard's, which a CLI
 * reads; null when the whiteboard has none (main then refuses a CLI with
 * "no-workspace", and an API never reads one anyway). Resolves to the boxes, how
 * many files a CLI read on the way, and — for a CLI asked with the whiteboard's
 * `boardId` — the board's conversation the answer went into; rejects with an
 * AnswerError — or with an AbortError when `signal` (the editor's Stop) cancels it,
 * which stops the CLI or the request in main too (or takes it out of the queue,
 * while it waits its turn behind another answer on the board).
 */
export async function requestFlowAnswer(
  ask: { provider: ProviderStatus; wsId: string | null; boardId?: string | null; question: FlowQuestion },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ parts: FlowAiPart[]; files: number | null; conversation: AnswerConversation | null }> {
  const boardId = typeof ask.boardId === "string" ? ask.boardId : undefined
  try {
    const result = await requestAnswer(
      { provider: ask.provider, wsId: ask.wsId, boardId },
      answerPrompt(ask.question, ask.provider.kind),
      signal,
      onStep,
    )
    return {
      parts: parseFlowAiAnswer(result.text, ask.question.split, ask.question.subtext !== false),
      files: result.files,
      conversation: result.conversation,
    }
  } finally {
    // The answer started the board's conversation, or added to it — or, stopped or
    // failed, perhaps not: main says which.
    if (boardId !== undefined && ask.provider.kind === "cli") void refreshBoardConversation(boardId)
  }
}

/**
 * Reject malformed output before the editor receives replacement boxes. Condense
 * reads nothing, so `wsId` may be null even for a CLI: main runs it in a scratch
 * folder then. Nor is it ever part of the board's conversation, so it sends no
 * board.
 */
export async function requestFlowCondense(
  ask: { provider: ProviderStatus; wsId: string | null; selection: FlowCondenseRequest },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ parts: FlowAiPart[]; files: number | null }> {
  const result = await requestAnswer(
    { provider: ask.provider, wsId: ask.wsId, operation: "condense" },
    condensePrompt(ask.selection, ask.provider.kind),
    signal,
    onStep,
  )
  return { parts: parseFlowCondenseAnswer(result.text, ask.selection), files: result.files }
}

/** Both operations share request ids, provider errors, progress, and Stop cleanup. */
async function requestAnswer(
  ask: { provider: ProviderStatus; wsId: string | null; boardId?: string; operation?: "condense" },
  prompt: { system: string; user: string },
  signal: AbortSignal,
  onStep: (step: AnswerStep) => void,
): Promise<{ text: string; files: number | null; conversation: AnswerConversation | null }> {
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
      ...(ask.boardId !== undefined ? { boardId: ask.boardId } : {}),
      ...(ask.operation ? { operation: ask.operation } : {}),
      ...prompt,
      schema: FLOW_ANSWER_SCHEMA,
    })
    if (signal.aborted) throw new DOMException("Stopped", "AbortError")
    if (!result.ok) throw new AnswerError(result.error, "code" in result ? result.code : undefined)
    const conversation = "conversation" in result ? result.conversation : undefined
    return {
      text: result.text,
      files: "files" in result && typeof result.files === "number" ? result.files : null,
      conversation:
        conversation && typeof conversation.turns === "number"
          ? { turns: conversation.turns, resumed: conversation.resumed === true }
          : null,
    }
  } finally {
    off()
    signal.removeEventListener("abort", stop)
  }
}
