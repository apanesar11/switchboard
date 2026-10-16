"use client"

// The custom React Flow node every diagram is drawn from — a box, a sticky
// note, a piece of free text or an image. A dumb renderer: layoutDiagram() has
// already decided where it goes and how big it is (the node's `width`/`height`
// come from there), so this only decides what it looks like.
//
// The read-only canvas disables dragging and selection, while file nodes still
// offer their copy-path button. The handles route a diagram's edges between
// nodes. FlowEditor.tsx reuses FlowBox for the editable canvas.
//
// Switchboard: a box an answer wrote carries a small tag under its corner naming
// the workspace that answer read, and a pinned terminal draws here as a still card
// (an archived whiteboard's read-only canvas has no live terminal to show; the
// editor draws its own, FlowEditor.tsx TerminalNode). A teleport draws here for
// both canvases, naming where it goes; a click on it takes the view there — on the
// read-only canvas through FlowBoxNode below, in the editor through its onNodeClick.
// A YouTube video's face (VideoFace) is drawn here for both canvases too: its poster
// until it is played, then the player. The read-only canvas plays it itself; the
// editor's VideoNode (FlowEditor.tsx) keeps what is playing in the editor's state.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Handle, Position, getViewportForBounds, useReactFlow, useStore, useStoreApi, type NodeProps, type Viewport } from "@xyflow/react"
import {
  RiDoorOpenLine,
  RiExternalLinkLine,
  RiImageLine,
  RiPlayFill,
  RiSparkling2Fill,
  RiStopFill,
  RiFileTextLine,
  RiTerminalBoxLine,
  RiYoutubeFill,
} from "@remixicon/react"
import { toast } from "@/components/Toast"
import { call } from "@/lib/bridge"
import { cx, focusRing } from "@/lib/utils"
import {
  FLOW_TEXT_METRICS,
  flowLabelWeight,
  type FlowBoxNodeData,
} from "@/lib/diagrams/layout"
import { installFlowTextMeasure } from "@/lib/diagrams/measure"
import {
  FLOW_SIDES,
  TELEPORT_LABEL,
  TERMINAL_HEADER,
  VIDEO_BAR,
  VIDEO_LABEL,
  isFlowBoxShape,
  type FlowBoxShape,
  type FlowSide,
  type FlowTextAlign,
  type FlowTone,
  type FlowRichText,
} from "@/lib/diagrams/types"
import { plainTextParagraphs, richTextHtml } from "@/lib/diagrams/rich-text"
import { flowCheckbox } from "@/lib/diagrams/rich-text-dom"
import { isYouTubeVideoId, youTubeEmbedUrl, youTubeThumbnailUrl, youTubeWatchUrl } from "@/lib/diagrams/youtube"
import { DiagramFileCopy } from "./DiagramFileCopy"

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

export function FlowLabelText({ text, richText, className, style, onToggleCheck }: {
  text: string
  richText?: FlowRichText
  className?: string
  style?: React.CSSProperties
  onToggleCheck?: (paragraph: number) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const focusCheck = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (focusCheck.current === null) return
    container.current?.querySelector<HTMLElement>(`[data-flow-checkbox="${focusCheck.current}"]`)?.focus()
    focusCheck.current = null
  }, [richText])
  return <div
    ref={container}
    className={cx("flow-rich-text w-full", FLOW_TEXT_WRAP, className)}
    style={style}
    onPointerDown={(event) => {
      if (flowCheckbox(event.target)) { event.preventDefault(); event.stopPropagation() }
    }}
    onDoubleClick={(event) => {
      if (flowCheckbox(event.target)) event.stopPropagation()
    }}
    onClick={(event) => {
      const checkbox = flowCheckbox(event.target)
      if (!checkbox || !onToggleCheck) return
      event.stopPropagation()
      const index = Number(checkbox.dataset.flowCheckbox)
      if (document.activeElement === checkbox) focusCheck.current = index
      onToggleCheck(index)
    }}
    dangerouslySetInnerHTML={{ __html: richTextHtml(richText ?? plainTextParagraphs(text), Boolean(onToggleCheck)) }}
  />
}

/**
 * Switchboard: the workspace an answer read, as a small tag hanging under the
 * box's bottom-right edge — absolutely placed, so it never changes the size the
 * box was measured at. `ghost` is the dashed one on an answer still on its way.
 */
export function WorkspaceTag({ id, ghost = false }: { id: string; ghost?: boolean }) {
  return (
    <span
      className={cx("flow-wtag", ghost && "flow-wtag-ghost")}
      title={ghost ? `Reading ${id}` : `Answered by reading ${id}`}
    >
      {id}
    </span>
  )
}

/** Switchboard: what the rail's dot means, for the dot on a pinned terminal. */
export const TERMINAL_DOT_TITLES: Record<string, string> = {
  run: "Running",
  bell: "Claude finished a turn",
  fail: "Failed",
  chg: "Has changes",
}

/** Switchboard: the rail's status dot for a workspace (SB.dotFor), or nothing. */
export function TerminalDot({ dot }: { dot?: string }) {
  if (!dot || !TERMINAL_DOT_TITLES[dot]) return null
  return (
    <span
      role="img"
      aria-label={TERMINAL_DOT_TITLES[dot]}
      title={TERMINAL_DOT_TITLES[dot]}
      className={cx("flow-terminal-dot", dot)}
    />
  )
}

/**
 * Switchboard: what a teleport says it goes to — the destination's words on one line,
 * or what it is when it has none (a picture, an empty note) — or null when there is
 * no such node.
 */
export function teleportDestinationName(box: FlowBoxNodeData | undefined): string | null {
  if (!box) return null
  if (box.shape === "terminal") return `${box.workspace ?? box.label} terminal`
  if (box.shape === "teleport") return TELEPORT_LABEL
  const words = box.label.replace(/\s+/g, " ").trim()
  if (words) return words
  return box.shape === "image"
    ? "Image"
    : box.shape === "video"
      ? "Video"
      : box.shape === "note"
        ? "Note"
        : box.shape === "text"
          ? "Text"
          : "Untitled"
}

/**
 * Switchboard: where a teleport leaves the view — `rect` (a node, in canvas units)
 * framed in a pane of `pane`'s size: at the zoom it was at, or life size when that
 * was smaller, and further out only for a node too big to fit.
 */
export function teleportViewport(
  rect: { x: number; y: number; width: number; height: number },
  pane: { width: number; height: number },
  zoom: number,
): Viewport {
  return getViewportForBounds(rect, pane.width, pane.height, 0.15, Math.min(2.5, Math.max(zoom, 1)), 0.3)
}

/** Switchboard: how long the view takes to fly to a teleport's destination. */
export const TELEPORT_DURATION_MS = 450

/**
 * Switchboard: a teleport's face — a white pill with a door, set apart from a step by
 * its shape and its icon, saying where it goes. The destination's words come from React Flow's own
 * store, so renaming that node renames it here too, on either canvas.
 */
function TeleportFace({ to }: { to?: string }) {
  const name = useStore((state) =>
    to ? teleportDestinationName(state.nodeLookup.get(to)?.data as FlowBoxNodeData | undefined) : null,
  )
  return (
    <div
      className="flow-teleport"
      data-linked={name !== null}
      title={name !== null ? `Teleport to ${name}` : "Teleport · no destination yet"}
    >
      <span className="flow-teleport-icon">
        <RiDoorOpenLine className="size-[18px]" aria-hidden="true" />
      </span>
      <span className="flow-teleport-text">
        <b>{TELEPORT_LABEL}</b>
        <small>{name !== null ? `to ${name}` : "No destination yet"}</small>
      </span>
    </div>
  )
}

/**
 * Switchboard: whether the board the read-only canvas draws is on screen — off it, a
 * video there goes back to its poster (ReadOnlyVideo). DiagramCanvas provides it.
 */
export const VideoShownContext = createContext(true)

/**
 * Switchboard: a YouTube video's face, on either canvas. A strip across the top, which
 * the node is dragged by, with YouTube's glyph, the video's title, Open on YouTube and,
 * while it plays, Stop; under it the video's poster with a play button, or once it is
 * played, the player.
 *
 * Nothing of YouTube's but the poster's picture loads before Play. The player's iframe
 * is put on the page only by a click (or the editor's Enter), the gesture its autoplay
 * plays on. `onPlay` is the read-only canvas's own: the poster is a button there. The
 * editor plays from its onNodeClick instead, so a drag that starts on the poster moves
 * the node rather than playing it. Both addresses are built from the checked id and
 * fixed hosts (lib/diagrams/youtube.ts), so nothing a board file says reaches the <img>
 * or the <iframe> as a URL.
 */
export function VideoFace({
  videoId,
  videoStart,
  label,
  playing,
  interactive = true,
  onPlay,
  onStop,
}: {
  videoId?: string
  videoStart?: number
  label: string
  playing: boolean
  /** False while the editor's hand tool is out: the player takes no pointer then. */
  interactive?: boolean
  onPlay?: () => void
  onStop: () => void
}) {
  const id = videoId !== undefined && isYouTubeVideoId(videoId) ? videoId : null
  const name = label.replace(/\s+/g, " ").trim() || VIDEO_LABEL
  const live = playing && id !== null
  async function openOnYouTube() {
    if (id === null) return
    const result = await call("openExternal", youTubeWatchUrl({ videoId: id, start: videoStart }))
    if (!result.ok) toast({ title: "Couldn't open your browser", description: result.error, variant: "error" })
  }
  // A button in the strip: never a drag, nor a click on the node beneath it — as a
  // pinned terminal's header's are.
  const action = (what: string, run: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      aria-label={what}
      title={what}
      disabled={!interactive}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        run()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cx("nodrag nopan flow-video-btn", focusRing)}
    >
      {icon}
    </button>
  )

  return (
    <div className="flow-video" data-playing={live} role="group" aria-label={name}>
      <div className="flow-video-head" style={{ height: VIDEO_BAR }}>
        <RiYoutubeFill className="flow-video-glyph" aria-hidden="true" />
        <b title={name}>{name}</b>
        <span className="flow-video-actions">
          {id !== null
            ? action("Open on YouTube", () => void openOnYouTube(), <RiExternalLinkLine className="size-3.5" aria-hidden="true" />)
            : null}
          {live ? action("Stop", onStop, <RiStopFill className="size-3.5" aria-hidden="true" />) : null}
        </span>
      </div>
      <div className="flow-video-body">
        {live ? (
          // Every press and wheel over the player is the player's — not a drag of the
          // node, nor a pan of the canvas. The editor takes the pointer back from it
          // while a gesture of its own is under way (styles.css, [data-flow-gesture]).
          <div className={cx("flow-video-player nodrag nopan nowheel", !interactive && "flow-video-still")}>
            <iframe
              className="flow-video-frame"
              src={youTubeEmbedUrl({ videoId: id, start: videoStart })}
              title={name}
              // Full screen in allow= alone: Electron warns that it takes precedence
              // over an allowfullscreen attribute.
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : (
          <VideoPoster videoId={id} label={name} onPlay={onPlay} />
        )}
      </div>
    </div>
  )
}

/**
 * Switchboard: a video's poster — YouTube's own picture of it, cropped to the player,
 * under a play button. YouTube answers for a picture it hasn't got with a grey stand-in
 * 120 pixels wide (HTTP 404, but a JPEG that loads), so a picture no wider than that,
 * or none at all (offline), gives a dark face with the video's title on it instead.
 */
function VideoPoster({ videoId, label, onPlay }: { videoId: string | null; label: string; onPlay?: () => void }) {
  const [missing, setMissing] = useState<string | null>(null)
  const picture = videoId !== null && missing !== videoId ? videoId : null
  const face = (
    <>
      {picture !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- YouTube's picture of the video, sized by the node rather than by next/image
        <img
          src={youTubeThumbnailUrl(picture)}
          alt=""
          draggable={false}
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth <= 120) setMissing(picture)
          }}
          onError={() => setMissing(picture)}
        />
      ) : null}
      <span className="flow-video-play" aria-hidden="true">
        <RiPlayFill className="size-7" />
      </span>
      {picture === null ? <span className="flow-video-name">{label}</span> : null}
    </>
  )
  return onPlay ? (
    <button
      type="button"
      className={cx("flow-video-poster", focusRing)}
      data-pictured={picture !== null}
      aria-label={`Play ${label}`}
      title={`Play ${label}`}
      onClick={(event) => {
        event.stopPropagation()
        onPlay()
      }}
    >
      {face}
    </button>
  ) : (
    <div className="flow-video-poster" data-pictured={picture !== null} title={`Play ${label}`}>
      {face}
    </div>
  )
}

/**
 * Switchboard: a video on the read-only canvas, which plays it there and then. Off
 * screen it goes back to its poster: the page takes the player's iframe out with the
 * board, and put back it would load again and start over, out loud. (Full screen
 * remounts that canvas — DiagramsPage's resetKey — which does the same.)
 */
function ReadOnlyVideo({ videoId, videoStart, label }: Pick<FlowBoxNodeData, "videoId" | "videoStart" | "label">) {
  const shown = useContext(VideoShownContext)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!shown) setPlaying(false)
  }, [shown])
  return (
    <VideoFace
      videoId={videoId}
      videoStart={videoStart}
      label={label}
      playing={playing && shown}
      onPlay={() => setPlaying(true)}
      onStop={() => setPlaying(false)}
    />
  )
}

/**
 * The box itself, shared by the read-only node below and the editor's
 * editable one, so a diagram looks identical whether you are reading it or
 * arranging it. `children` is where each caller puts its handles.
 */
export function FlowBox({
  labelOverride,
  onToggleCheck,
  onTeleport,
  className,
  children,
  ...box
}: FlowBoxNodeData & {
  /** Drawn in place of the label and detail — the editor's text fields. */
  labelOverride?: React.ReactNode
  onToggleCheck?: (field: "label" | "detail", paragraph: number) => void
  /** Switchboard: a click on a teleport, on the read-only canvas. */
  onTeleport?: (event: React.MouseEvent) => void
  className?: string
  children?: React.ReactNode
}) {
  const { label, detail, shape, tone, dashed, align } = box
  if (shape === "document") {
    return (
      <div className={cx("flow-file-node relative flex size-full items-center gap-3 rounded-xl border border-gray-300 bg-white px-4 shadow-sm dark:border-gray-700 dark:bg-gray-900", className)} title={`${label} · Double-click to open`}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-faint text-brand dark:bg-brand/15 dark:text-brand-light">
          <RiFileTextLine className="size-6" aria-hidden="true" />
        </div>
        <div className="min-w-0 text-left">
          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-50">{label}</div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Markdown document</div>
        </div>
        <DiagramFileCopy box={box} />
        {children}
      </div>
    )
  }
  if (shape === "image") {
    return (
      <div className="flow-file-node relative size-full">
        <FlowImage src={box.src} alt={label} />
        <DiagramFileCopy box={box} />
        {children}
      </div>
    )
  }
  // Switchboard: a pinned terminal on a whiteboard that can't be edited — its
  // header, and where the shell would be, a word on how to get it back.
  if (shape === "terminal") {
    const workspace = box.workspace ?? label
    return (
      <div className={cx("flow-terminal-node relative size-full", className)} title={`${workspace} terminal`}>
        <div className="flow-terminal-card-frame">
          <div className="flow-terminal-head" style={{ height: TERMINAL_HEADER }}>
            <RiTerminalBoxLine className="size-3.5 shrink-0 text-[#0969da]" aria-hidden="true" />
            <b>{workspace}</b>
          </div>
          {box.minimized ? null : (
            <div className="flow-terminal-body flow-terminal-card">
              <p>Unarchive to use this terminal</p>
            </div>
          )}
        </div>
        {children}
      </div>
    )
  }

  if (shape === "teleport") {
    return (
      <div className={cx("relative size-full", className)} onClick={onTeleport}>
        <TeleportFace to={box.teleportTo} />
        {children}
      </div>
    )
  }

  // Switchboard: a YouTube video, played where it is. This is the read-only canvas's;
  // the editor draws its own (FlowEditor.tsx VideoNode), whose playing is the editor's.
  if (shape === "video") {
    return (
      <div className={cx("relative size-full", className)}>
        <ReadOnlyVideo videoId={box.videoId} videoStart={box.videoStart} label={label} />
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
            <FlowLabelText text={label} richText={box.labelRichText} className={flowLabelClass(box)} style={flowLabelStyle(box)} onToggleCheck={onToggleCheck ? (index) => onToggleCheck("label", index) : undefined} />
            {detail ? (
              <FlowLabelText text={detail} richText={box.detailRichText} className="mt-0.5 text-[11px] leading-4 opacity-60" onToggleCheck={onToggleCheck ? (index) => onToggleCheck("detail", index) : undefined} />
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
      {/* Switchboard: and the workspace it read, while the words are still the AI's. */}
      {box.ai && box.answeredIn ? <WorkspaceTag id={box.answeredIn} /> : null}
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

/**
 * Switchboard: a teleport on the read-only canvas — clicked, the view flies to the
 * node it goes to. (The editor handles its own clicks: it selects the node, and
 * offers Back.)
 */
function useTeleportClick(to: string | undefined): ((event: React.MouseEvent) => void) | undefined {
  const { getViewport, setViewport } = useReactFlow()
  const store = useStoreApi()
  if (!to) return undefined
  return (event) => {
    const { nodeLookup, domNode } = store.getState()
    const target = nodeLookup.get(to)
    const pane = domNode?.getBoundingClientRect()
    if (!target || target.hidden || !pane) return
    event.stopPropagation()
    const width = target.measured?.width ?? target.width ?? 0
    const height = target.measured?.height ?? target.height ?? 0
    void setViewport(
      teleportViewport({ ...target.position, width, height }, pane, getViewport().zoom),
      { duration: TELEPORT_DURATION_MS },
    )
  }
}

export function FlowBoxNode({ data }: NodeProps) {
  const box = data as FlowBoxNodeData
  const teleport = useTeleportClick(box.shape === "teleport" ? box.teleportTo : undefined)

  return (
    <FlowBox {...box} className={teleport ? "cursor-pointer" : undefined} onTeleport={teleport}>
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
