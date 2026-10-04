// The Diagrams bundle — the one part of Switchboard that is React, because it is the
// admin's Flow editor (app/dashboard/diagrams, copied and mirrored by hand), and
// rewriting four thousand lines of it as classic scripts would only make two editors
// to keep alike. scripts/build-diagrams.js builds this file into
// src/renderer/diagrams/diagrams.js, which index.html loads like any other script;
// views/diagrams.js drives it through the one global it sets:
//
//   SBDiagrams.mount(element, props)   once — the root lives for the window's life
//   SBDiagrams.update(props)           the workspace on screen, whether it is shown
//   SBDiagrams.flush()                 write what the editor holds, now (quit, blur)
//   SBDiagrams.editAction(action, image, text)  Edit ▸ Undo / Redo / Copy / Cut / Paste for the canvas
//   SBDiagrams.fullscreen()            is the diagram full screen — Esc's first say
//   SBDiagrams.leaveFullscreen()
//   SBDiagrams.refreshAnswers(fresh)   ask main again who can answer
//
// Everything it renders sits inside the element mount() is given, which gets the
// class .sbdg: the bundle's stylesheet is scoped to it (build-diagrams.js), so the
// admin's Tailwind can style the editor and never the rest of the app.

import { createRoot, type Root } from "react-dom/client"
import { DiagramsPage, exposeFullscreen } from "./app/dashboard/diagrams/DiagramsPage"
import type { FlowEditorHandle } from "./app/dashboard/diagrams/FlowEditor"
import { Toaster } from "./components/Toast"
import { setPortalContainer } from "./lib/portal"
import { refreshAnswerStatus } from "./lib/diagrams/ai-client"
import { clipboardImageFile } from "./lib/diagrams/upload"

type Props = {
  /** The workspace on screen, or null when the tab has none. */
  wsId: string | null
  wsName: string
  /** Whether the Diagrams tab is the screen right now. */
  active: boolean
  onOpenSettings: () => void
  onOpenTerminal: (wsId: string) => void
  /** How many diagrams hold edits not yet written — 0 or 1: one is open at a time. */
  onDirty: (count: number) => void
}

let root: Root | null = null
let props: Props | null = null
let editor: FlowEditorHandle | null = null

function render() {
  if (!root || !props) return
  const current = props
  root.render(
    <>
      {current.wsId ? (
        // Keyed by workspace: another workspace is another set of files, and the
        // editor it replaces writes what it held as it unmounts.
        <DiagramsPage
          key={current.wsId}
          wsId={current.wsId}
          wsName={current.wsName || current.wsId}
          active={current.active}
          onOpenSettings={current.onOpenSettings}
          onOpenTerminal={() => current.onOpenTerminal(current.wsId as string)}
          onEditor={(next) => {
            editor = next
          }}
          onDirtyChange={(dirty) => props?.onDirty(dirty ? 1 : 0)}
        />
      ) : null}
      <Toaster />
    </>,
  )
}

function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
}

const api = {
  mount(element: HTMLElement, initial: Props) {
    if (root) return
    element.classList.add("sbdg")
    const app = document.createElement("div")
    app.className = "sbdg-app"
    const portal = document.createElement("div")
    portal.className = "sbdg-portal"
    element.append(app, portal)
    setPortalContainer(portal)
    props = initial
    root = createRoot(app)
    render()
  },

  update(next: Partial<Props>) {
    if (!props) return
    props = { ...props, ...next }
    render()
  },

  /** Write whatever the editor on screen holds. Resolves either way. */
  flush(): Promise<void> {
    return editor ? editor.flush().catch(() => {}) : Promise.resolve()
  },

  /**
   * Edit ▸ Undo / Redo / Copy / Cut / Paste, when the canvas has the keyboard. False leaves the
   * action to the rest of the app — a box's own text field takes Undo and Paste the
   * way any field does (app.js's document fallback).
   */
  editAction(action: string, image: boolean, text = ""): boolean | Promise<boolean> {
    if (!editor || !props?.active) return false
    if (isTextField(document.activeElement)) return false
    // The Google Images panel's page has the keyboard. Main gives it the Edit menu
    // itself; one that reaches here anyway must not copy or paste boxes instead.
    if (document.activeElement?.tagName === "WEBVIEW") return false
    // Copy, Cut and Paste of boxes: what is selected, put down again at the pointer.
    if (action === "copy") return editor.copy()
    if (action === "cut") return editor.cut()
    if (action === "paste" && !image) return editor.pasteBoxes(text)
    if (action === "undo") {
      editor.undo()
      return true
    }
    if (action === "redo") {
      editor.redo()
      return true
    }
    if (action === "paste" && image) {
      const target = editor
      return clipboardImageFile().then((file) => {
        if (!file) return false
        target.paste([file])
        return true
      })
    }
    return false
  },

  fullscreen(): boolean {
    return !!props?.active && !!exposeFullscreen.current?.isFullscreen()
  },

  leaveFullscreen() {
    exposeFullscreen.current?.leave()
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
