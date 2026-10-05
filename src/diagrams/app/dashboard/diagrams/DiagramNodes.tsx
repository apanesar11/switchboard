"use client"

// The custom React Flow node every diagram is drawn from — a box, a sticky
// note, a piece of free text or an image. A dumb renderer: layoutDiagram() has
// already decided where it goes and how big it is (the node's `width`/`height`
// come from there), so this only decides what it looks like.
//
// Nothing here is interactive: the read-only canvas emits every node with
// draggable:false and selectable:false. The handles exist because React Flow
// routes a diagram's edges between them. (Diagrams are arranged by hand in
// FlowEditor.tsx, which reuses FlowBox from here.)

import { useState } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { RiImageLine, RiSparkling2Fill } from "@remixicon/react"
import { cx } from "@/lib/utils"
import {
  FLOW_TEXT_METRICS,
  flowLabelWeight,
  type FlowBoxNodeData,
} from "@/lib/diagrams/layout"
import { installFlowTextMeasure } from "@/lib/diagrams/measure"
import {
  FLOW_SIDES,
  isFlowBoxShape,
  type FlowBoxShape,
  type FlowSide,
  type FlowTextAlign,
  type FlowTone,
  type FlowRichText,
} from "@/lib/diagrams/types"
import { plainTextParagraphs, richTextHtml } from "@/lib/diagrams/rich-text"

// Every box is sized from its text; in the browser, measure that text for
// real rather than estimate it, so a box is as tall as its text really wraps.
installFlowTextMeasure()

// A hidden handle. React Flow needs it to exist and to be MEASURABLE — so
// opacity, not display:none, which would remove it from layout and take its
// bounds with it.
const HIDDEN_HANDLE: React.CSSProperties = {
  opacity: 0,
  pointerEvents: "none",
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 0,
  background: "transparent",
}

// Exported for the editor's colour swatches, so a swatch is exactly the box
// it will turn into.
export const TONE_STYLES: Record<FlowBoxNodeData["tone"], string> = {
  default:
    "border-gray-300 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-50",
  accent:
    "border-brand/40 bg-brand-faint text-gray-900 dark:border-brand/50 dark:bg-brand/15 dark:text-gray-50",
  muted:
    "border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-800 dark:bg-gray-800 dark:text-gray-300",
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100",
  warning:
    "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
  danger:
    "border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100",
}

// The diamond's outline colour, matching each tone's border. A diamond is
// clipped out of its box, which clips the box's own border away with it, so
// its outline is drawn separately (DiamondOutline).
const TONE_OUTLINES: Record<FlowTone, string> = {
  default: "stroke-gray-300 dark:stroke-gray-700",
  accent: "stroke-brand/40 dark:stroke-brand/50",
  muted: "stroke-gray-300 dark:stroke-gray-700",
  success: "stroke-emerald-300 dark:stroke-emerald-900/60",
  warning: "stroke-amber-300 dark:stroke-amber-900/60",
  danger: "stroke-red-300 dark:stroke-red-900/60",
}

const SHAPE_STYLES: Record<FlowBoxShape, string> = {
  box: "rounded-none",
  rounded: "rounded-lg",
  pill: "rounded-full",
  // A real rotated square would rotate the label with it. Clipping the box
  // keeps the text upright and the silhouette right; the extra horizontal
  // padding is what stops a label reaching the clipped corners.
  diamond:
    "rounded-none border-0 px-8 [clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)]",
}

// A sticky note's paper for each tone — yellow unless told otherwise, like the
// real thing, and the same pastel in dark mode, where a note still reads as
// paper with dark ink on it. Exported for the editor's colour swatches.
export const NOTE_TONE_STYLES: Record<FlowTone, string> = {
  default: "bg-amber-100 text-amber-950 dark:bg-amber-200",
  accent: "bg-sky-100 text-sky-950 dark:bg-sky-200",
  muted: "bg-gray-100 text-gray-800 dark:bg-gray-300 dark:text-gray-900",
  success: "bg-emerald-100 text-emerald-950 dark:bg-emerald-200",
  warning: "bg-orange-100 text-orange-950 dark:bg-orange-200",
  danger: "bg-rose-100 text-rose-950 dark:bg-rose-200",
}

// Free text's ink for each tone. Exported for the editor's colour swatches.
export const TEXT_TONE_STYLES: Record<FlowTone, string> = {
  default: "text-gray-900 dark:text-gray-50",
  accent: "text-brand dark:text-brand-light",
  muted: "text-gray-500 dark:text-gray-400",
  success: "text-emerald-700 dark:text-emerald-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
}

const ALIGN_STYLES: Record<FlowTextAlign, string> = {
  left: "items-start text-left",
  center: "items-center text-center",
  right: "items-end text-right",
}

/** A box label's type, from its text size — the sizes flowNodeHeight measured. */
export function flowLabelStyle(box: Pick<FlowBoxNodeData, "textSize">): React.CSSProperties {
  const metrics = FLOW_TEXT_METRICS[box.textSize] ?? FLOW_TEXT_METRICS.medium
  return { fontSize: metrics.fontSize, lineHeight: `${metrics.lineHeight}px` }
}

/** Weight and slant for a label — the weight flowLabelWeight measured. */
export function flowLabelClass(
  box: Pick<FlowBoxNodeData, "shape" | "bold" | "italic" | "labelRichText">,
): string {
  const weight = flowLabelWeight(box)
  return cx(
    weight >= 700 ? "font-bold" : weight >= 500 ? "font-medium" : "font-normal",
    box.italic && !box.labelRichText && "italic",
  )
}

// Four lines rather than one polygon, because a line's ends can be given in
// percentages and a polygon's points cannot — so it fits a box of any height
// without being told it. Drawn over the clipped box, not inside it.
function DiamondOutline({ tone, dashed }: Pick<FlowBoxNodeData, "tone" | "dashed">) {
  const corners = [
    ["50%", "0"],
    ["100%", "50%"],
    ["50%", "100%"],
    ["0", "50%"],
  ] as const
  return (
    <svg
      aria-hidden="true"
      className={cx(
        "pointer-events-none absolute inset-0 size-full overflow-visible",
        TONE_OUTLINES[tone] ?? TONE_OUTLINES.default,
      )}
      strokeWidth={1}
      strokeDasharray={dashed ? "5 4" : undefined}
    >
      {corners.map(([x1, y1], index) => {
        const [x2, y2] = corners[(index + 1) % corners.length]
        return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />
      })}
    </svg>
  )
}

/** Where each named side's handle sits — the names FlowEdgeSpec.fromSide/toSide use. */
export const FLOW_SIDE_POSITIONS: Record<FlowSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/**
 * How a box's text wraps, matching how layout.ts measures it: line breaks
 * typed into it kept, and a word too long for the box broken rather than left
 * to run out of it. Exported for the editor's text fields.
 */
export const FLOW_TEXT_WRAP = "whitespace-pre-line [overflow-wrap:anywhere]"

export function FlowLabelText({ text, richText, className, style }: {
  text: string
  richText?: FlowRichText
  className?: string
  style?: React.CSSProperties
}) {
  return <div
    className={cx("flow-rich-text w-full", FLOW_TEXT_WRAP, className)}
    style={style}
    dangerouslySetInnerHTML={{ __html: richTextHtml(richText ?? plainTextParagraphs(text)) }}
  />
}

/**
 * The box itself, shared by the read-only node below and the editor's
 * editable one, so a diagram looks identical whether you are reading it or
 * arranging it. `children` is where each caller puts its handles.
 */
export function FlowBox({
  labelOverride,
  className,
  children,
  ...box
}: FlowBoxNodeData & {
  /** Drawn in place of the label and detail — the editor's text fields. */
  labelOverride?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  const { label, detail, shape, tone, dashed, align } = box
  if (shape === "image") {
    return (
      <div className="relative size-full">
        <FlowImage src={box.src} alt={label} />
        {children}
      </div>
    )
  }

  // The paddings are the ones flowNodeSize measures with (FLOW_NOTE_PAD,
  // FLOW_TEXT_PAD_X / _Y), so the text that was measured is the text that fits.
  const look =
    shape === "note"
      ? cx("justify-start rounded-sm p-3.5 shadow-md", NOTE_TONE_STYLES[tone] ?? NOTE_TONE_STYLES.default)
      : shape === "text"
        ? cx("justify-start px-1 py-[3px]", TEXT_TONE_STYLES[tone] ?? TEXT_TONE_STYLES.default)
        : cx(
            "justify-center border px-3 py-2 shadow-sm",
            isFlowBoxShape(shape) ? SHAPE_STYLES[shape] : SHAPE_STYLES.rounded,
            TONE_STYLES[tone] ?? TONE_STYLES.default,
            dashed && "border-dashed",
          )
  const diamond = shape === "diamond"
  return (
    <div className="relative size-full">
      <div
        className={cx(
          "flex size-full flex-col",
          look,
          ALIGN_STYLES[align] ?? ALIGN_STYLES.center,
          className,
        )}
      >
        {labelOverride ?? (
          <>
            <FlowLabelText text={label} richText={box.labelRichText} className={flowLabelClass(box)} style={flowLabelStyle(box)} />
            {detail ? (
              <FlowLabelText text={detail} richText={box.detailRichText} className="mt-0.5 text-[11px] leading-4 opacity-60" />
            ) : null}
          </>
        )}
      </div>
      {diamond ? <DiamondOutline tone={tone} dashed={dashed} /> : null}
      {/* Words the editor's ✦ Answer wrote, not edited since. Over the corner
          rather than in the text's flow, so it never changes the box's size. */}
      {box.ai ? (
        <span
          role="img"
          aria-label="Answered by AI"
          title="Answered by AI"
          // pointer-events-auto: the read-only canvas turns them off on its
          // nodes, and the title is the mark's only explanation.
          className="pointer-events-auto absolute right-1 top-1 cursor-default text-violet-500 dark:text-violet-400"
        >
          <RiSparkling2Fill className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {children}
    </div>
  )
}

// An image node's picture, filling the node — or, when there is no picture to
// show (a dead link, a URL that isn't one), a frame with its alt text, so the
// node is still something you can see, select and replace.
function FlowImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-gray-300 bg-gray-50 p-2 text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500">
        <RiImageLine className="size-6 shrink-0" aria-hidden="true" />
        <span className="max-w-full truncate text-xs">{alt}</span>
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- any https picture a spec names, sized by the node rather than by next/image
    <img
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setFailed(src)}
      className="size-full select-none rounded-md object-contain shadow-sm ring-1 ring-black/5 dark:ring-white/10"
    />
  )
}

export function FlowBoxNode({ data }: NodeProps) {
  const box = data as FlowBoxNodeData

  return (
    <FlowBox {...box}>
      {/* A diagram's edges are routed by React Flow, so these handles carry
          real geometry — one per side, named after it, and each edge names the
          pair it uses (layoutFlow). They are all "source" handles; the canvas
          runs in loose connection mode, which is what lets an edge land on
          one. */}
      {FLOW_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={FLOW_SIDE_POSITIONS[side]}
          style={HIDDEN_HANDLE}
        />
      ))}
    </FlowBox>
  )
}

// One object, referentially stable, so React Flow never warns about a node type
// map that changes identity between renders.
export const diagramNodeTypes = {
  flowBox: FlowBoxNode,
} as const
