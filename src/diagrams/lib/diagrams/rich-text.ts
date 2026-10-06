import { DIAGRAM_TEXT_MAX_LENGTH, type FlowRichText, type FlowTextParagraph, type FlowTextRun } from "./types"

export const FLOW_BULLET_INDENT = 1.35
export const FLOW_CHECKLIST_INDENT = 1.65
export const FLOW_LIST_MAX_LEVEL = 8

function isList(paragraph: FlowTextParagraph): boolean {
  return paragraph.checked !== undefined || Boolean(paragraph.bullet)
}

function listStyle(paragraph: Pick<FlowTextParagraph, "bullet" | "checked" | "level">): Pick<FlowTextParagraph, "bullet" | "checked" | "level"> {
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
      return { runs: paragraph.runs }
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

/** The same whitespace rules as normalizeFlowText, preserving each character's marks. */
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
  return normalizeListLevels(paragraphs)
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
  if (!Array.isArray(value) || value.length > DIAGRAM_TEXT_MAX_LENGTH + 1) {
    throw new Error("rich text must be an array of paragraphs")
  }
  let characters = Math.max(0, value.length - 1)
  const rich: FlowRichText = value.map((paragraph) => {
    if (!paragraph || typeof paragraph !== "object" || !Array.isArray(paragraph.runs) ||
        paragraph.runs.length > DIAGRAM_TEXT_MAX_LENGTH + 1) {
      throw new Error("each rich text paragraph must contain runs")
    }
    const runs: FlowTextRun[] = []
    for (const run of paragraph.runs) {
      if (!run || typeof run !== "object" || typeof run.text !== "string" || /\r/.test(run.text)) {
        throw new Error("rich text runs must contain text with normalized line breaks")
      }
      characters += run.text.length
      if (characters > DIAGRAM_TEXT_MAX_LENGTH * 10) throw new Error("rich text is too long")
      appendTextRun(runs, { text: run.text, bold: run.bold === true, italic: run.italic === true })
    }
    if (paragraph.checked !== undefined && typeof paragraph.checked !== "boolean") {
      throw new Error("checklist state must be true or false")
    }
    if (paragraph.level !== undefined && (!Number.isInteger(paragraph.level) || paragraph.level < 0 || paragraph.level > FLOW_LIST_MAX_LEVEL)) {
      throw new Error(`list nesting level must be an integer from 0 to ${FLOW_LIST_MAX_LEVEL}`)
    }
    return { runs, ...listStyle({ bullet: paragraph.bullet === true, checked: paragraph.checked, level: paragraph.level }) }
  })
  const normalized = normalizeRichText(rich)
  if (richTextPlainText(normalized) !== plainText) return undefined
  return normalized.some((paragraph) => paragraph.checked !== undefined || paragraph.bullet || paragraph.runs.some((run) => run.bold || run.italic))
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

/** Only our own escaped text and fixed tags enter a contenteditable field. */
export function richTextHtml(value: FlowRichText, interactive = true): string {
  let html = ""
  const lists: ("bullet" | "check")[] = []
  const closeList = () => { html += "</li></ul>"; lists.pop() }
  normalizeListLevels(value).forEach((paragraph, index) => {
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
    const position = `data-flow-paragraph="${index}"`
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
