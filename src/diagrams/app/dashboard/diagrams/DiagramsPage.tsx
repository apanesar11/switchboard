"use client"

// Switchboard's copy of the admin's app/dashboard/diagrams/DiagramsPage.tsx: ONE
// whiteboard, open on its own screen. Mirrored by hand like FlowEditor.tsx; what
// differs:
//
//   * A board, not a product's list. The page shows exactly `boardId` and never picks
//     another on its own: the quick switcher, ← / →, New whiteboard and Duplicate ask
//     the host to open a board (`onOpenBoard`), which changes the route, and the host
//     keeps one canvas per board (views/whiteboards.js). Boards are files on this Mac
//     (lib/diagrams/actions.ts), in folders the user makes, not rows.
//   * No page header. Switchboard's header (Whiteboards › folder › board, and a status
//     line) sits above and is fed by `onBoardChange` after the load and every write, so
//     the bar over the canvas holds only the switcher, New whiteboard, full screen and
//     Actions.
//   * Full screen covers the window, below the macOS traffic lights — its bar is a
//     window drag region with room left for them, as the Editor's full screen is.
//   * Actions ▸ Open terminal…, Show or hide terminals, Rename, Move to folder…,
//     Duplicate, which the admin doesn't have. Terminals float over the board in the
//     host's layer (views/wbterminals.js); this page only asks for them.
//   * ✦ Answer reads the board's own workspace (`board.workspace`), changed from the
//     editor's AI menu and remembered with the board.
//   * `active`: false while off screen. Each board's tree stays mounted (the host
//     keeps it), but may not answer keys meant for a terminal or another canvas. The
//     editor hears it too (`shown`) so its Google Images panel stops accepting input
//     when inactive.
//
// The canvas IS the editor (FlowEditor.tsx), and changes save as you go — the spec
// only. Rename writes the name only, so neither can carry an old copy of the other
// over a newer one written somewhere else.
//
// The switcher (DiagramPicker) lists the boards of THIS board's folder, active ones
// first and archived ones under an "Archived" heading at the bottom. It is flanked by
// ← / → arrows that step to the board either side in exactly that order, on the bare
// arrow keys: a board is one canvas, so there is no second list for them to belong to.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import * as PopoverPrimitives from "@radix-ui/react-popover"
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiErrorWarningLine,
  RiFullscreenExitLine,
} from "@remixicon/react"
import {
  archiveWhiteboard,
  duplicateWhiteboard,
  getWhiteboard,
  isMissingWhiteboard,
  listWhiteboards,
  listWorkspaceChoices,
  moveWhiteboard,
  renameWhiteboard,
  saveWhiteboardSpec,
  setWhiteboardWorkspace,
  unarchiveWhiteboard,
  type OpenedWhiteboard,
} from "@/lib/diagrams/actions"
import type { DiagramSummary, FlowSpec, TerminalSlot } from "@/lib/diagrams/types"
import { diagramNavigation, searchDiagrams } from "@/lib/diagrams/search"
import {
  listen,
  type WhiteboardFolder,
  type WhiteboardSummary,
  type WhiteboardsIndex,
  type WorkspaceChoices,
  type WorkspaceStatus,
} from "@/lib/bridge"
import { usePortalContainer } from "@/lib/portal"
import { cx, focusRing } from "@/lib/utils"
import { Button } from "@/components/Button"
import { Glyph } from "@/components/Glyph"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuIconWrapper,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSubMenu,
  DropdownMenuSubMenuContent,
  DropdownMenuSubMenuTrigger,
  DropdownMenuTrigger,
} from "@/components/Dropdown"
import { toast } from "@/components/Toast"
import { DiagramCanvas } from "./DiagramCanvas"
import { DiagramPicker } from "./DiagramPicker"
import { DeleteDiagramDialog } from "./DeleteDiagramDialog"
import { FlowEditor, type FlowEditorHandle } from "./FlowEditor"
import { NewFlowDiagramDialog } from "./NewFlowDiagramDialog"
import { RenameDiagramDialog } from "./RenameDiagramDialog"
import { WorkspacePicker } from "./WorkspacePicker"
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

// One of the two arrows flanking the switcher. Styled as a sibling of its trigger
// rather than as a bare icon, so the three read as one control.
//
// `target` is the board this arrow lands on — null at the ends of the list, which
// is what disables the button. Naming it (and flagging an archived one) means
// stepping off the end of the active boards and into the Archived section is
// something you can see coming.
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
  const what = `${direction === "prev" ? "Previous" : "Next"} whiteboard`
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
  "h-[30px] gap-[7px] rounded-lg border-black/[.13] px-3 text-[13px] font-medium shadow-none",
  "hover:bg-[#f5f5f7] dark:border-white/15 dark:hover:bg-gray-900",
)

// The Actions menu's rows, at the height and size of Switchboard's own menus.
const MENU_ITEM = "h-[30px] gap-[9px] rounded-[7px] px-[9px] py-0 text-[13px]"
const MENU_ICON = "flex size-[14px] items-center justify-center text-[#3a3a3c] dark:text-gray-400"

// The Move to folder… value for No folder. Folder ids are uuids, so it can't collide.
const NO_FOLDER = "none"

const OPEN_TERMINAL_FOOTER =
  "The same shell as the workspace's Terminal tab. One already open comes to the front."

/** A rectangle in client (window) pixels. */
export type ClientRect = { left: number; top: number; width: number; height: number }

export type DiagramsPageProps = {
  /** The whiteboard on screen. The page shows exactly this one. */
  boardId: string
  /** False while off screen. */
  active: boolean
  onOpenSettings?: () => void
  /** Open another board — the switcher, ← / →, New whiteboard and Duplicate. */
  onOpenBoard: (id: string) => void
  /** Leave the board for `folderId`'s list: Delete, or Back. */
  onClosed: (folderId: string | null) => void
  /** The board and its folder after the load and after every write, for the header. */
  onBoardChange: (board: WhiteboardSummary | null, folder: WhiteboardFolder | null) => void
  /** The rail's dot and branch for each workspace — pinned terminals and pickers. */
  workspaceStatus: WorkspaceStatus
  /** Float a terminal for the workspace over the board, or bring its panel to front. */
  onOpenTerminal: (wsId: string) => void
  /** Show or hide every floating terminal (⌘A). */
  onToggleTerminals: () => void
  /** Where pinned terminals are on screen — [] whenever no editor is drawn. */
  onTerminalSlots: (slots: TerminalSlot[]) => void
  /** A pinned terminal's Float button. */
  onTerminalFloat: (wsId: string) => void
  /** A pinned terminal left the canvas by undo or by delete, from where it was. */
  onTerminalRemoved: (wsId: string, reason: "undo" | "delete", rect: ClientRect) => void
  /** A workspace picker the host opened through the handle is showing — it has the keys. */
  pickerOpen?: boolean
  /** The editor on screen, so the Edit menu and the quit flush can reach it. */
  onEditor?: (editor: FlowEditorHandle | null) => void
  /** Whether that editor holds anything not yet saved. */
  onDirtyChange?: (dirty: boolean) => void
  /** The board's full-screen controls, for the host's Esc. */
  onFullscreen?: (handle: FullscreenHandle | null) => void
  onFullscreenChange?: (open: boolean) => void
}

export type FullscreenHandle = { isFullscreen: () => boolean; leave: () => void }

// The board as this page last saw it, tagged with the id it belongs to — so one
// board's name never paints over another's drawing if the host swaps `boardId`.
type Loaded =
  | { boardId: string; status: "ready"; board: OpenedWhiteboard }
  | { boardId: string; status: "missing" }
  | { boardId: string; status: "error"; error: string }

function summaryOf(board: OpenedWhiteboard): WhiteboardSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { spec, specError, ...summary } = board
  return summary
}

export function DiagramsPage({
  boardId,
  active,
  onOpenSettings,
  onOpenBoard,
  onClosed,
  onBoardChange,
  workspaceStatus,
  onOpenTerminal,
  onToggleTerminals,
  onTerminalSlots,
  onTerminalFloat,
  onTerminalRemoved,
  pickerOpen = false,
  onEditor,
  onDirtyChange,
  onFullscreen,
  onFullscreenChange,
}: DiagramsPageProps) {
  const portal = usePortalContainer()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = loaded !== null && loaded.boardId === boardId ? loaded : null
  const board = current?.status === "ready" ? current.board : null

  // Every folder and board, for the switcher, the folder's name and Move to folder…
  // It comes after the board and is refetched when main says something changed.
  const [index, setIndex] = useState<WhiteboardsIndex | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [workspaceChoices, setWorkspaceChoices] = useState<WorkspaceChoices | null>(null)
  const [search, setSearch] = useState("")

  // Paint the canvas over the whole window. Plain state, not the browser
  // Fullscreen API: the pane merely swaps to fixed positioning, so React Flow
  // is never unmounted and every keyboard shortcut keeps working.
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenNow = useRef(false)
  const paneRef = useRef<HTMLDivElement | null>(null)
  // One structural write at a time (archive, move, duplicate), so a double-click
  // can't fire two.
  const [busy, setBusy] = useState(false)

  // The Actions menu, while open, has the keyboard (see keyboardEnabled). Its
  // trigger is where focus goes back to after a dialog opened from it.
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLButtonElement | null>(null)
  // What an Actions item opens — a dialog, or the Open terminal… picker — waits here
  // until the menu has finished closing. Opened in the same tick, a modal dialog
  // and the closing menu each take a turn at <body>'s pointer-events, and the menu's
  // restore can lose: the window is left with pointer-events: none, dead to clicks.
  // `toTrigger`: focus goes back to the Actions button first, as after any menu, for
  // an action whose result takes focus later on its own (a terminal the host shows).
  // `stale`: picked as the board left the screen. The menu's exit animation stalls in
  // the hidden portal and ends only once the board is back, long after the user moved
  // on — the item is dropped then, and focus stays wherever it is.
  const afterMenu = useRef<{ run: () => void; toTrigger?: boolean; stale?: boolean } | null>(null)
  // Actions ▸ Open terminal…: a popover anchored to the Actions button.
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false)
  const pickedTerminal = useRef(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    archived: boolean
  } | null>(null)
  const [newFlowOpen, setNewFlowOpen] = useState(false)
  // Switchboard: the board Actions ▸ Rename is open for.
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  // The editor, so a pending autosave can be written before a structural write.
  const flowEditorRef = useRef<FlowEditorHandle | null>(null)
  const attachEditor = useCallback((editor: FlowEditorHandle | null) => {
    flowEditorRef.current = editor
    onEditor?.(editor)
  }, [onEditor])

  // Bumped as each of this page's own writes lands. A folder list fetched before one
  // landed may predate it, so it must not overwrite the board's name or folder.
  const writes = useRef(0)
  // Set once this page deleted the board, so main's "deleted" echo isn't mistaken
  // for the board vanishing under it.
  const deleted = useRef(false)
  const boardIdNow = useRef(boardId)
  useEffect(() => {
    boardIdNow.current = boardId
  }, [boardId])
  const activeNow = useRef(active)
  useEffect(() => {
    activeNow.current = active
  }, [active])

  const isArchived = board !== null && board.archivedAt !== null
  const editorShown = board !== null && board.spec !== null && !isArchived

  // ── Loading ──────────────────────────────────────────────────────────

  // Bumped to read the board again after it couldn't be read: Try again, or the board
  // coming back on screen. A file fixed by hand, or a read that failed for a moment,
  // then opens without a restart — the host keeps this canvas while it is parked.
  const [reload, setReload] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const unreadable = current?.status === "error"
  const unreadableNow = useRef(unreadable)
  useEffect(() => {
    unreadableNow.current = unreadable
  }, [unreadable])
  const readAgain = useCallback(() => {
    setRetrying(true)
    setReload((value) => value + 1)
  }, [])

  // The board first: its canvas is drawn without waiting for the folder list. Read
  // again keeps what is on screen until the answer comes.
  useEffect(() => {
    let cancelled = false
    deleted.current = false
    getWhiteboard({ id: boardId })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setLoaded({ boardId, status: "ready", board: result.data })
        else if (isMissingWhiteboard(result)) setLoaded({ boardId, status: "missing" })
        else setLoaded({ boardId, status: "error", error: result.error })
      })
      .catch((err) => {
        console.error("getWhiteboard failed:", err)
        if (!cancelled) {
          setLoaded({ boardId, status: "error", error: err instanceof Error ? err.message : "Request failed" })
        }
      })
      .finally(() => {
        if (!cancelled) setRetrying(false)
      })
    return () => {
      cancelled = true
    }
  }, [boardId, reload])

  // A summary main wrote for this page — its own write — folded straight in. The
  // spec stays as the editor has it, unless the write was a save that carried one.
  const applyWrite = useCallback((summary: WhiteboardSummary, spec?: FlowSpec) => {
    writes.current++
    setLoaded((prev) =>
      prev && prev.status === "ready" && prev.board.id === summary.id
        ? {
            ...prev,
            board: {
              ...prev.board,
              ...summary,
              ...(spec ? { spec, specError: null } : {}),
            },
          }
        : prev,
    )
  }, [])

  // The same board as somewhere else last left it — the Whiteboards screen can move
  // it to another folder. Only what other screens change is taken; the counts are
  // taken only when they are newer than the ones this page's own saves brought.
  const applyRemote = useCallback((fresh: WhiteboardSummary) => {
    setLoaded((prev) => {
      if (!prev || prev.status !== "ready" || prev.board.id !== fresh.id) return prev
      const mine = prev.board
      const newer = fresh.updatedAt > mine.updatedAt
      const next = {
        ...mine,
        name: fresh.name,
        folderId: fresh.folderId,
        archivedAt: fresh.archivedAt,
        workspace: fresh.workspace,
        ...(newer
          ? { updatedAt: fresh.updatedAt, boxes: fresh.boxes, reads: fresh.reads, thumb: fresh.thumb }
          : {}),
      }
      const same =
        next.name === mine.name &&
        next.folderId === mine.folderId &&
        next.archivedAt === mine.archivedAt &&
        next.workspace === mine.workspace &&
        !newer
      return same ? prev : { ...prev, board: next }
    })
  }, [])

  // Asked again when the folder list no longer has this board: gone, or unreadable.
  const recheckBoard = useCallback(() => {
    const id = boardIdNow.current
    void getWhiteboard({ id }).then((result) => {
      if (deleted.current || boardIdNow.current !== id) return
      if (result.ok) applyRemote(summaryOf(result.data))
      else if (isMissingWhiteboard(result)) setLoaded({ boardId: id, status: "missing" })
    })
  }, [applyRemote])

  const refreshList = useCallback(() => {
    const started = writes.current
    listWhiteboards()
      .then((result) => {
        if (!result.ok) {
          setListFailed(true)
          console.error("listWhiteboards failed:", result.error)
          return
        }
        setListFailed(false)
        setIndex(result.data)
        const id = boardIdNow.current
        const mine = result.data.boards.find((b) => b.id === id)
        if (mine && writes.current === started) applyRemote(mine)
        else if (!mine && !deleted.current) recheckBoard()
      })
      .catch((err) => {
        console.error("listWhiteboards failed:", err)
        setListFailed(true)
      })
  }, [applyRemote, recheckBoard])

  const refreshChoices = useCallback(() => {
    listWorkspaceChoices()
      .then((result) => {
        if (result.ok) setWorkspaceChoices(result.data)
        else console.error("listWorkspaceChoices failed:", result.error)
      })
      .catch((err) => console.error("listWorkspaceChoices failed:", err))
  }, [])

  // Once on mount, and again each time the board comes back on screen: a parked
  // canvas's list goes stale while another screen moves and renames things.
  const wasActive = useRef<boolean | null>(null)
  useEffect(() => {
    const first = wasActive.current === null
    const cameBack = active && wasActive.current === false
    wasActive.current = active
    if (first || cameBack) {
      refreshList()
      refreshChoices()
    }
    if (cameBack && unreadableNow.current) readAgain()
  }, [active, refreshList, refreshChoices, readAgain])

  // Main says what changed. A save of this very board is this page's own autosave and
  // changes nothing the list shows here; anything else may have renamed a folder,
  // moved a board in or out of this folder, or moved this board — refetched once
  // things settle, so a burst of writes costs one list. Another board's save only
  // reorders the switcher, so a canvas off screen leaves it to the refetch it makes
  // on coming back rather than following every keystroke typed elsewhere.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = listen("onWhiteboardsChanged", (change) => {
      if (change && change.reason === "save") {
        if (change.boardId === boardIdNow.current || !activeNow.current) return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refreshList()
      }, 120)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [refreshList])

  // ── What the rest of the page reads ─────────────────────────────────

  const folder = useMemo(
    () => (board && board.folderId !== null ? index?.folders.find((f) => f.id === board.folderId) ?? null : null),
    [board, index],
  )
  // "Architecture", "No folder", or null while the folder's name isn't known yet.
  const folderLabel =
    board === null
      ? null
      : board.folderId === null
        ? "No folder"
        : folder
          ? folder.name
          : index !== null || listFailed
            ? "No folder"
            : null

  // The boards of this board's folder, with this one as the page holds it — its own
  // saves don't refetch the list, so the list's copy of it may be behind.
  const siblings = useMemo<DiagramSummary[] | null>(() => {
    if (!index || !board) return null
    const others = index.boards.filter((b) => b.folderId === board.folderId && b.id !== board.id)
    return [summaryOf(board), ...others]
  }, [index, board])

  const results = useMemo(() => searchDiagrams(siblings ?? [], search), [siblings, search])
  // The board either side of this one, in the switcher's own order — including
  // whatever a live search has filtered it down to.
  const nav = useMemo(() => diagramNavigation(results, boardId), [results, boardId])

  // The keys belong to whatever owns focus while a dialog, menu or picker is open —
  // and to nothing here at all while the board is off screen.
  const keyboardEnabled =
    active &&
    !actionsOpen &&
    !terminalPickerOpen &&
    !pickerOpen &&
    deleteTarget === null &&
    !newFlowOpen &&
    renameTarget === null

  function openBoard(id: string) {
    if (id !== boardId) onOpenBoard(id)
  }

  function stepBoard(delta: -1 | 1) {
    const target = delta === -1 ? nav.previous : nav.next
    if (target) openBoard(target.id)
  }

  useArrowKeys(keyboardEnabled && nav.ordered.length > 1, stepBoard)

  // ── Telling the host ────────────────────────────────────────────────

  // The header's breadcrumb and status line. Reported once the folder's name is
  // known (or there is none), so it never flashes "No folder" for a board that has one.
  const boardChange = useRef(onBoardChange)
  useEffect(() => {
    boardChange.current = onBoardChange
  })
  useEffect(() => {
    if (current === null) return
    if (current.status !== "ready") {
      boardChange.current(null, null)
      return
    }
    if (current.board.folderId !== null && folderLabel === null) return
    boardChange.current(summaryOf(current.board), folder)
  }, [current, folder, folderLabel])

  // No editor drawn (loading, archived, missing, or a spec that can't be drawn): no
  // pinned terminal has anywhere to be, so the host's overlays must all go.
  const terminalSlots = useRef(onTerminalSlots)
  useEffect(() => {
    terminalSlots.current = onTerminalSlots
  })
  useEffect(() => {
    if (!editorShown) terminalSlots.current([])
  }, [editorShown])

  // ── Keyboard and full screen ────────────────────────────────────────

  // Esc leaves full screen, like any lightbox. Gated on keyboardEnabled so a
  // dialog opened over the overlay keeps Esc for itself. The host asks
  // isFullscreen() first, so Switchboard's own Esc waits its turn.
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

  // The host moves to body while full screen, out of the slab's clip and stacking
  // context, preserving this exact React Flow tree and all of its editor state.
  useLayoutEffect(() => {
    onFullscreenChange?.(fullscreen)
  }, [fullscreen, onFullscreenChange])

  // Body-level dialogs and menus cannot remain visible after this board loses
  // the screen.
  useEffect(() => {
    if (!active) {
      // A menu closing now finishes only once the board is back (see afterMenu).
      if (afterMenu.current || actionsOpen) afterMenu.current = { run: () => {}, stale: true }
      setFullscreen(false)
      setActionsOpen(false)
      setTerminalPickerOpen(false)
      setDeleteTarget(null)
      setNewFlowOpen(false)
      setRenameTarget(null)
    }
  }, [active])

  // A different board in the same instance starts with nothing of the last one's open.
  useEffect(() => {
    setSearch("")
    setDeleteTarget(null)
    setRenameTarget(null)
    setTerminalPickerOpen(false)
  }, [boardId])

  // Entering full screen moves focus off the now-invisible toolbar and into the
  // overlay — otherwise Tab/Enter keep operating the hidden buttons behind it,
  // sight unseen.
  useEffect(() => {
    if (fullscreen) paneRef.current?.focus()
  }, [fullscreen])

  // Each board owns its own canvas, and the host asks the one on screen.
  useEffect(() => {
    onFullscreen?.({
      isFullscreen: () => fullscreenNow.current,
      leave: () => setFullscreen(false),
    })
    return () => onFullscreen?.(null)
  }, [onFullscreen])

  // ── Writes ──────────────────────────────────────────────────────────

  // The editor's autosave: the spec only. It never remounts the canvas — the editor
  // already shows what was saved, and a remount would drop the selection, the
  // viewport and the undo history mid-edit. `id` is bound when the editor renders,
  // so a save flushed as it unmounts still goes to the board it came from.
  async function saveFlow(id: string, spec: FlowSpec): Promise<string | null> {
    const result = await saveWhiteboardSpec({ id, spec })
    if (!result.ok) return result.error
    const { spec: savedSpec, ...summary } = result.data
    applyWrite(summary, savedSpec)
    return null
  }

  // Switchboard: Rename — the name only.
  async function renameBoard(id: string, name: string): Promise<string | null> {
    const result = await renameWhiteboard({ id, name })
    if (!result.ok) return result.error
    applyWrite(result.data)
    toast({ title: `Renamed to ${result.data.name}`, variant: "success" })
    return null
  }

  // The workspace ✦ Answer reads, picked in the editor's AI menu.
  async function changeWorkspace(wsId: string) {
    if (!board) return
    const result = await setWhiteboardWorkspace({ id: board.id, workspace: wsId })
    if (!result.ok) {
      toast({ title: "Couldn't change the workspace", description: result.error, variant: "error" })
      return
    }
    applyWrite(result.data)
    // Main moved it to the front of the recent ones.
    refreshChoices()
  }

  // Archive and unarchive are the same shape: one write, after which the switcher
  // regroups (main's change event refetches it). The board stays open either way,
  // which is what makes archiving feel undoable — Unarchive is right there.
  async function handleArchiveToggle() {
    if (!board || busy) return
    const archived = board.archivedAt !== null
    setBusy(true)
    try {
      // The board's last few edits are written before it goes read-only.
      if (!archived) await flowEditorRef.current?.flush()
      const result = archived
        ? await unarchiveWhiteboard({ id: board.id })
        : await archiveWhiteboard({ id: board.id })
      if (!result.ok) {
        toast({
          title: archived ? "Couldn't unarchive" : "Couldn't archive",
          description: result.error,
          variant: "error",
        })
        return
      }
      toast({
        title: archived ? `Restored ${result.data.name}` : `Archived ${result.data.name}`,
        description: archived
          ? "It's active again and back at the top of its folder."
          : "It's in its folder's Archived section — unarchive it any time.",
        variant: "success",
      })
      applyWrite(result.data)
    } finally {
      setBusy(false)
    }
  }

  // Actions ▸ Move to folder…. The board's last edits are written first, so the
  // move never races an autosave of the same file.
  async function moveTo(folderId: string | null) {
    if (!board || busy || folderId === board.folderId) return
    setBusy(true)
    try {
      await flowEditorRef.current?.flush()
      const result = await moveWhiteboard({ id: board.id, folderId })
      if (!result.ok) {
        toast({ title: "Couldn't move the whiteboard", description: result.error, variant: "error" })
        return
      }
      applyWrite(result.data)
      const target = folderId === null ? null : index?.folders.find((f) => f.id === folderId)
      toast({
        title: folderId === null ? "Moved out of its folder" : `Moved to ${target?.name ?? "the folder"}`,
        variant: "success",
      })
      refreshList()
    } finally {
      setBusy(false)
    }
  }

  // Actions ▸ Duplicate: a copy in the same folder with the same workspace, opened
  // straight away. Written after the board's last edits, so the copy has them.
  async function duplicate() {
    if (!board || busy) return
    setBusy(true)
    try {
      await flowEditorRef.current?.flush()
      const result = await duplicateWhiteboard({ id: board.id })
      if (!result.ok) {
        toast({ title: "Couldn't duplicate the whiteboard", description: result.error, variant: "error" })
        return
      }
      toast({ title: `Duplicated as “${result.data.name}”`, variant: "success" })
      onOpenBoard(result.data.id)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (!board) return
    const target = { id: board.id, name: board.name, archived: isArchived }
    // The board's last few edits are written first, so none of them can land
    // after the file is gone.
    if (editorShown) await flowEditorRef.current?.flush()
    // Left during the write: the confirmation would wait in the hidden portal and
    // greet the user, unasked, when the board comes back.
    if (!activeNow.current || boardIdNow.current !== target.id) return
    setDeleteTarget(target)
  }

  // ── Rendering ───────────────────────────────────────────────────────

  // Rendered in every state, so a dialog still open (or closing) when the board goes
  // — Delete's own, above all — closes as Radix expects. Unmounted mid-close, the
  // dialog would leave <body> with pointer-events: none, and the window dead to clicks.
  const dialogs = (
    <>
      <NewFlowDiagramDialog
        open={newFlowOpen}
        onOpenChange={setNewFlowOpen}
        folderId={board?.folderId ?? null}
        folderName={folder?.name ?? null}
        returnFocusRef={actionsRef}
        onCreated={(created) => onOpenBoard(created.id)}
      />

      <RenameDiagramDialog
        target={renameTarget}
        returnFocusRef={actionsRef}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        onRename={renameBoard}
      />

      <DeleteDiagramDialog
        target={deleteTarget}
        returnFocusRef={actionsRef}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onDeleted={(deletedId) => {
          if (deletedId !== boardIdNow.current) return
          // The board's file is gone: back to its folder's list, and nothing of it
          // left drawn here should the host not leave at once.
          deleted.current = true
          const folderId = board?.folderId ?? null
          setFullscreen(false)
          onClosed(folderId)
          setLoaded({ boardId: deletedId, status: "missing" })
        }}
      />
    </>
  )

  if (current === null) {
    return (
      <>
        <div className="size-full animate-pulse bg-[var(--term-bg,#f7f7f9)]" />
        {dialogs}
      </>
    )
  }

  if (current.status !== "ready" || board === null) {
    const missing = current.status === "missing"
    return (
      <>
        <div className="flex size-full flex-col items-center justify-center gap-1.5 bg-[var(--term-bg,#f7f7f9)] p-6 text-center">
          <span className="mb-2 flex size-10 items-center justify-center rounded-[10px] bg-white text-gray-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)] dark:bg-gray-900 dark:text-gray-400">
            {missing ? (
              <Glyph name="board" size={20} />
            ) : (
              <RiErrorWarningLine className="size-5" aria-hidden="true" />
            )}
          </span>
          <h2 className="text-[15px] font-semibold text-gray-900 dark:text-gray-50">
            {missing ? "This whiteboard no longer exists" : "This whiteboard can't be opened"}
          </h2>
          <p className="max-w-sm text-[13px] text-gray-500 dark:text-gray-400">
            {missing
              ? "It was deleted, or its file is no longer in Switchboard's whiteboards folder."
              : current.status === "error"
                ? current.error
                : null}
          </p>
          <div className="mt-3 flex items-center gap-2">
            {/* Back from a board that couldn't be read is not a goodbye: the host
                forgets this canvas, and the board opens again once it can be read. */}
            <Button
              className="h-[30px] rounded-lg border-transparent bg-[#1d1d1f] px-3 text-[13px] text-white shadow-none hover:bg-[#333336] dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-white"
              onClick={() => onClosed(null)}
            >
              <Glyph name="chevL" className="-ml-1 mr-1.5" />
              Back
            </Button>
            {missing ? null : (
              <Button
                variant="secondary"
                className={BAR_BUTTON}
                disabled={retrying}
                onClick={readAgain}
              >
                {retrying ? "Trying again…" : "Try again"}
              </Button>
            )}
          </div>
        </div>
        {dialogs}
      </>
    )
  }

  const folderChoices = index?.folders ?? null

  return (
    <>
      <div className="flex size-full flex-col overflow-hidden">
        {/* The bar — the switcher on the left, New whiteboard, full screen and
            Actions on the right. Every destructive path starts here, on the board
            you can see, rather than from a row in a list. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-black/[.08] bg-white px-3 py-[9px] dark:border-white/10 dark:bg-gray-950">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* Step / pick / step. The arrows only appear once there is
                somewhere to step to. */}
            {nav.ordered.length > 1 ? (
              <DiagramStepButton direction="prev" target={nav.previous} onSelect={openBoard} />
            ) : null}
            <DiagramPicker
              boards={siblings}
              current={summaryOf(board)}
              folderLabel={folderLabel}
              onSelect={openBoard}
              search={search}
              onSearchChange={setSearch}
              formatRelative={formatRelative}
              active={active}
            />
            {nav.ordered.length > 1 ? (
              <>
                <DiagramStepButton direction="next" target={nav.next} onSelect={openBoard} />
                {nav.position !== null ? (
                  <span className="shrink-0 px-1 text-xs tabular-nums text-gray-400">
                    {nav.position}/{nav.ordered.length}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="secondary" className={BAR_BUTTON} onClick={() => setNewFlowOpen(true)}>
              <Glyph name="plus" className="-ml-0.5" />
              New whiteboard
            </Button>
            <Button
              variant="secondary"
              className={cx(BAR_BUTTON, "size-[30px] px-0")}
              aria-label="Full screen"
              title="Full screen"
              onClick={() => setFullscreen(true)}
            >
              <Glyph name="full" />
            </Button>

            {/* Actions ▸ Open terminal… opens a picker anchored to this same
                button, once the menu has closed. */}
            <PopoverPrimitives.Root
              open={terminalPickerOpen}
              onOpenChange={(open) => {
                setTerminalPickerOpen(open)
                if (open) refreshChoices()
              }}
            >
              <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
                <PopoverPrimitives.Anchor asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      ref={actionsRef}
                      variant="secondary"
                      className={cx(BAR_BUTTON, "gap-1.5", (actionsOpen || terminalPickerOpen) && "bg-[#f5f5f7]")}
                      data-whiteboard-actions
                    >
                      Actions
                      <Glyph name="chevD" className="-mr-0.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </PopoverPrimitives.Anchor>
                <DropdownMenuContent
                  align="end"
                  sideOffset={6}
                  className="min-w-56 rounded-[10px] p-[5px]"
                  onCloseAutoFocus={(event) => {
                    // The menu is gone now. A dialog or picker it opens takes
                    // focus itself, so focus doesn't go back to the trigger first.
                    // Nothing opens on a board that isn't on screen, or for an item
                    // picked as it left (see afterMenu).
                    const next = afterMenu.current
                    afterMenu.current = null
                    if (!next) return
                    if (next.stale || !activeNow.current) {
                      event.preventDefault()
                      return
                    }
                    if (!next.toTrigger) event.preventDefault()
                    next.run()
                  }}
                >
                  <DropdownMenuItem
                    className={MENU_ITEM}
                    onSelect={() => {
                      refreshChoices()
                      afterMenu.current = {
                        run: () => {
                          pickedTerminal.current = false
                          setTerminalPickerOpen(true)
                        },
                      }
                    }}
                  >
                    <DropdownMenuIconWrapper className={MENU_ICON}>
                      <Glyph name="term" />
                    </DropdownMenuIconWrapper>
                    Open terminal…
                    <Glyph name="chev" className="ml-auto text-[#b0b0b5]" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={MENU_ITEM}
                    shortcut="⌘A"
                    onSelect={() => {
                      // After the menu has handed focus back, so a terminal the
                      // host shows and focuses keeps it.
                      afterMenu.current = { run: () => onToggleTerminals(), toTrigger: true }
                    }}
                  >
                    <DropdownMenuIconWrapper className={MENU_ICON}>
                      <Glyph name="termStack" />
                    </DropdownMenuIconWrapper>
                    Show or hide terminals
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className={MENU_ITEM}
                    onSelect={() => {
                      const target = { id: board.id, name: board.name }
                      afterMenu.current = { run: () => setRenameTarget(target) }
                    }}
                  >
                    <DropdownMenuIconWrapper className={MENU_ICON}>
                      <Glyph name="edit" />
                    </DropdownMenuIconWrapper>
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSubMenu>
                    <DropdownMenuSubMenuTrigger className={cx(MENU_ITEM, "pr-[7px]")} disabled={busy}>
                      <DropdownMenuIconWrapper className={MENU_ICON}>
                        <Glyph name="folder" />
                      </DropdownMenuIconWrapper>
                      Move to folder…
                    </DropdownMenuSubMenuTrigger>
                    <DropdownMenuSubMenuContent className="max-h-80 min-w-48 overflow-y-auto rounded-[10px] p-[5px]">
                      {folderChoices === null ? (
                        <DropdownMenuItem className={MENU_ITEM} disabled>
                          {listFailed ? "Couldn't load the folders" : "Loading folders…"}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuRadioGroup
                          value={board.folderId ?? NO_FOLDER}
                          onValueChange={(value) => void moveTo(value === NO_FOLDER ? null : value)}
                        >
                          {folderChoices.map((choice) => (
                            <DropdownMenuRadioItem
                              key={choice.id}
                              value={choice.id}
                              iconType="check"
                              className="h-[30px] py-0 text-[13px] data-[state=checked]:font-medium"
                            >
                              <span className="truncate">{choice.name}</span>
                            </DropdownMenuRadioItem>
                          ))}
                          {folderChoices.length > 0 ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuRadioItem
                            value={NO_FOLDER}
                            iconType="check"
                            className="h-[30px] py-0 text-[13px] data-[state=checked]:font-medium"
                          >
                            No folder
                          </DropdownMenuRadioItem>
                          {folderChoices.length === 0 ? (
                            <DropdownMenuLabel className="max-w-56 py-1.5 font-normal tracking-normal">
                              Make folders on the Whiteboards screen.
                            </DropdownMenuLabel>
                          ) : null}
                        </DropdownMenuRadioGroup>
                      )}
                    </DropdownMenuSubMenuContent>
                  </DropdownMenuSubMenu>
                  <DropdownMenuItem className={MENU_ITEM} disabled={busy} onSelect={() => void duplicate()}>
                    <DropdownMenuIconWrapper className={MENU_ICON}>
                      <Glyph name="copy" />
                    </DropdownMenuIconWrapper>
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={MENU_ITEM}
                    disabled={busy}
                    onSelect={() => void handleArchiveToggle()}
                  >
                    <DropdownMenuIconWrapper className={MENU_ICON}>
                      <Glyph name={isArchived ? "unarchive" : "archive"} />
                    </DropdownMenuIconWrapper>
                    {isArchived ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      afterMenu.current = { run: () => void confirmDelete() }
                    }}
                    className={cx(MENU_ITEM, "text-[#a02c2c] dark:text-red-400")}
                  >
                    <DropdownMenuIconWrapper className={cx(MENU_ICON, "text-[#a02c2c] dark:text-red-400")}>
                      <Glyph name="trash" />
                    </DropdownMenuIconWrapper>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <PopoverPrimitives.Portal container={portal}>
                <PopoverPrimitives.Content
                  align="end"
                  side="bottom"
                  sideOffset={6}
                  collisionPadding={8}
                  className="z-50 outline-none"
                  onCloseAutoFocus={(event) => {
                    // A picked terminal takes focus itself (the host focuses it);
                    // otherwise back to the button the picker came from.
                    event.preventDefault()
                    if (!pickedTerminal.current && actionsRef.current?.isConnected) actionsRef.current.focus()
                    pickedTerminal.current = false
                  }}
                >
                  <WorkspacePicker
                    tone="light"
                    title="Open a terminal in"
                    choices={workspaceChoices}
                    status={workspaceStatus}
                    current={board.workspace}
                    currentLabel="This board's workspace"
                    footer={OPEN_TERMINAL_FOOTER}
                    onPick={(wsId) => {
                      pickedTerminal.current = true
                      setTerminalPickerOpen(false)
                      onOpenTerminal(wsId)
                    }}
                    onClose={() => setTerminalPickerOpen(false)}
                  />
                </PopoverPrimitives.Content>
              </PopoverPrimitives.Portal>
            </PopoverPrimitives.Root>
          </div>
        </div>

        {/* Full screen swaps the classes on this SAME element to a fixed overlay
            instead of rendering a second canvas, so React Flow is never remounted
            on the way in or out. */}
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
                {board.name}
                {folderLabel ? <span className="font-normal text-gray-500"> · {folderLabel}</span> : null}
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
              <Glyph name="archive" className="shrink-0" />
              <span>
                This whiteboard is archived. It stays out of its folder&apos;s list
                until you unarchive it, and can be edited again then.
              </span>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {board.spec === null ? (
              <div className="flex size-full items-center justify-center p-6">
                <div className="max-w-md rounded-md border border-red-200 bg-red-50 p-4 text-center dark:border-red-900/50 dark:bg-red-950/40">
                  <p className="text-sm font-medium text-red-700 dark:text-red-400">
                    This whiteboard can&apos;t be drawn
                  </p>
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{board.specError}</p>
                </div>
              </div>
            ) : editorShown ? (
              // Keyed by the board alone — never its folder, workspace or full
              // screen: a remount would throw away the undo history, so the editor
              // re-fits itself instead (fitKey) and hears the rest as props.
              <FlowEditor
                key={board.id}
                ref={attachEditor}
                spec={board.spec}
                onSave={(spec) => saveFlow(board.id, spec)}
                keyboardEnabled={keyboardEnabled}
                shown={active}
                fitKey={String(fullscreen)}
                boardId={board.id}
                diagramName={board.name}
                answerWorkspace={board.workspace}
                workspaceChoices={workspaceChoices}
                onAnswerWorkspaceChange={(wsId) => void changeWorkspace(wsId)}
                onOpenSettings={onOpenSettings}
                onOpenTerminal={onOpenTerminal}
                workspaceStatus={workspaceStatus}
                onTerminalSlots={onTerminalSlots}
                onTerminalFloat={onTerminalFloat}
                onTerminalRemoved={onTerminalRemoved}
                onDirtyChange={onDirtyChange}
              />
            ) : (
              <DiagramCanvas
                spec={board.spec}
                diagramName={board.name}
                resetKey={`${board.id}:${fullscreen}`}
              />
            )}
          </div>
        </div>
      </div>

      {dialogs}
    </>
  )
}
