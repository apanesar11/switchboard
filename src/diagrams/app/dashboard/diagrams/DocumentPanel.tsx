import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { RiCloseLine, RiFileTextLine, RiLayoutRightLine, RiFullscreenLine, RiWindowLine, RiArrowGoBackLine, RiCheckLine } from "@remixicon/react"
import type { Result } from "@/lib/bridge"
import { CopyPathButton } from "./DiagramFileCopy"
import type { DocumentBuffer } from "./useFlowDocuments"

export type DocumentView = "floating" | "docked" | "focus"
type Mode = "read" | "write" | "split"

function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const markdown = (window as unknown as { SB?: { markdown?: { render(text: string, options: { breaks: boolean }): DocumentFragment } } }).SB?.markdown
    if (ref.current) ref.current.replaceChildren(markdown ? markdown.render(text, { breaks: false }) : document.createTextNode(text))
  }, [text])
  return <div ref={ref} className="flow-document-markdown" />
}

export function DocumentPanel({ buffer, title, diagramName, view, onView, onRename, onEdit, onSave, onCopyPath, onResolve, onRetry, onClose, initialWrite = false, readOnly = false }: {
  buffer?: DocumentBuffer
  title: string
  diagramName?: string
  view: DocumentView
  onView(view: DocumentView): void
  onRename(title: string): void
  onEdit(text: string): void
  onSave(): void
  onCopyPath(): Promise<Result<string>>
  onResolve(overwrite: boolean): void
  onRetry(): void
  onClose(): void
  initialWrite?: boolean
  readOnly?: boolean
}) {
  const [mode, setMode] = useState<Mode>(initialWrite && !readOnly ? "write" : "read")
  const [width, setWidth] = useState(520)
  const panelId = useId()
  const panel = useRef<HTMLElement>(null)
  const source = useRef<HTMLTextAreaElement>(null)
  const previousView = useRef<DocumentView>("floating")
  const ready = !!buffer?.revision && !buffer.loading
  const text = buffer?.text ?? ""
  const status = buffer?.saving ? "Saving…" : buffer && buffer.text !== buffer.saved ? "Unsaved changes" : "Saved locally"

  useEffect(() => {
    const element = initialWrite ? source.current : panel.current
    element?.focus()
  }, [initialWrite])

  useEffect(() => {
    if (buffer?.generation && mode !== "read" && !readOnly && ready) source.current?.focus()
    // Replacing externally reloaded source resets native undo and restores editing
    // focus. Switching layouts keeps the same textarea and its history.
  }, [buffer?.generation])

  // Focus view keeps keyboard navigation inside the document. Floating and docked
  // views leave the canvas available; their keys never reach its shortcuts.
  useEffect(() => {
    if (view !== "focus") return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => { if (previouslyFocused?.isConnected) previouslyFocused.focus() }
  }, [view])

  function switchView(next: DocumentView) {
    if (next === "focus") previousView.current = view
    onView(next)
  }
  function leaveFocus() { onView(previousView.current === "focus" ? "floating" : previousView.current) }

  function insert(mark: string) {
    const field = source.current
    if (!field || !ready) return
    setMode(mode === "split" ? "split" : "write")
    requestAnimationFrame(() => {
      field.focus()
      const start = field.selectionStart, end = field.selectionEnd
      const selected = field.value.slice(start, end)
      if (mark === "- " || mark === "- [ ] ") {
        const from = field.value.lastIndexOf("\n", start - 1) + 1
        const last = end > start && field.value[end - 1] === "\n" ? end - 1 : end
        const newline = field.value.indexOf("\n", last)
        const to = newline < 0 ? field.value.length : newline
        const lines = field.value.slice(from, to).split("\n").map((line) => {
          const parts = /^([ \t]*)(?:(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?)?(.*)$/.exec(line)!
          const prefix = mark === "- [ ] " && parts[2] ? `- [${parts[2]}] ` : mark
          return parts[1] + prefix + parts[3]
        }).join("\n")
        field.setSelectionRange(from, to)
        document.execCommand("insertText", false, lines)
        return
      }
      const value = mark + (selected || "text") + mark
      // Chromium owns the source field's undo history, including toolbar edits.
      document.execCommand("insertText", false, value)
      if (!selected) field.setSelectionRange(start + mark.length, start + mark.length + 4)
    })
  }

  return (
    <div className={`flow-document-host flow-document-${view}`} data-flow-document-panel>
      {view === "focus" ? <button className="flow-document-scrim" aria-label="Return to canvas" onClick={leaveFocus} /> : null}
      <section
        ref={panel}
        className="flow-document-panel"
        style={view === "focus" ? undefined : { width }}
        role={view === "focus" ? "dialog" : "region"}
        aria-modal={view === "focus" ? true : undefined}
        aria-label={`Document: ${title}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Escape") {
            event.preventDefault()
            if (view === "focus") leaveFocus()
            else onClose()
          } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault()
            onSave()
          } else if (event.key === "Tab" && view === "focus" && event.target !== source.current) {
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]') ?? [])].filter((item) => item.getClientRects().length > 0)
            const index = items.indexOf(document.activeElement as HTMLElement)
            if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index < 0 || index === items.length - 1))) {
              event.preventDefault()
              items[event.shiftKey ? items.length - 1 : 0]?.focus()
            }
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {view !== "focus" ? <div className="flow-document-resize" title="Resize document panel" onPointerDown={(event) => {
          const start = event.clientX, before = width
          const handle = event.currentTarget
          handle.setPointerCapture(event.pointerId)
          const move = (e: PointerEvent) => setWidth(Math.max(340, Math.min(850, before + start - e.clientX)))
          const done = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", done); handle.removeEventListener("pointercancel", done) }
          handle.addEventListener("pointermove", move)
          handle.addEventListener("pointerup", done)
          handle.addEventListener("pointercancel", done)
        }} /> : null}
        <header className="flow-document-header">
          <span className="flow-document-kind"><RiFileTextLine size={17} /> Document</span>
          <div className="flow-document-actions">
            {view === "focus" ? <button title="Return to canvas" aria-label="Return to canvas" onClick={leaveFocus}><RiArrowGoBackLine size={17} /></button> : null}
            <button title="Floating panel" aria-label="Floating panel" aria-pressed={view === "floating"} onClick={() => switchView("floating")}><RiWindowLine size={17} /></button>
            <button title="Dock to the right" aria-label="Dock to the right" aria-pressed={view === "docked"} onClick={() => switchView("docked")}><RiLayoutRightLine size={17} /></button>
            <button title="Focus view" aria-label="Focus view" aria-pressed={view === "focus"} onClick={() => switchView("focus")}><RiFullscreenLine size={17} /></button>
            <button title="Close document · Esc" aria-label="Close document" onClick={onClose}><RiCloseLine size={19} /></button>
          </div>
        </header>
        <div className="flow-document-heading">
          <div className="flow-document-breadcrumb">{diagramName || "Flowchart"} <span>/</span> Markdown document</div>
          <input aria-label="Document name" value={title} maxLength={200} readOnly={readOnly} onChange={(event) => onRename(event.target.value)} onBlur={() => { if (!title.trim()) onRename("Untitled document") }} />
        </div>
        <div className="flow-document-tabs" role="tablist" aria-label="Document mode">
          {(["read", "write", "split"] as const).filter((value) => !readOnly || value === "read").map((value) => <button key={value} role="tab" aria-selected={mode === value} aria-controls={`${panelId}-${value}`} onClick={() => { setMode(value); if (value !== "read") requestAnimationFrame(() => source.current?.focus()) }}>{value === "read" ? "Read" : value === "write" ? "Write" : "Split"}</button>)}
          <span>Markdown</span>
        </div>
        {buffer?.error ? <div className="flow-document-error" role="alert">
          <p>{buffer.error}</p>
          <div>{buffer.conflict && !readOnly ? <><button onClick={() => onResolve(false)}>Reload file</button><button onClick={() => onResolve(true)}>Save my version</button></> : <button onClick={ready && !readOnly ? onSave : onRetry}>Retry</button>}</div>
        </div> : null}
        {!buffer || buffer.loading ? <div className="flow-document-loading" role="status">Opening document…</div> : null}
        {!readOnly && mode !== "read" ? <div className="flow-document-format" role="toolbar" aria-label="Markdown formatting">
          <button title="Bold selected words" onClick={() => insert("**")} disabled={!ready}><b>B</b></button>
          <button title="Italic selected words" onClick={() => insert("*")} disabled={!ready}><i>I</i></button>
          <button onClick={() => insert("- ")} disabled={!ready}>Bullet list</button>
          <button onClick={() => insert("- [ ] ")} disabled={!ready}>Checklist</button>
          <span>Tab indents · Shift+Tab outdents</span>
        </div> : null}
        <div className={`flow-document-content flow-document-mode-${mode}`} id={`${panelId}-${mode}`} role="tabpanel" aria-label={mode}>
          <textarea
            key={buffer?.generation ?? 0}
            ref={source}
            className="flow-document-source"
            aria-label="Markdown source"
            spellCheck={false}
            value={text}
            disabled={!ready || readOnly}
            onChange={(event) => onEdit(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && !event.altKey && ["b", "i"].includes(event.key.toLowerCase())) {
                event.preventDefault()
                insert(event.key.toLowerCase() === "b" ? "**" : "*")
                return
              }
              if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              const field = event.currentTarget, start = field.selectionStart, end = field.selectionEnd
              if (!event.shiftKey && start === end) document.execCommand("insertText", false, "  ")
              else {
                const from = field.value.lastIndexOf("\n", start - 1) + 1
                const last = end > start && field.value[end - 1] === "\n" ? end - 1 : end
                const newline = field.value.indexOf("\n", last)
                const to = newline < 0 ? field.value.length : newline
                const lines = field.value.slice(from, to)
                const replacement = event.shiftKey ? lines.replace(/^( {1,2}|\t)/gm, "") : lines.replace(/^/gm, "  ")
                if (lines === replacement) return
                field.setSelectionRange(from, to)
                document.execCommand("insertText", false, replacement)
                field.setSelectionRange(from, from + replacement.length)
              }
            }}
          />
          <div className="flow-document-preview">
            {ready && !text.trim() ? <div className="flow-document-empty"><RiFileTextLine size={32} /><h3>A little more room for your thoughts</h3><p>Keep the flowchart clear. Add the details here with headings, lists, checkboxes, tables and code.</p>{!readOnly ? <button onClick={() => { setMode("write"); requestAnimationFrame(() => source.current?.focus()) }}>Start writing</button> : null}</div> : <Markdown text={text} />}
          </div>
        </div>
        <footer className="flow-document-footer">
          <span role="status">{ready && !buffer?.error ? <RiCheckLine size={14} /> : null}{buffer?.error ? "Save needs attention" : ready ? status : "Markdown file"}</span>
          <span>{text.trim() ? text.trim().split(/\s+/).length.toLocaleString() : 0} words</span>
          {buffer?.path ? <CopyPathButton label="Copy Markdown file path" onPath={onCopyPath} disabled={!ready}>.md file</CopyPathButton> : null}
        </footer>
      </section>
    </div>
  )
}
