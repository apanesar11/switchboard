import { useCallback, useEffect, useMemo, useState } from "react"
import { call, type FlowDocument, type Result } from "@/lib/bridge"

export type DocumentBuffer = {
  id: string
  text: string
  saved: string
  revision: string
  path: string
  loading: boolean
  saving: boolean
  error: string | null
  conflict: boolean
  generation: number
}

type DocumentStore = {
  entries: Map<string, DocumentBuffer>
  loads: Map<string, Promise<void>>
  chains: Map<string, Promise<void>>
  timers: Map<string, ReturnType<typeof setTimeout>>
  listeners: Set<() => void>
}
const stores = new Map<string, DocumentStore>()
function storeFor(workspace: string): DocumentStore {
  let store = stores.get(workspace)
  if (!store) {
    store = { entries: new Map(), loads: new Map(), chains: new Map(), timers: new Map(), listeners: new Set() }
    stores.set(workspace, store)
  }
  return store
}

// Buffers belong to the editor, rather than the panel: closing it, opening another
// document or changing its view cannot discard a debounce or an unsaved edit.
export function useFlowDocuments(workspace: string, activeId?: string) {
  // A failed save stays recoverable when switching diagrams. Shared queues also
  // prevent two canvases referencing the same file from racing each other's save.
  const store = useMemo(() => storeFor(workspace), [workspace])
  const entries = useMemo(() => ({ current: store.entries }), [store])
  const loads = useMemo(() => ({ current: store.loads }), [store])
  const chains = useMemo(() => ({ current: store.chains }), [store])
  const timers = useMemo(() => ({ current: store.timers }), [store])
  const [version, setVersion] = useState(0)
  const notify = useCallback(() => { for (const listener of store.listeners) listener() }, [store])
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1)
    store.listeners.add(listener)
    return () => { store.listeners.delete(listener) }
  }, [store])

  const load = useCallback(async (id: string, refresh = false) => {
    const pending = loads.current.get(id)
    if (pending) return pending
    let entry = entries.current.get(id)
    if (entry && !refresh) return
    if (!entry) {
      entry = { id, text: "", saved: "", revision: "", path: "", loading: true, saving: false, error: null, conflict: false, generation: 0 }
      entries.current.set(id, entry)
      notify()
    }
    const buffer = entry
    const job = (async () => {
      const result = await call("diagramsGetDocument", workspace, id)
      buffer.loading = false
      if (buffer.saving) return
      if (!result.ok) {
        buffer.error = result.error
      } else if (buffer.text !== buffer.saved || buffer.saving) {
        // An external editor changed the file while this panel held edits.
        if (buffer.revision !== result.data.revision) {
          buffer.conflict = true
          buffer.error = "This file changed in another editor. Reload it, or save your version over it."
        }
      } else {
        if (buffer.text !== result.data.text) buffer.generation++
        Object.assign(buffer, result.data, { saved: result.data.text, error: null, conflict: false })
      }
      notify()
    })()
    loads.current.set(id, job)
    try { await job } finally { loads.current.delete(id) }
  }, [workspace, notify])

  const save = useCallback((id: string): Promise<void> => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    const job = (chains.current.get(id) ?? Promise.resolve()).then(async () => {
      const entry = entries.current.get(id)
      if (!entry || entry.loading || !entry.revision || entry.text === entry.saved) return
      const text = entry.text
      entry.saving = true
      notify()
      const result = await call("diagramsSaveDocument", workspace, id, text, entry.revision)
      entry.saving = false
      if (result.ok) {
        entry.saved = text
        entry.revision = result.data.revision
        entry.error = null
        entry.conflict = false
      } else {
        entry.error = result.error
        entry.conflict = "code" in result && result.code === "conflict"
      }
      notify()
    })
    chains.current.set(id, job)
    void job.finally(() => { if (chains.current.get(id) === job) chains.current.delete(id) })
    return job
  }, [workspace, notify])

  const edit = useCallback((id: string, text: string) => {
    const entry = entries.current.get(id)
    if (!entry || entry.loading || !entry.revision) return
    entry.text = text
    // A conflict needs an explicit choice, never a subsequent keystroke.
    if (!entry.conflict) entry.error = null
    notify()
    clearTimeout(timers.current.get(id))
    if (!entry.conflict) timers.current.set(id, setTimeout(() => void save(id), 600))
  }, [notify, save])

  const flush = useCallback(async () => {
    await Promise.all([...entries.current.keys()].map(save))
  }, [save])

  const create = useCallback(async (text = ""): Promise<Result<FlowDocument>> => {
    const result = await call("diagramsCreateDocument", workspace, text)
    if (result.ok) {
      entries.current.set(result.data.id, {
        ...result.data, saved: text, loading: false, saving: false, error: null, conflict: false, generation: 0,
      })
      notify()
    }
    return result
  }, [workspace, notify])

  const read = useCallback(async (id: string): Promise<Result<string>> => {
    const local = entries.current.get(id)
    if (local?.revision && local.text !== local.saved) return { ok: true, data: local.text }
    await chains.current.get(id)
    await load(id, true)
    const entry = entries.current.get(id)
    return entry?.revision ? { ok: true, data: entry.text } : { ok: false, error: entry?.error ?? "Document not found" }
  }, [load])

  // The AI reads the file on disk, so do not hand out a path while this editor
  // still holds newer text or a save conflict. Copying must not overwrite a conflict.
  const getPath = useCallback(async (id: string): Promise<Result<string>> => {
    await chains.current.get(id)
    await load(id, true)
    const entry = entries.current.get(id)
    if (!entry?.revision || entry.error) return { ok: false, error: entry?.error ?? "Document not found" }
    while (entry.text !== entry.saved || entry.saving) {
      await save(id)
      if (entry.error) return { ok: false, error: entry.error }
    }
    return { ok: true, data: entry.path }
  }, [load, save])

  const resolve = useCallback(async (id: string, overwrite: boolean) => {
    await chains.current.get(id)
    const entry = entries.current.get(id)
    if (!entry) return
    const result = await call("diagramsGetDocument", workspace, id)
    if (!result.ok) {
      entry.error = result.error
      notify()
      return
    }
    if (overwrite) {
      entry.revision = result.data.revision
      entry.saved = result.data.text
      entry.error = null
      entry.conflict = false
      notify()
      await save(id)
    } else {
      clearTimeout(timers.current.get(id))
      entry.generation++
      Object.assign(entry, result.data, { saved: result.data.text, loading: false, error: null, conflict: false })
      notify()
    }
  }, [workspace, save, notify])

  useEffect(() => {
    if (!activeId) return
    void load(activeId, true)
    const refresh = () => void load(activeId, true)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [activeId, load])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    void flush()
  }, [flush])

  const dirty = [...entries.current.values()].some((entry) => entry.saving || entry.text !== entry.saved)
  const saving = [...entries.current.values()].some((entry) => entry.saving)
  const problem = [...entries.current.values()].find((entry) => entry.error && entry.text !== entry.saved)
  return useMemo(() => ({
    active: activeId ? entries.current.get(activeId) : undefined,
    dirty, saving, problem, edit, flush, create, read, getPath, resolve, retry: load, save,
  }), [version, activeId, dirty, saving, problem, edit, flush, create, read, getPath, resolve, load, save])
}
