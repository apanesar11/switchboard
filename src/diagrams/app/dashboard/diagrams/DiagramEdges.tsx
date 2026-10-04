"use client"

import { cx } from "@/lib/utils"

// A diagram's edges are React Flow's built-in smoothstep, which takes its
// colours from these custom properties — a class on the <path> would not reach
// it. Re-pointed at the app's grays so the lines (and their arrowheads, which
// read the same variable) hold up on both the light and the dark canvas, and
// at the brand colour for the edge you have selected in the editor. Set on the
// wrapper of both the read-only canvas and the editor so the two draw a
// diagram identically.
export const FLOW_EDGE_THEME = cx(
  "[--xy-edge-stroke:#6b7280] [--xy-edge-stroke-width:1.5] [--xy-edge-stroke-selected:var(--brand-primary)]",
  "dark:[--xy-edge-stroke:#9ca3af] dark:[--xy-edge-label-background-color:#111827] dark:[--xy-edge-label-color:#f3f4f6]",
)
