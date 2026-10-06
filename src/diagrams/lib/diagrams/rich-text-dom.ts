import { appendTextRun, richTextHtml, richTextPlainText, richTextSelectedParagraphs, type FlowTextSelection } from "./rich-text"
import type { FlowRichText, FlowTextRun } from "./types"

export type FlowTextCommand = "bold" | "italic" | "insertUnorderedList" | "checklist"
export const FLOW_FORMAT_EVENT = "flow-text-format"
export const FLOW_PASTE_EVENT = "flow-text-paste"

/** Read the browser's editing DOM into the small, HTML-free saved vocabulary. */
export function readRichText(element: HTMLElement, paragraphElements?: HTMLElement[]): FlowRichText {
  const paragraphs: FlowRichText = []
  let runs: FlowTextRun[] = []
  let bullet = false
  let checked: boolean | undefined
  let owner = element
  const flush = (force = false) => {
    if (runs.length || force) {
      paragraphs.push({ runs, ...(checked !== undefined ? { checked } : bullet ? { bullet: true } : {}) })
      paragraphElements?.push(owner)
    }
    runs = []
  }
  function walk(node: Node, bold: boolean, italic: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendTextRun(runs, { text: (node.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " "), bold, italic })
      return
    }
    if (!(node instanceof HTMLElement) || node.hasAttribute("data-flow-checkbox") || ["SCRIPT", "STYLE", "IMG"].includes(node.tagName)) return
    const tag = node.tagName
    if (tag === "BR") {
      // A sole final <br> is the caret's placeholder, not an extra paragraph.
      if (node.nextSibling) appendTextRun(runs, { text: "\n", bold, italic })
      return
    }
    const block = ["DIV", "P", "LI", "UL", "OL"].includes(tag)
    if (block) flush()
    const previousBullet = bullet
    const previousChecked = checked
    const previousOwner = owner
    if (block && tag !== "UL" && tag !== "OL" && checked === undefined) owner = node
    if (tag === "LI") {
      bullet = true
      checked = node.hasAttribute("data-flow-checked") ? node.dataset.flowChecked === "true" : undefined
      owner = node
    }
    const style = getComputedStyle(node)
    const nextBold = tag === "B" || tag === "STRONG" || Number.parseInt(style.fontWeight, 10) >= 600
    const nextItalic = tag === "I" || tag === "EM" || style.fontStyle === "italic"
    const before = paragraphs.length
    for (const child of node.childNodes) walk(child, nextBold, nextItalic)
    if (block && tag !== "UL" && tag !== "OL") flush(runs.length > 0 || before === paragraphs.length)
    bullet = previousBullet
    checked = previousChecked
    owner = previousOwner
  }
  const style = getComputedStyle(element)
  for (const child of element.childNodes) walk(child, Number.parseInt(style.fontWeight, 10) >= 600, style.fontStyle === "italic")
  flush()
  return paragraphs.length ? paragraphs : [{ runs: [] }]
}

/** Text offsets exclude the checkbox buttons and count paragraph separators. */
export function flowTextSelection(element: HTMLElement): FlowTextSelection {
  const focused = flowCheckbox(document.activeElement)
  if (focused && element.contains(focused)) {
    const elements: HTMLElement[] = []
    const rich = readRichText(element, elements)
    const index = elements.indexOf(focused.closest("li")!)
    if (index >= 0) {
      const start = rich.slice(0, index).reduce((length, paragraph) => length + richTextPlainText([paragraph]).length + 1, 0)
      return { start, end: start + richTextPlainText([rich[index]]).length }
    }
  }
  const selection = window.getSelection()
  if (!selection?.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return { start: 0, end: 0 }
  const range = selection.getRangeAt(0)
  const before = (node: Node, offset: number) => {
    const prefix = document.createRange()
    prefix.selectNodeContents(element)
    prefix.setEnd(node, offset)
    const clone = element.cloneNode(false) as HTMLElement
    clone.append(prefix.cloneContents())
    return richTextPlainText(readRichText(clone)).length
  }
  return { start: before(range.startContainer, range.startOffset), end: before(range.endContainer, range.endOffset) }
}

export function restoreFlowTextSelection(element: HTMLElement, selection: FlowTextSelection): void {
  const elements: HTMLElement[] = []
  const rich = readRichText(element, elements)
  const point = (position: number): [Node, number] => {
    for (let index = 0; index < rich.length; index += 1) {
      const length = richTextPlainText([rich[index]]).length
      if (position > length && index < rich.length - 1) { position -= length + 1; continue }
      const paragraph = elements[index] ?? element
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement?.closest("[data-flow-checkbox]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      })
      while (walker.nextNode()) {
        const node = walker.currentNode
        const length = node.textContent?.length ?? 0
        if (position <= length) return [node, Math.max(0, position)]
        position -= length
      }
      return [paragraph, paragraph.childNodes.length]
    }
    return [element, element.childNodes.length]
  }
  const range = document.createRange()
  range.setStart(...point(selection.start))
  range.setEnd(...point(selection.end))
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

/** A native HTML edit records checkbox attributes and state in browser undo. */
export function replaceFlowRichText(element: HTMLElement, value: FlowRichText, selection: FlowTextSelection): void {
  element.focus()
  selectRichText(element)
  document.execCommand("insertHTML", false, richTextHtml(value))
  restoreFlowTextSelection(element, selection)
}

export function flowCheckbox(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-flow-checkbox]") : null
}

export function flowChecklistActive(element: HTMLElement): boolean {
  const rich = readRichText(element)
  const selected = richTextSelectedParagraphs(rich, flowTextSelection(element))
  return selected.length > 0 && selected.every((index) => rich[index].checked !== undefined)
}

export function toggleFlowCheckbox(element: HTMLElement, checkbox: HTMLElement): void {
  const elements: HTMLElement[] = []
  const rich = readRichText(element, elements)
  const index = elements.indexOf(checkbox.closest("li")!)
  if (index < 0 || rich[index].checked === undefined) return
  const selection = flowTextSelection(element)
  const focused = document.activeElement === checkbox
  rich[index] = { ...rich[index], checked: !rich[index].checked }
  replaceFlowRichText(element, rich, selection)
  if (focused) element.querySelector<HTMLElement>(`[data-flow-checkbox="${index}"]`)?.focus()
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
  const focused = document.activeElement
  const element = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-flow-text]") : null
  if (element?.isContentEditable) {
    element.dispatchEvent(new CustomEvent(FLOW_FORMAT_EVENT, { detail: command }))
  }
}

/** Native Edit menu accelerators arrive over IPC, ahead of browser key events. */
export function editFlowText(element: HTMLElement, action: string, text: string, copy: (text: string) => void): boolean {
  if (["selectAll", "undo", "redo", "paste", "copy", "cut"].includes(action) && document.activeElement !== element) {
    const selection = flowTextSelection(element)
    element.focus()
    restoreFlowTextSelection(element, selection)
  }
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
