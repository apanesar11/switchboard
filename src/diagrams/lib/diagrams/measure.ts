// Real text measurement for the diagram layout, in the browser.
//
// layout.ts sizes every box from its text, and by default measures that text
// with a table of character widths — fine in tests and scripts, but an
// estimate: a line it thinks fits can wrap on screen, and then the box is a
// line too short and its text runs out of it. Installed once in the browser
// (DiagramNodes.tsx, which both the editor and the read-only canvas load),
// this measures with a canvas in the page's own font instead, so the lines
// the layout counts are the lines that are drawn.

import { setFlowTextMeasure } from "./layout"

let installed = false

export function installFlowTextMeasure(): void {
  if (installed || typeof document === "undefined") return
  const context = document.createElement("canvas").getContext("2d")
  if (!context) return
  installed = true

  // The boxes inherit the page's font, read once it is first needed (the
  // body is styled by then).
  let family: string | null = null
  const widths = new Map<string, number>()

  setFlowTextMeasure((text, fontSize, weight) => {
    family ??= getComputedStyle(document.body).fontFamily || "sans-serif"
    const key = `${weight} ${fontSize}\u0000${text}`
    const known = widths.get(key)
    if (known !== undefined) return known
    context.font = `${weight} ${fontSize}px ${family}`
    // A pixel to spare, so sub-pixel rounding on screen never wraps a line
    // the layout counted as fitting.
    const width = Math.ceil(context.measureText(text).width) + 1
    // Wrapping measures every prefix of a line; keep the cache bounded.
    if (widths.size > 5_000) widths.clear()
    widths.set(key, width)
    return width
  })
}
