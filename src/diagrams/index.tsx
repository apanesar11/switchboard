// Switchboard's React diagram editor. One instance belongs to each workspace and
// its DOM host can move between the workspace tab and a Grid square without
// remounting React Flow or losing the selection, viewport, or undo history.
import { createRoot, type Root } from "react-dom/client"
import { createPortal } from "react-dom"
import { DiagramsPage, type FullscreenHandle } from "./app/dashboard/diagrams/DiagramsPage"
import type { FlowEditorHandle } from "./app/dashboard/diagrams/FlowEditor"
import { Toaster } from "./components/Toast"
import { PortalProvider } from "./lib/portal"
import { refreshAnswerStatus } from "./lib/diagrams/ai-client"
import { clipboardImageFile } from "./lib/diagrams/upload"

type Props = {
  wsId: string
  wsName: string
  active: boolean
  onOpenSettings: () => void
  onOpenTerminal: (wsId: string) => void
  onDirty: (count: number) => void
  onFullscreenChange?: (open: boolean) => void
}

type Instance = {
  root: Root
  props: Props
  editor: FlowEditorHandle | null
  fullscreen: FullscreenHandle | null
  portal: HTMLElement
  onEditor: (editor: FlowEditorHandle | null) => void
  onFullscreen: (handle: FullscreenHandle | null) => void
}

const instances = new Set<Instance>()

function render(instance: Instance) {
  const current = instance.props
  instance.root.render(
    <PortalProvider container={instance.portal}>
      <DiagramsPage
        wsId={current.wsId}
        wsName={current.wsName || current.wsId}
        active={current.active}
        onOpenSettings={current.onOpenSettings}
        onOpenTerminal={() => current.onOpenTerminal(current.wsId)}
        onEditor={instance.onEditor}
        onFullscreen={instance.onFullscreen}
        onFullscreenChange={current.onFullscreenChange}
        onDirtyChange={(dirty) => instance.props.onDirty(dirty ? 1 : 0)}
      />
      {current.active ? createPortal(<Toaster />, instance.portal) : null}
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
    onEditor: (editor) => { instance.editor = editor },
    onFullscreen: (handle) => { instance.fullscreen = handle },
  }
  instances.add(instance)
  portal.style.display = initial.active ? "block" : "none"
  render(instance)

  return {
    update(next: Partial<Props>) {
      instance.props = { ...instance.props, ...next }
      portal.style.display = instance.props.active ? "block" : "none"
      render(instance)
    },
    flush(): Promise<void> {
      return instance.editor ? instance.editor.flush().catch(() => {}) : Promise.resolve()
    },
    editAction(action: string, image: boolean, text = ""): boolean | Promise<boolean> {
      const editor = instance.editor
      if (!editor || !instance.props.active) return false
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
  /** Quit writes every workspace canvas, including those parked off screen. */
  flush(): Promise<void> {
    return Promise.all([...instances].map((instance) =>
      instance.editor ? instance.editor.flush().catch(() => {}) : Promise.resolve(),
    )).then(() => {})
  },
  refreshAnswers(fresh: boolean) {
    void refreshAnswerStatus(fresh)
  },
}

declare global {
  interface Window {
    SBDiagrams?: typeof api
  }
}

window.SBDiagrams = api
