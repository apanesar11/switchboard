// The window.sb calls the whiteboard bundle makes — src/preload.js defines them, and
// src/main/index.js answers them from src/main/whiteboards.js (ARCHITECTURE §4.17,
// §4.18). Every one resolves to a value; a failure is { ok: false, error }, never a
// rejection, exactly as main answers.
//
// A whiteboard is addressed by its own id alone. It belongs to a FOLDER the user made
// (or none), not to a workspace: `workspace` on a board is only the one ✦ Answer reads,
// and the board can be moved between folders without its id or its files changing.

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

/**
 * One whiteboard as a list shows it — never its spec. `boxes` counts the boxes on it
 * (pinned terminals left out), `reads` the workspaces its answers read, and `thumb` up
 * to 14 rectangles `[x, y, w, h]` inside a 40×30 box, for the list's small preview.
 */
export type WhiteboardSummary = {
  id: string
  name: string
  kind: "flow"
  folderId: string | null
  workspace: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  boxes: number
  reads: string[]
  thumb: number[][]
}

/** A whiteboard with its spec, as main has it on disk — not yet validated. */
export type WhiteboardDetail = WhiteboardSummary & { spec: unknown }

/**
 * A folder of whiteboards. Folders live only in main's store.json, never on disk;
 * `moved` marks one the migration from per-workspace diagrams made, until it is touched.
 * `count` is its boards that are not archived, `archived` the rest.
 */
export type WhiteboardFolder = {
  id: string
  name: string
  createdAt: string
  moved: boolean
  count: number
  archived: number
}

/** How the move from per-workspace diagrams went, for the Whiteboards screen's notice. */
export type WhiteboardsMigration = { error: string | null; skipped: number; legacyRoot: string | null }

/** whiteboardsList(): every folder and every board, newest edit first. */
export type WhiteboardsIndex = {
  folders: WhiteboardFolder[]
  boards: WhiteboardSummary[]
  notice: { boards: number; folders: number; dismissed: boolean } | null
  lastWorkspace: string | null
  recentWorkspaces: string[]
  migration: WhiteboardsMigration | null
}

/** A rail workspace a picker can offer; `dirLabel` is its folder with ~ for home. */
export type WorkspaceChoice = { id: string; project: string; dirLabel: string }

/** whiteboardsWorkspaces(): the rail's workspaces, the recent ones, and the last used. */
export type WorkspaceChoices = { workspaces: WorkspaceChoice[]; recent: string[]; last: string | null }

/**
 * What the rail shows for each workspace, pushed in by the host: `dot` is SB.dotFor(ws)
 * ('' | 'run' | 'bell' | 'fail' | 'chg') and `branch` its branch once scanned.
 */
export type WorkspaceStatus = Record<string, { dot: string; branch: string | null }>

/** Why main says the whiteboards changed (sb:evt:wbChanged). */
export type WhiteboardsChange = {
  reason: "save" | "create" | "rename" | "workspace" | "move" | "duplicate" | "archive" | "delete" | "folder" | "notice"
  boardId?: string
  folderId?: string
}

export type FlowDocument = { id: string; text: string; revision: string; path: string }

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
  | {
      ok: false
      error: string
      // "no-workspace": a CLI was asked with no workspace to read, or one no longer in the rail.
      code?: "missing" | "signed-out" | "no-key" | "bad-key" | "timeout" | "stopped" | "no-workspace"
    }

/**
 * A picture main fetched for the canvas, from an address dragged or offered out of
 * the Google Images panel. Always one of the three types a whiteboard keeps — main
 * converts anything else it can read to PNG — and `name` is a short label taken
 * from the address, or "Image".
 */
export type FetchedImage =
  | { ok: true; bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp"; name: string }
  | { ok: false; error: string }

/**
 * "Add Image to Whiteboard", picked in the right-click menu of a picture in the Google
 * Images panel. `guestId` is the panel page's webContents id, which the panel
 * compares with its own <webview>'s, and `referrer` the page the picture was on. On
 * one of Google's results `url` is the full picture and `fallback` its thumbnail, to
 * add instead should the full one not come; "" otherwise.
 */
export type ImageOffer = { guestId: number; url: string; fallback?: string; referrer: string }

type Bridge = {
  whiteboardsList(): Promise<Result<WhiteboardsIndex>>
  whiteboardsGet(id: string): Promise<Result<WhiteboardDetail>>
  /** `workspace` left out: main gives the board the workspace used last. */
  whiteboardsCreate(req: {
    folderId: string | null
    name: string
    spec: unknown
    workspace?: string | null
  }): Promise<Result<WhiteboardDetail>>
  /** Autosave: the spec only, never the name — a rename elsewhere can't be undone by it. */
  whiteboardsSaveSpec(id: string, spec: unknown): Promise<Result<WhiteboardSummary>>
  whiteboardsRename(id: string, name: string): Promise<Result<WhiteboardSummary>>
  whiteboardsSetWorkspace(id: string, wsId: string | null): Promise<Result<WhiteboardSummary>>
  whiteboardsMove(id: string, folderId: string | null): Promise<Result<WhiteboardSummary>>
  whiteboardsDuplicate(id: string): Promise<Result<WhiteboardDetail>>
  whiteboardsArchive(id: string, archived: boolean): Promise<Result<WhiteboardSummary>>
  whiteboardsDelete(id: string): Promise<Result<{ id: string }>>
  whiteboardsCreateFolder(name: string): Promise<Result<Omit<WhiteboardFolder, "count" | "archived">>>
  whiteboardsRenameFolder(id: string, name: string): Promise<Result<Omit<WhiteboardFolder, "count" | "archived">>>
  whiteboardsDeleteFolder(id: string): Promise<Result<{ id: string }>>
  whiteboardsDismissNotice(): Promise<Result<Record<string, never>>>
  whiteboardsNoteWorkspace(wsId: string): Promise<Result<{ recentWorkspaces: string[] }>>
  whiteboardsWorkspaces(): Promise<Result<WorkspaceChoices>>
  whiteboardsMigrate(): Promise<Result<unknown>>
  // Markdown documents: one store for every board, keyed by the document's id alone.
  whiteboardsCreateDocument(text: string): Promise<Result<FlowDocument>>
  whiteboardsGetDocument(id: string): Promise<Result<FlowDocument>>
  whiteboardsSaveDocument(id: string, text: string, revision: string): Promise<Result<FlowDocument>>
  onWhiteboardsChanged(cb: (change: WhiteboardsChange) => void): () => void
  diagramsSaveImage(bytes: Uint8Array, type: string): Promise<{ ok: true; src: string } | { ok: false; error: string }>
  diagramsGetImagePath(src: string): Promise<Result<string>>
  diagramsClipboardImage(): Promise<{ ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string }>
  diagramsDirty(count: number): Promise<unknown>
  writeClipboard(text: string): Promise<{ ok: true } | { ok: false; error: string }>
  answerStatus(opts?: { fresh?: boolean }): Promise<AnswerStatus | { ok: false; error: string }>
  answerSetSettings(patch: Partial<AnswerSettings>): Promise<AnswerStatus | { ok: false; error: string }>
  answerStart(
    id: string,
    // `wsId` is the board's workspace, null when it has none: a CLI then answers
    // { code: "no-workspace" }, and condense, which reads no files, goes ahead anyway.
    req: { provider: ProviderId; wsId: string | null; system: string; user: string; schema: unknown; operation?: "condense" },
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

const MISSING = "this build of Switchboard has no whiteboards"

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
 * One bridge call: feature-checked (a preload from before whiteboards has none of these —
 * a stale caller fails with MISSING rather than sending the wrong arguments), and
 * settled as a value, never a rejection.
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
export function listen<
  K extends "onAnswerStep" | "onAnswerStatus" | "onDiagramsImageOffer" | "onWhiteboardsChanged",
>(
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
