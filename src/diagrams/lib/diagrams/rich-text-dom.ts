import { appendTextRun, richTextPlainText } from "./rich-text"
import type { FlowRichText, FlowTextRun } from "./types"

export type FlowTextCommand = "bold" | "italic" | "insertUnorderedList"
export const FLOW_FORMAT_EVENT = "flow-text-format"
export const FLOW_PASTE_EVENT = "flow-text-paste"

/** Read the browser's editing DOM into the small, HTML-free saved vocabulary. */
export function readRichText(element: HTMLElement): FlowRichText {
  const paragraphs: FlowRichText = []
  let runs: FlowTextRun[] = []
  let bullet = false
  const flush = (force = false) => {
    if (runs.length || force) paragraphs.push({ runs, ...(bullet ? { bullet: true } : {}) })
    runs = []
  }
  function walk(node: Node, bold: boolean, italic: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendTextRun(runs, { text: (node.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " "), bold, italic })
      return
    }
    if (!(node instanceof HTMLElement) || ["SCRIPT", "STYLE", "IMG"].includes(node.tagName)) return
    const tag = node.tagName
    if (tag === "BR") {
      // A sole final <br> is the caret's placeholder, not an extra paragraph.
      if (node.nextSibling) appendTextRun(runs, { text: "\n", bold, italic })
      return
    }
    const block = ["DIV", "P", "LI", "UL", "OL"].includes(tag)
    if (block) flush()
    const previousBullet = bullet
    if (tag === "LI") bullet = true
    const style = getComputedStyle(node)
    const nextBold = tag === "B" || tag === "STRONG" || Number.parseInt(style.fontWeight, 10) >= 600
    const nextItalic = tag === "I" || tag === "EM" || style.fontStyle === "italic"
    const before = paragraphs.length
    for (const child of node.childNodes) walk(child, nextBold, nextItalic)
    if (block && tag !== "UL" && tag !== "OL") flush(runs.length > 0 || before === paragraphs.length)
    bullet = previousBullet
  }
  const style = getComputedStyle(element)
  for (const child of element.childNodes) walk(child, Number.parseInt(style.fontWeight, 10) >= 600, style.fontStyle === "italic")
  flush()
  return paragraphs.length ? paragraphs : [{ runs: [] }]
}

export function selectRichText(element: HTMLElement): void {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Plain character positions survive sanitization/truncation of an editing DOM. */
export function richTextSelectionLength(element: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return 0
  const clone = element.cloneNode(false) as HTMLElement
  clone.append(selection.getRangeAt(0).cloneContents())
  return richTextPlainText(readRichText(clone)).length
}

export function formatActiveFlowText(command: FlowTextCommand): void {
  const element = document.activeElement
  if (element instanceof HTMLElement && element.isContentEditable && element.dataset.flowText) {
    element.dispatchEvent(new CustomEvent(FLOW_FORMAT_EVENT, { detail: command }))
  }
}

/** Native Edit menu accelerators arrive over IPC, ahead of browser key events. */
export function editFlowText(element: HTMLElement, action: string, text: string, copy: (text: string) => void): boolean {
  if (action === "selectAll") {
    selectRichText(element)
    return true
  }
  if (action === "undo" || action === "redo") {
    document.execCommand(action)
    return true
  }
  if (action === "paste") {
    element.dispatchEvent(new CustomEvent(FLOW_PASTE_EVENT, { detail: text }))
    return true
  }
  if (action === "copy" || action === "cut") {
    const selection = window.getSelection()
    if (selection && element.contains(selection.anchorNode) && element.contains(selection.focusNode)) {
      const selected = selection.toString()
      if (selected) {
        copy(selected)
        if (action === "cut") document.execCommand("delete")
      }
    }
    return true
  }
  return false
}
