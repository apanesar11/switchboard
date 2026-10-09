import { useCallback, useEffect, useMemo, useState } from "react"
import { call, type FlowDocument, type Result } from "@/lib/bridge"

// The Markdown documents on whiteboards. Switchboard keeps them in ONE folder for every
// board (~/.switchboard/whiteboards/documents/<id>.md), addressed by the document's id
// alone, so moving a board between folders never moves a file, and an archived board
// opens its documents like any other.

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
  /** Each mounted hook's wake-up, told which document changed (see notify). */
  listeners: Set<(id: string) => void>
}

// One store for the whole window. A failed save stays recoverable when switching
// boards, and two canvases showing the same document (a board and its duplicate before
// the copy is made) share one save queue instead of racing.
const store: DocumentStore = {
  entries: new Map(), loads: new Map(), chains: new Map(), timers: new Map(), listeners: new Set(),
}

// Buffers belong to the editor, rather than the panel: closing it, opening another
// document or changing its view cannot discard a debounce or an unsaved edit.
export function useFlowDocuments(activeId?: string) {
  const entries = useMemo(() => ({ current: store.entries }), [])
  const loads = useMemo(() => ({ current: store.loads }), [])
  const chains = useMemo(() => ({ current: store.chains }), [])
  const timers = useMemo(() => ({ current: store.timers }), [])
  // The documents THIS editor has opened, made or edited. The store is shared, so its
  // dirty flag and save problem are read from these alone — one board must not show
  // another board's failed save as its own.
  const mine = useMemo(() => new Set<string>(), [])
  const [version, setVersion] = useState(0)
  // A change to one document re-renders only the editors that hold it. Every board's
  // canvas stays mounted while the host keeps it (several, parked ones included), so
  // waking every hook in the window would re-render each FlowEditor, off screen too,
  // several times per keystroke typed in one document. What a hook returns is read
  // from `mine` alone — its active document is in there from its first load.
  const notify = useCallback((id: string) => { for (const listener of store.listeners) listener(id) }, [])
  useEffect(() => {
    const listener = (id: string) => { if (mine.has(id)) setVersion((value) => value + 1) }
    store.listeners.add(listener)
    return () => { store.listeners.delete(listener) }
  }, [mine])

  const load = useCallback(async (id: string, refresh = false) => {
    mine.add(id)
    const pending = loads.current.get(id)
    if (pending) return pending
    let entry = entries.current.get(id)
    if (entry && !refresh) return
    if (!entry) {
      entry = { id, text: "", saved: "", revision: "", path: "", loading: true, saving: false, error: null, conflict: false, generation: 0 }
      entries.current.set(id, entry)
      notify(id)
    }
    const buffer = entry
    const job = (async () => {
      const result = await call("whiteboardsGetDocument", id)
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
      notify(id)
    })()
    loads.current.set(id, job)
    try { await job } finally { loads.current.delete(id) }
  }, [entries, loads, mine, notify])

  const save = useCallback((id: string): Promise<void> => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    const job = (chains.current.get(id) ?? Promise.resolve()).then(async () => {
      const entry = entries.current.get(id)
      if (!entry || entry.loading || !entry.revision || entry.text === entry.saved) return
      const text = entry.text
      entry.saving = true
      notify(id)
      const result = await call("whiteboardsSaveDocument", id, text, entry.revision)
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
      notify(id)
    })
    chains.current.set(id, job)
    void job.finally(() => { if (chains.current.get(id) === job) chains.current.delete(id) })
    return job
  }, [entries, chains, timers, notify])

  const edit = useCallback((id: string, text: string) => {
    const entry = entries.current.get(id)
    if (!entry || entry.loading || !entry.revision) return
    mine.add(id)
    entry.text = text
    // A conflict needs an explicit choice, never a subsequent keystroke.
    if (!entry.conflict) entry.error = null
    notify(id)
    clearTimeout(timers.current.get(id))
    if (!entry.conflict) timers.current.set(id, setTimeout(() => void save(id), 600))
  }, [entries, timers, mine, notify, save])

  const flush = useCallback(async () => {
    await Promise.all([...entries.current.keys()].map(save))
  }, [entries, save])

  const create = useCallback(async (text = ""): Promise<Result<FlowDocument>> => {
    const result = await call("whiteboardsCreateDocument", text)
    if (result.ok) {
      mine.add(result.data.id)
      entries.current.set(result.data.id, {
        ...result.data, saved: text, loading: false, saving: false, error: null, conflict: false, generation: 0,
      })
      notify(result.data.id)
    }
    return result
  }, [entries, mine, notify])

  const read = useCallback(async (id: string): Promise<Result<string>> => {
    const local = entries.current.get(id)
    if (local?.revision && local.text !== local.saved) return { ok: true, data: local.text }
    await chains.current.get(id)
    await load(id, true)
    const entry = entries.current.get(id)
    return entry?.revision ? { ok: true, data: entry.text } : { ok: false, error: entry?.error ?? "Document not found" }
  }, [entries, chains, load])

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
  }, [entries, chains, load, save])

  const resolve = useCallback(async (id: string, overwrite: boolean) => {
    await chains.current.get(id)
    const entry = entries.current.get(id)
    if (!entry) return
    const result = await call("whiteboardsGetDocument", id)
    if (!result.ok) {
      entry.error = result.error
      notify(id)
      return
    }
    if (overwrite) {
      entry.revision = result.data.revision
      entry.saved = result.data.text
      entry.error = null
      entry.conflict = false
      notify(id)
      await save(id)
    } else {
      clearTimeout(timers.current.get(id))
      entry.generation++
      Object.assign(entry, result.data, { saved: result.data.text, loading: false, error: null, conflict: false })
      notify(id)
    }
  }, [entries, chains, timers, save, notify])

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
  }, [timers, flush])

  const own = [...mine].map((id) => entries.current.get(id)).filter((entry): entry is DocumentBuffer => entry !== undefined)
  const dirty = own.some((entry) => entry.saving || entry.text !== entry.saved)
  const saving = own.some((entry) => entry.saving)
  const problem = own.find((entry) => entry.error && entry.text !== entry.saved)
  return useMemo(() => ({
    active: activeId ? entries.current.get(activeId) : undefined,
    dirty, saving, problem, edit, flush, create, read, getPath, resolve, retry: load, save,
  }), [version, activeId, dirty, saving, problem, edit, flush, create, read, getPath, resolve, load, save])
}
