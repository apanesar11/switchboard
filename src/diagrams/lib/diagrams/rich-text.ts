import { FLOW_BOX_TEXT_MAX_LENGTH, type FlowRichText, type FlowTextParagraph, type FlowTextRun } from "./types"

export const FLOW_BULLET_INDENT = 1.35
export const FLOW_CHECKLIST_INDENT = 1.65
export const FLOW_LIST_MAX_LEVEL = 8

/**
 * A box's label or second line, which may run over several lines (Shift+Enter
 * in the editor): spaces collapse as everywhere else, but each line break is
 * kept — with at most one blank line in a row, and none at either end.
 * Exported for flowSpecFromCanvas, which saves text exactly as this keeps it.
 * Switchboard: defined here (validate.ts re-exports it) because the rich text is
 * normalized by the same rules, and a code block's words are checked against them.
 */
export function normalizeFlowText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function isList(paragraph: FlowTextParagraph): boolean {
  return paragraph.checked !== undefined || Boolean(paragraph.bullet)
}

/** Switchboard: whether a paragraph is a code block (FlowTextParagraph.code). */
export function isCodeParagraph(paragraph: Pick<FlowTextParagraph, "code">): boolean {
  return paragraph.code === true
}

type ParagraphStyle = Pick<FlowTextParagraph, "bullet" | "checked" | "level" | "code">

// Switchboard: a code block is a style of its own, and never a list item — code
// wins over any list mark it is given.
function listStyle(paragraph: ParagraphStyle): ParagraphStyle {
  if (paragraph.code) return { code: true }
  const marker = paragraph.checked !== undefined
    ? { checked: paragraph.checked }
    : paragraph.bullet ? { bullet: true } : {}
  return { ...marker, ...((paragraph.checked !== undefined || paragraph.bullet) && paragraph.level ? { level: paragraph.level } : {}) }
}

/** A nested item must follow a parent, without skipping a nesting level. */
function normalizeListLevels(value: FlowRichText): FlowRichText {
  const ancestors: number[] = []
  return value.map((paragraph) => {
    if (!isList(paragraph)) {
      ancestors.length = 0
      return { runs: paragraph.runs, ...(paragraph.code ? { code: true } : {}) }
    }
    const sourceLevel = paragraph.level ?? 0
    while (ancestors.length && ancestors[ancestors.length - 1] >= sourceLevel) ancestors.pop()
    const level = Math.min(ancestors.length, FLOW_LIST_MAX_LEVEL)
    ancestors.push(sourceLevel)
    return { runs: paragraph.runs, ...listStyle({ ...paragraph, level }) }
  })
}

export function richTextPlainText(value: FlowRichText): string {
  return value.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n")
}

export function plainTextParagraphs(text: string, bold = false, italic = false): FlowRichText {
  return text.split("\n").map((text) => ({
    runs: [{ text, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}) }],
  }))
}

/** Merge adjacent equal marks; never store HTML or arbitrary style properties. */
export function appendTextRun(runs: FlowTextRun[], run: FlowTextRun): void {
  if (!run.text) return
  const last = runs[runs.length - 1]
  if (last && Boolean(last.bold) === Boolean(run.bold) && Boolean(last.italic) === Boolean(run.italic)) {
    last.text += run.text
  } else {
    runs.push({ text: run.text, ...(run.bold ? { bold: true } : {}), ...(run.italic ? { italic: true } : {}) })
  }
}

/**
 * Switchboard: code blocks next to each other as one block, their lines joined by a
 * soft break — the plain text, and so every offset into it, is unchanged.
 */
function mergeCodeBlocks(value: FlowRichText): FlowRichText {
  const merged: FlowRichText = []
  for (const paragraph of value) {
    const last = merged[merged.length - 1]
    if (paragraph.code && last?.code) {
      const runs = [...last.runs]
      appendTextRun(runs, { text: "\n" })
      for (const run of paragraph.runs) appendTextRun(runs, run)
      merged[merged.length - 1] = { ...last, runs }
    } else {
      merged.push(paragraph)
    }
  }
  return merged
}

/**
 * The same whitespace rules as normalizeFlowText, preserving each character's marks.
 * Switchboard: except in a code block, whose spaces are kept as typed — only what
 * trails a line goes — in one unmarked run; blank lines there collapse as elsewhere.
 */
export function normalizeRichText(value: FlowRichText): FlowRichText {
  const lines: (FlowTextParagraph & { paragraph: number })[] = []
  value.forEach((paragraph, index) => {
    let line: FlowTextRun[] = []
    for (const run of paragraph.runs) {
      run.text.split("\n").forEach((text, part) => {
        if (part) {
          lines.push({ runs: line, paragraph: index, ...listStyle(paragraph) })
          line = []
        }
        appendTextRun(line, { ...run, text })
      })
    }
    lines.push({ runs: line, paragraph: index, ...listStyle(paragraph) })
  })
  const normalized: typeof lines = []
  for (const line of lines) {
    const runs: FlowTextRun[] = []
    if (line.code) {
      appendTextRun(runs, { text: line.runs.map((run) => run.text).join("").replace(/\s+$/, "") })
    } else {
      let space: FlowTextRun | undefined
      for (const run of line.runs) {
        for (const character of run.text) {
          if (/\s/.test(character)) {
            if (runs.length && !space) space = { ...run, text: " " }
            continue
          }
          if (space) appendTextRun(runs, space)
          space = undefined
          appendTextRun(runs, { ...run, text: character })
        }
      }
    }
    if (!runs.length && !normalized.length) continue
    if (!runs.length && !normalized[normalized.length - 1]?.runs.length) continue
    normalized.push({ ...line, runs })
  }
  while (normalized.length && !normalized[normalized.length - 1].runs.length) normalized.pop()
  const paragraphs: FlowRichText = []
  let previous = -1
  for (const line of normalized) {
    if (line.paragraph === previous) {
      const runs = paragraphs[paragraphs.length - 1].runs
      appendTextRun(runs, { text: "\n" })
      for (const run of line.runs) appendTextRun(runs, run)
    } else {
      paragraphs.push({ runs: line.runs, ...listStyle(line) })
    }
    previous = line.paragraph
  }
  return normalizeListLevels(mergeCodeBlocks(paragraphs))
}

/** Visual lines retain an item's indent without creating additional bullets. */
export function richTextVisualLines(value: FlowRichText): FlowRichText {
  return value.flatMap((paragraph) => {
    const lines: FlowRichText = [{ runs: [], ...listStyle(paragraph) }]
    for (const run of paragraph.runs) {
      run.text.split("\n").forEach((text, index) => {
        if (index) lines.push({ runs: [], ...listStyle(paragraph) })
        appendTextRun(lines[lines.length - 1].runs, { ...run, text })
      })
    }
    return lines
  })
}

/** Validate untrusted JSON; mismatched formatting never attaches to changed words. */
export function parseFlowRichText(value: unknown, plainText: string): FlowRichText | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > FLOW_BOX_TEXT_MAX_LENGTH + 1) {
    throw new Error("rich text must be an array of paragraphs")
  }
  let characters = Math.max(0, value.length - 1)
  const rich: FlowRichText = value.map((paragraph) => {
    if (!paragraph || typeof paragraph !== "object" || !Array.isArray(paragraph.runs) ||
        paragraph.runs.length > FLOW_BOX_TEXT_MAX_LENGTH + 1) {
      throw new Error("each rich text paragraph must contain runs")
    }
    const runs: FlowTextRun[] = []
    for (const run of paragraph.runs) {
      if (!run || typeof run !== "object" || typeof run.text !== "string" || /\r/.test(run.text)) {
        throw new Error("rich text runs must contain text with normalized line breaks")
      }
      characters += run.text.length
      if (characters > FLOW_BOX_TEXT_MAX_LENGTH * 10) throw new Error("rich text is too long")
      appendTextRun(runs, { text: run.text, bold: run.bold === true, italic: run.italic === true })
    }
    if (paragraph.checked !== undefined && typeof paragraph.checked !== "boolean") {
      throw new Error("checklist state must be true or false")
    }
    if (paragraph.level !== undefined && (!Number.isInteger(paragraph.level) || paragraph.level < 0 || paragraph.level > FLOW_LIST_MAX_LEVEL)) {
      throw new Error(`list nesting level must be an integer from 0 to ${FLOW_LIST_MAX_LEVEL}`)
    }
    if (paragraph.code !== undefined && typeof paragraph.code !== "boolean") {
      throw new Error("a code block must be true or false")
    }
    return { runs, ...listStyle({ bullet: paragraph.bullet === true, checked: paragraph.checked, level: paragraph.level, code: paragraph.code === true }) }
  })
  const normalized = normalizeRichText(rich)
  // Switchboard: the words must be the plain text's — read as the plain text is kept,
  // since a code block keeps spaces the plain text collapses. (Without a code block the
  // two readings are the same, so this is the exact check it always was.)
  if (normalizeFlowText(richTextPlainText(normalized)) !== plainText) return undefined
  return normalized.some((paragraph) => paragraph.checked !== undefined || paragraph.bullet || paragraph.code || paragraph.runs.some((run) => run.bold || run.italic))
    ? normalized
    : undefined
}

export function truncateRichText(value: FlowRichText, max: number): FlowRichText {
  const result: FlowRichText = []
  let remaining = max
  for (const paragraph of value) {
    if (result.length) remaining -= 1
    if (remaining < 0) break
    const runs: FlowTextRun[] = []
    for (const run of paragraph.runs) {
      const text = run.text.slice(0, remaining)
      appendTextRun(runs, { ...run, text })
      remaining -= text.length
    }
    result.push({ runs, ...listStyle(paragraph) })
  }
  return result
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

// Switchboard: the copy button's two faces — a clipboard, and a tick once copied (CSS
// shows one or the other by data-copied). Fixed markup: nothing a board says is in it.
const COPY_ICON = '<svg class="flow-code-copy-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1.001 1.001 0 0 1 3 21l.003-14c0-.552.45-1 1.007-1H7zM5.003 8 5 20h10V8H5.003zM9 6h8v10h2V4H9v2z"/></svg>'
const COPIED_ICON = '<svg class="flow-code-copied-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M10 15.172l9.192-9.193 1.415 1.414L10 18l-6.364-6.364 1.414-1.414z"/></svg>'

/** Only our own escaped text and fixed tags enter a contenteditable field. */
export function richTextHtml(value: FlowRichText, interactive = true): string {
  let html = ""
  const lists: ("bullet" | "check")[] = []
  const closeList = () => { html += "</li></ul>"; lists.pop() }
  normalizeListLevels(value).forEach((paragraph, index) => {
    const position = `data-flow-paragraph="${index}"`
    // Switchboard: a code block — a <pre> with its copy button first, as a checklist
    // item has its checkbox, and its lines as the text's own line breaks. The button
    // is clickable on either canvas, so it is never disabled.
    if (paragraph.code) {
      while (lists.length) closeList()
      const copy = `<button type="button" contenteditable="false" class="flow-code-copy nodrag nopan" data-flow-copy="${index}" aria-label="Copy code" title="Copy code">${COPY_ICON}${COPIED_ICON}</button>`
      const text = paragraph.runs.map((run) => run.text).join("")
      // A block that is, or ends on, an empty line shows that line (a trailing line
      // feed alone draws none), and the caret can sit on it; readRichText reads a sole
      // final <br> as nothing, so the words come back as they went in.
      html += `<pre ${position} class="flow-code">${copy}${escapeHtml(text)}${text === "" || text.endsWith("\n") ? "<br>" : ""}</pre>`
      return
    }
    const kind = paragraph.checked !== undefined ? "check" : paragraph.bullet ? "bullet" : undefined
    const level = paragraph.level ?? 0
    if (!kind) {
      while (lists.length) closeList()
    } else {
      while (lists.length > level + 1) closeList()
      if (lists.length === level + 1 && lists[level] !== kind) closeList()
      if (lists.length === level + 1) html += "</li>"
      else {
        html += kind === "check" ? '<ul data-flow-checklist="true">' : "<ul>"
        lists.push(kind)
      }
    }
    const text = paragraph.runs.map((run) => {
      let content = escapeHtml(run.text)
      if (run.bold) content = `<b>${content}</b>`
      if (run.italic) content = `<i>${content}</i>`
      return content
    }).join("") || "<br>"
    if (kind === "check") {
      const label = escapeHtml(`${paragraph.checked ? "Uncheck" : "Check"} ${paragraph.runs.map((run) => run.text).join("") || "item"}`)
      const checkbox = `<button type="button" role="checkbox" contenteditable="false" class="flow-checkbox nodrag nopan" data-flow-checkbox="${index}" aria-checked="${paragraph.checked}" aria-label="${label}"${interactive ? "" : ' disabled tabindex="-1"'}></button>`
      html += `<li ${position} data-flow-checked="${paragraph.checked}">${checkbox}${text}`
    } else {
      html += kind === "bullet" ? `<li ${position}>${text}` : `<div ${position}>${text}</div>`
    }
  })
  while (lists.length) closeList()
  return html
}

export type FlowTextSelection = { start: number; end: number }

/** A selection ending at the next paragraph's start excludes that paragraph. */
export function richTextSelectedParagraphs(value: FlowRichText, selection: FlowTextSelection): number[] {
  const result: number[] = []
  let offset = 0
  value.forEach((paragraph, index) => {
    const end = offset + paragraph.runs.reduce((length, run) => length + run.text.length, 0)
    if (selection.start <= end && (selection.end > offset || (selection.start === selection.end && selection.start >= offset))) result.push(index)
    offset = end + 1
  })
  return result
}

export function toggleChecklist(value: FlowRichText, selection: FlowTextSelection): FlowRichText {
  const selected = new Set(richTextSelectedParagraphs(value, selection))
  const remove = [...selected].every((index) => value[index].checked !== undefined)
  return normalizeListLevels(value.map((paragraph, index) => selected.has(index)
    ? { runs: paragraph.runs, ...(!remove ? listStyle({ checked: paragraph.checked ?? false, level: paragraph.level }) : {}) }
    : paragraph))
}

export function checklistToBullets(value: FlowRichText, selection: FlowTextSelection): FlowRichText {
  const selected = new Set(richTextSelectedParagraphs(value, selection))
  return normalizeListLevels(value.map((paragraph, index) => selected.has(index) ? { runs: paragraph.runs, ...listStyle({ bullet: true, level: paragraph.level }) } : paragraph))
}

export function toggleBullets(value: FlowRichText, selection: FlowTextSelection): FlowRichText {
  const selected = new Set(richTextSelectedParagraphs(value, selection))
  const remove = [...selected].every((index) => value[index].bullet && value[index].checked === undefined)
  return remove
    ? normalizeListLevels(value.map((paragraph, index) => selected.has(index) ? { runs: paragraph.runs } : paragraph))
    : checklistToBullets(value, selection)
}

/**
 * Switchboard: the selected paragraphs as one code block — their words joined line by
 * line, marks and list marks gone, so the plain text (and every offset into it) is
 * unchanged — or, every one of them a code block already, as plain paragraphs again,
 * each line of the block one paragraph's soft break. A block made next to another is
 * one block with it.
 */
export function toggleCode(value: FlowRichText, selection: FlowTextSelection): FlowRichText {
  const selected = richTextSelectedParagraphs(value, selection)
  if (!selected.length) return value
  if (selected.every((index) => value[index].code)) {
    const picked = new Set(selected)
    return normalizeListLevels(value.map((paragraph, index) => (picked.has(index) ? { runs: paragraph.runs } : paragraph)))
  }
  const first = selected[0]
  const last = selected[selected.length - 1]
  const runs: FlowTextRun[] = []
  value.slice(first, last + 1).forEach((paragraph, index) => {
    if (index) appendTextRun(runs, { text: "\n" })
    appendTextRun(runs, { text: richTextPlainText([paragraph]) })
  })
  return normalizeListLevels(mergeCodeBlocks([...value.slice(0, first), { runs, code: true }, ...value.slice(last + 1)]))
}

/**
 * Switchboard: `text` typed into a code block in place of the selection — Enter's new
 * line ("\n"), or a paste of several lines — when the selection lies within one block:
 * the block with the words changed, and the caret after what went in. Null when the
 * selection isn't within one block, where the browser's own insertion will do. (The
 * browser's line break at the end of a <pre> is a lone <br>, which reads as nothing;
 * going through the words instead keeps the block's DOM the one richTextHtml draws.)
 */
export function insertCodeText(value: FlowRichText, selection: FlowTextSelection, text: string): { richText: FlowRichText; selection: FlowTextSelection } | null {
  const selected = richTextSelectedParagraphs(value, selection)
  const index = selected[0]
  if (index === undefined || selected.length !== 1 || !value[index].code) return null
  const offset = value.slice(0, index).reduce((length, paragraph) => length + richTextPlainText([paragraph]).length + 1, 0)
  const words = richTextPlainText([value[index]])
  const next = words.slice(0, selection.start - offset) + text + words.slice(selection.end - offset)
  const richText = value.map((paragraph, at) => (at === index ? { runs: next ? [{ text: next }] : [], code: true } : paragraph))
  const caret = selection.start + text.length
  return { richText, selection: { start: caret, end: caret } }
}

/**
 * Switchboard: Enter at the end of a code block whose last line is empty — the way out
 * of the block, as Enter on an empty item is the way out of a list: that empty line
 * goes and a plain paragraph follows the block, with the caret in it; a block that was
 * only an empty line becomes that paragraph. Null anywhere else, where Enter is a new
 * line of code.
 */
export function leaveCode(value: FlowRichText, selection: FlowTextSelection): { richText: FlowRichText; selection: FlowTextSelection } | null {
  if (selection.start !== selection.end) return null
  const [index] = richTextSelectedParagraphs(value, selection)
  if (index === undefined || !value[index].code) return null
  const offset = value.slice(0, index).reduce((length, paragraph) => length + richTextPlainText([paragraph]).length + 1, 0)
  const text = richTextPlainText([value[index]])
  if (selection.start !== offset + text.length) return null
  if (text !== "" && !text.endsWith("\n")) return null
  const kept = text.endsWith("\n") ? text.slice(0, -1) : text
  const block: FlowRichText = kept ? [{ runs: [{ text: kept }], code: true }] : []
  const richText = normalizeListLevels([...value.slice(0, index), ...block, { runs: [] }, ...value.slice(index + 1)])
  const caret = offset + (kept ? kept.length + 1 : 0)
  return { richText, selection: { start: caret, end: caret } }
}

/** Move selected list items with their descendants, preserving the list tree. */
export function shiftListIndent(value: FlowRichText, selection: FlowTextSelection, direction: 1 | -1): FlowRichText {
  const selected = richTextSelectedParagraphs(value, selection)
  if (!selected.length || selected.some((index) => !isList(value[index]))) return value
  const first = selected[0]
  let last = selected[selected.length - 1]
  const lastLevel = Math.min(...selected.map((index) => value[index].level ?? 0))
  while (last + 1 < value.length && isList(value[last + 1]) && (value[last + 1].level ?? 0) > lastLevel) last += 1
  if (direction === 1 && (first === 0 || !isList(value[first - 1]) || (value[first - 1].level ?? 0) < (value[first].level ?? 0))) return value
  if (value.slice(first, last + 1).some((paragraph) => {
    const level = (paragraph.level ?? 0) + direction
    return level < 0 || level > FLOW_LIST_MAX_LEVEL
  })) return value
  return normalizeListLevels(value.map((paragraph, index) => index >= first && index <= last
    ? { runs: paragraph.runs, ...listStyle({ ...paragraph, level: (paragraph.level ?? 0) + direction }) }
    : paragraph))
}

function sliceRuns(runs: FlowTextRun[], start: number, end: number): FlowTextRun[] {
  const result: FlowTextRun[] = []
  let offset = 0
  for (const run of runs) {
    appendTextRun(result, { ...run, text: run.text.slice(Math.max(0, start - offset), Math.max(0, end - offset)) })
    offset += run.text.length
  }
  return result
}

/** Enter keeps the item's level; an empty item outdents, then exits the list. */
export function continueList(value: FlowRichText, selection: FlowTextSelection): { richText: FlowRichText; selection: FlowTextSelection } {
  const selected = richTextSelectedParagraphs(value, selection)
  const first = selected[0] ?? 0
  const last = richTextSelectedParagraphs(value, { start: selection.end, end: selection.end })[0] ?? selected[selected.length - 1] ?? first
  const offset = value.slice(0, first).reduce((length, paragraph) => length + richTextPlainText([paragraph]).length + 1, 0)
  const lastOffset = value.slice(0, last).reduce((length, paragraph) => length + richTextPlainText([paragraph]).length + 1, 0)
  const paragraph = value[first]
  if (!richTextPlainText([paragraph]).trim() && selection.start === selection.end) {
    const richText = paragraph.level
      ? shiftListIndent(value, selection, -1)
      : normalizeListLevels(value.map((paragraph, index) => index === first ? { runs: paragraph.runs } : paragraph))
    return { richText, selection }
  }
  const before = sliceRuns(paragraph.runs, 0, selection.start - offset)
  const after = sliceRuns(value[last].runs, selection.end - lastOffset, Infinity)
  const nextStyle = listStyle({ ...paragraph, checked: paragraph.checked !== undefined ? false : undefined })
  const richText = normalizeListLevels([...value.slice(0, first), { runs: before, ...listStyle(paragraph) }, { runs: after, ...nextStyle }, ...value.slice(last + 1)])
  return { richText, selection: { start: selection.start + 1, end: selection.start + 1 } }
}
