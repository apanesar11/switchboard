"use client"

// Switchboard's copy of the admin's app/dashboard/diagrams/DiagramsPage.tsx: the
// Diagrams tab of ONE workspace. Mirrored by hand like FlowEditor.tsx; what differs:
//
//   * A workspace, not a product. `wsId` is what the admin calls productId, and the
//     diagrams are files on this Mac (lib/diagrams/actions.ts), not rows.
//   * No page header. Switchboard's workspace header (name, branch, tabs) sits above,
//     so "New diagram" moves into the bar over the canvas, beside Actions.
//   * Full screen covers the window, below the macOS traffic lights — its bar is a
//     window drag region with room left for them, as the Editor's full screen is.
//   * `active`: false while another tab or workspace is on screen. The tree stays
//     mounted behind it (views/diagrams.js keeps it), and nothing here may answer a
//     key meant for that screen — Backspace on the Terminal deleting the boxes
//     selected here, say.
//
// The canvas IS the editor (FlowEditor.tsx), and changes save as you go.
//
// Diagrams are switched through a searchable dropdown (DiagramPicker), which
// lists active diagrams first and archived ones under an "Archived" heading at
// the bottom. Archiving puts a diagram away and can be undone; Delete, behind
// a confirmation, removes it for good. Both live in the Actions menu, so the
// bar over the canvas stays quiet.
//
// The dropdown is flanked by ← / → arrows that step to the diagram either side
// of it in exactly that order. They are on the bare arrow keys here, unlike
// Mockups: a diagram is one canvas, so there is no second list for ← / → to
// belong to.

import { useEffect, useMemo, useRef, useState } from "react"
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiFlowChart,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiInboxUnarchiveLine,
} from "@remixicon/react"
import {
  archiveDiagram,
  getDiagram,
  listDiagrams,
  unarchiveDiagram,
  updateDiagram,
} from "@/lib/diagrams/actions"
import type {
  DiagramDetail,
  DiagramSpec,
  DiagramSummary,
  FlowSpec,
} from "@/lib/diagrams/types"
import {
  diagramNavigation,
  preferredSelection,
  searchDiagrams,
} from "@/lib/diagrams/search"
import { cx, focusRing } from "@/lib/utils"
import { Button } from "@/components/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuIconWrapper,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/Dropdown"
import { toast } from "@/components/Toast"
import { DiagramCanvas } from "./DiagramCanvas"
import { DiagramPicker } from "./DiagramPicker"
import { DeleteDiagramDialog } from "./DeleteDiagramDialog"
import { FlowEditor, type FlowEditorHandle } from "./FlowEditor"
import { NewFlowDiagramDialog } from "./NewFlowDiagramDialog"
import { useArrowKeys } from "../mockups/useArrowKeys"

// Short relative label. Only ever rendered after the fetch resolves.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

// One of the two arrows flanking the picker. Styled as a sibling of the picker
// trigger rather than as a bare icon, so the three read as one control.
//
// `target` is the diagram this arrow lands on — null at the ends of the list,
// which is what disables the button. Naming it (and flagging an archived one)
// means stepping off the end of the active diagrams and into the Archived
// section is something you can see coming.
function DiagramStepButton({
  direction,
  target,
  onSelect,
}: {
  direction: "prev" | "next"
  target: DiagramSummary | null
  onSelect: (id: string) => void
}) {
  const Icon = direction === "prev" ? RiArrowLeftSLine : RiArrowRightSLine
  const what = `${direction === "prev" ? "Previous" : "Next"} diagram`
  const label = target
    ? `${what} — ${target.name}${target.archivedAt !== null ? " (archived)" : ""}`
    : what
  return (
    <button
      type="button"
      disabled={target === null}
      onClick={() => {
        if (target) onSelect(target.id)
      }}
      aria-label={label}
      title={`${label} · ${direction === "prev" ? "←" : "→"}`}
      className={cx(
        "flex size-[30px] shrink-0 items-center justify-center rounded-lg border transition-colors",
        "border-black/[.13] bg-white text-gray-500 hover:bg-[#f5f5f7] hover:text-gray-900",
        "dark:border-white/15 dark:bg-gray-950 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-50",
        "disabled:pointer-events-none disabled:opacity-40",
        focusRing,
      )}
    >
      <Icon className="size-[18px]" aria-hidden="true" />
    </button>
  )
}

// The bar's quiet buttons, drawn the way Switchboard draws its own (styles.css .btn
// and .ib): 30px, 8px corners, a hairline edge.
const BAR_BUTTON = cx(
  "h-[30px] rounded-lg border-black/[.13] px-3 text-[13px] font-medium shadow-none",
  "hover:bg-[#f5f5f7] dark:border-white/15 dark:hover:bg-gray-900",
)

export type DiagramsPageProps = {
  /** The workspace whose diagrams these are — the admin's productId. */
  wsId: string
  /** Its name, for the empty state and for "Reads sample-api first". */
  wsName: string
  /** False while the tab is not on screen: nothing here may take a key then. */
  active: boolean
  onOpenSettings?: () => void
  onOpenTerminal?: () => void
  /** The editor on screen, so the Edit menu and the quit flush can reach it. */
  onEditor?: (editor: FlowEditorHandle | null) => void
  /** Whether that editor holds anything not yet saved. */
  onDirtyChange?: (dirty: boolean) => void
}

export function DiagramsPage({
  wsId,
  wsName,
  active,
  onOpenSettings,
  onOpenTerminal,
  onEditor,
  onDirtyChange,
}: DiagramsPageProps) {
  const productId = wsId

  const [diagrams, setDiagrams] = useState<DiagramSummary[] | null>(null)
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  // The selected diagram's spec, tagged with the diagram it belongs to.
  // Deriving `spec` from that tag (rather than resetting it to null in an
  // effect) means the canvas never paints one diagram's title against another
  // diagram's drawing during a switch.
  const [specCache, setSpecCache] = useState<{
    diagramId: string
    spec: DiagramSpec | null
    error: string | null
  } | null>(null)
  // Bumped on every save so the canvas remounts and re-fits rather than holding
  // the pan/zoom of the pre-save drawing.
  const [canvasNonce, setCanvasNonce] = useState(0)
  // Paint the canvas over the whole window. Plain state, not the browser
  // Fullscreen API: the pane merely swaps to fixed positioning, so React Flow
  // is never unmounted and every keyboard shortcut keeps working.
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenNow = useRef(false)
  const paneRef = useRef<HTMLDivElement | null>(null)
  // Guards archive/unarchive so a double-click can't fire two writes.
  const [archiving, setArchiving] = useState(false)

  // The Actions menu, while open, has the keyboard (see keyboardEnabled). Its
  // trigger is where focus goes back to after a dialog opened from it.
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLButtonElement | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    archived: boolean
  } | null>(null)
  const [newFlowOpen, setNewFlowOpen] = useState(false)
  // The editor, so a pending autosave can be written before the diagram is
  // deleted out from under it.
  const flowEditorRef = useRef<FlowEditorHandle | null>(null)
  const attachEditor = (editor: FlowEditorHandle | null) => {
    flowEditorRef.current = editor
    onEditor?.(editor)
  }

  const selected = (diagrams ?? []).find((d) => d.id === selectedId) ?? null
  const isArchived = selected?.archivedAt != null
  const loaded =
    specCache !== null && specCache.diagramId === selectedId ? specCache : null

  useEffect(() => {
    let cancelled = false
    listDiagrams({ productId })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setDiagrams(result.data)
          // Keep the current selection when it survived the refresh, otherwise
          // fall back to the first ACTIVE diagram — "diagrams exist but none
          // selected" is never a state the user sees, and a fresh visit should
          // never open onto something archived.
          setSelectedId((prev) => {
            if (prev && result.data.some((d) => d.id === prev)) return prev
            const active = result.data.find((d) => d.archivedAt === null)
            return active?.id ?? result.data[0]?.id ?? null
          })
        } else {
          setDiagrams([])
          toast({
            title: "Couldn't load diagrams",
            description: result.error,
            variant: "error",
          })
        }
      })
      .catch((err) => {
        console.error("listDiagrams failed:", err)
        if (!cancelled) setDiagrams([])
      })

    return () => {
      cancelled = true
    }
  }, [productId, version])

  // The selected diagram's spec. A spec that no longer validates is kept as an
  // ERROR rather than a failure to load: the canvas says what is wrong with it,
  // and the diagram can still be archived or deleted.
  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false

    getDiagram({ productId, id: selectedId })
      .then((result) => {
        if (cancelled) return
        setSpecCache({
          diagramId: selectedId,
          spec: result.ok ? result.data.spec : null,
          error: result.ok ? null : result.error,
        })
      })
      .catch((err) => {
        console.error("getDiagram failed:", err)
        if (cancelled) return
        setSpecCache({
          diagramId: selectedId,
          spec: null,
          error: err instanceof Error ? err.message : "Request failed",
        })
      })

    return () => {
      cancelled = true
    }
    // A save writes the new spec straight into specCache, so there is no
    // separate refetch trigger here.
  }, [productId, selectedId])

  const results = useMemo(
    () => searchDiagrams(diagrams ?? [], search),
    [diagrams, search],
  )

  // The diagram either side of the selection, in the picker's own order —
  // including whatever a live search has filtered it down to.
  const nav = useMemo(
    () => diagramNavigation(results, selectedId),
    [results, selectedId],
  )

  // The keys belong to whatever owns focus while a dialog or menu is open — and to
  // nothing here at all while the tab is off screen.
  const keyboardEnabled = active && !actionsOpen && deleteTarget === null && !newFlowOpen

  function stepDiagram(delta: -1 | 1) {
    const target = delta === -1 ? nav.previous : nav.next
    if (target) setSelectedId(target.id)
  }

  useArrowKeys(keyboardEnabled && nav.ordered.length > 1, stepDiagram)

  // Esc leaves full screen, like any lightbox. Gated on keyboardEnabled so a
  // dialog opened over the overlay keeps Esc for itself. views/diagrams.js asks
  // isFullscreen() first, so Switchboard's own Esc (back) waits its turn.
  useEffect(() => {
    if (!fullscreen || !keyboardEnabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [fullscreen, keyboardEnabled])
  useEffect(() => {
    fullscreenNow.current = fullscreen
  }, [fullscreen])

  // Leaving the tab leaves full screen: it covers the window, and must not outlive
  // the screen it belongs to.
  useEffect(() => {
    if (!active) setFullscreen(false)
  }, [active])

  // Entering full screen moves focus off the now-invisible toolbar and into the
  // overlay — otherwise Tab/Enter keep operating the hidden buttons behind it,
  // sight unseen.
  useEffect(() => {
    if (fullscreen) paneRef.current?.focus()
  }, [fullscreen])

  // Move the selection into the search results when — and ONLY when — the
  // search itself changes. Gating on the search string (rather than re-running
  // whenever `results` changes) is load-bearing: `results` also changes when a
  // diagram is archived or created, and re-running then would yank the canvas
  // to a different diagram, or silently drop the one just created.
  const autoSelectedFor = useRef<string | null>(null)
  useEffect(() => {
    if (diagrams === null) return
    if (autoSelectedFor.current === search) return
    autoSelectedFor.current = search
    const next = preferredSelection(results, selectedId)
    if (next === null || next === selectedId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(next)
  }, [diagrams, search, results, selectedId])

  // Fold a just-written diagram back into the list straight away.
  function applyWrite(saved: DiagramSummary) {
    setDiagrams((prev) => {
      if (prev === null) return prev
      const index = prev.findIndex((d) => d.id === saved.id)
      if (index === -1) return [saved, ...prev]
      const next = [...prev]
      next[index] = saved
      return next
    })
  }

  // Archive and unarchive are the same shape: one write, then refresh the list
  // so the picker regroups. The diagram stays selected either way, which is
  // what makes archiving feel undoable — Unarchive is right there.
  async function handleArchiveToggle() {
    if (!selected || archiving) return
    const archived = selected.archivedAt !== null
    // The diagram's last few edits are written before it goes read-only.
    if (!archived) await flowEditorRef.current?.flush()
    setArchiving(true)
    try {
      const result = archived
        ? await unarchiveDiagram({ productId, id: selected.id })
        : await archiveDiagram({ productId, id: selected.id })

      if (!result.ok) {
        toast({
          title: archived ? "Couldn't unarchive" : "Couldn't archive",
          description: result.error,
          variant: "error",
        })
        return
      }
      toast({
        title: archived
          ? `Restored ${result.data.name}`
          : `Archived ${result.data.name}`,
        description: archived
          ? "It's active again and back at the top of the list."
          : "It's in the Archive section — unarchive it any time.",
        variant: "success",
      })
      applyWrite(result.data)
      setVersion((v) => v + 1)
    } finally {
      setArchiving(false)
    }
  }

  function handleSaved(saved: DiagramDetail) {
    const { spec, ...summary } = saved
    applyWrite(summary)
    setSpecCache({ diagramId: saved.id, spec, error: null })
    setSelectedId(saved.id)
    setCanvasNonce((n) => n + 1)
    setVersion((v) => v + 1)
  }

  // The editor's autosave. Unlike handleSaved this must NOT remount the
  // canvas — the editor already shows what was saved, and a remount would drop
  // the selection, the viewport and the undo history mid-edit. `id` and `name`
  // are bound when the editor renders, so a save flushed as it unmounts still
  // goes to the diagram it came from.
  async function saveFlow(
    id: string,
    name: string,
    spec: FlowSpec,
  ): Promise<string | null> {
    const result = await updateDiagram({ productId, id, name, spec })
    if (!result.ok) return result.error
    const { spec: savedSpec, ...summary } = result.data
    applyWrite(summary)
    // Only while that diagram is still the one loaded — a flush landing after
    // a switch must not overwrite the next diagram's spec.
    setSpecCache((prev) =>
      prev && prev.diagramId === id ? { ...prev, spec: savedSpec, error: null } : prev,
    )
    return null
  }

  const hasDiagrams = (diagrams ?? []).length > 0
  const editable = !isArchived

  function confirmDelete() {
    if (!selected) return
    // The diagram's last few edits are written first, so none of them can
    // land after the file is gone.
    if (editable) void flowEditorRef.current?.flush()
    setDeleteTarget({ id: selected.id, name: selected.name, archived: isArchived })
  }

  // views/diagrams.js asks this before Switchboard's own Esc means "back".
  useEffect(() => {
    exposeFullscreen.current = {
      isFullscreen: () => fullscreenNow.current,
      leave: () => setFullscreen(false),
    }
  })

  return (
    <>
      {diagrams === null ? (
        <div className="size-full animate-pulse bg-[var(--term-bg,#f7f7f9)]" />
      ) : !hasDiagrams ? (
        <div className="flex size-full flex-col items-center justify-center gap-1.5 bg-[var(--term-bg,#f7f7f9)] p-6 text-center">
          <span className="mb-2 flex size-10 items-center justify-center rounded-[10px] bg-white text-gray-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)] dark:bg-gray-900 dark:text-gray-400">
            <RiFlowChart className="size-5" aria-hidden="true" />
          </span>
          <h2 className="text-[15px] font-semibold text-gray-900 dark:text-gray-50">
            No diagrams in {wsName} yet
          </h2>
          <p className="max-w-sm text-[13px] text-gray-500 dark:text-gray-400">
            Draw one to think something through. ✦ Answer can read this
            workspace&apos;s code to answer a box&apos;s question.
          </p>
          <Button
            className="mt-3 h-[30px] rounded-lg border-transparent bg-[#1d1d1f] px-3 text-[13px] text-white shadow-none hover:bg-[#333336] dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-white"
            onClick={() => setNewFlowOpen(true)}
          >
            <RiAddLine className="-ml-1 mr-1 size-4" aria-hidden="true" />
            New diagram
          </Button>
        </div>
      ) : (
        <div className="flex size-full flex-col overflow-hidden">
          {/* Toolbar — picker on the left, actions for the selected diagram on
              the right. Every destructive path starts here, on a diagram you
              can see, rather than from a row in a list. */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-black/[.08] bg-white px-2.5 py-[9px] dark:border-white/10 dark:bg-gray-950">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {/* Step / pick / step. The arrows only appear once there is
                  somewhere to step to. */}
              <div className="flex min-w-0 items-center gap-1">
                {nav.ordered.length > 1 ? (
                  <DiagramStepButton
                    direction="prev"
                    target={nav.previous}
                    onSelect={setSelectedId}
                  />
                ) : null}
                <DiagramPicker
                  diagrams={diagrams ?? []}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  search={search}
                  onSearchChange={setSearch}
                  formatRelative={formatRelative}
                />
                {nav.ordered.length > 1 ? (
                  <>
                    <DiagramStepButton
                      direction="next"
                      target={nav.next}
                      onSelect={setSelectedId}
                    />
                    {nav.position !== null ? (
                      <span className="shrink-0 px-0.5 text-xs tabular-nums text-gray-400">
                        {nav.position}/{nav.ordered.length}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
              {selected ? (
                <p className="hidden truncate text-xs text-gray-500 sm:block dark:text-gray-400">
                  Updated {formatRelative(selected.updatedAt)}
                  {isArchived && selected.archivedAt
                    ? ` · archived ${formatRelative(selected.archivedAt)}`
                    : ""}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="secondary" className={BAR_BUTTON} onClick={() => setNewFlowOpen(true)}>
                <RiAddLine className="-ml-1 mr-1 size-4" aria-hidden="true" />
                New diagram
              </Button>
              {selected ? (
                <>
                  <Button
                    variant="secondary"
                    className={cx(BAR_BUTTON, "size-[30px] px-0")}
                    aria-label="Full screen"
                    title="Full screen"
                    onClick={() => setFullscreen(true)}
                  >
                    <RiFullscreenLine className="size-4" aria-hidden="true" />
                  </Button>

                  {/* Archive and Delete are rare, and the one that can't be
                      undone sits last, behind a confirmation. */}
                  <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button ref={actionsRef} variant="secondary" className={cx(BAR_BUTTON, "gap-1")}>
                        Actions
                        <RiArrowDownSLine className="-mr-1 size-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        disabled={archiving}
                        onSelect={() => void handleArchiveToggle()}
                      >
                        <DropdownMenuIconWrapper className="mr-2">
                          {isArchived ? (
                            <RiInboxUnarchiveLine className="size-4" aria-hidden="true" />
                          ) : (
                            <RiArchiveLine className="size-4" aria-hidden="true" />
                          )}
                        </DropdownMenuIconWrapper>
                        {isArchived ? "Unarchive" : "Archive"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={confirmDelete}
                        className="text-red-600 dark:text-red-400"
                      >
                        <DropdownMenuIconWrapper className="mr-2 text-red-600 dark:text-red-400">
                          <RiDeleteBinLine className="size-4" aria-hidden="true" />
                        </DropdownMenuIconWrapper>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : null}
            </div>
          </div>

          {selected === null ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Pick a diagram from the selector above to see it.
              </p>
            </div>
          ) : (
            // Full screen swaps the classes on this SAME element to a fixed
            // overlay instead of rendering a second canvas, so React Flow is
            // never remounted on the way in or out.
            <div
              ref={paneRef}
              tabIndex={fullscreen ? -1 : undefined}
              className={cx(
                "flex flex-col overflow-hidden bg-gray-100 outline-none dark:bg-gray-900",
                fullscreen ? "fixed inset-0 z-50" : "min-h-0 flex-1",
              )}
            >
              {fullscreen ? (
                // A window drag region, as the title bar it covers was, under the
                // traffic lights. Measured on macOS 26 they are 14px, from y=18 to
                // y=32 (trafficLightPosition y:18), so the band is 18 + 14 + 18 and
                // its 1px border: as much room under them as over them, and the row
                // centred on theirs at y=25. At 38px they hung 5px off the border.
                // The Editor's .edband is the same 51px; change one, change both.
                // The text starts at x=92, clear of the larger lights. The way out
                // is the enter button's icon turned around; Esc still works.
                <div
                  className="flex h-[51px] shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white pl-[92px] pr-3 dark:border-gray-800 dark:bg-gray-950"
                  style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
                >
                  <p className="truncate text-[13px] font-medium text-gray-900 dark:text-gray-50">
                    {selected.name}
                    <span className="font-normal text-gray-500"> · {wsName}</span>
                  </p>
                  <Button
                    variant="ghost"
                    className="size-[26px] shrink-0 rounded-md p-0 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                    aria-label="Exit full screen"
                    title="Exit full screen"
                    onClick={() => setFullscreen(false)}
                  >
                    <RiFullscreenExitLine className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}

              {isArchived ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <RiArchiveLine className="size-4 shrink-0" aria-hidden="true" />
                  <span>
                    This diagram is archived. It stays out of the main list
                    until you unarchive it, and can be edited again then.
                  </span>
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                {loaded === null ? (
                  <div className="size-full animate-pulse bg-gray-100 dark:bg-gray-900" />
                ) : loaded.spec === null ? (
                  <div className="flex size-full items-center justify-center p-6">
                    <div className="max-w-md rounded-md border border-red-200 bg-red-50 p-4 text-center dark:border-red-900/50 dark:bg-red-950/40">
                      <p className="text-sm font-medium text-red-700 dark:text-red-400">
                        This diagram can&apos;t be drawn
                      </p>
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                        {loaded.error}
                      </p>
                    </div>
                  </div>
                ) : editable ? (
                  // Keyed WITHOUT `fullscreen`, unlike the read-only canvas:
                  // remounting would throw away the undo history, so the editor
                  // re-fits itself instead (fitKey).
                  <FlowEditor
                    key={`${selected.id}:${canvasNonce}`}
                    ref={attachEditor}
                    spec={loaded.spec}
                    onSave={(spec) => saveFlow(selected.id, selected.name, spec)}
                    keyboardEnabled={keyboardEnabled}
                    fitKey={String(fullscreen)}
                    productId={productId}
                    diagramName={selected.name}
                    workspaceName={wsName}
                    onOpenSettings={onOpenSettings}
                    onOpenTerminal={onOpenTerminal}
                    onDirtyChange={onDirtyChange}
                  />
                ) : (
                  <DiagramCanvas
                    spec={loaded.spec}
                    resetKey={`${selected.id}:${canvasNonce}:${fullscreen}`}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <NewFlowDiagramDialog
        open={newFlowOpen}
        onOpenChange={setNewFlowOpen}
        productId={productId}
        onCreated={handleSaved}
      />

      <DeleteDiagramDialog
        target={deleteTarget}
        productId={productId}
        returnFocusRef={actionsRef}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onDeleted={(deletedId) => {
          // Drop the selection so the refresh picks a surviving diagram instead
          // of trying to draw a file that no longer exists. Full screen goes
          // with it — the refresh's auto-select must not reopen the overlay on
          // a diagram the user never chose.
          setSelectedId((prev) => (prev === deletedId ? null : prev))
          setFullscreen(false)
          setVersion((v) => v + 1)
        }}
      />
    </>
  )
}

/**
 * views/diagrams.js's way in: is the diagram on screen full screen, and the way
 * out of it. Module-level because there is one Diagrams tab on screen at a time.
 */
export const exposeFullscreen: {
  current: { isFullscreen: () => boolean; leave: () => void } | null
} = { current: null }
