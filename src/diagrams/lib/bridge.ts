// The window.sb calls the Diagrams bundle makes — src/preload.js defines them, and
// src/main/index.js answers them (ARCHITECTURE §4.17, §4.18). Every one resolves to a
// value; a failure is { ok: false, error }, never a rejection, exactly as main answers.

import type { DiagramDetail, DiagramSummary } from "./diagrams/types"

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

/** What a CLI is doing while it answers, a line at a time — main/answer.js claudeStep(). */
export type AnswerStep = {
  kind: "read" | "search" | "list" | "run" | "think" | "write" | "fetch" | "web" | "other"
  text: string
  target?: string
}

export type ProviderId = "claude-code" | "codex" | "claude-api" | "openai-api"

export type Choice = { id: string; name: string }

export type ModelChoice = Choice & { efforts?: Choice[] }

/** One way to answer, as main sees it on this Mac right now. */
export type ProviderStatus = {
  id: ProviderId
  name: string
  kind: "cli" | "api"
  /** Can it answer now: a CLI that is here (and not signed out), an API with a key. */
  ready: boolean
  state: "ready" | "missing" | "signed-out" | "no-key"
  /** The one line the Settings screen shows: "Installed · 2.1.288 · signed in". */
  line: string
  installed?: boolean
  signedIn?: boolean | null
  version?: string | null
  hasKey?: boolean
  last4?: string | null
  models?: ModelChoice[]
  model?: string
  efforts?: Choice[]
  effort?: string
}

export type AnswerSettings = {
  /** Who answers — never null here: main fills in the first one that is ready. */
  provider: ProviderId
  /** What the user picked, or null while main is choosing for them. */
  chosen: ProviderId | null
  split: "auto" | "one"
  context: boolean
  /** Web access: whoever answers may open a link or search the web, when it needs to. */
  web: boolean
  /** A line of detail under each answer box. */
  subtext: boolean
  claudeCodeEffort: string
  claudeApiModel: string
  openaiModel: string
  openaiEffort: string
}

export type AnswerStatus = {
  ok: true
  settings: AnswerSettings
  providers: ProviderStatus[]
  keysSafe: boolean
}

export type AnswerResult =
  | { ok: true; text: string; files?: number }
  | { ok: false; error: string; code?: "missing" | "signed-out" | "no-key" | "bad-key" | "timeout" | "stopped" }

/**
 * A picture main fetched for the canvas, from an address dragged or offered out of
 * the Google Images panel. Always one of the three types a diagram keeps — main
 * converts anything else it can read to PNG — and `name` is a short label taken
 * from the address, or "Image".
 */
export type FetchedImage =
  | { ok: true; bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp"; name: string }
  | { ok: false; error: string }

/**
 * "Add Image to Diagram", picked in the right-click menu of a picture in the Google
 * Images panel. `guestId` is the panel page's webContents id, which the panel
 * compares with its own <webview>'s, and `referrer` the page the picture was on. On
 * one of Google's results `url` is the full picture and `fallback` its thumbnail, to
 * add instead should the full one not come; "" otherwise.
 */
export type ImageOffer = { guestId: number; url: string; fallback?: string; referrer: string }

type Bridge = {
  diagramsList(wsId: string): Promise<Result<DiagramSummary[]>>
  diagramsGet(wsId: string, id: string): Promise<Result<DiagramSummary & { spec: unknown }>>
  diagramsCreate(wsId: string, name: string, spec: unknown): Promise<Result<DiagramDetail>>
  diagramsUpdate(wsId: string, id: string, name: string, spec: unknown): Promise<Result<DiagramDetail>>
  diagramsArchive(wsId: string, id: string, archived: boolean): Promise<Result<DiagramSummary>>
  diagramsDelete(wsId: string, id: string): Promise<Result<{ id: string }>>
  diagramsSaveImage(bytes: Uint8Array, type: string): Promise<{ ok: true; src: string } | { ok: false; error: string }>
  diagramsClipboardImage(): Promise<{ ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string }>
  diagramsDirty(count: number): Promise<unknown>
  writeClipboard(text: string): Promise<unknown>
  answerStatus(opts?: { fresh?: boolean }): Promise<AnswerStatus | { ok: false; error: string }>
  answerSetSettings(patch: Partial<AnswerSettings>): Promise<AnswerStatus | { ok: false; error: string }>
  answerStart(
    id: string,
    req: { provider: ProviderId; wsId: string; system: string; user: string; schema: unknown; operation?: "condense" },
  ): Promise<AnswerResult>
  answerStop(id: string): Promise<unknown>
  onAnswerStep(cb: (id: string, step: AnswerStep) => void): () => void
  onAnswerStatus(cb: (status: AnswerStatus) => void): () => void
  diagramsFetchImage(url: string, referrer?: string): Promise<FetchedImage>
  onDiagramsImageOffer(cb: (offer: ImageOffer) => void): () => void
  openExternal(url: string): Promise<{ ok: true } | { ok: false; error: string }>
}

declare global {
  interface Window {
    sb?: Partial<Bridge>
  }
}

const MISSING = "this build of Switchboard has no diagrams"

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "")
  return (
    text
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/^(?:Uncaught )?Error:\s*/, "")
      .trim() || "that did not work"
  )
}

/**
 * One bridge call: feature-checked (a preload from before the Diagrams tab has none of
 * these), and settled as a value, never a rejection.
 */
export async function call<K extends keyof Bridge>(
  name: K,
  ...args: Parameters<Bridge[K]>
): Promise<Awaited<ReturnType<Bridge[K]>> | { ok: false; error: string }> {
  const api = window.sb
  const fn = api?.[name] as ((...a: unknown[]) => unknown) | undefined
  if (typeof fn !== "function") return { ok: false, error: MISSING }
  try {
    const out = (await fn.apply(api, args)) as Awaited<ReturnType<Bridge[K]>> | null
    if (out && typeof out === "object") return out
    return { ok: false, error: "the app process did not answer" }
  } catch (err) {
    return { ok: false, error: message(err) }
  }
}

/**
 * Puts `text` on the system clipboard, through main — a page can't write it outside a
 * gesture, and an Edit menu item arriving over IPC is not one.
 */
export function writeClipboard(text: string): void {
  void call("writeClipboard", text)
}

/** A push event's subscription, or a no-op when the preload has none. */
export function listen<K extends "onAnswerStep" | "onAnswerStatus" | "onDiagramsImageOffer">(
  name: K,
  cb: Parameters<Bridge[K]>[0],
): () => void {
  const fn = window.sb?.[name] as ((callback: unknown) => () => void) | undefined
  if (typeof fn !== "function") return () => {}
  try {
    return fn(cb)
  } catch {
    return () => {}
  }
}
