// The admin's lib/diagrams/actions.ts, with the same names and the same answers, over
// Switchboard's bridge instead of server actions and Postgres. `productId` is the
// workspace id (lib/products.ts says why); the files live in
// ~/.switchboard/diagrams/ (src/main/diagrams.js).
//
// The admin's actions validate on the server, the only place it trusts. Here the
// renderer and main are one app on one Mac, so the spec is validated HERE, with the
// admin's own parser, before main is asked to write it — and re-parsed on the way back
// out, as getDiagram does there, so a file edited by hand into something the canvas
// can't draw is reported rather than drawn.

import { call } from "../bridge"
import type { DiagramDetail, DiagramSummary, ServerActionResult } from "./types"
import { isUuid, normalizeDiagramName, parseDiagramSpec } from "./validate"

export async function listDiagrams(input: {
  productId: string
}): Promise<ServerActionResult<DiagramSummary[]>> {
  return call("diagramsList", input.productId)
}

export async function getDiagram(input: {
  productId: string
  id: string
}): Promise<ServerActionResult<DiagramDetail>> {
  if (!isUuid(input.id)) return { ok: false, error: "Invalid diagram id" }
  const result = await call("diagramsGet", input.productId, input.id)
  if (!result.ok) return result
  const parsed = parseDiagramSpec(result.data.spec)
  if (!parsed.ok) {
    return { ok: false, error: `This diagram's spec is no longer valid — ${parsed.error}` }
  }
  return { ok: true, data: { ...result.data, spec: parsed.value } }
}

async function write(
  productId: string,
  name: string,
  spec: unknown,
  id: string | null,
): Promise<ServerActionResult<DiagramDetail>> {
  const cleanName = normalizeDiagramName(name)
  if (!cleanName.ok) return { ok: false, error: cleanName.error }
  const parsed = parseDiagramSpec(spec)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const result =
    id === null
      ? await call("diagramsCreate", productId, cleanName.value, parsed.value)
      : await call("diagramsUpdate", productId, id, cleanName.value, parsed.value)
  if (!result.ok) return result
  return { ok: true, data: { ...result.data, spec: parsed.value } }
}

export async function createDiagram(input: {
  productId: string
  name: string
  spec: unknown
}): Promise<ServerActionResult<DiagramDetail>> {
  return write(input.productId, input.name, input.spec, null)
}

export async function updateDiagram(input: {
  productId: string
  id: string
  name: string
  spec: unknown
}): Promise<ServerActionResult<DiagramDetail>> {
  if (!isUuid(input.id)) return { ok: false, error: "Invalid diagram id" }
  return write(input.productId, input.name, input.spec, input.id)
}

export async function archiveDiagram(input: {
  productId: string
  id: string
}): Promise<ServerActionResult<DiagramSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: "Invalid diagram id" }
  return call("diagramsArchive", input.productId, input.id, true)
}

export async function unarchiveDiagram(input: {
  productId: string
  id: string
}): Promise<ServerActionResult<DiagramSummary>> {
  if (!isUuid(input.id)) return { ok: false, error: "Invalid diagram id" }
  return call("diagramsArchive", input.productId, input.id, false)
}

export async function deleteDiagram(input: {
  productId: string
  id: string
}): Promise<ServerActionResult<{ id: string }>> {
  if (!isUuid(input.id)) return { ok: false, error: "Invalid diagram id" }
  return call("diagramsDelete", input.productId, input.id)
}
