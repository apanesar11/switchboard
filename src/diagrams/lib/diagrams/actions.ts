// The admin's lib/diagrams/actions.ts, over Switchboard's bridge instead of server
// actions and Postgres. Switchboard: a whiteboard is addressed by its own id alone —
// it lives in a folder the user made, not under a product or a workspace — and the
// files are in ~/.switchboard/whiteboards/ (src/main/whiteboards.js). The admin's
// single "update" is split in two: autosave writes the spec only and Rename the name
// only, so neither can carry a stale copy of the other back over a newer one.
//
// The admin's actions validate on the server, the only place it trusts. Here the
// renderer and main are one app on one Mac, so the spec is validated HERE, with the
// admin's own parser, before main is asked to write it — and re-parsed on the way back
// out, as getDiagram does there, so a file edited by hand into something the canvas
// can't draw is reported rather than drawn.

import {
  call,
  type WhiteboardDetail,
  type WhiteboardSummary,
  type WhiteboardsIndex,
  type WorkspaceChoices,
} from "../bridge"
import type { DiagramSpec, ServerActionResult } from "./types"
import { isUuid, normalizeDiagramName, parseDiagramSpec } from "./validate"

const INVALID_ID = "Invalid whiteboard id"

/**
 * A whiteboard as the page opens it. A spec that no longer validates is kept as
 * `specError` rather than failing the whole fetch: the canvas says what is wrong with
 * it, and the board can still be renamed, moved, archived or deleted.
 */
export type OpenedWhiteboard = WhiteboardSummary & {
  spec: DiagramSpec | null
  specError: string | null
}

/** A just-written whiteboard with the spec it was written with, validated. */
export type SavedWhiteboard = WhiteboardSummary & { spec: DiagramSpec }

/** Main's answer when a board's file is gone — told apart from one it can't read. */
export function isMissingWhiteboard(result: { ok: false; error: string; code?: string }): boolean {
  return result.code === "not-found" || /not found|no longer exists/i.test(result.error)
}

/** Only the summary's own fields: main may add a spec, and a list never carries one. */
function summaryOf(data: WhiteboardSummary): WhiteboardSummary {
  return {
    id: data.id,
    name: data.name,
    kind: data.kind,
    folderId: data.folderId ?? null,
    workspace: data.workspace ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    archivedAt: data.archivedAt ?? null,
    boxes: typeof data.boxes === "number" ? data.boxes : 0,
    reads: Array.isArray(data.reads) ? data.reads : [],
    thumb: Array.isArray(data.thumb) ? data.thumb : [],
  }
}

function folderIdProblem(folderId: string | null): string | null {
  return folderId === null || isUuid(folderId) ? null : "Invalid folder id"
}

export async function listWhiteboards(): Promise<ServerActionResult<WhiteboardsIndex>> {
  return call("whiteboardsList")
}

export async function getWhiteboard(input: {
  id: string
}): Promise<ServerActionResult<OpenedWhiteboard> & { code?: string }> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID, code: "not-found" }
  const result = await call("whiteboardsGet", input.id)
  if (!result.ok) return result
  const parsed = parseDiagramSpec(result.data.spec)
  return {
    ok: true,
    data: parsed.ok
      ? { ...summaryOf(result.data), spec: parsed.value, specError: null }
      : {
          ...summaryOf(result.data),
          spec: null,
          specError: `This whiteboard's spec is no longer valid — ${parsed.error}`,
        },
  }
}

export async function createWhiteboard(input: {
  folderId: string | null
  name: string
  spec: unknown
  /** Left out, main gives the board the workspace ✦ Answer used last. */
  workspace?: string | null
}): Promise<ServerActionResult<SavedWhiteboard>> {
  const folder = folderIdProblem(input.folderId)
  if (folder) return { ok: false, error: folder }
  const cleanName = normalizeDiagramName(input.name)
  if (!cleanName.ok) return { ok: false, error: cleanName.error }
  const parsed = parseDiagramSpec(input.spec)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const result = await call("whiteboardsCreate", {
    folderId: input.folderId,
    name: cleanName.value,
    spec: parsed.value,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  })
  if (!result.ok) return result
  return { ok: true, data: { ...summaryOf(result.data), spec: parsed.value } }
}

/** The editor's autosave: the spec only. */
export async function saveWhiteboardSpec(input: {
  id: string
  spec: unknown
}): Promise<ServerActionResult<SavedWhiteboard>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const parsed = parseDiagramSpec(input.spec)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const result = await call("whiteboardsSaveSpec", input.id, parsed.value)
  if (!result.ok) return result
  return { ok: true, data: { ...summaryOf(result.data), spec: parsed.value } }
}

/** The name only — the drawing on disk is left exactly as the last autosave wrote it. */
export async function renameWhiteboard(input: {
  id: string
  name: string
}): Promise<ServerActionResult<WhiteboardSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const cleanName = normalizeDiagramName(input.name)
  if (!cleanName.ok) return { ok: false, error: cleanName.error }
  const result = await call("whiteboardsRename", input.id, cleanName.value)
  return result.ok ? { ok: true, data: summaryOf(result.data) } : result
}

/** The workspace ✦ Answer reads on this board, or null for none. */
export async function setWhiteboardWorkspace(input: {
  id: string
  workspace: string | null
}): Promise<ServerActionResult<WhiteboardSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const result = await call("whiteboardsSetWorkspace", input.id, input.workspace)
  return result.ok ? { ok: true, data: summaryOf(result.data) } : result
}

export async function moveWhiteboard(input: {
  id: string
  folderId: string | null
}): Promise<ServerActionResult<WhiteboardSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const folder = folderIdProblem(input.folderId)
  if (folder) return { ok: false, error: folder }
  const result = await call("whiteboardsMove", input.id, input.folderId)
  return result.ok ? { ok: true, data: summaryOf(result.data) } : result
}

/** A copy in the same folder, named "X copy", with its own copies of every document. */
export async function duplicateWhiteboard(input: {
  id: string
}): Promise<ServerActionResult<WhiteboardDetail>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  return call("whiteboardsDuplicate", input.id)
}

export async function archiveWhiteboard(input: {
  id: string
}): Promise<ServerActionResult<WhiteboardSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const result = await call("whiteboardsArchive", input.id, true)
  return result.ok ? { ok: true, data: summaryOf(result.data) } : result
}

export async function unarchiveWhiteboard(input: {
  id: string
}): Promise<ServerActionResult<WhiteboardSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  const result = await call("whiteboardsArchive", input.id, false)
  return result.ok ? { ok: true, data: summaryOf(result.data) } : result
}

export async function deleteWhiteboard(input: {
  id: string
}): Promise<ServerActionResult<{ id: string }>> {
  if (!isUuid(input.id)) return { ok: false, error: INVALID_ID }
  return call("whiteboardsDelete", input.id)
}

/** The rail's workspaces for a picker: recent first, then all of them. */
export async function listWorkspaceChoices(): Promise<ServerActionResult<WorkspaceChoices>> {
  return call("whiteboardsWorkspaces")
}
