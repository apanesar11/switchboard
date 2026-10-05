import { DIAGRAM_TEXT_MAX_LENGTH, type FlowRichText, type FlowTextRun } from "./types"

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
  const lines: { runs: FlowTextRun[]; paragraph: number; bullet?: boolean }[] = []
  value.forEach((paragraph, index) => {
    let line: FlowTextRun[] = []
    for (const run of paragraph.runs) {
      run.text.split("\n").forEach((text, part) => {
        if (part) {
          lines.push({ runs: line, paragraph: index, bullet: paragraph.bullet })
          line = []
        }
        appendTextRun(line, { ...run, text })
      })
    }
    lines.push({ runs: line, paragraph: index, bullet: paragraph.bullet })
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
      paragraphs.push({ runs: line.runs, ...(line.bullet ? { bullet: true } : {}) })
    }
    previous = line.paragraph
  }
  return paragraphs
}

/** Visual lines retain an item's indent without creating additional bullets. */
export function richTextVisualLines(value: FlowRichText): FlowRichText {
  return value.flatMap((paragraph) => {
    const lines: FlowRichText = [{ runs: [], bullet: paragraph.bullet }]
    for (const run of paragraph.runs) {
      run.text.split("\n").forEach((text, index) => {
        if (index) lines.push({ runs: [], bullet: paragraph.bullet })
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
    return { runs, ...(paragraph.bullet === true ? { bullet: true } : {}) }
  })
  const normalized = normalizeRichText(rich)
  if (richTextPlainText(normalized) !== plainText) return undefined
  return normalized.some((paragraph) => paragraph.bullet || paragraph.runs.some((run) => run.bold || run.italic))
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
    result.push({ runs, ...(paragraph.bullet ? { bullet: true } : {}) })
  }
  return result
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

/** Only our own escaped text and fixed tags enter a contenteditable field. */
export function richTextHtml(value: FlowRichText): string {
  let html = ""
  let list = false
  for (const paragraph of value) {
    if (Boolean(paragraph.bullet) !== list) {
      html += paragraph.bullet ? "<ul>" : "</ul>"
      list = Boolean(paragraph.bullet)
    }
    const text = paragraph.runs.map((run) => {
      let content = escapeHtml(run.text)
      if (run.bold) content = `<b>${content}</b>`
      if (run.italic) content = `<i>${content}</i>`
      return content
    }).join("") || "<br>"
    html += paragraph.bullet ? `<li>${text}</li>` : `<div>${text}</div>`
  }
  return html + (list ? "</ul>" : "")
}
