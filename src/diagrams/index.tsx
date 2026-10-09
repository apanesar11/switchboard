// Switchboard's React whiteboard editor. One instance belongs to each open BOARD
// (views/whiteboards.js keeps them, keyed by board id, at most a handful at once), and
// its DOM host can move between the Whiteboards screen and a Grid square without
// remounting React Flow or losing the selection, viewport, or undo history. A board
// never has two instances, so two editors can never write the same file.
import { createRoot, type Root } from "react-dom/client"
import { createPortal } from "react-dom"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { DiagramsPage, type ClientRect, type ClosedInfo, type FullscreenHandle } from "./app/dashboard/diagrams/DiagramsPage"
import type { FlowEditorHandle } from "./app/dashboard/diagrams/FlowEditor"
import { WorkspacePicker } from "./app/dashboard/diagrams/WorkspacePicker"
import { Toaster } from "./components/Toast"
import { PortalProvider } from "./lib/portal"
import { refreshAnswerStatus } from "./lib/diagrams/ai-client"
import { listWorkspaceChoices } from "./lib/diagrams/actions"
import { clipboardImageFile } from "./lib/diagrams/upload"
import { editFlowText } from "./lib/diagrams/rich-text-dom"
import { BLANK_FLOW } from "./lib/diagrams/templates"
import type { FlowSpec, TerminalSlot } from "./lib/diagrams/types"
import {
  writeClipboard,
  type WhiteboardFolder,
  type WhiteboardSummary,
  type WorkspaceChoices,
  type WorkspaceStatus,
} from "./lib/bridge"

type Props = {
  boardId: string
  active: boolean
  onOpenSettings(): void
  /** The quick switcher, ← / →, New whiteboard and Duplicate: the host changes the route. */
  onOpenBoard(id: string): void
  /**
   * After Delete, and Back on a board that no longer exists or couldn't be read.
   * `info.missing` is true only when the board is gone (deleted, or not found); Back
   * from one that merely couldn't be read passes false, and it may open again.
   */
  onClosed(folderId: string | null, info?: ClosedInfo): void
  /** After the load and every write — the header's breadcrumb and status line. */
  onBoardChange(board: WhiteboardSummary | null, folder: WhiteboardFolder | null): void
  onDirty(count: number): void
  onFullscreenChange?(open: boolean): void
  /** The host terminal layer's list for this board, pushed as it changes. */
  terminals: { wsId: string; open: boolean; minimized: boolean; pinned: boolean }[]
  workspaceStatus: WorkspaceStatus
  /** Float (or bring to front) a terminal panel for the workspace. */
  onOpenTerminal(wsId: string): void
  /** ⌘A's meaning: the host decides what showing or hiding them all is. */
  onToggleTerminals(): void
  onTerminalSlots(slots: TerminalSlot[]): void
  onTerminalFloat(wsId: string): void
  onTerminalRemoved(wsId: string, reason: "undo" | "delete", rect: ClientRect): void
}

type PickOptions = {
  title: string
  footer?: string
  current?: string | null
  currentLabel?: string
  status?: WorkspaceStatus
}

/** A workspace picker the host asked for (pickWorkspace), and how to answer it. */
type PickRequest = {
  serial: number
  anchor: ClientRect
  opts: PickOptions
  choices: WorkspaceChoices | null
  /** Where focus was, to go back to when the picker closes without a pick. */
  returnFocus: Element | null
  resolve: (wsId: string | null) => void
}

type Callbacks = {
  onOpenSettings: () => void
  onOpenBoard: (id: string) => void
  onClosed: (folderId: string | null, info?: ClosedInfo) => void
  onBoardChange: (board: WhiteboardSummary | null, folder: WhiteboardFolder | null) => void
  onDirtyChange: (dirty: boolean) => void
  onFullscreenChange: (open: boolean) => void
  onOpenTerminal: (wsId: string) => void
  onToggleTerminals: () => void
  onTerminalSlots: (slots: TerminalSlot[]) => void
  onTerminalFloat: (wsId: string) => void
  onTerminalRemoved: (wsId: string, reason: "undo" | "delete", rect: ClientRect) => void
}

type Instance = {
  root: Root
  props: Props
  editor: FlowEditorHandle | null
  fullscreen: FullscreenHandle | null
  portal: HTMLElement
  /** The board as the page last reported it — the handle's board(). */
  board: WhiteboardSummary | null
  picker: PickRequest | null
  /** Set once destroy() has begun; resolves when the instance is gone. */
  destroying: Promise<void> | null
  /** True from the moment React is torn down: nothing is reported to the host after it. */
  dead: boolean
  callbacks: Callbacks
  onEditor: (editor: FlowEditorHandle | null) => void
  onFullscreen: (handle: FullscreenHandle | null) => void
}

const instances = new Set<Instance>()
let pickSerial = 0

const NO_STATUS: WorkspaceStatus = {}

// The host's callbacks, wrapped once per instance. Stable identities keep the page's
// and the editor's effects from re-running on every update(); reading the props at
// call time keeps them current; and a torn-down instance stays silent — an editor
// unmounting after destroy() must not clear the dirty flag, or the terminal slots, of
// a NEW canvas the host has since made for the same board.
function callbacksFor(instance: Instance): Callbacks {
  function relay<K extends keyof Props>(name: K) {
    return (...args: unknown[]) => {
      if (instance.dead) return
      const fn = instance.props[name]
      if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...args)
    }
  }
  const onBoardChange = relay("onBoardChange")
  return {
    onOpenSettings: relay("onOpenSettings"),
    onOpenBoard: relay("onOpenBoard"),
    onClosed: relay("onClosed"),
    onBoardChange: (board, folder) => {
      if (instance.dead) return
      instance.board = board
      onBoardChange(board, folder)
    },
    onDirtyChange: (dirty) => relay("onDirty")(dirty ? 1 : 0),
    onFullscreenChange: relay("onFullscreenChange"),
    onOpenTerminal: relay("onOpenTerminal"),
    onToggleTerminals: relay("onToggleTerminals"),
    onTerminalSlots: relay("onTerminalSlots"),
    onTerminalFloat: relay("onTerminalFloat"),
    onTerminalRemoved: relay("onTerminalRemoved"),
  }
}

// The picker the host opened with pickWorkspace(): under the anchor and left-aligned
// to it, above it when there is no room below, and kept inside the window. A press
// anywhere outside it closes it, as a popover would, and so does Escape wherever the
// keyboard happens to be. A press on the anchor itself — the button that opened it,
// pressed again — puts it away as a toggle does.
function AnchoredPicker({ request, onPick, onClose }: {
  request: PickRequest
  onPick: (wsId: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const { anchor } = request

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const gap = 6
    const margin = 8
    const width = element.offsetWidth
    const height = element.offsetHeight
    const room = { width: window.innerWidth, height: window.innerHeight }
    let top = anchor.top + anchor.height + gap
    if (top + height > room.height - margin) {
      const above = anchor.top - gap - height
      top = above >= margin ? above : Math.max(margin, room.height - margin - height)
    }
    const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, room.width - margin - width))
    setPlace({ left: Math.round(left), top: Math.round(top) })
    // Measured again once the choices arrive and the list grows.
  }, [anchor, request.choices])

  const close = useRef(onClose)
  const anchorNow = useRef(anchor)
  useEffect(() => {
    close.current = onClose
    anchorNow.current = anchor
  })
  useEffect(() => {
    // The anchor is the button that asked for the picker (the tray's +, or Actions).
    // Closed on its pointerdown, the picker would be gone by its click, and the
    // button's own handler would open a fresh one: the picker could never be put away
    // from its own button, only flicker. So a press there goes no further — neither
    // the pointerdown (Actions opens its menu on it) nor the click (the + asks again)
    // — and the click closes the picker. Same rectangle the host anchored it to.
    let pressedAnchor = false
    function onAnchor(event: MouseEvent): boolean {
      const a = anchorNow.current
      return a.width > 0 && a.height > 0 &&
        event.clientX >= a.left && event.clientX <= a.left + a.width &&
        event.clientY >= a.top && event.clientY <= a.top + a.height
    }
    function down(event: PointerEvent) {
      pressedAnchor = false
      if (!ref.current || !(event.target instanceof Node) || ref.current.contains(event.target)) return
      if (onAnchor(event)) {
        pressedAnchor = true
        event.stopPropagation()
        return
      }
      close.current()
    }
    function click(event: MouseEvent) {
      if (!pressedAnchor) return
      pressedAnchor = false
      // Dragged off the button before letting go: no click on it, nothing to undo.
      if (!onAnchor(event)) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    // The search box normally has the keyboard and closes the picker on Escape itself.
    // This catches Escape when it doesn't — focus moved off with Tab, or never arrived —
    // in the capture phase on window, before the app's own keys (its "Esc means back"
    // among them), and stops it there: one Escape closes the picker and does nothing
    // more, so the board behind it stays on screen.
    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("click", click, true)
    window.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("click", click, true)
      window.removeEventListener("keydown", key, true)
    }
  }, [])

  // Never hidden while it is measured: WorkspacePicker puts the keyboard in its search
  // box as it mounts, and an element under visibility:hidden can't take focus — the
  // keys would stay with whatever opened the picker (the tray's +, or the body after
  // ⌘A), where Enter presses + again and Escape means back. The first render sits
  // under the anchor; the layout effect above moves it before anything is painted.
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: place?.left ?? anchor.left,
        top: place?.top ?? anchor.top + anchor.height + 6,
        zIndex: 60,
      }}
    >
      <WorkspacePicker
        tone="light"
        title={request.opts.title}
        footer={request.opts.footer}
        current={request.opts.current}
        currentLabel={request.opts.currentLabel}
        status={request.opts.status}
        choices={request.choices}
        onPick={onPick}
        onClose={onClose}
      />
    </div>
  )
}

function PickerLayer({ instance }: { instance: Instance }) {
  const request = instance.picker
  const answer = useCallback((wsId: string | null) => {
    finishPick(instance, wsId)
  }, [instance])
  if (!request) return null
  return (
    <AnchoredPicker
      key={request.serial}
      request={{ ...request, opts: { ...request.opts, status: request.opts.status ?? instance.props.workspaceStatus ?? NO_STATUS } }}
      onPick={(wsId) => answer(wsId)}
      onClose={() => answer(null)}
    />
  )
}

function finishPick(instance: Instance, wsId: string | null) {
  const request = instance.picker
  if (!request) return
  instance.picker = null
  if (!instance.dead) {
    syncPortal(instance)
    render(instance)
  }
  // Without a pick, focus goes back where it was; a pick hands it to whatever the
  // host opens for that workspace.
  if (wsId === null) {
    const back = request.returnFocus
    const lost = !document.activeElement || document.activeElement === document.body
      || instance.portal.contains(document.activeElement)
    if (lost && back instanceof HTMLElement && back.isConnected) back.focus()
  }
  request.resolve(wsId)
}

function syncPortal(instance: Instance) {
  // Popovers live in the portal; it is hidden while the board is off screen — except
  // while a picker the host asked for is open, which is always on screen (and closes
  // the moment the host says the board isn't: update()).
  instance.portal.style.display = instance.props.active || instance.picker ? "block" : "none"
}

function render(instance: Instance) {
  if (instance.dead) return
  const current = instance.props
  const callbacks = instance.callbacks
  instance.root.render(
    <PortalProvider container={instance.portal}>
      <DiagramsPage
        boardId={current.boardId}
        active={current.active}
        onOpenSettings={callbacks.onOpenSettings}
        onOpenBoard={callbacks.onOpenBoard}
        onClosed={callbacks.onClosed}
        onBoardChange={callbacks.onBoardChange}
        workspaceStatus={current.workspaceStatus ?? NO_STATUS}
        onOpenTerminal={callbacks.onOpenTerminal}
        onToggleTerminals={callbacks.onToggleTerminals}
        onTerminalSlots={callbacks.onTerminalSlots}
        onTerminalFloat={callbacks.onTerminalFloat}
        onTerminalRemoved={callbacks.onTerminalRemoved}
        pickerOpen={instance.picker !== null}
        onEditor={instance.onEditor}
        onFullscreen={instance.onFullscreen}
        onFullscreenChange={callbacks.onFullscreenChange}
        onDirtyChange={callbacks.onDirtyChange}
      />
      {current.active ? createPortal(<Toaster />, instance.portal) : null}
      {instance.picker ? createPortal(<PickerLayer instance={instance} />, instance.portal) : null}
    </PortalProvider>,
  )
}

function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
}

function create(element: HTMLElement, initial: Props) {
  element.classList.add("sbdg")
  const app = document.createElement("div")
  app.className = "sbdg-app"
  const portal = document.createElement("div")
  // Popovers and dialogs must escape Grid's container query and clipped cell.
  // A second scoped root on body keeps their Tailwind rules and dark theme.
  portal.className = "sbdg sbdg-portal-root"
  document.body.appendChild(portal)
  element.appendChild(app)

  const instance: Instance = {
    root: createRoot(app),
    props: initial,
    editor: null,
    fullscreen: null,
    portal,
    board: null,
    picker: null,
    destroying: null,
    dead: false,
    callbacks: null as unknown as Callbacks,
    onEditor: (editor) => { instance.editor = editor },
    onFullscreen: (handle) => { instance.fullscreen = handle },
  }
  instance.callbacks = callbacksFor(instance)
  instances.add(instance)
  syncPortal(instance)
  render(instance)

  function flush(): Promise<void> {
    return instance.editor ? instance.editor.flush().catch(() => {}) : Promise.resolve()
  }

  return {
    update(next: Partial<Props>) {
      if (instance.destroying) return
      instance.props = { ...instance.props, ...next }
      // A picker the host asked for belongs to the board on screen. Once the host says
      // this board no longer is — the route moved on, or another Grid square took the
      // keyboard — it closes unanswered; left open it would float over the next screen
      // and open a terminal on a board nobody can see.
      if (instance.picker && next.active === false) finishPick(instance, null)
      syncPortal(instance)
      render(instance)
    },
    flush,
    /**
     * Writes what the editor holds, then tears the instance down — React root, the
     * body-level portal, and its place in the quit flush. The host forgets the canvas
     * when it calls this; nothing is reported to it afterwards.
     */
    destroy(): Promise<void> {
      if (instance.destroying) return instance.destroying
      // The picker goes at once, not after the write: nothing may be picked for a
      // board that is going away.
      finishPick(instance, null)
      instance.destroying = flush().then(() => {
        instance.dead = true
        try {
          instance.root.unmount()
        } catch (err) {
          console.error("[switchboard] whiteboard: unmount:", err)
        }
        portal.remove()
        instances.delete(instance)
        instance.editor = null
        instance.fullscreen = null
      })
      return instance.destroying
    },
    /** The board as the page last reported it, or null before it loads (or when gone). */
    board(): WhiteboardSummary | null {
      return instance.board
    },
    /**
     * A workspace picker (light), under `anchor` and left-aligned to it, kept inside
     * the window: the tray's + and ⌘A with no workspace. Resolves the workspace
     * picked, or null when it is closed without one. The choices are fetched afresh
     * each time, so a workspace added to the rail a moment ago is there.
     */
    pickWorkspace(anchor: ClientRect, opts: PickOptions): Promise<string | null> {
      // A board that is going away, or isn't in the window, has nothing to anchor one to.
      if (instance.destroying || !element.isConnected) return Promise.resolve(null)
      finishPick(instance, null)
      return new Promise<string | null>((resolve) => {
        const serial = ++pickSerial
        instance.picker = {
          serial,
          anchor: { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
          opts,
          choices: null,
          returnFocus: document.activeElement,
          resolve,
        }
        syncPortal(instance)
        render(instance)
        void listWorkspaceChoices().then((result) => {
          const request = instance.picker
          if (!request || request.serial !== serial || instance.dead) return
          if (!result.ok) console.error("[switchboard] whiteboard: workspaces:", result.error)
          instance.picker = {
            ...request,
            choices: result.ok ? result.data : { workspaces: [], recent: [], last: null },
          }
          render(instance)
        })
      })
    },
    // Pinned terminals, passed through to the editor — nothing to do without one
    // (the board is loading, archived, missing, or can't be drawn). pinTerminal's
    // `rect` is the floating panel's outer client rect and `body`, when given, where
    // its live terminal sits inside it: the editor then places the node so the pinned
    // terminal lands on exactly that spot, and the shell needs no resize.
    pinTerminal(wsId: string, rect: ClientRect, body?: ClientRect): boolean {
      return instance.editor ? instance.editor.pinTerminal(wsId, rect, body ?? undefined) : false
    },
    unpinTerminal(wsId: string): ClientRect | null {
      return instance.editor ? instance.editor.unpinTerminal(wsId) : null
    },
    revealTerminal(wsId: string): boolean {
      return instance.editor ? instance.editor.revealTerminal(wsId) : false
    },
    terminalSlots(): TerminalSlot[] {
      return instance.editor ? instance.editor.terminalSlots() : []
    },
    editAction(action: string, image: boolean, text = ""): boolean | Promise<boolean> {
      const editor = instance.editor
      if (!editor || !instance.props.active) return false
      const focused = document.activeElement
      // Documents own native source/title editing and focus navigation. A menu
      // command inside their panel must never undo or delete the canvas behind it.
      if (focused instanceof Element && focused.closest("[data-flow-document-panel]")) return false
      const field = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-flow-text]") : null
      if (field?.isContentEditable && app.contains(field)) {
        return image ? true : editFlowText(field, action, text, writeClipboard)
      }
      if (isTextField(document.activeElement)) return false
      if (document.activeElement?.tagName === "WEBVIEW") return false
      if (action === "copy") return editor.copy()
      if (action === "cut") return editor.cut()
      if (action === "paste" && !image) return editor.pasteBoxes(text)
      if (action === "undo") { editor.undo(); return true }
      if (action === "redo") { editor.redo(); return true }
      if (action === "paste" && image) {
        return clipboardImageFile().then((file) => {
          if (!file) return false
          editor.paste([file])
          return true
        })
      }
      return false
    },
    fullscreen(): boolean {
      return instance.props.active && !!instance.fullscreen?.isFullscreen()
    },
    leaveFullscreen() {
      instance.fullscreen?.leave()
    },
    contains(element: globalThis.Node | null): boolean {
      return !!element && (app.contains(element) || portal.contains(element))
    },
  }
}

const api = {
  create,
  /** Quit writes every open board, including those parked off screen. */
  flush(): Promise<void> {
    return Promise.all([...instances].map((instance) =>
      instance.editor ? instance.editor.flush().catch(() => {}) : Promise.resolve(),
    )).then(() => {})
  },
  refreshAnswers(fresh: boolean) {
    void refreshAnswerStatus(fresh)
  },
  /** A fresh empty spec, for the Whiteboards screen's New whiteboard. */
  blankSpec(): FlowSpec {
    return structuredClone(BLANK_FLOW)
  },
}

declare global {
  interface Window {
    SBDiagrams?: typeof api
  }
}

window.SBDiagrams = api
