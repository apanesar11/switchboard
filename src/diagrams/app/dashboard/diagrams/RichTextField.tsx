import { useLayoutEffect, useRef } from "react"
import { FLOW_BOX_TEXT_MAX_LENGTH, type FlowRichText } from "@/lib/diagrams/types"
import { continueList, insertCodeText, leaveCode, plainTextParagraphs, richTextHtml, richTextPlainText, richTextSelectedParagraphs, shiftListIndent, toggleBullets, toggleChecklist, toggleCode, truncateRichText } from "@/lib/diagrams/rich-text"
import { FLOW_FORMAT_EVENT, FLOW_PASTE_EVENT, flowCheckbox, flowCodeAtSelection, flowCodeCopy, flowTextSelection, readRichText, replaceFlowRichText, restoreFlowTextSelection, richTextSelectionLength, selectRichText, toggleFlowCheckbox, type FlowTextCommand } from "@/lib/diagrams/rich-text-dom"
import { copyFlowCodeBlock } from "./DiagramNodes"

/** Let Chromium own the editing DOM and its undo history; React owns saved data. */
export function RichTextField({
  text, richText, bold = false, italic = false, field, placeholder, label,
  className, style, autoFocus, selectOnFocus, focusOnMount, onChange, onKeyDown,
}: {
  text: string
  richText?: FlowRichText
  bold?: boolean
  italic?: boolean
  field: "label" | "detail"
  placeholder: string
  label: string
  className?: string
  style?: React.CSSProperties
  autoFocus?: boolean
  selectOnFocus?: () => boolean
  focusOnMount?: () => boolean
  onChange: (text: string, richText: FlowRichText, typing: boolean) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const current = useRef({ onChange })
  current.current = { onChange }
  const last = useRef("")

  function commit(typing = true) {
    const element = elementRef.current
    if (!element) return
    let rich = readRichText(element)
    let plain = richTextPlainText(rich)
    if (plain.length > FLOW_BOX_TEXT_MAX_LENGTH) {
      rich = truncateRichText(rich, FLOW_BOX_TEXT_MAX_LENGTH)
      plain = richTextPlainText(rich)
      element.innerHTML = richTextHtml(rich)
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
    last.current = JSON.stringify({ text: plain, richText: rich })
    current.current.onChange(plain, rich, typing)
  }

  function paste(text: string) {
    const element = elementRef.current!
    const length = richTextPlainText(readRichText(element)).length
    const available = Math.max(0, FLOW_BOX_TEXT_MAX_LENGTH - length + richTextSelectionLength(element))
    const pasted = text.replace(/\r\n?/g, "\n").slice(0, available)
    // Switchboard: several lines into a code block go in through the words
    // (insertCodeText) — Chromium would split the block in two at every newline.
    const code = pasted.includes("\n") ? flowCodeAtSelection(element) : null
    const typed = code ? insertCodeText(code.rich, code.selection, pasted) : null
    if (typed) replaceFlowRichText(element, typed.richText, typed.selection)
    else document.execCommand("insertText", false, pasted)
    commit()
  }

  function format(command: FlowTextCommand) {
    const element = elementRef.current!
    const rich = readRichText(element)
    const selection = flowTextSelection(element)
    if (command === "checklist") {
      replaceFlowRichText(element, toggleChecklist(rich, selection), selection)
    } else if (command === "insertUnorderedList") {
      replaceFlowRichText(element, toggleBullets(rich, selection), selection)
    } else if (command === "code") {
      // Switchboard: the selected paragraphs as one code block, or back to paragraphs.
      replaceFlowRichText(element, toggleCode(rich, selection), selection)
    } else if (command === "indent" || command === "outdent") {
      const next = shiftListIndent(rich, selection, command === "indent" ? 1 : -1)
      if (next === rich) return
      replaceFlowRichText(element, next, selection)
    } else {
      // Switchboard: code carries no marks — bold or italic in a block would only be
      // taken off again when the text is tidied.
      if (richTextSelectedParagraphs(rich, selection).some((index) => rich[index].code)) return
      if (document.activeElement !== element) {
        element.focus()
        // A focused checkbox selects its own item for inline formatting.
        restoreFlowTextSelection(element, selection)
      }
      document.execCommand(command)
    }
    commit(false)
  }

  // Only replace DOM for an external change (for example diagram undo). Typing
  // and toolbar commands keep the browser's selection and native undo stack.
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    const rich = richText ?? plainTextParagraphs(text, bold, italic)
    const value = JSON.stringify({ text, richText: rich })
    if (value === last.current) return
    element.innerHTML = richTextHtml(rich)
    last.current = value
  }, [text, richText, bold, italic])

  useLayoutEffect(() => {
    const element = elementRef.current!
    const formatText = (event: Event) => format((event as CustomEvent<FlowTextCommand>).detail)
    const pasteText = (event: Event) => paste((event as CustomEvent<string>).detail)
    element.addEventListener(FLOW_FORMAT_EVENT, formatText)
    element.addEventListener(FLOW_PASTE_EVENT, pasteText)
    if (autoFocus || focusOnMount?.()) element.focus()
    // Select after focus has placed the caret, once per editing session.
    if (autoFocus && selectOnFocus?.()) selectRichText(element)
    return () => {
      element.removeEventListener(FLOW_FORMAT_EVENT, formatText)
      element.removeEventListener(FLOW_PASTE_EVENT, pasteText)
    }
  }, [])

  return (
    <div
      ref={elementRef}
      role="textbox"
      aria-label={label}
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-flow-text={field}
      data-placeholder={placeholder}
      data-empty={!text ? "true" : undefined}
      className={`flow-rich-text ${className ?? ""}`}
      style={style}
      onInput={() => commit()}
      onPointerDown={(event) => {
        if (flowCheckbox(event.target) || flowCodeCopy(event.target)) { event.preventDefault(); event.stopPropagation() }
      }}
      onMouseDown={(event) => {
        if (flowCheckbox(event.target) || flowCodeCopy(event.target)) event.preventDefault()
      }}
      onClick={(event) => {
        // Switchboard: a code block's copy button, mid-edit — the words as they stand.
        const copy = flowCodeCopy(event.target)
        if (copy) {
          event.preventDefault()
          event.stopPropagation()
          void copyFlowCodeBlock(copy)
          return
        }
        const checkbox = flowCheckbox(event.target)
        if (!checkbox) return
        event.preventDefault()
        event.stopPropagation()
        toggleFlowCheckbox(event.currentTarget, checkbox)
        commit(false)
      }}
      onDoubleClick={(event) => {
        if (flowCheckbox(event.target) || flowCodeCopy(event.target)) event.stopPropagation()
      }}
      onBeforeInput={(event) => {
        const input = event.nativeEvent as InputEvent
        if (input.isComposing || !input.data || !input.inputType?.startsWith("insert")) return
        const length = richTextPlainText(readRichText(event.currentTarget)).length
        if (length - richTextSelectionLength(event.currentTarget) + input.data.length > FLOW_BOX_TEXT_MAX_LENGTH) event.preventDefault()
      }}
      onPaste={(event) => {
        event.preventDefault()
        paste(event.clipboardData.getData("text/plain"))
      }}
      onDrop={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        const checkbox = flowCheckbox(event.target)
        if (checkbox) {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault()
            toggleFlowCheckbox(event.currentTarget, checkbox)
            commit(false)
          }
          event.stopPropagation()
          return
        }
        const command = event.metaKey || event.ctrlKey
        if (command && !event.altKey && ((!event.shiftKey && event.key.toLowerCase() === "b") || (event.shiftKey && event.code === "Digit8"))) {
          event.preventDefault()
          event.stopPropagation()
          format(event.shiftKey ? "insertUnorderedList" : "bold")
          return
        }
        // Switchboard: ⌘E makes (or unmakes) a code block, as it does in most editors.
        if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "e") {
          event.preventDefault()
          event.stopPropagation()
          format("code")
          return
        }
        // Switchboard: in a code block, Enter (with or without Shift) is a new line of
        // code, Enter on an empty last line the way out of the block (leaveCode), and
        // Tab two spaces of indentation — none of them the canvas's.
        if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) && !command && !event.altKey) {
          const code = flowCodeAtSelection(event.currentTarget)
          if (code) {
            event.preventDefault()
            event.stopPropagation()
            if (event.key === "Tab") {
              if (richTextPlainText(code.rich).length + 2 <= FLOW_BOX_TEXT_MAX_LENGTH) document.execCommand("insertText", false, "  ")
              commit()
              return
            }
            // Through the words rather than the browser's line break, whose <br> at the
            // end of the block reads as nothing (insertCodeText).
            const next = leaveCode(code.rich, code.selection) ??
              (richTextPlainText(code.rich).length < FLOW_BOX_TEXT_MAX_LENGTH ? insertCodeText(code.rich, code.selection, "\n") : null)
            if (next) replaceFlowRichText(event.currentTarget, next.richText, next.selection)
            commit()
            return
          }
        }
        // List indentation consumes Tab before it reaches the canvas shortcuts.
        if (event.key === "Tab" && !command && !event.altKey) {
          const rich = readRichText(event.currentTarget)
          const selected = richTextSelectedParagraphs(rich, flowTextSelection(event.currentTarget))
          if (selected.some((index) => rich[index].bullet || rich[index].checked !== undefined)) {
            event.preventDefault()
            event.stopPropagation()
            format(event.shiftKey ? "outdent" : "indent")
            return
          }
        }
        // Enter keeps list depth; an empty nested item outdents before exiting.
        // Elsewhere the canvas retains Enter to finish and Shift+Enter for a line.
        const inList = document.queryCommandState("insertUnorderedList")
        if (event.key === "Enter" && !command && !event.shiftKey) {
          const rich = readRichText(event.currentTarget)
          const selection = flowTextSelection(event.currentTarget)
          const selected = richTextSelectedParagraphs(rich, selection)
          if (selected.length && (rich[selected[0]].bullet || rich[selected[0]].checked !== undefined)) {
            event.preventDefault()
            event.stopPropagation()
            const next = continueList(rich, selection)
            if (richTextPlainText(next.richText).length <= FLOW_BOX_TEXT_MAX_LENGTH) {
              replaceFlowRichText(event.currentTarget, next.richText, next.selection)
              commit()
            }
            return
          }
        }
        if (event.key === "Enter" && !command && event.shiftKey && !inList) {
          // Separate paragraphs let an introduction be followed by a list.
          event.preventDefault()
          event.stopPropagation()
          document.execCommand("insertParagraph")
          commit()
          return
        }
        if (event.key === "Enter" && !command && !event.shiftKey && inList) {
          if (richTextPlainText(readRichText(event.currentTarget)).length >= FLOW_BOX_TEXT_MAX_LENGTH) event.preventDefault()
          event.stopPropagation()
          return
        }
        onKeyDown(event)
      }}
    />
  )
}
