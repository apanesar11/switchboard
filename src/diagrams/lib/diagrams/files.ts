// Switchboard: PDFs and spreadsheets on a whiteboard — which files are which, the
// address a node names one by, and the few sizes and words the canvas and the panels
// share. Dependency-free (types.ts only), so the validator, the editor, the panels and
// the tests under plain node all read the same rules.
//
// A file dropped, pasted or picked onto a board is kept on this Mac by main, once, by
// its content — ~/.switchboard/whiteboards/files/<sha256 to 32 hex>.<ext> — and the node
// names it sbfile://file/<that name>: a scheme index.js serves PDFs from that folder and
// nothing else. The extension is the file's kind, so the address alone says what it is;
// src/main/whiteboards.js keeps the same list (FILE_EXTENSIONS) and checks the bytes
// match it before keeping a file.

import { FLOW_PDF_DEFAULT_SIZE, FLOW_SIZE_MAX, PDF_BAR, PDF_LABEL, SHEET_LABEL, type FlowSize } from "./types"

export type FlowFileKind = "pdf" | "sheet"

/** Every extension a whiteboard keeps, and what it is. Mirrored in whiteboards.js. */
export const FLOW_FILE_EXTENSIONS: Readonly<Record<string, FlowFileKind>> = {
  pdf: "pdf",
  xlsx: "sheet",
  xlsm: "sheet",
  xlsb: "sheet",
  xls: "sheet",
  ods: "sheet",
  numbers: "sheet",
  csv: "sheet",
  tsv: "sheet",
}

/**
 * The MIME types a file may come with in place of an extension it lacks — a file built
 * in memory, or one Finder named without one. The extension wins when there is one.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.apple.numbers": "numbers",
  "application/x-iwork-numbers-sffnumbers": "numbers",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
}

/** The most a PDF or a spreadsheet may be. Mirrored in whiteboards.js. */
export const FLOW_PDF_MAX_BYTES = 100 * 1024 * 1024
export const FLOW_SHEET_MAX_BYTES = 50 * 1024 * 1024

/** The file picker's `accept`: every extension above, with a dot. */
export const FLOW_FILE_ACCEPT = Object.keys(FLOW_FILE_EXTENSIONS).map((ext) => `.${ext}`).join(",")

/** What a file's name and type make it: its extension, lowercase, or null for neither. */
export function flowFileExtension(name: string, type = ""): string | null {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim())
  const ext = match ? match[1].toLowerCase() : null
  if (ext !== null && Object.prototype.hasOwnProperty.call(FLOW_FILE_EXTENSIONS, ext)) return ext
  const mime = type.toLowerCase().split(";")[0].trim()
  return Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : null
}

/** Whether a dropped or pasted file is a PDF, a spreadsheet, or neither (null). */
export function flowFileKind(name: string, type = ""): FlowFileKind | null {
  const ext = flowFileExtension(name, type)
  return ext === null ? null : FLOW_FILE_EXTENSIONS[ext]
}

/** Why `file` can't go on a whiteboard as a PDF or a spreadsheet, or null when it can. */
export function flowFileProblem(file: { name: string; size: number; type: string }): string | null {
  const kind = flowFileKind(file.name, file.type)
  const name = file.name || "That file"
  if (kind === null) return `${name} isn't a PDF or a spreadsheet`
  if (file.size === 0) return `${name} is empty`
  const most = kind === "pdf" ? FLOW_PDF_MAX_BYTES : FLOW_SHEET_MAX_BYTES
  if (file.size > most) return `${name} is over ${Math.round(most / 1024 / 1024)} MB`
  return null
}

/** sbfile://file/<32 hex>.<ext> — the only address a pdf or a sheet may name. */
const FILE_SRC_RE = /^sbfile:\/\/file\/([0-9a-f]{32}\.([a-z]+))$/

/** What a file address names — its file name, extension and kind — or null for any other text. */
export function parseFlowFileSrc(src: unknown): { name: string; ext: string; kind: FlowFileKind } | null {
  if (typeof src !== "string") return null
  const match = FILE_SRC_RE.exec(src)
  if (match === null || !Object.prototype.hasOwnProperty.call(FLOW_FILE_EXTENSIONS, match[2])) return null
  return { name: match[1], ext: match[2], kind: FLOW_FILE_EXTENSIONS[match[2]] }
}

/**
 * A node's label from the file's name: the name without its extension, on one line,
 * at most 200 characters — or "PDF" / "Spreadsheet" when that leaves nothing.
 */
export function flowFileLabel(name: string, kind: FlowFileKind): string {
  // Trimmed first, as flowFileExtension reads the name: "Report.csv " loses its ".csv" too.
  const words = name
    .trim()
    .replace(/\.[A-Za-z0-9]{1,10}$/, "")
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is dropped
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const chars = Array.from(words)
  const label = chars.length > 200 ? chars.slice(0, 200).join("").trimEnd() : words
  return label || (kind === "pdf" ? PDF_LABEL : SHEET_LABEL)
}

/** What a spreadsheet card says it is, from its extension. */
export function sheetFormatName(ext: string): string {
  switch (ext) {
    case "csv":
      return "CSV file"
    case "tsv":
      return "TSV file"
    case "ods":
      return "OpenDocument spreadsheet"
    case "numbers":
      return "Numbers spreadsheet"
    default:
      return "Excel spreadsheet"
  }
}

/** A column's letters, as a spreadsheet names it: 0 → A, 25 → Z, 26 → AA, 701 → ZZ. */
export function sheetColumnName(index: number): string {
  let n = Math.max(0, Math.floor(index)) + 1
  let name = ""
  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/**
 * The size a PDF goes onto the canvas at: 240 wide, its cover's shape above the bar, the
 * cover held between a landscape slide's height and a long receipt's. With no cover,
 * FLOW_PDF_DEFAULT_SIZE.
 */
export function flowPdfSize(cover?: { width: number; height: number } | null): FlowSize {
  if (!cover || !(cover.width > 0) || !(cover.height > 0)) return { ...FLOW_PDF_DEFAULT_SIZE }
  const width = FLOW_PDF_DEFAULT_SIZE.width
  const page = Math.min(Math.max(Math.round((width * cover.height) / cover.width), 120), 600)
  return { width, height: Math.min(FLOW_SIZE_MAX, page + PDF_BAR) }
}

/**
 * Whether pasted words could be files Finder copied — its Copy puts their names on the
 * clipboard as the text, one a line — and so whether Edit ▸ Paste should ask main for the
 * files themselves: one to twenty lines, each a name ending in an extension. Plain words
 * never send main to the clipboard for files.
 */
export function flowLooksLikeCopiedFiles(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== "")
  return lines.length > 0 && lines.length <= 20 && lines.every((line) => line.length <= 255 && /^(?!\.)[^/]+\.[A-Za-z0-9]{1,10}$/.test(line))
}
