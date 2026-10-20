// Switchboard: the panel a PDF or a spreadsheet on a whiteboard opens in, beside the
// canvas as a Markdown document's does (DocumentPanel.tsx) — its chrome, its three
// views and its classes, so the canvas treats the two alike: its keys, the Edit menu
// (index.tsx editAction) and a pinned terminal's overlay all leave a
// [data-flow-document-panel] alone.
//
// A PDF is Chromium's own viewer in an <iframe>, from the sbfile address main serves
// (index.js): its toolbar pages, zooms and prints. A spreadsheet is never loaded as a
// page: main reads it (src/main/sheets.js) and the grid here asks for its rows a page
// at a time, drawing only the rows and columns in view, so a sheet of 100,000 rows
// scrolls as lightly as one of ten.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowUpSLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileExcel2Line,
  RiFilePdf2Line,
  RiFullscreenLine,
  RiLayoutRightLine,
  RiSearchLine,
  RiWindowLine,
} from "@remixicon/react"
import { toast } from "@/components/Toast"
import { call, type SheetInfo } from "@/lib/bridge"
import { parseFlowFileSrc, sheetColumnName, sheetFormatName } from "@/lib/diagrams/files"
import { PDF_LABEL, SHEET_LABEL } from "@/lib/diagrams/types"
import { CopyPathButton } from "./DiagramFileCopy"
import type { DocumentView } from "./DocumentPanel"

/** The panel's width beside the canvas — wider than a document's, for a page or a grid. */
const PANEL_WIDTH = 640
const PANEL_MIN = 360
const PANEL_MAX = 1400

/** Every row of a sheet is this tall, so a row's place is its index times it. */
const ROW_HEIGHT = 26
/** The strip of column letters across the top of the grid. */
const LETTERS_HEIGHT = 24
/** Rows asked of main at once, and kept together. */
const PAGE_ROWS = 200
/** Rows drawn past the top and bottom of the view, and pixels past its sides. */
const OVERSCAN_ROWS = 12
const OVERSCAN_PX = 320
/**
 * How far the view scrolls before the rows and columns drawn are worked out again —
 * less than the overscan, so what comes into view is always already drawn.
 */
const SCROLL_STEP_Y = ROW_HEIGHT * 4
const SCROLL_STEP_X = 128
/** A page is asked for once scrolling pauses this long, not for each one flown past. */
const FETCH_SETTLE_MS = 40
const FIND_SETTLE_MS = 200
const FIND_LIMIT = 1000
const COLUMN_MIN = 56
const COLUMN_MAX = 320
const COLUMN_DEFAULT = 96
/** The most of a cell's text drawn in the grid; the bar above it shows the rest. */
const CELL_TEXT_MAX = 300
/** Text a spreadsheet would right-align: a number, as formatted — 1,250.00, $12, (3), 45%. */
const NUMERIC = /^[-+(]?[$€£¥]?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?\)?%?$|^[-+]?\.\d+$/

type Cell = { row: number; col: number }

/**
 * A key that only confirms or cancels what an input method is composing — Enter
 * choosing "東京" for "とうきょう", Esc dropping the candidates — and so is the input
 * method's, not ours. WebKit sends one more keydown, keyCode 229, just after the
 * composition ends.
 */
function composing(event: React.KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

type Found = { matches: Cell[]; more: boolean; index: number; searching: boolean; error: string | null }

const NOT_FOUND: Found = { matches: [], more: false, index: -1, searching: false, error: null }

export function FilePanel({ kind, src, title, diagramName, view, onView, onRename, onClose }: {
  kind: "pdf" | "sheet"
  /** The node's `file`: sbfile://file/<name>. */
  src: string
  title: string
  diagramName?: string
  view: DocumentView
  onView(view: DocumentView): void
  /** Called once per edit, trimmed, never blank. Left out, the name is read-only. */
  onRename?(title: string): void
  onClose(): void
}) {
  const [width, setWidth] = useState(PANEL_WIDTH)
  const [resizing, setResizing] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const previousView = useRef<DocumentView>("floating")
  const openFind = useRef<(() => void) | null>(null)
  const ext = parseFlowFileSrc(src)?.ext ?? (kind === "pdf" ? "pdf" : "xlsx")
  const fallback = kind === "pdf" ? PDF_LABEL : SHEET_LABEL
  const name = title || fallback
  // What macOS opens each in unless told otherwise; shell.openPath uses whichever app
  // the user made the default.
  const openLabel = kind === "pdf" ? "Open in Preview" : "Open in Numbers or Excel"

  useEffect(() => {
    panel.current?.focus()
  }, [])

  // Focus view keeps keyboard navigation inside the panel, as a document's does — but
  // leaves the grid with the keyboard when it already has it.
  useEffect(() => {
    if (view !== "focus") return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!panel.current?.contains(previouslyFocused)) panel.current?.focus()
    return () => { if (previouslyFocused?.isConnected) previouslyFocused.focus() }
  }, [view])

  function switchView(next: DocumentView) {
    if (next === "focus") previousView.current = view
    onView(next)
  }
  function leaveFocus() { onView(previousView.current === "focus" ? "floating" : previousView.current) }

  async function openInApp() {
    const result = await call("diagramsOpenFile", src)
    if (!result.ok) toast({ title: `Couldn't open ${name}`, description: result.error, variant: "error" })
  }

  return (
    <div className={`flow-document-host flow-document-${view}`} data-flow-document-panel>
      {view === "focus" ? <button className="flow-document-scrim" aria-label="Return to canvas" onClick={leaveFocus} /> : null}
      <section
        ref={panel}
        className="flow-document-panel flow-file-panel"
        data-kind={kind}
        data-resizing={resizing || undefined}
        style={view === "focus" ? undefined : { width }}
        role={view === "focus" ? "dialog" : "region"}
        aria-modal={view === "focus" ? true : undefined}
        aria-label={`${kind === "pdf" ? "PDF" : "Spreadsheet"}: ${name}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Escape") {
            if (composing(event)) return
            event.preventDefault()
            if (view === "focus") leaveFocus()
            else onClose()
          } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f" && openFind.current) {
            event.preventDefault()
            openFind.current()
          } else if (event.key === "Tab" && view === "focus") {
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), iframe, [tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length > 0)
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
        {view !== "focus" ? <div className="flow-document-resize" title="Resize panel" onPointerDown={(event) => {
          const start = event.clientX, before = width
          const handle = event.currentTarget
          handle.setPointerCapture(event.pointerId)
          // A PDF's viewer is a page of its own: under the pointer it would take the
          // moves the handle needs, and the resize would stall (styles.css).
          setResizing(true)
          const move = (e: PointerEvent) => setWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - 80, before + start - e.clientX)))
          const done = () => {
            setResizing(false)
            handle.removeEventListener("pointermove", move)
            handle.removeEventListener("pointerup", done)
            handle.removeEventListener("pointercancel", done)
            handle.removeEventListener("lostpointercapture", done)
          }
          handle.addEventListener("pointermove", move)
          handle.addEventListener("pointerup", done)
          handle.addEventListener("pointercancel", done)
          handle.addEventListener("lostpointercapture", done)
        }} /> : null}
        <header className="flow-document-header">
          <span className="flow-document-kind">
            {kind === "pdf" ? <><RiFilePdf2Line size={17} /> PDF</> : <><RiFileExcel2Line size={17} /> Spreadsheet</>}
          </span>
          <div className="flow-document-actions">
            <button title={openLabel} aria-label={openLabel} onClick={() => void openInApp()}><RiExternalLinkLine size={17} /></button>
            <span className="flow-file-divider" aria-hidden="true" />
            {view === "focus" ? <button title="Return to canvas" aria-label="Return to canvas" onClick={leaveFocus}><RiArrowGoBackLine size={17} /></button> : null}
            <button title="Floating panel" aria-label="Floating panel" aria-pressed={view === "floating"} onClick={() => switchView("floating")}><RiWindowLine size={17} /></button>
            <button title="Dock to the right" aria-label="Dock to the right" aria-pressed={view === "docked"} onClick={() => switchView("docked")}><RiLayoutRightLine size={17} /></button>
            <button title="Focus view" aria-label="Focus view" aria-pressed={view === "focus"} onClick={() => switchView("focus")}><RiFullscreenLine size={17} /></button>
            <button title="Close · Esc" aria-label={kind === "pdf" ? "Close PDF" : "Close spreadsheet"} onClick={onClose}><RiCloseLine size={19} /></button>
          </div>
        </header>
        <div className="flow-document-heading">
          <div className="flow-document-breadcrumb">{diagramName || "Flowchart"} <span>/</span> {kind === "pdf" ? "PDF" : sheetFormatName(ext)}</div>
          <NameField title={title} fallback={fallback} label={kind === "pdf" ? "PDF name" : "Spreadsheet name"} onRename={onRename} />
        </div>
        {kind === "pdf"
          ? <PdfView src={src} title={name} />
          : <SheetView src={src} ext={ext} openLabel={openLabel} onOpen={() => void openInApp()} findRef={openFind} />}
      </section>
    </div>
  )
}

/**
 * The name, renamed when the edit ends — Enter or leaving the field — rather than at
 * each key, so one rename is one step to undo. Esc puts back the name it had. Enter
 * hands the keyboard to the panel, not to the page: on the page it would be the
 * canvas's, where the next Backspace deletes the node this panel shows.
 */
function NameField({ title, fallback, label, onRename }: {
  title: string
  fallback: string
  label: string
  onRename?(title: string): void
}) {
  const [draft, setDraft] = useState(title)
  const editing = useRef(false)
  // An undo, or a rename from elsewhere, shows here — but never under the caret.
  useEffect(() => { if (!editing.current) setDraft(title) }, [title])

  if (!onRename) return <input aria-label={label} value={title} readOnly />

  function commit() {
    editing.current = false
    const next = draft.trim() || fallback
    setDraft(next)
    if (next !== title) onRename?.(next)
  }

  return <input
    aria-label={label}
    value={draft}
    maxLength={200}
    onFocus={() => { editing.current = true }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (composing(event)) return
      if (event.key === "Enter") {
        event.preventDefault()
        // Leaving the field renames (onBlur); the grid, when there is one, takes the arrows.
        const host = event.currentTarget.closest<HTMLElement>(".flow-file-panel")
        const target = host?.querySelector<HTMLElement>(".flow-sheet-grid") ?? host
        if (target) target.focus({ preventScroll: true })
        else event.currentTarget.blur()
      } else if (event.key === "Escape" && draft !== title) {
        // One Esc, one step: this one takes the edit back; the next closes the panel.
        event.preventDefault()
        event.stopPropagation()
        setDraft(title)
      }
    }}
  />
}

/** The foot of either panel: what is shown, and Copy file path. */
function FileFooter({ src, ext, children }: { src: string; ext: string; children?: ReactNode }) {
  return <footer className="flow-document-footer">
    <span role="status">{children}</span>
    <CopyPathButton label="Copy file path" onPath={() => call("diagramsGetFilePath", src)}>.{ext} file</CopyPathButton>
  </footer>
}

function PdfView({ src, title }: { src: string; title: string }) {
  // No sandbox attribute: it would keep Chromium's viewer from loading. Keyed by the
  // address, so another file is a fresh page rather than a navigation of this one.
  return <>
    <div className="flow-file-pdf">
      <iframe key={src} className="flow-file-frame" src={src} title={title} />
    </div>
    <FileFooter src={src} ext="pdf">PDF file</FileFooter>
  </>
}

/**
 * A cell's room around its text: 8px of padding each side, its 1px border, and 3px
 * to spare — text measured to the pixel still lands a fraction off once drawn.
 */
const CELL_ROOM = 20
/** Enough of a cell's text to tell it wider than COLUMN_MAX, in the narrowest letters. */
const MEASURE_CHARS = 160

/** The grid's font, read from its style the first time a page is measured. */
let gridFont: { size: string; family: string } | null = null
let measurer: CanvasRenderingContext2D | null | undefined

/**
 * How wide `text` is drawn in a cell of the grid, in pixels — measured with a canvas
 * in the grid's own font, as one line: the cell's `nowrap` joins its lines with
 * spaces. A number is drawn with tabular figures (styles.css), every digit as wide
 * as a 0 and none of them kerned, so it is measured that way. Null with no canvas.
 */
function textWidth(text: string, bold: boolean, numeric: boolean, grid: HTMLElement | null): number | null {
  if (measurer === undefined) measurer = document.createElement("canvas").getContext("2d")
  if (!measurer) return null
  if (!gridFont && grid) {
    const style = getComputedStyle(grid)
    // A canvas may not know the -apple-system alias the page's font starts with.
    gridFont = { size: style.fontSize, family: style.fontFamily.replace(/-apple-system/g, "system-ui") }
  }
  const font = gridFont ?? { size: "12px", family: "system-ui" }
  measurer.font = `${bold ? 600 : 400} ${font.size} ${font.family}`
  measurer.fontKerning = numeric ? "none" : "auto"
  const line = text.slice(0, MEASURE_CHARS).replace(/[ \t\n\r\f]+/g, " ").trim()
  return measurer.measureText(numeric ? line.replace(/\d/g, "0") : line).width
}

/**
 * Each column's width, from the sheet's first page of rows: room for the widest text
 * in it, held between COLUMN_MIN and COLUMN_MAX. Before that page comes, all alike.
 */
function columnWidths(rows: string[][] | undefined, cols: number, grid: HTMLElement | null): number[] {
  const widths = new Array<number>(cols).fill(rows ? COLUMN_MIN : COLUMN_DEFAULT)
  if (!rows) return widths
  rows.forEach((row, index) => {
    const end = Math.min(row.length, cols)
    for (let col = 0; col < end; col++) {
      const text = row[col]
      if (!text || widths[col] >= COLUMN_MAX) continue
      // The first row may be drawn bold, as a header; it is measured so either way.
      const measured = textWidth(text, index === 0, NUMERIC.test(text), grid)
      const width = Math.ceil(measured ?? text.length * 8) + CELL_ROOM
      if (width > widths[col]) widths[col] = Math.min(COLUMN_MAX, width)
    }
  })
  return widths
}

/** The column whose span holds `x`, measured from the first column's left edge. */
function columnAt(lefts: number[], x: number): number {
  let lo = 0
  let hi = lefts.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lefts[mid] <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

function SheetView({ src, ext, openLabel, onOpen, findRef }: {
  src: string
  ext: string
  openLabel: string
  onOpen(): void
  /** Set to what ⌘F does here, for the panel, which hears it wherever focus is. */
  findRef: React.RefObject<(() => void) | null>
}) {
  const [info, setInfo] = useState<SheetInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [sheet, setSheet] = useState(0)
  const [header, setHeader] = useState(true)
  const [selected, setSelected] = useState<Cell>({ row: 0, col: 0 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [, setArrived] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<Found>(NOT_FOUND)
  // Each sheet's rows as they come, a page of PAGE_ROWS at a time: sheet → page → rows.
  const pages = useRef(new Map<number, Map<number, string[][]>>())
  const pending = useRef(new Set<number>())
  // Bumped when the pages asked for stop being wanted — another sheet, a retry, the
  // panel closing — so an answer to an older ask is dropped rather than kept.
  const generation = useRef(0)
  const searches = useRef(0)
  const grid = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const copyText = useRef<HTMLSpanElement>(null)

  const current = info?.sheets[sheet]
  const rows = current?.rows ?? 0
  const cols = current?.cols ?? 0
  const sheetPages = pages.current.get(sheet)
  const firstPage = sheetPages?.get(0)
  // The grid is there by the time a page is: it came with the sheet's info.
  const widths = useMemo(() => columnWidths(firstPage, cols, grid.current), [firstPage, cols])
  const lefts = useMemo(() => {
    const out = [0]
    for (const width of widths) out.push(out[out.length - 1] + width)
    return out
  }, [widths])
  const totalWidth = lefts[lefts.length - 1]
  const gutter = Math.max(44, String(rows).length * 7 + 22)
  // "Header row": the first row stays under the letters, in bold, as the sheet scrolls.
  const stickyRows = header && rows > 0 ? 1 : 0
  const top = LETTERS_HEIGHT + stickyRows * ROW_HEIGHT
  const viewHeight = viewport.height || 600
  const viewWidth = viewport.width || PANEL_WIDTH
  const firstRow = Math.max(stickyRows, Math.floor((scroll.top + top - LETTERS_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS)
  const lastRow = Math.min(rows - 1, Math.ceil((scroll.top + viewHeight - LETTERS_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS)
  const firstCol = columnAt(lefts, scroll.left - OVERSCAN_PX)
  const lastCol = cols ? columnAt(lefts, scroll.left + viewWidth - gutter + OVERSCAN_PX) : -1
  const selectedPage = sheetPages?.get(Math.floor(selected.row / PAGE_ROWS))
  const selectedText = selectedPage?.[selected.row % PAGE_ROWS]?.[selected.col] ?? ""

  // What scrolling a cell into view reads, from an answer that arrives after renders.
  const layout = useRef({ lefts, widths, gutter, top, stickyRows, rows, cols })
  layout.current = { lefts, widths, gutter, top, stickyRows, rows, cols }
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    let alive = true
    setError(null)
    void call("diagramsSheetInfo", src).then((result) => {
      if (!alive) return
      if (result.ok) setInfo(result.data)
      else setError(result.error)
    })
    return () => { alive = false }
  }, [src, attempt])

  useEffect(() => () => {
    generation.current++
    searches.current++
  }, [])

  const hasGrid = !!current
  useLayoutEffect(() => {
    const element = grid.current
    if (!element) return
    const measure = () => setViewport((prev) =>
      prev.width === element.clientWidth && prev.height === element.clientHeight ? prev : { width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasGrid])

  // The panel takes the keyboard as it opens; once the sheet is there, the grid has it,
  // so the arrows move the selection straight away.
  useEffect(() => {
    const active = document.activeElement
    if (grid.current && active instanceof HTMLElement && active.classList.contains("flow-file-panel")) grid.current.focus({ preventScroll: true })
  }, [hasGrid])

  function fetchPage(page: number) {
    const start = page * PAGE_ROWS
    if (start >= rows || pending.current.has(page) || pages.current.get(sheet)?.has(page)) return
    pending.current.add(page)
    const ask = generation.current
    const index = sheet
    void call("diagramsSheetRows", src, index, start, Math.min(PAGE_ROWS, rows - start)).then((result) => {
      if (ask !== generation.current) return
      pending.current.delete(page)
      if (!result.ok) { setRowsError(result.error); return }
      let kept = pages.current.get(index)
      if (!kept) pages.current.set(index, (kept = new Map()))
      kept.set(page, result.data.rows)
      setArrived((n) => n + 1)
    })
  }

  useEffect(() => {
    if (!current || rows === 0 || rowsError) return
    const timer = setTimeout(() => {
      // The first page always: it sizes the columns and holds the header row.
      fetchPage(0)
      for (let page = Math.floor(firstRow / PAGE_ROWS); page <= Math.floor(lastRow / PAGE_ROWS); page++) fetchPage(page)
      fetchPage(Math.floor(selected.row / PAGE_ROWS))
    }, pages.current.get(sheet)?.size ? FETCH_SETTLE_MS : 0)
    return () => clearTimeout(timer)
  }, [current, sheet, rows, firstRow, lastRow, selected.row, rowsError])

  function forgetAsks() {
    generation.current++
    pending.current.clear()
    setRowsError(null)
  }

  function chooseSheet(index: number) {
    if (index === sheet) return
    forgetAsks()
    setSheet(index)
    setSelected({ row: 0, col: 0 })
    setScroll({ top: 0, left: 0 })
    grid.current?.scrollTo({ top: 0, left: 0 })
    // The keyboard goes with it, as a spreadsheet's does: the arrows move in the sheet.
    grid.current?.focus({ preventScroll: true })
  }

  function onScroll() {
    const element = grid.current
    if (!element) return
    const next = {
      top: Math.floor(element.scrollTop / SCROLL_STEP_Y) * SCROLL_STEP_Y,
      left: Math.floor(element.scrollLeft / SCROLL_STEP_X) * SCROLL_STEP_X,
    }
    setScroll((prev) => (prev.top === next.top && prev.left === next.left ? prev : next))
  }

  // Scrolls just enough to show `cell` clear of the letters, the header row and the
  // row numbers, which all stay over the cells. The header row is always in view, but
  // a key that moves up to it (⌘↑, ⌘Home) means the top of the sheet: the rows under
  // it come back into view too.
  function reveal(cell: Cell, byKey: boolean) {
    const element = grid.current
    if (!element) return
    const { lefts, widths, gutter, top, stickyRows } = layout.current
    let { scrollTop, scrollLeft } = element
    if (cell.row >= stickyRows || byKey) {
      const y = LETTERS_HEIGHT + Math.max(cell.row, stickyRows) * ROW_HEIGHT
      if (y < scrollTop + top) scrollTop = y - top
      else if (y + ROW_HEIGHT > scrollTop + element.clientHeight) scrollTop = y + ROW_HEIGHT - element.clientHeight
    }
    if (cell.col < widths.length) {
      const x = gutter + lefts[cell.col]
      const width = widths[cell.col]
      if (x < scrollLeft + gutter) scrollLeft = x - gutter
      else if (x + width > scrollLeft + element.clientWidth) scrollLeft = Math.min(x - gutter, x + width - element.clientWidth)
    }
    if (scrollTop !== element.scrollTop || scrollLeft !== element.scrollLeft) element.scrollTo({ top: scrollTop, left: scrollLeft })
  }

  function select(cell: Cell, byKey = false) {
    const { rows, cols } = layout.current
    const next = { row: Math.max(0, Math.min(rows - 1, cell.row)), col: Math.max(0, Math.min(cols - 1, cell.col)) }
    // At once, not at the next render: a key held down repeats faster than that.
    selectedRef.current = next
    setSelected(next)
    reveal(next, byKey)
  }

  // ⌘C never reaches the grid's keydown in the app: the Edit menu's accelerator takes
  // it (main/index.js), and with a [data-flow-document-panel] focused the renderer
  // copies the document's selection instead (app.js handleEdit). So while the grid has
  // the keyboard, the selected cell's text is kept selected, out of sight — and only
  // then: left selected, it is what ⌘C anywhere with no selection of its own (the
  // canvas, after a click on it) would put on the clipboard.
  function armCopy() {
    const target = copyText.current
    if (target && document.activeElement === grid.current) window.getSelection()?.selectAllChildren(target)
  }
  function disarmCopy() {
    const selection = window.getSelection()
    if (selection?.anchorNode && copyText.current?.contains(selection.anchorNode)) selection.removeAllRanges()
  }
  useEffect(() => { armCopy() }, [selectedText, hasGrid])

  function copyCell() {
    if (!selectedPage) return
    void call("writeClipboard", selectedText).then((result) => {
      if (!result.ok) toast({ title: "Couldn't copy the cell", description: result.error, variant: "error" })
    })
  }

  function onGridKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || !current) return
    const mod = event.metaKey || event.ctrlKey
    const screen = Math.max(1, Math.floor((event.currentTarget.clientHeight - top) / ROW_HEIGHT) - 1)
    let { row, col } = selectedRef.current
    switch (event.key) {
      case "ArrowUp": row = mod ? 0 : row - 1; break
      case "ArrowDown": row = mod ? rows - 1 : row + 1; break
      case "ArrowLeft": col = mod ? 0 : col - 1; break
      case "ArrowRight": col = mod ? cols - 1 : col + 1; break
      case "PageUp": row -= screen; break
      case "PageDown": row += screen; break
      case "Home": col = 0; if (mod) row = 0; break
      case "End": col = cols - 1; if (mod) row = rows - 1; break
      default:
        if (mod && event.key.toLowerCase() === "c") {
          event.preventDefault()
          copyCell()
        }
        return
    }
    event.preventDefault()
    select({ row, col }, true)
  }

  useEffect(() => {
    const ask = ++searches.current
    if (!findOpen || !current || !query.trim()) {
      setFound(NOT_FOUND)
      return
    }
    setFound((prev) => ({ ...prev, searching: true, error: null }))
    const timer = setTimeout(() => {
      void call("diagramsSheetFind", src, sheet, query, FIND_LIMIT).then((result) => {
        if (ask !== searches.current) return
        if (!result.ok) { setFound({ ...NOT_FOUND, error: result.error }); return }
        const { matches, more } = result.data
        // The first match from the selected cell on, as a find in a page goes on from
        // where you are.
        const from = selectedRef.current
        const after = matches.findIndex((match) => match.row > from.row || (match.row === from.row && match.col >= from.col))
        const index = matches.length ? Math.max(0, after) : -1
        setFound({ matches, more, index, searching: false, error: null })
        if (index >= 0) select(matches[index])
      })
    }, FIND_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [findOpen, query, sheet, current, src])

  function step(by: number) {
    if (!found.matches.length) return
    const index = (found.index + by + found.matches.length) % found.matches.length
    setFound({ ...found, index })
    select(found.matches[index])
  }

  function showFind() {
    setFindOpen(true)
    requestAnimationFrame(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }

  function closeFind() {
    setFindOpen(false)
    grid.current?.focus({ preventScroll: true })
  }

  useEffect(() => { findRef.current = current ? showFind : null })
  useEffect(() => () => { findRef.current = null }, [findRef])

  const matchKeys = useMemo(() => (findOpen ? new Set(found.matches.map((match) => `${match.row}:${match.col}`)) : null), [findOpen, found.matches])
  const currentMatch = findOpen && found.index >= 0 ? found.matches[found.index] : null
  const currentKey = currentMatch ? `${currentMatch.row}:${currentMatch.col}` : ""

  if (error) {
    return <>
      <div className="flow-file-problem" role="alert">
        <RiErrorWarningLine size={28} aria-hidden="true" />
        <p>{error}</p>
        <div>
          <button className="flow-file-primary" onClick={onOpen}>{openLabel}</button>
          <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      </div>
      <FileFooter src={src} ext={ext}>{sheetFormatName(ext)}</FileFooter>
    </>
  }
  if (!info) {
    return <>
      <div className="flow-document-loading flow-file-loading" role="status">Opening spreadsheet…</div>
      <FileFooter src={src} ext={ext}>{sheetFormatName(ext)}</FileFooter>
    </>
  }
  if (!current) {
    return <>
      <div className="flow-file-problem" role="status"><p>This spreadsheet has no sheets to show.</p></div>
      <FileFooter src={src} ext={ext}>{sheetFormatName(ext)}</FileFooter>
    </>
  }

  const columns: number[] = []
  for (let col = firstCol; col <= lastCol; col++) columns.push(col)
  const bodyRows: number[] = []
  for (let row = firstRow; row <= lastRow; row++) bodyRows.push(row)

  function rowCells(row: number, cells: string[] | undefined) {
    return columns.map((col) => {
      const full = cells?.[col] ?? ""
      const text = full.length > CELL_TEXT_MAX ? full.slice(0, CELL_TEXT_MAX) : full
      const key = `${row}:${col}`
      return <div
        key={col}
        className="flow-sheet-cell"
        data-row={row}
        data-col={col}
        data-num={NUMERIC.test(text) || undefined}
        data-match={matchKeys?.has(key) || undefined}
        data-current={key === currentKey || undefined}
        data-selected={(row === selected.row && col === selected.col) || undefined}
        style={{ left: lefts[col], width: widths[col] }}
      >{text}</div>
    })
  }

  const findStatus = found.error
    ?? (found.searching ? "Searching…"
      : !query.trim() ? ""
        : found.matches.length ? `${found.index + 1} of ${found.matches.length.toLocaleString()}${found.more ? "+" : ""}`
          : "No matches")

  return (
    <div className="flow-sheet" onKeyDown={(event) => {
      if (composing(event)) return
      // One Esc, one step: this one closes find; the next closes the panel.
      if (event.key === "Escape" && findOpen) {
        event.preventDefault()
        event.stopPropagation()
        closeFind()
      }
    }}>
      <div className="flow-sheet-tools">
        <div className="flow-sheet-inspector" aria-live="polite">
          <span className="flow-sheet-ref">{rows ? `${sheetColumnName(selected.col)}${selected.row + 1}` : "—"}</span>
          <div className="flow-sheet-value">{!rows ? "" : !selectedPage ? "…" : selectedText || <em>Empty cell</em>}</div>
        </div>
        <button className="flow-sheet-toggle" aria-pressed={header} title="Keep the first row at the top, in bold" onClick={() => setHeader(!header)}>Header row</button>
        <button className="flow-sheet-tool" title="Find in sheet · ⌘F" aria-label="Find in sheet" aria-pressed={findOpen} onClick={() => (findOpen ? closeFind() : showFind())}><RiSearchLine size={15} /></button>
      </div>
      {findOpen ? <div className="flow-sheet-find" role="search">
        <RiSearchLine size={14} aria-hidden="true" />
        <input
          ref={findInput}
          type="text"
          aria-label="Find in sheet"
          placeholder="Find in sheet"
          value={query}
          maxLength={200}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (composing(event)) return
            if (event.key === "Enter") {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            }
          }}
        />
        <span role="status">{findStatus}</span>
        <button title="Previous match · ⇧↵" aria-label="Previous match" disabled={!found.matches.length} onClick={() => step(-1)}><RiArrowUpSLine size={16} /></button>
        <button title="Next match · ↵" aria-label="Next match" disabled={!found.matches.length} onClick={() => step(1)}><RiArrowDownSLine size={16} /></button>
        <button title="Close find · Esc" aria-label="Close find" onClick={closeFind}><RiCloseLine size={16} /></button>
      </div> : null}
      {rowsError ? <div className="flow-document-error" role="alert">
        <p>{rowsError}</p>
        <div><button onClick={forgetAsks}>Try again</button></div>
      </div> : null}
      <div className="flow-sheet-body">
        <div
          ref={grid}
          className="flow-sheet-grid"
          tabIndex={0}
          aria-label={`${current.name || "Sheet"} — ${rows.toLocaleString()} rows`}
          onScroll={onScroll}
          onKeyDown={onGridKey}
          onFocus={armCopy}
          onBlur={disarmCopy}
          onMouseDown={(event) => {
            if (event.button !== 0 || !(event.target instanceof Element)) return
            const target = event.target.closest<HTMLElement>("[data-row], [data-col]")
            if (!target) return
            select({
              row: target.dataset.row === undefined ? selectedRef.current.row : Number(target.dataset.row),
              col: target.dataset.col === undefined ? selectedRef.current.col : Number(target.dataset.col),
            })
          }}
        >
          <div className="flow-sheet-sizer" style={{ width: gutter + totalWidth }}>
            <div className="flow-sheet-band" style={{ height: top }}>
              <div className="flow-sheet-corner" style={{ width: gutter, height: top }}>
                {stickyRows ? <div className="flow-sheet-rownum" data-row={0} data-selected={selected.row === 0 || undefined} style={{ top: LETTERS_HEIGHT }}>1</div> : null}
              </div>
              {columns.map((col) => <div key={col} className="flow-sheet-letter" data-col={col} data-selected={col === selected.col || undefined} style={{ left: gutter + lefts[col], width: widths[col] }}>{sheetColumnName(col)}</div>)}
              {stickyRows ? <div className="flow-sheet-row flow-sheet-head" data-loading={!firstPage || undefined} style={{ top: LETTERS_HEIGHT, left: gutter, width: totalWidth }}>{rowCells(0, firstPage?.[0])}</div> : null}
            </div>
            <div className="flow-sheet-gutter" style={{ width: gutter, height: Math.max(0, rows - stickyRows) * ROW_HEIGHT }}>
              {bodyRows.map((row) => <div key={row} className="flow-sheet-rownum" data-row={row} data-selected={row === selected.row || undefined} style={{ top: (row - stickyRows) * ROW_HEIGHT }}>{row + 1}</div>)}
            </div>
            {bodyRows.map((row) => {
              const page = sheetPages?.get(Math.floor(row / PAGE_ROWS))
              return <div key={row} className="flow-sheet-row" data-loading={!page || undefined} style={{ top: LETTERS_HEIGHT + row * ROW_HEIGHT, left: gutter, width: totalWidth }}>
                {rowCells(row, page?.[row % PAGE_ROWS])}
              </div>
            })}
          </div>
        </div>
        {rows === 0 && !current.truncated ? <div className="flow-sheet-blank">This sheet is empty.</div> : null}
        {rows === 0 && current.truncated ? <div className="flow-file-problem flow-sheet-skipped" role="status">
          <p>This sheet wasn't read — the panel stops at 2,000,000 cells a workbook and 100,000 rows a sheet.</p>
          <div><button className="flow-file-primary" onClick={onOpen}>{openLabel}</button></div>
        </div> : null}
        <span ref={copyText} className="flow-sheet-copy" aria-hidden="true">{selectedText}</span>
      </div>
      {info.sheets.length > 1 ? <div className="flow-sheet-tabs" role="tablist" aria-label="Sheets">
        {info.sheets.map((entry, index) => <button key={index} role="tab" aria-selected={index === sheet} title={entry.name} onClick={() => chooseSheet(index)}>{entry.name || `Sheet ${index + 1}`}</button>)}
      </div> : null}
      <FileFooter src={src} ext={ext}>
        {rows.toLocaleString()} {rows === 1 ? "row" : "rows"} × {cols.toLocaleString()} {cols === 1 ? "column" : "columns"}
        {current.truncated && rows > 0 ? <em>Showing the first {rows.toLocaleString()} rows</em> : null}
        {current.clipped ? <em>Long cells cut at 32,767 characters</em> : null}
      </FileFooter>
    </div>
  )
}
