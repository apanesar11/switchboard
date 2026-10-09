"use client"

// Switchboard's copy of the admin's app/dashboard/diagrams/FlowEditor.tsx. Keep it
// mirrored by hand; every difference is marked "Switchboard:" — who answers ✦ Answer
// (one of four ways, lib/diagrams/answer.ts and ai-client.ts, rather than an OpenAI
// model), Edit ▸ Undo / Redo / Paste arriving through the handle rather than as
// keystrokes, and unsaved changes reported rather than held with a beforeunload.

// The Diagrams page's canvas: a diagram you arrange by hand, in the spirit of
// Whimsical.
//
// The toolbar down the left picks what a click on the canvas does: select
// (and drag-select), pan, or place a box, a sticky note or a piece of free
// text where you click — and it opens the file picker for an image, which can
// also be dropped or pasted straight onto the canvas. Notes, text and images
// resize from their corners and edges. Boxes are dragged about, and an arrow
// is drawn by dragging from one of a box's side dots onto another box.
// With a box selected, Tab adds a connected box to its right and starts you
// typing in it; Shift+Tab steps back to the box it hangs off, so the next Tab
// adds a sibling under the last one. Whatever is selected gets a toolbar
// floating above it — shape, colour and outline for a box, type for its text
// while you are editing it, label and line style for an arrow. Backspace
// deletes, ⌘Z / ⇧⌘Z undo and redo, ⌘D duplicates.
//
// A box's toolbar also leads with ✦ Answer (⌘↵, or Switchboard's ⌘I): the box's text goes to an
// OpenAI model (lib/diagrams/ai.ts, app/api/diagrams/answer) and the answer
// comes back as one box — or one per part when it has parts — hanging off the
// box's right side, placed the way Tab would place them, as one undo step.
// The chevron beside it picks the model and the reasoning effort.
// Switchboard: any number of boxes can be waiting on an answer at once, one
// answer per box; a drag-select takes every box it touches, not only the ones
// wholly inside it; and deleting a box from a branch closes the gap it leaves.
// A selected node's toolbar folds all of its outgoing branches as one action;
// clicking it again brings them back. A collapsed node keeps its +N count
// visible, and clicking it expands the branches. Individual arrow fold flags
// in the saved spec remain readable, including partially folded older diagrams.
// Switchboard: the image tool also offers Google Images (G), in a panel docked
// on the canvas's right (ImageSearchPanel.tsx). A picture dragged out of it, or
// right-clicked ▸ Add Image to Whiteboard, is fetched by main and goes on exactly
// as a dropped file does.
// Switchboard: a whiteboard belongs to no workspace, so ✦ Answer reads the one the
// whiteboard names (`answerWorkspace`, chosen in the who-answers menu's Workspace
// row, kept on the board by the host) — taken at the moment of asking, and written
// on each box the answer adds (`answeredIn`, the small tag under its corner). A CLI
// with no workspace to read is told so before anything is asked.
// Switchboard: a workspace's terminal can be pinned to the board as a node of its
// own ("terminal"). The node is only a frame — header, buttons, a dark body — and
// the host lays the live terminal over its body itself, from the geometry this
// editor reports (onTerminalSlots): an xterm inside the canvas's CSS transform
// would draw blurred and misread the pointer. Pinning, floating, undo and delete
// move the node in and out of the board like any other edit; the host hears which
// it was (onTerminalRemoved).
//
// It edits the SAME spec every other part of the Diagrams feature reads.
// layoutDiagram() turns the spec into the canvas, and flowSpecFromCanvas()
// (lib/diagrams/flow-editor.ts) turns the canvas back into a spec with a
// position on every box and a side on every edge — so the read-only canvas
// and Claude both see exactly what was arranged here.
//
// SAVING is driven by one value: the JSON of the spec the canvas currently
// shows. Whenever it differs from the last JSON saved, and nothing is mid-drag,
// a debounced save writes it; saves run one at a time, in order, so a slow one
// can never land after a newer one. Deriving it from the JSON rather than
// wiring a save into each gesture means no gesture can forget to save.
//
// UNDO records a snapshot of that JSON just before each change, from the
// handlers that make the change. A burst of typing records once, so undo takes
// back the whole rename rather than one letter.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  EdgeToolbar,
  Handle,
  NodeResizeControl,
  NodeResizer,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ResizeControlVariant,
  SelectionMode,
  SmoothStepEdge,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getSmoothStepPath,
  getViewportForBounds,
  reconnectEdge,
  useConnection,
  useReactFlow,
  useStore,
  useStoreApi,
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowState,
} from "@xyflow/react"
import {
  RiAddLine,
  RiFileTextLine,
  RiAlignCenter,
  RiAlignLeft,
  RiAlignRight,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiArrowUpSLine,
  RiContractRightLine,
  RiExpandRightLine,
  RiArrowLeftRightLine,
  RiArrowLeftSLine,
  RiBold,
  RiCheckLine,
  RiCheckboxLine,
  RiIndentDecrease,
  RiIndentIncrease,
  RiCloseLine,
  RiCursorLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFolderImageLine,
  RiHand,
  RiImageAddLine,
  RiItalic,
  RiKeyboardLine,
  RiLinkM,
  RiLinkUnlinkM,
  RiLoader4Line,
  RiListUnordered,
  RiPictureInPictureExitLine,
  RiSearchLine,
  RiShapesLine,
  RiSparkling2Fill,
  RiStickyNoteLine,
  RiStopFill,
  RiSubtractLine,
  RiTerminalBoxLine,
  RiText,
  RiTextBlock,
  RiZoomInLine,
  type RemixiconComponentType,
} from "@remixicon/react"
import { toast } from "@/components/Toast"
import { cx, focusRing } from "@/lib/utils"
import {
  flowEdgeAppearance,
  flowNodeSize,
  FLOW_IMAGE_DEFAULT_SIZE,
  FLOW_NODE_WIDTH,
  FLOW_TEXT_MIN_WIDTH,
  layoutDiagram,
  type FlowBoxNodeData,
  type FlowEdgeData,
} from "@/lib/diagrams/layout"
import {
  boxInDirection,
  clearOfBoxes,
  flowSpecFromCanvas,
  nextChildPosition,
  FLOW_TAB_GAP_Y,
  nextFlowNodeId,
  OPPOSITE_DIRECTION,
  placeTabChild,
  placeTabChildren,
  tidyAfterDelete,
  tidyAfterMove,
  tidyFlowTree,
  flowBranches,
  foldFlow,
  flowNodeFoldGroups,
  toggleFlowNodeFold,
  carryFoldedPositions as carryFolded,
  UNTITLED_FLOW_LABEL,
  type FlowCanvasEdge,
  type FlowCanvasNode,
  type FlowDirection,
  type FlowFoldEdge,
  type FlowRect,
  type FlowSpecMeta,
} from "@/lib/diagrams/flow-editor"
import {
  DEFAULT_FLOW_TEXT_ALIGN,
  DEFAULT_FLOW_TEXT_SIZE,
  DIAGRAM_TEXT_MAX_LENGTH,
  FLOW_BOX_SHAPES,
  FLOW_SIDES,
  FLOW_SIZE_MAX,
  FLOW_TERMINAL_DEFAULT_SIZE,
  FLOW_TERMINAL_FLOOR,
  FLOW_TERMINAL_MIN_SIZE,
  FLOW_TEXT_ALIGNS,
  FLOW_TEXT_SIZES,
  FLOW_TONES,
  TERMINAL_BASE_FONT,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  TERMINAL_HEADER,
  TERMINAL_MIN_FONT,
  isFlowBoxShape,
  type ClientRect,
  type TerminalSlot,
  type FlowBoxShape,
  type FlowShape,
  type FlowSide,
  type FlowSize,
  type FlowSpec,
  type FlowTextAlign,
  type FlowTextSize,
  type FlowTone,
} from "@/lib/diagrams/types"
import {
  diagramImageProblem,
  imageDisplaySize,
  uploadDiagramImage,
} from "@/lib/diagrams/upload"
import { normalizeFlowText, normalizeWorkspaceId } from "@/lib/diagrams/validate"
import {
  FLOW_AI_MAX_EXISTING,
  flowQuestionPath,
  type FlowAiPart,
} from "@/lib/diagrams/ai"
// Switchboard: who answers is one of four (lib/diagrams/answer.ts), chosen on this Mac
// and kept by main, rather than the admin's OpenAI model in localStorage.
import {
  AnswerError,
  requestFlowAnswer,
  requestFlowCondense,
  updateAnswerSettings,
  useAnswerStatus,
} from "@/lib/diagrams/ai-client"
import { inspectFlowCondenseSelection, replaceFlowSelection } from "@/lib/diagrams/condense"
import type {
  AnswerSettings,
  AnswerStatus,
  AnswerStep,
  ProviderId,
  ProviderStatus,
  WorkspaceChoices,
  WorkspaceStatus,
} from "@/lib/bridge"
import { call, writeClipboard } from "@/lib/bridge"
// Switchboard: Google Images beside the canvas, and pictures dragged out of it.
import { imageUrlsFromDrop, isUrlDrag } from "@/lib/diagrams/image-search"
import { FIT_VIEW_OPTIONS } from "./DiagramCanvas"
import { ImageSearchPanel, type ImageSearchAsk } from "./ImageSearchPanel"
import { DocumentPanel, type DocumentView } from "./DocumentPanel"
import { useFlowDocuments } from "./useFlowDocuments"
import { DiagramFileCopyContext } from "./DiagramFileCopy"
import {
  FlowBox,
  FLOW_TEXT_WRAP,
  flowLabelClass,
  flowLabelStyle,
  FLOW_SIDE_POSITIONS,
  NOTE_TONE_STYLES,
  TerminalDot,
  TEXT_TONE_STYLES,
  TONE_STYLES,
  WorkspaceTag,
} from "./DiagramNodes"
import { PickerGlyph, WorkspacePicker, workspaceDir, workspaceGone } from "./WorkspacePicker"
import { FLOW_EDGE_THEME } from "./DiagramEdges"
import { RichTextField } from "./RichTextField"
import { flowListState, formatActiveFlowText, type FlowTextCommand } from "@/lib/diagrams/rich-text-dom"
import { parseFlowRichText } from "@/lib/diagrams/rich-text"

import "@xyflow/react/dist/style.css"

/** Quiet time after the last change before it is written. */
const SAVE_DELAY_MS = 700
/** Changes closer together than this are one undo step (a burst of typing). */
const UNDO_COALESCE_MS = 1_000
const UNDO_LIMIT = 100

const EDIT_NODE_TYPE = "flowEdit"
const EDIT_EDGE_TYPE = "flowEditEdge"
// Switchboard: the admin's type, without the admin's name in it.
const DRAG_MIME = "application/x-flow-shape"
const SNAP_GRID: [number, number] = [10, 10]
// Left-drag on empty canvas draws a selection box, like Figma or Whimsical;
// the middle and right buttons pan, as do scrolling and holding Space.
const PAN_BUTTONS = [1, 2]
const DELETE_KEYS = ["Backspace", "Delete"]
const ARROW_DIRECTIONS: Record<string, FlowDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
}

/**
 * How much of the view a box Tab or Shift+Tab moves to must be clear of, in
 * screen pixels: the toolbar on the left, the floating toolbar above, the
 * controls below.
 */
const REVEAL_MARGIN = { left: 84, right: 32, top: 72, bottom: 64 }

/**
 * What a click on the empty canvas does: select (dragging draws a selection
 * box), pan (dragging moves the view), or place a box, a note or a text.
 */
type Tool = "select" | "hand" | "shape" | "note" | "text" | "document"

/** A ✦ Answer being waited for. */
type Asking = {
  /** The box that asked. */
  id: string
  /** Switchboard: what it asked, for the card when several are on their way. */
  question: string
  /** Switchboard: when it was asked, for its "· 12s" wherever that is shown. */
  startedAt: number
  /** Switchboard: who is answering, and its name for the strip. */
  provider: ProviderId
  name: string
  /** A CLI reads the workspace first, and the strip shows what it is doing. */
  cli: boolean
  /**
   * Switchboard: the workspace a CLI is reading, as it was when asked — what the
   * card over the strip names, the tag on the placeholder, and the tag each box the
   * answer adds carries. Null for an API, which reads none.
   */
  workspace: string | null
  /** Web access was on when it was asked: it may look things up on the web too. */
  web: boolean
  /** Which answer this is, counted from 1 — keys its status, so its timer restarts. */
  serial: number
  /** Switchboard: Condense replaces these boxes instead of answering one. */
  mode?: "condense"
  selectedIds?: string[]
}

/** Switchboard: how the last answer went, for "3 answers added · Claude Code read 6 files in 41s". */
type AnswerNote = { by: string; files: number | null; seconds: number; condensed?: number }

/**
 * Switchboard: an answer that didn't come, said in the strip with the one thing that
 * fixes it — Settings for a CLI that isn't here or a missing key, the Terminal for a
 * CLI that isn't signed in.
 */
type AnswerFailure = {
  message: string
  code?: string
  /** Switchboard: the workspace the failed answer was to read — where Open Terminal goes. */
  workspace?: string | null
  /** Switchboard: the box that asked — where Choose workspace… opens the menu. */
  nodeId?: string
}

/**
 * Switchboard: why a CLI can't answer a box on this whiteboard — it has no workspace
 * to read, or the one it names has left the rail — or null when it can. Only ✦ Answer
 * asks this: Condense reads nothing, so it never needs a workspace.
 */
function noWorkspace(provider: ProviderStatus, workspace: string | null, gone: boolean): AnswerFailure | null {
  if (provider.kind !== "cli") return null
  if (!workspace) return { message: `Pick a workspace for ${provider.name} to read`, code: "no-workspace" }
  if (gone) {
    return {
      message: `${workspace} is no longer in the rail — pick a workspace for ${provider.name} to read`,
      code: "no-workspace",
    }
  }
  return null
}

/** Why `provider` can't answer right now, or null when it can. */
function notReady(provider: ProviderStatus): AnswerFailure | null {
  if (provider.ready) return null
  if (provider.state === "missing") {
    return { message: `${provider.name} isn't installed on this Mac`, code: "missing" }
  }
  if (provider.state === "signed-out") {
    return { message: `${provider.name} isn't signed in on this Mac`, code: "signed-out" }
  }
  return { message: `There's no ${provider.name} key on this Mac yet`, code: "no-key" }
}

/**
 * The single-letter keys for the tools, and "i" for an image. Switchboard: "g"
 * for Google Images.
 */
const TOOL_KEYS: Record<string, Tool | "image" | "images"> = {
  v: "select",
  h: "hand",
  r: "shape",
  s: "note",
  t: "text",
  i: "image",
  g: "images",
}

// What a free text and a note show while they are empty and being typed in.
const TEXT_PLACEHOLDER = "Type something"
const NOTE_PLACEHOLDER = "Write a note"
const DETAIL_PLACEHOLDER = "Second line"

/** How far apart several images dropped or pasted at once land. */
const IMAGE_CASCADE = 30

/** How long "3 answers added · Undo" stays up after an answer lands. */
const ANSWERED_NOTICE_MS = 8_000
/** The placeholder drawn where an answer will land, while it is awaited. */
const ANSWER_GHOST_SIZE = { width: FLOW_NODE_WIDTH, height: 52 }

/**
 * Switchboard: how far in from a pinned terminal's left, right and bottom edges the
 * live terminal is laid, in screen pixels — the strip that keeps the node's own
 * resize handles under the pointer rather than under the terminal.
 */
const TERMINAL_BODY_INSET = 5
/** Switchboard: what in the canvas counts as floating over a pinned terminal. */
const CANVAS_OVERLAY_SELECTOR = "[data-canvas-overlay], .flow-document-floating .flow-document-panel, .flow-document-focus"
/**
 * Switchboard: the canvas's own chrome — React Flow's panels (the tool rail, the
 * undo bar, the zoom controls, the attribution) — which a pinned terminal's live
 * overlay leaves uncovered (TerminalSlot.holes), as every other node passes under it.
 */
const CANVAS_CHROME_SELECTOR = ".react-flow__panel, .react-flow__controls"

const HANDLE_STYLE: React.CSSProperties = {
  width: 11,
  height: 11,
  background: "var(--brand-primary)",
  border: "2px solid white",
}

// The box shapes the toolbar offers. Each is a shape plus the label and colour
// a new box of that kind starts with — the label is selected for typing over
// at once.
type PaletteItem = {
  shape: FlowBoxShape
  name: string
  label: string
  tone: FlowTone
}

const PALETTE: PaletteItem[] = [
  { shape: "rounded", name: "Step", label: "Step", tone: "default" },
  { shape: "box", name: "Box", label: "Box", tone: "default" },
  { shape: "pill", name: "Start / end", label: "Start", tone: "muted" },
  { shape: "diamond", name: "Decision", label: "Decision?", tone: "accent" },
]

const SHAPE_NAMES: Record<FlowBoxShape, string> = {
  rounded: "Rounded",
  box: "Square",
  pill: "Pill",
  diamond: "Diamond",
}

const TONE_NAMES: Record<FlowTone, string> = {
  default: "Plain",
  accent: "Brand",
  muted: "Muted",
  success: "Green",
  warning: "Amber",
  danger: "Red",
}

// A sticky note's colours go by what they look like, not what they mean.
const NOTE_TONE_NAMES: Record<FlowTone, string> = {
  default: "Yellow",
  accent: "Blue",
  muted: "Grey",
  success: "Green",
  warning: "Orange",
  danger: "Pink",
}

const TEXT_SIZE_NAMES: Record<FlowTextSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
}

const ALIGN_ICONS: Record<FlowTextAlign, RemixiconComponentType> = {
  left: RiAlignLeft,
  center: RiAlignCenter,
  right: RiAlignRight,
}

// A shape as a small line drawing, for the toolbars.
function ShapeGlyph({ shape, className }: { shape: FlowBoxShape; className?: string }) {
  return (
    <svg
      viewBox="0 0 36 28"
      className={cx("h-5 w-7 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      {shape === "diamond" ? (
        <polygon points="18,2 34,14 18,26 2,14" strokeLinejoin="round" />
      ) : (
        <rect
          x={2}
          y={6}
          width={32}
          height={16}
          rx={shape === "pill" ? 8 : shape === "rounded" ? 4 : 0}
        />
      )}
    </svg>
  )
}

// A solid or dashed outline / line, for the toolbar's style toggles.
function StrokeGlyph({ kind, dashed }: { kind: "outline" | "line"; dashed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeDasharray={dashed ? "3 2.5" : undefined}
      aria-hidden="true"
    >
      {kind === "outline" ? (
        <rect x={3} y={3} width={14} height={14} rx={2.5} />
      ) : (
        <line x1={2} y1={10} x2={18} y2={10} />
      )}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Spec ⇄ canvas
// ─────────────────────────────────────────────────────────────────────

function editableEdge(
  base: Pick<Edge, "id" | "source" | "target"> & Partial<Edge>,
  data: FlowEdgeData,
): Edge {
  return { ...base, type: EDIT_EDGE_TYPE, data, ...flowEdgeAppearance(data) }
}

// The spec laid out exactly as the read-only canvas would draw it, then made
// editable. Also how undo restores a snapshot.
function toCanvas(spec: FlowSpec): { nodes: Node[]; edges: Edge[] } {
  const layout = layoutDiagram(spec)
  return {
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      type: EDIT_NODE_TYPE,
      position: node.position,
      width: node.width,
      height: node.height,
      data: node.data,
    })),
    edges: layout.edges.map((edge) =>
      editableEdge(
        {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        },
        edge.data as FlowEdgeData,
      ),
    ),
  }
}

function canvasJson(meta: FlowSpecMeta, nodes: Node[], edges: Edge[]): string {
  return JSON.stringify(
    flowSpecFromCanvas(
      meta,
      nodes as unknown as FlowCanvasNode[],
      edges as unknown as FlowCanvasEdge[],
    ),
  )
}

/** A new box with every text and outline style at its default. */
function plainBox(start: Pick<FlowBoxNodeData, "label" | "shape" | "tone">): FlowBoxNodeData {
  return {
    ...start,
    dashed: false,
    textSize: DEFAULT_FLOW_TEXT_SIZE,
    align: DEFAULT_FLOW_TEXT_ALIGN,
    bold: false,
    italic: false,
  }
}

/** What a new note or free text starts as: empty, left-aligned. */
function blankNode(shape: "note" | "text"): FlowBoxNodeData {
  return { ...plainBox({ label: "", shape, tone: "default" }), align: "left" }
}

/** What an empty label stands in for while it is typed into, by shape. */
function placeholderFor(shape: FlowShape): string {
  return shape === "text"
    ? TEXT_PLACEHOLDER
    : shape === "note"
      ? NOTE_PLACEHOLDER
      : UNTITLED_FLOW_LABEL
}

/**
 * The size a node is drawn at — the read-only canvas's, for the same node.
 * An empty label is measured as its placeholder, so a field you haven't typed
 * in yet is still wide enough to show what goes there.
 */
function boxSize(box: FlowBoxNodeData): FlowSize {
  return flowNodeSize({
    ...box,
    // As typed, line breaks and all, so the box grows the moment Shift+Enter
    // starts a new line — not once something is typed on it.
    label: box.label.trim() ? box.label : placeholderFor(box.shape),
    detail: box.detail === "" ? DETAIL_PLACEHOLDER : box.detail,
  })
}

// `node` with its box swapped for `box`, re-sized to what the read-only canvas
// would give it. Height changes about the centre, so the arrows level with it
// stay straight as a label wraps or a shape or type changes; width (free text
// running wider as you type) from the left edge, so the text stays put.
// Switchboard: a pinned terminal keeps its header where it is — folding it to its
// title bar happens in place.
function withBox(node: Node, box: FlowBoxNodeData): Node {
  const { width, height } = boxSize(box)
  if (box.shape === "terminal") return { ...node, data: box, width, height }
  const grow = height - (node.height ?? height)
  const position =
    grow === 0
      ? node.position
      : { x: node.position.x, y: Math.round(node.position.y - grow / 2) }
  return { ...node, data: box, width, height, position }
}

/** Whether two texts read the same once saved (see flowSpecFromCanvas's clean()). */
function sameWords(a: string | undefined, b: string | undefined): boolean {
  const words = (value: string | undefined) => (value ?? "").trim().replace(/\s+/g, " ")
  return words(a) === words(b)
}

function isText(box: FlowBoxNodeData): boolean {
  return box.shape === "text"
}

/** Whether a node has text you can edit directly on the canvas. */
function hasText(box: FlowBoxNodeData): boolean {
  // Switchboard: nor has a pinned terminal — its label is only its workspace.
  return box.shape !== "image" && box.shape !== "document" && box.shape !== "terminal"
}

/** Switchboard: whether `node` is a pinned terminal. */
function isTerminal(node: Node): boolean {
  return (node.data as FlowBoxNodeData).shape === "terminal"
}

/** Switchboard: the workspace a pinned terminal shows. */
function terminalWorkspace(node: Node): string {
  const box = node.data as FlowBoxNodeData
  return box.workspace ?? box.label
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Rounded to `places` decimals — what the slots carry, so equal geometry compares equal. */
function roundTo(value: number, places = 2): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale + 0
}

function intersects(a: ClientRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.left + a.width && a.top < b.bottom && b.top < a.top + a.height
}

/** Switchboard: how long re-framing the drawing takes (full screen in or out) — fitView's own. */
const REFIT_DURATION_MS = 200

/** React Flow's own easing for an animated view change (d3-ease's cubicInOut). */
function easeInOutCubic(t: number): number {
  return ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2
}

/**
 * Switchboard: the view part-way (`t`, 0–1) from one to another in a pane this size —
 * the canvas point at the pane's centre moving evenly, the zoom evenly in proportion,
 * so a zoom in or out reads as one movement rather than a slide and a scale.
 */
function viewBetween(
  from: { x: number; y: number; zoom: number },
  to: { x: number; y: number; zoom: number },
  t: number,
  width: number,
  height: number,
): { x: number; y: number; zoom: number } {
  const zoom = from.zoom * (to.zoom / from.zoom) ** t
  // The canvas point under the pane's centre, in each view.
  const fromX = (width / 2 - from.x) / from.zoom
  const fromY = (height / 2 - from.y) / from.zoom
  const toX = (width / 2 - to.x) / to.zoom
  const toY = (height / 2 - to.y) / to.zoom
  return {
    x: width / 2 - (fromX + (toX - fromX) * t) * zoom,
    y: height / 2 - (fromY + (toY - fromY) * t) * zoom,
    zoom,
  }
}

/** Switchboard: up to a whole number — but not for the dust a division leaves (230.0000001). */
function wholeUp(value: number): number {
  return Math.ceil(value - 1e-6)
}

/** Switchboard: a ClientRect a host handed over — finite, with some size — or not. */
function isClientRect(value: unknown): value is ClientRect {
  if (typeof value !== "object" || value === null) return false
  const { left, top, width, height } = value as Record<string, unknown>
  return (
    [left, top, width, height].every((side) => typeof side === "number" && Number.isFinite(side)) &&
    (width as number) > 0 &&
    (height as number) > 0
  )
}

/** Switchboard: the part of `b` inside `a`, as a slot's hole carries it — or null when they don't meet. */
function overlap(a: ClientRect, b: DOMRect): TerminalSlot["holes"][number] | null {
  if (!intersects(a, b)) return null
  return {
    left: roundTo(Math.max(a.left, b.left)),
    top: roundTo(Math.max(a.top, b.top)),
    right: roundTo(Math.min(a.left + a.width, b.right)),
    bottom: roundTo(Math.min(a.top + a.height, b.bottom)),
  }
}

function rectOf(node: Node): FlowRect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? FLOW_NODE_WIDTH,
    height: node.height ?? 0,
  }
}

function deselected<T extends { selected?: boolean }>(items: T[]): T[] {
  return items.map((item) => (item.selected ? { ...item, selected: false } : item))
}

// Switchboard: what ⌘C copied — the boxes selected and the arrows between them, for
// ⌘V to put down again. Kept here, for every diagram the bundle shows, so a copy
// pastes into another diagram too; the system clipboard gets only their words (for
// pasting anywhere else), and `text` is those words: ⌘V puts the boxes down only while
// the clipboard still holds them, so text copied since, from anywhere, never pastes
// boxes from an older copy.
type FlowCopy = {
  documents?: Promise<Map<string, string>>
  text: string
  nodes: { id: string; position: { x: number; y: number }; width?: number; height?: number; data: FlowBoxNodeData }[]
  edges: {
    source: string
    target: string
    sourceHandle: string | null
    targetHandle: string | null
    data: FlowEdgeData
  }[]
}
let flowCopy: FlowCopy | null = null

/** A box's words as the clipboard gets them: its label, and its second line under it. */
function clipboardWords(box: FlowBoxNodeData): string {
  const label =
    normalizeFlowText(box.label) ||
    (box.shape === "image" ? "Image" : box.shape === "note" ? "Note" : UNTITLED_FLOW_LABEL)
  const detail = box.detail ? normalizeFlowText(box.detail) : ""
  return detail ? `${label}\n${detail}` : label
}

/** Clipboard text compared the way it comes back: line endings and the ends aside. */
function sameClipboard(a: string, b: string): boolean {
  const plain = (text: string) => text.replace(/\r\n?/g, "\n").trim()
  return plain(a) === plain(b)
}

// Switchboard: folding a branch away behind a collapsed arrow (layout.ts foldFlow).

function isCollapsed(edge: Edge): boolean {
  return (edge.data as FlowEdgeData | undefined)?.collapsed === true
}

/** What the collapsed arrows on the canvas fold away. */
function foldOf(nodes: Node[], edges: Edge[]) {
  return foldFlow(
    nodes.map((node) => node.id),
    edges.map((edge) => ({ source: edge.source, target: edge.target, collapsed: isCollapsed(edge) })),
  )
}

/**
 * The canvas as the layout sees it: the boxes showing, and the arrows between
 * them. A folded branch takes no room, so Tab, ✦ Answer, a delete, the arrow
 * keys and Duplicate all work as if it weren't there.
 */
function showing(nodes: Node[], edges: Edge[], hidden: Set<string> = foldOf(nodes, edges).hidden) {
  return {
    nodes: nodes.filter((node) => !hidden.has(node.id)),
    boxes: nodes
      .filter((node) => !hidden.has(node.id))
      .map((node) => ({
        id: node.id,
        ...rectOf(node),
        detached: (node.data as FlowBoxNodeData).detached === true,
        shape: (node.data as FlowBoxNodeData).shape,
      })),
    edges: edges.filter(
      (edge) => !isCollapsed(edge) && !hidden.has(edge.source) && !hidden.has(edge.target),
    ),
  }
}

/**
 * Switchboard: whether `node` is joined into a branch the way Tab joins boxes — an
 * arrow from its right side to another's left, or one into its left — or was
 * detached from one: what the toolbar's Attached / Detached is for.
 */
function inBranch(node: Node, edges: Edge[]): boolean {
  if ((node.data as FlowBoxNodeData).detached) return true
  return edges.some(
    (edge) =>
      edge.sourceHandle === "right" &&
      edge.targetHandle === "left" &&
      (edge.source === node.id || edge.target === node.id),
  )
}

/** Switchboard: `node` back in its branch if it was detached — what adding to it does. */
function attached(node: Node): Node {
  const box = node.data as FlowBoxNodeData
  return box.detached ? { ...node, data: { ...box, detached: undefined } } : node
}

/** A node's folded branches and the unique nodes hidden behind them. */
type FoldBadge = { boxes: number; arrows: number; total: number }

function newEdgeId(): string {
  return `edge-${Math.random().toString(36).slice(2, 10)}`
}

function snap(value: number): number {
  return Math.round(value / SNAP_GRID[0]) * SNAP_GRID[0]
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  )
}

// ─────────────────────────────────────────────────────────────────────
// The editable box and arrow
// ─────────────────────────────────────────────────────────────────────

type EditorContextValue = {
  editingId: string | null
  /** Starts editing a box's text. */
  startEditing: (id: string) => void
  /** Stops editing `id` — and nothing else, if another box has taken over. */
  stopEditing: (id: string) => void
  updateNode: (id: string, patch: Partial<FlowBoxNodeData>, typing?: boolean) => void
  /** Asks for `id`'s second line to take focus once it is on screen. */
  requestDetailFocus: (id: string) => void
  /** True once for each request — the second line field's cue to focus. */
  takeDetailFocus: (id: string) => boolean
  /** The one arrow selected on its own — the only kind that gets a toolbar. */
  soleEdgeId: string | null
  updateEdge: (id: string, patch: Partial<FlowEdgeData>, typing?: boolean) => void
  reverseEdge: (id: string) => void
  deleteEdge: (id: string) => void
  /**
   * Called as a resize handle is pressed. The undo step is only taken once it
   * actually moves — a click on a handle changes nothing, so it shouldn't
   * throw away what redo could bring back.
   */
  startResize: () => void
  /**
   * The size a note, text or image is being dragged to: `done` false for
   * each step of the drag, true once it ends.
   */
  resize: (id: string, size: FlowSize, done: boolean) => void
  /** The one box selected on its own — the only one that gets resize handles. */
  soleNodeId: string | null
  /** False while the hand tool is out: nothing reacts to hovering then. */
  interactive: boolean
  /** Switchboard: the boxes whose ✦ Answers are being waited for. */
  answeringIds: ReadonlySet<string>
  /** Collapsed nodes keep their hidden-node count visible on the canvas. */
  folds: ReadonlyMap<string, FoldBadge>
  expandFold: (id: string) => void
}

// How the boxes and arrows reach the editor's state. A context rather than
// functions in node `data`, because data is part of what gets compared and
// saved.
const EditorContext = createContext<EditorContextValue | null>(null)

/**
 * Switchboard: what a pinned terminal's node needs from the editor and its host —
 * apart from EditorContext, so the rail's dots changing redraws only the terminals.
 */
type TerminalContextValue = {
  /** The rail's dot and branch for each workspace. */
  status: WorkspaceStatus
  /** Whether a terminal's workspace has left the rail (terminalGone). */
  gone: (wsId: string) => boolean
  /** The node's Float: the host lifts the terminal off the board. */
  float: (wsId: string) => void
  /** Minimize / Restore — an undoable canvas edit. */
  toggleMinimized: (id: string) => void
  /** Close — deletes the node, as Delete would. */
  close: (id: string) => void
  /** "Zoom in to use": to the zoom the terminal's type reads at, centred on it. */
  zoomTo: (id: string) => void
  /** A resize handle was pressed: the slot says so until the size is committed. */
  startResize: (id: string) => void
  /** The press ended without resizing anything: the slot stops saying so. */
  endResize: (id: string) => void
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

/**
 * Switchboard: workspaces pinned here that `over` — the choices the editor had at
 * the time — didn't list. See terminalGone.
 */
type FreshPins = { over: WorkspaceChoices | null; ids: ReadonlySet<string> }

/**
 * Switchboard: whether a pinned terminal's workspace has left the rail. One the
 * choices don't list, but that was pinned here since they came, is newer than them
 * rather than gone: the tray's + and ⌘A pick through the host, which asks main
 * itself and keeps what it heard, so a workspace added to the rail since the board
 * loaded can be floated and pinned before these choices know of it. It counts as in
 * the rail until main's next answer — asked for as it is pinned — replaces them,
 * and that answer has the last word.
 */
function terminalGone(wsId: string, choices: WorkspaceChoices | null, fresh: FreshPins): boolean {
  return workspaceGone(wsId, choices) && !(fresh.over === choices && fresh.ids.has(wsId))
}

// The text fields that stand in for a box's label and second line while you
// edit it. Enter or clicking away keeps the text, Escape puts the original
// back, and Shift+Enter starts a new line. Enter continues a bullet list (the
// second line itself is added from the text toolbar). In lists, Tab and
// Shift+Tab change indentation; otherwise the canvas handles them.
function TextEditor({
  id,
  box,
  editor,
}: {
  id: string
  box: FlowBoxNodeData
  editor: EditorContextValue
}) {
  // The AI's mark too: Escape puts the AI's words back, and with them the mark
  // that says they are the AI's.
  // Switchboard: and the workspace that answer read, which goes and comes with it.
  const [original] = useState(() => ({
    label: box.label, detail: box.detail, ai: box.ai, answeredIn: box.answeredIn,
    labelRichText: box.labelRichText, detailRichText: box.detailRichText,
    bold: box.bold, italic: box.italic,
  }))
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selectedOnce = useRef(false)

  // Focus lands on the second line as it mounts, when it was asked for — a
  // field that has only just been added isn't there to focus until then.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return
    // Shift+Enter is left to the field, which starts a new line; ⌘↵ to the
    // canvas, which finishes the edit and answers the box — and needs this
    // field still on the page to know it came from one. Anything else with
    // Enter finishes the edit.
    const command = event.metaKey || event.ctrlKey
    const answerKey = command && !event.shiftKey && !event.altKey
    const newLine = event.shiftKey && !command
    if (event.key === "Enter" && !answerKey && !newLine) {
      event.preventDefault()
      editor.stopEditing(id)
    } else if (event.key === "Escape") {
      event.preventDefault()
      // Keeps Escape from also leaving full screen.
      event.stopPropagation()
      editor.updateNode(id, original, true)
      editor.stopEditing(id)
    }
  }

  const align = cx(
    box.align === "left" ? "text-left" : box.align === "right" ? "text-right" : "text-center",
  )
  // The box is the field — none of the forms plugin's border, padding or
  // focus ring.
  const field = cx(
    "nodrag nopan nowheel w-full border-0 bg-transparent p-0 outline-none focus:[box-shadow:none]",
    // Wrapped exactly as the box draws it, so nothing jumps when typing ends.
    FLOW_TEXT_WRAP,
  )

  return (
    <div
      ref={containerRef}
      className="flex w-full flex-col"
      // Moving between the label and the second line is still editing;
      // anywhere else ends it. (The toolbar's buttons never take focus.)
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof globalThis.Node && containerRef.current?.contains(next)) return
        editor.stopEditing(id)
      }}
    >
      <RichTextField
        autoFocus
        text={box.label}
        richText={box.labelRichText}
        bold={box.bold}
        italic={box.italic}
        placeholder={placeholderFor(box.shape)}
        label={isText(box) ? "Text" : box.shape === "note" ? "Note" : "Box label"}
        field="label"
        // Selected once, on the way in, so typing replaces a starter label —
        // but not again when you come back up from the second line.
        selectOnFocus={() => {
          if (selectedOnce.current) return false
          selectedOnce.current = true
          return true
        }}
        onChange={(label, labelRichText, typing) =>
          editor.updateNode(id, { label, labelRichText, bold: false, italic: false }, typing)
        }
        onKeyDown={onKeyDown}
        className={cx(field, align, flowLabelClass(box))}
        style={flowLabelStyle(box)}
      />
      {box.detail !== undefined ? (
        <RichTextField
          focusOnMount={() => editor.takeDetailFocus(id)}
          text={box.detail}
          richText={box.detailRichText}
          placeholder={DETAIL_PLACEHOLDER}
          label="Second line"
          field="detail"
          onChange={(detail, detailRichText, typing) =>
            editor.updateNode(id, { detail, detailRichText }, typing)
          }
          onKeyDown={onKeyDown}
          className={cx(field, align, "mt-0.5 text-[11px] leading-4 opacity-60")}
        />
      ) : null}
    </div>
  )
}

// The handles that resize a note, a text or an image while it is selected:
// all four corners and edges for a note, keeping its proportions for an
// image, and only the sides for a text, whose height follows its lines.
function Resizer({
  id,
  box,
  editor,
}: {
  id: string
  box: FlowBoxNodeData
  editor: EditorContextValue
}) {
  // Kept the same between renders: the resize controls rebuild their drag
  // handling whenever these change, which every step of a resize would
  // otherwise do — and a touch drag doesn't survive that.
  const { startResize, resize } = editor
  const handles = useMemo(
    () => ({
      onResizeStart: () => startResize(),
      onResize: (_: unknown, size: FlowSize) =>
        resize(id, { width: size.width, height: size.height }, false),
      onResizeEnd: (_: unknown, size: FlowSize) =>
        resize(id, { width: size.width, height: size.height }, true),
    }),
    [id, startResize, resize],
  )
  // React Flow draws its resize lines 1px wide, which is all but impossible
  // to grab; the invisible ::after widens what the pointer can catch without
  // changing what is drawn.
  const lineClassName = "!border-brand after:absolute after:-inset-1 after:content-['']"
  const handleClassName = "!size-2.5 !rounded-[3px] !border-[1.5px] !border-brand !bg-white"

  if (isText(box)) {
    // Only ever wider or narrower — a text's height follows its lines. Its
    // bottom corners carry handles as well as its sides, because the middle of
    // each short side is taken by the dot an arrow is drawn from. (Not the top
    // ones: React Flow moves a box dragged by a top control up and down with
    // the pointer, height or no height.)
    const controls = [
      ["left", ResizeControlVariant.Line],
      ["right", ResizeControlVariant.Line],
      ["bottom-left", ResizeControlVariant.Handle],
      ["bottom-right", ResizeControlVariant.Handle],
    ] as const
    return (
      <>
        {controls.map(([position, variant]) => (
          <NodeResizeControl
            key={position}
            position={position}
            variant={variant}
            resizeDirection="horizontal"
            minWidth={FLOW_TEXT_MIN_WIDTH}
            maxWidth={FLOW_SIZE_MAX}
            className={variant === ResizeControlVariant.Line ? lineClassName : handleClassName}
            {...handles}
          />
        ))}
      </>
    )
  }
  return (
    <NodeResizer
      isVisible
      keepAspectRatio={box.shape === "image"}
      minWidth={box.shape === "image" ? 24 : 80}
      minHeight={box.shape === "image" ? 24 : 48}
      maxWidth={FLOW_SIZE_MAX}
      maxHeight={FLOW_SIZE_MAX}
      lineClassName={lineClassName}
      handleClassName={handleClassName}
      {...handles}
    />
  )
}

// Switchboard: a pinned terminal is a node of its own kind — a different component,
// so a node that changes kind across an undo is mounted afresh rather than handed
// the other's hooks.
function EditableFlowNode(props: NodeProps) {
  return (props.data as FlowBoxNodeData).shape === "terminal" ? (
    <TerminalNode id={props.id} box={props.data as FlowBoxNodeData} selected={Boolean(props.selected)} />
  ) : (
    <EditableBoxNode {...props} />
  )
}

/**
 * Switchboard: a terminal pinned to the board — the frame the host lays the live
 * terminal into. A header that drags it (the rail's dot, the workspace, its branch,
 * then Float, Minimize or Restore, and Close), and under it a dark body the live
 * terminal covers, inset a few pixels so the resize handles stay reachable. When
 * the terminal can't be shown there the body says why: its type would be too small
 * to read at this zoom ("Zoom in to use"), or its workspace has left the rail.
 */
function TerminalNode({ id, box, selected }: { id: string; box: FlowBoxNodeData; selected: boolean }) {
  const editor = useContext(EditorContext)
  const terminal = useContext(TerminalContext)
  const zoom = useStore((state) => state.transform[2])
  const connecting = useConnection((connection) => connection.inProgress)
  const selectionRect = useStore((state) => state.nodesSelectionActive)
  const interactive = editor?.interactive ?? true
  const workspace = box.workspace ?? box.label
  const gone = terminal?.gone(workspace) ?? false
  const minimized = box.minimized === true
  const tooSmall = (box.font ?? TERMINAL_BASE_FONT) * zoom < TERMINAL_MIN_FONT
  const status = terminal?.status[workspace]
  const resizable =
    editor !== null &&
    selected &&
    editor.soleNodeId === id &&
    !selectionRect &&
    !connecting &&
    !minimized &&
    !gone
  // The body's cards are drawn at screen size whatever the zoom — they show at
  // all only when the board is zoomed out, where canvas-sized words can't be read.
  const unscale = Math.min(1 / Math.max(zoom, 0.01), 4)
  // A button in the header: never a drag, nor a click on the node beneath it.
  const action = (label: string, run: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!interactive}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        run()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cx("nodrag nopan flow-terminal-btn", focusRing)}
    >
      {icon}
    </button>
  )

  return (
    <div
      className={cx("relative size-full", interactive && "group")}
      data-terminal-node={workspace}
      role="group"
      aria-label={`${workspace} terminal`}
    >
      <div className="flow-terminal-node flow-terminal-card-frame">
        {/* As the floating panels' headers are: the workspace, its branch, the
            rail's dot, then the buttons. */}
        <div className="flow-terminal-head" style={{ height: TERMINAL_HEADER }}>
          <RiTerminalBoxLine className="size-3.5 shrink-0 text-[#0969da]" aria-hidden="true" />
          <b>{workspace}</b>
          {status?.branch ? <small>{status.branch}</small> : null}
          <TerminalDot dot={status?.dot} />
          <span className="flow-terminal-actions">
            {gone || !terminal
              ? null
              : action(`Float ${workspace} over the whiteboard`, () => terminal.float(workspace), (
                  <RiPictureInPictureExitLine className="size-3.5" aria-hidden="true" />
                ))}
            {gone || !terminal
              ? null
              : action(minimized ? `Restore ${workspace}` : `Minimize ${workspace}`, () => terminal.toggleMinimized(id), (
                  minimized ? (
                    <RiArrowUpSLine className="size-4" aria-hidden="true" />
                  ) : (
                    <RiSubtractLine className="size-3.5" aria-hidden="true" />
                  )
                ))}
            {terminal
              ? action(`Close ${workspace}`, () => terminal.close(id), <RiCloseLine className="size-3.5" aria-hidden="true" />)
              : null}
          </span>
        </div>
        {minimized ? null : gone ? (
          <div className="flow-terminal-body flow-terminal-card">
            <p style={{ transform: `scale(${unscale})` }}>{workspace} is no longer in the rail</p>
          </div>
        ) : tooSmall ? (
          <div className="flow-terminal-body flow-terminal-card">
            <button
              type="button"
              disabled={!interactive || !terminal}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                terminal?.zoomTo(id)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              style={{ transform: `scale(${unscale})` }}
              className={cx("nodrag nopan flow-terminal-zoom", focusRing)}
            >
              <RiZoomInLine className="size-4" aria-hidden="true" />
              Zoom in to use
            </button>
          </div>
        ) : (
          // Where the host lays the live terminal; dark beneath it, so nothing
          // flashes while it moves in.
          <div className="flow-terminal-body" data-terminal-body={workspace}>
            <RiTerminalBoxLine className="flow-terminal-watermark" aria-hidden="true" />
          </div>
        )}
      </div>
      {resizable ? <TerminalResizer id={id} size={box.size} editor={editor} /> : null}
      <div
        aria-hidden="true"
        className={cx(
          "pointer-events-none absolute -inset-1 rounded-[13px] border-2 transition-opacity",
          selected ? "border-brand opacity-100" : "border-brand/40 opacity-0 group-hover:opacity-100",
        )}
      />
      {editor !== null && (editor.folds.get(id)?.arrows ?? 0) > 0 ? (
        <FoldButton
          fold={editor.folds.get(id)!}
          label={workspace}
          disabled={!interactive}
          onClick={() => editor.expandFold(id)}
        />
      ) : null}
      {FLOW_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={FLOW_SIDE_POSITIONS[side]}
          style={HANDLE_STYLE}
          className={cx(
            "transition-opacity",
            selected || connecting ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        />
      ))}
    </div>
  )
}

/**
 * Switchboard: a pinned terminal's resize handles — every edge and corner, no
 * proportions kept, never smaller than a header and a few rows. Its size is only
 * written once the handle is let go; until then React Flow resizes the node, and
 * the host holds the live terminal's size still (TerminalSlot.resizing). One pinned
 * at a high zoom can already be smaller than that: it keeps its size as the least,
 * rather than jumping up to the minimum the moment a handle is touched.
 */
function TerminalResizer({ id, size, editor }: { id: string; size: FlowSize | undefined; editor: EditorContextValue }) {
  const terminal = useContext(TerminalContext)
  const { startResize, resize } = editor
  const begin = terminal?.startResize
  const end = terminal?.endResize
  // Whether this press of a handle has changed the size yet.
  const movedRef = useRef(false)
  const handles = useMemo(
    () => ({
      onResizeStart: () => {
        startResize()
        begin?.(id)
        // React Flow calls onResizeStart as a handle is pressed, but onResizeEnd only
        // after a drag that changed the size: a press let go where it was (or a
        // jiggle the grid snaps back) ends no resize, and the slot would go on saying
        // "resizing" — the host holding the shell's size — until a real one. So the
        // press's own release ends it when nothing moved (and a cancelled pointer
        // always). Released after a move, onResizeEnd commits the size and ends it.
        movedRef.current = false
        const release = (event: PointerEvent) => {
          window.removeEventListener("pointerup", release, true)
          window.removeEventListener("pointercancel", release, true)
          if (!movedRef.current || event.type === "pointercancel") end?.(id)
        }
        window.addEventListener("pointerup", release, true)
        window.addEventListener("pointercancel", release, true)
      },
      onResize: (_: unknown, size: FlowSize) => {
        movedRef.current = true
        resize(id, { width: size.width, height: size.height }, false)
      },
      onResizeEnd: (_: unknown, size: FlowSize) =>
        resize(id, { width: size.width, height: size.height }, true),
    }),
    [id, startResize, resize, begin, end],
  )
  return (
    <NodeResizer
      isVisible
      minWidth={clampNumber(size?.width ?? Infinity, FLOW_TERMINAL_FLOOR.width, FLOW_TERMINAL_MIN_SIZE.width)}
      minHeight={clampNumber(size?.height ?? Infinity, FLOW_TERMINAL_FLOOR.height, FLOW_TERMINAL_MIN_SIZE.height)}
      maxWidth={FLOW_SIZE_MAX}
      maxHeight={FLOW_SIZE_MAX}
      lineClassName="!border-brand after:absolute after:-inset-1 after:content-['']"
      handleClassName="!size-2.5 !rounded-[3px] !border-[1.5px] !border-brand !bg-white"
      {...handles}
    />
  )
}

function EditableBoxNode({ id, data, selected }: NodeProps) {
  const box = data as FlowBoxNodeData
  const editor = useContext(EditorContext)
  // Every box shows its dots while an arrow is being drawn, so you can see
  // where it can land.
  const connecting = useConnection((connection) => connection.inProgress)
  const editing = editor !== null && editor.editingId === id
  const interactive = editor?.interactive ?? true
  // Not under the rectangle a drag-select leaves over the selection either:
  // it sits on top of the boxes and would swallow the handles.
  const selectionRect = useStore((state) => state.nodesSelectionActive)
  const resizable =
    editor !== null &&
    selected &&
    editor.soleNodeId === id &&
    !selectionRect &&
    !editing &&
    !connecting &&
    (box.shape === "note" || box.shape === "text" || box.shape === "image")

  return (
    <div className={cx("relative size-full", interactive && "group")}>
      <FlowBox
        {...box}
        label={box.label.trim() || box.shape === "note" ? box.label : UNTITLED_FLOW_LABEL}
        labelOverride={
          editing ? <TextEditor id={id} box={box} editor={editor} /> : undefined
        }
        onToggleCheck={editor && interactive ? (field, index) => {
          const key = field === "label" ? "labelRichText" : "detailRichText"
          const rich = box[key]
          if (!rich || rich[index]?.checked === undefined) return
          editor.updateNode(id, { [key]: rich.map((paragraph, position) => position === index ? { ...paragraph, checked: !paragraph.checked } : paragraph) })
        } : undefined}
      />
      {resizable ? <Resizer id={id} box={box} editor={editor} /> : null}
      {/* The selection outline sits OUTSIDE the box rather than being a ring
          on it: a diamond is clipped out of its box, and would clip its own
          ring away with it. */}
      <div
        aria-hidden="true"
        className={cx(
          "pointer-events-none absolute -inset-1 rounded-[10px] border-2 transition-opacity",
          selected
            ? "border-brand opacity-100"
            : "border-brand/40 opacity-0 group-hover:opacity-100",
        )}
      />
      {editor !== null && (editor.folds.get(id)?.arrows ?? 0) > 0 ? (
        <FoldButton
          fold={editor.folds.get(id)!}
          label={box.label}
          disabled={!interactive}
          onClick={() => editor.expandFold(id)}
        />
      ) : null}
      {editor !== null && editor.answeringIds.has(id) ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 animate-pulse rounded-xl border-2 border-violet-400 dark:border-violet-500"
        />
      ) : null}
      {/* One dot per side, outside the (clippable) box for the same reason.
          All "source" handles: the canvas runs in loose connection mode, so an
          arrow can start on any of them and land on any other. */}
      {FLOW_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={FLOW_SIDE_POSITIONS[side]}
          style={HANDLE_STYLE}
          className={cx(
            "transition-opacity",
            selected || connecting
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100",
          )}
        />
      ))}
    </div>
  )
}

// React Flow's own smoothstep edge, plus the arrow's toolbar floating over its
// midpoint while it is the only thing selected.
function EditableFlowEdge(props: EdgeProps) {
  const editor = useContext(EditorContext)
  // The same path the edge draws (the default radius and offset), for the
  // point its label sits on.
  const [, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  })

  return (
    <>
      <SmoothStepEdge {...props} />
      {editor !== null && editor.soleEdgeId === props.id ? (
        <EdgeToolbar
          edgeId={props.id}
          x={labelX}
          y={labelY}
          alignY="bottom"
          isVisible
          className="nodrag nopan nowheel"
          // Above the label rather than on it; the gap lets clicks through.
          style={{ pointerEvents: "none", paddingBottom: 18 }}
        >
          <EdgeBar id={props.id} line={props.data as FlowEdgeData} editor={editor} />
        </EdgeToolbar>
      ) : null}
    </>
  )
}

const EDITOR_NODE_TYPES = { [EDIT_NODE_TYPE]: EditableFlowNode }
const EDITOR_EDGE_TYPES = { [EDIT_EDGE_TYPE]: EditableFlowEdge }

// ─────────────────────────────────────────────────────────────────────
// The editor
// ─────────────────────────────────────────────────────────────────────

export type FlowEditorHandle = {
  /** Writes anything not yet saved; resolves once it has been. */
  flush: () => Promise<void>
  // Switchboard: Edit ▸ Undo, Redo and Paste are menu items there, whose accelerators
  // win over the page's keydown — so ⌘Z never reaches the canvas as a keystroke, and
  // ⌘V never as a paste event. views/diagrams.js hands them in through these.
  undo: () => void
  redo: () => void
  paste: (files: File[]) => void
  /**
   * Switchboard: Edit ▸ Copy, Cut and Paste over the canvas, for boxes — false when
   * there is nothing of the canvas's for them to do (no box selected; text on the
   * clipboard that isn't a copy of boxes), which leaves them to the rest of the app.
   */
  copy: () => boolean
  cut: () => boolean
  pasteBoxes: (text: string) => boolean
  /** Switchboard: the diagram as the canvas now holds it — what Rename writes. */
  currentSpec: () => FlowSpec
  /**
   * Switchboard: pins `wsId`'s terminal to the board, as a node whose outer client
   * rect is `rect` (the floating panel's), so nothing on screen moves: placed at
   * the canvas point under its top-left corner, sized `rect` over the zoom, its type
   * 12.5px over the zoom. Given `body` — where the live terminal sits in the panel,
   * in client pixels — the node is placed and sized instead so that its slot's body
   * is exactly `body`, and the text doesn't move at all. Either way it keeps the
   * panel's size on screen, even where that is less than a hand resize allows. One
   * undo step. A node for `wsId` already there is revealed instead, and false returned.
   */
  pinTerminal: (wsId: string, rect: ClientRect, body?: ClientRect | null) => boolean
  /**
   * Switchboard: takes `wsId`'s terminal off the board (one undo step), returning the
   * node's outer client rect at that moment — where the floating panel goes — or null
   * when there is no such node.
   */
  unpinTerminal: (wsId: string) => ClientRect | null
  /** Switchboard: brings `wsId`'s node into view, restored if it was minimized, and selects it. */
  revealTerminal: (wsId: string) => boolean
  /** Switchboard: the pinned terminals' geometry now, for a host that can't wait for the next report. */
  terminalSlots: () => TerminalSlot[]
}

type Props = {
  /** Read once, on mount — key the editor to load a different spec. */
  spec: FlowSpec
  /** Writes a spec. Resolves to null when it saved, or the error to show. */
  onSave: (spec: FlowSpec) => Promise<string | null>
  /** False while a menu or dialog owns the keyboard. */
  keyboardEnabled: boolean
  /**
   * Switchboard: whether the Diagrams tab is on screen. The Google Images panel
   * makes its page again as the tab comes back (ImageSearchPanel.tsx says why).
   */
  shown?: boolean
  /** Changes when the pane is resized from outside (full screen), to re-fit. */
  fitKey: string
  /** Switchboard: which whiteboard this is — identity only, for keys and logs. */
  boardId: string
  /** The diagram's name — part of what ✦ Answer tells the model. */
  diagramName?: string
  /**
   * Switchboard: the workspace ✦ Answer's CLIs read for this whiteboard (the board's
   * own, kept by the host), or null when it has none yet.
   */
  answerWorkspace: string | null
  /** Switchboard: the rail's workspaces, for the Workspace row's picker; null while loading. */
  workspaceChoices: WorkspaceChoices | null
  /** Switchboard: a workspace picked in the Workspace row. The host keeps it on the board. */
  onAnswerWorkspaceChange: (wsId: string) => void
  /** Switchboard: where a failed answer sends you to fix it. */
  onOpenSettings?: () => void
  /** Switchboard: a terminal in `wsId` (to sign a CLI in), floated over the board. */
  onOpenTerminal: (wsId: string) => void
  /** Switchboard: the rail's dot and branch for each workspace, for pinned terminals' headers. */
  workspaceStatus: WorkspaceStatus
  /**
   * Switchboard: where the pinned terminals are, in client pixels — called at most
   * once a frame, only when something changed, and with [] as the editor goes.
   */
  onTerminalSlots: (slots: TerminalSlot[]) => void
  /** Switchboard: a pinned terminal's Float, pressed. The host calls unpinTerminal. */
  onTerminalFloat: (wsId: string) => void
  /**
   * Switchboard: a pinned terminal left the board other than through unpinTerminal —
   * "undo" when undo or redo took it away, "delete" for Delete, Cut or its Close —
   * with its outer client rect just before.
   */
  onTerminalRemoved: (wsId: string, reason: "undo" | "delete", rect: ClientRect) => void
  /**
   * Switchboard: in place of the admin's beforeunload, which Electron answers by
   * silently refusing to close the window. Main asks the page to save before a close
   * or a quit instead, and needs to know there is something to save.
   */
  onDirtyChange?: (dirty: boolean) => void
  ref?: React.Ref<FlowEditorHandle>
}

export function FlowEditor({ ref, ...props }: Props) {
  // useReactFlow (screen → canvas coordinates for a drop) needs the provider
  // ABOVE the component that calls it.
  return (
    <ReactFlowProvider>
      <FlowEditorCanvas {...props} editorRef={ref} />
    </ReactFlowProvider>
  )
}

function FlowEditorCanvas({
  spec,
  onSave,
  keyboardEnabled,
  shown = true,
  fitKey,
  boardId,
  diagramName,
  answerWorkspace,
  workspaceChoices,
  onAnswerWorkspaceChange,
  onOpenSettings,
  onOpenTerminal,
  workspaceStatus,
  onTerminalSlots,
  onTerminalFloat,
  onTerminalRemoved,
  onDirtyChange,
  editorRef,
}: Omit<Props, "ref"> & { editorRef?: React.Ref<FlowEditorHandle> }) {
  const { screenToFlowPosition, deleteElements, getViewport, setViewport, setCenter, getNodesBounds } =
    useReactFlow()
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // Switchboard: the whole editor — the canvas and the panels beside or over it —
  // where the canvas's own floating UI is looked for (TerminalSlot.covered).
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Switchboard: the rail's workspaces. The rail may have changed since the host last
  // asked, so each picker that opens asks main again — and what main said stands
  // until the host hands over something newer.
  const [fetchedChoices, setFetchedChoices] = useState<{ over: WorkspaceChoices | null; data: WorkspaceChoices } | null>(null)
  const choices = fetchedChoices !== null && fetchedChoices.over === workspaceChoices ? fetchedChoices.data : workspaceChoices
  const choicesPropRef = useRef(workspaceChoices)
  useEffect(() => {
    choicesPropRef.current = workspaceChoices
  })
  const refreshChoices = useCallback(() => {
    const over = choicesPropRef.current
    void call("whiteboardsWorkspaces").then((result) => {
      if (result.ok && choicesPropRef.current === over) setFetchedChoices({ over, data: result.data })
    })
  }, [])
  // Switchboard: the board's workspace for ✦ Answer, and whether it has left the rail.
  const answerWorkspaceGone = workspaceGone(answerWorkspace, choices)
  // Switchboard: workspaces pinned since the choices came that they don't list
  // (terminalGone). In a ref as well, for the slots, which are worked out between
  // renders — set at once by pinTerminal, before the slot it schedules.
  const [freshPins, setFreshPins] = useState<FreshPins>(() => ({ over: null, ids: new Set() }))
  const freshPinsRef = useRef(freshPins)

  // The parts of the spec the canvas doesn't show (title, summary, direction)
  // ride along untouched into every save.
  const [meta] = useState<FlowSpecMeta>(() => ({
    title: spec.title,
    summary: spec.summary,
    direction: spec.direction,
  }))
  const [initial] = useState(() => toCanvas(spec))
  const [nodes, setNodes] = useState<Node[]>(initial.nodes)
  const [edges, setEdges] = useState<Edge[]>(initial.edges)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [documentNodeId, setDocumentNodeId] = useState<string | null>(null)
  const [documentView, setDocumentView] = useState<DocumentView>("floating")
  const [documentStartsWriting, setDocumentStartsWriting] = useState(false)
  const documentNode = nodes.find((node) => node.id === documentNodeId && (node.data as FlowBoxNodeData).shape === "document")
  const documentBox = documentNode?.data as FlowBoxNodeData | undefined
  // Switchboard: one store of documents for every whiteboard, keyed by document id.
  const documents = useFlowDocuments(documentBox?.documentId)
  const documentsFlush = documents.flush
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const [tool, setTool] = useState<Tool>("select")
  // Which box the shape tool places — the last one picked from its menu.
  const [shapeChoice, setShapeChoice] = useState<FlowBoxShape>("rounded")

  // ✦ Answer. Switchboard: any number at once, one per box — `askings` are
  // the answers being waited for, oldest first (the box that asked, and what
  // it asked with), `askRef` the box and the way to cancel each, by serial.
  const answerStatus = useAnswerStatus()
  const [askings, setAskings] = useState<Asking[]>([])
  const askRef = useRef(new Map<number, { id: string; controller: AbortController; selectedIds?: string[] }>())
  const answeringIds = useMemo(
    () => new Set(askings.flatMap((entry) => entry.selectedIds ?? [entry.id])),
    [askings],
  )
  // Counts the answers asked for, to tell one wait from the next.
  const askCountRef = useRef(0)
  // How many boxes the last answer added, while "· Undo" is offered for it.
  const [answered, setAnswered] = useState<number | null>(null)
  // Switchboard: what each CLI has done so far for the answer being waited for (by
  // serial), how the last answer went, and why the last one didn't come.
  const [steps, setSteps] = useState<Record<number, AnswerStep[]>>({})
  const [answerNote, setAnswerNote] = useState<AnswerNote | null>(null)
  const [failure, setFailure] = useState<AnswerFailure | null>(null)
  // Leaving the diagram cancels every answer still on its way — upstream too.
  useEffect(() => {
    const running = askRef.current
    return () => {
      const controllers = [...running.values()].map((run) => run.controller)
      running.clear()
      for (const controller of controllers) controller.abort()
    }
  }, [])
  useEffect(() => {
    if (answered === null) return
    const timer = setTimeout(() => setAnswered(null), ANSWERED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [answered])
  const placing = tool === "shape" || tool === "note" || tool === "text" || tool === "document"
  // For an upload landing later, which mustn't act on the tool it started with.
  const toolRef = useRef(tool)
  useEffect(() => {
    toolRef.current = tool
  })
  const [uploading, setUploading] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Cancels the uploads still running when the editor goes away (another
  // diagram, another tab), rather than letting them finish into nothing.
  const uploadsRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    uploadsRef.current = controller
    return () => controller.abort()
  }, [])
  // Switchboard: Google Images, in the panel beside the canvas — whether it is
  // open, and what it was last asked to show. The image tool's menu (a file, or
  // Google Images) is open while `imageMenu` is.
  const [imagesOpen, setImagesOpen] = useState(false)
  const [imagesAsk, setImagesAsk] = useState<ImageSearchAsk>({ query: null, serial: 0 })
  const [imageMenu, setImageMenu] = useState(false)
  // Switchboard: the soft ring round the canvas while a picture is dragged over
  // it. Counted, because dragenter and dragleave fire for every element crossed
  // inside the canvas, not only at its edge.
  const [dropping, setDropping] = useState(false)
  const dragDepthRef = useRef(0)

  const json = useMemo(() => canvasJson(meta, nodes, edges), [meta, nodes, edges])
  const dragging = nodes.some((node) => node.dragging)

  // Kept current for the handlers and for the unmount flush, which must see
  // the latest canvas rather than the one they closed over — and for an
  // image upload, which finishes long after the render that started it.
  const latestRef = useRef(json)
  const onSaveRef = useRef(onSave)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  // Switchboard: the host's callbacks and the rail's workspaces, for the terminal
  // slots, which are worked out between renders.
  const onTerminalSlotsRef = useRef(onTerminalSlots)
  const onTerminalRemovedRef = useRef(onTerminalRemoved)
  const choicesRef = useRef(choices)
  // Switchboard: the handle's terminal calls, pointed at this render's functions.
  const terminalsRef = useRef<{
    pin: (wsId: string, rect: ClientRect, body?: ClientRect | null) => boolean
    unpin: (wsId: string) => ClientRect | null
    reveal: (wsId: string) => boolean
    slots: () => TerminalSlot[]
  }>({ pin: () => false, unpin: () => null, reveal: () => false, slots: () => [] })
  useEffect(() => {
    latestRef.current = json
    onSaveRef.current = onSave
    nodesRef.current = nodes
    edgesRef.current = edges
    onTerminalSlotsRef.current = onTerminalSlots
    onTerminalRemovedRef.current = onTerminalRemoved
    choicesRef.current = choices
  })

  // ─── saving ───

  // The canvas as first laid out counts as saved, even when the stored spec
  // had no positions yet — merely opening a diagram shouldn't write to it.
  const [savedJson, setSavedJson] = useState(json)
  const savedRef = useRef(json)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  // Saves are chained, so they run one at a time and in order. Each checks
  // against what was last saved when its turn comes, which is what makes a
  // flush queued behind an identical save a no-op.
  const enqueueSave = useCallback((next: string) => {
    chainRef.current = chainRef.current.then(async () => {
      if (next === savedRef.current) return
      setSaving(true)
      let error: string | null
      try {
        error = await onSaveRef.current(JSON.parse(next) as FlowSpec)
      } catch (err) {
        error = err instanceof Error ? err.message : "Save failed"
      }
      setSaving(false)
      setSaveError(error)
      if (error === null) {
        savedRef.current = next
        setSavedJson(next)
      }
    })
    return chainRef.current
  }, [])

  const flush = useCallback(async () => {
    await documentsFlush()
    await enqueueSave(latestRef.current)
  }, [enqueueSave, documentsFlush])
  useImperativeHandle(
    editorRef,
    () => ({
      flush,
      // Read at the moment they are called, by which time the ref holds this render's.
      undo: () => shortcutsRef.current.undo(),
      redo: () => shortcutsRef.current.redo(),
      paste: (files: File[]) => shortcutsRef.current.paste(files),
      copy: () => shortcutsRef.current.copy(),
      cut: () => shortcutsRef.current.cut(),
      pasteBoxes: (text: string) => shortcutsRef.current.pasteBoxes(text),
      currentSpec: () => JSON.parse(latestRef.current) as FlowSpec,
      pinTerminal: (wsId: string, rect: ClientRect, body?: ClientRect | null) =>
        terminalsRef.current.pin(wsId, rect, body),
      unpinTerminal: (wsId: string) => terminalsRef.current.unpin(wsId),
      revealTerminal: (wsId: string) => terminalsRef.current.reveal(wsId),
      terminalSlots: () => terminalsRef.current.slots(),
    }),
    [flush],
  )

  useEffect(() => {
    if (dragging || json === savedJson) return
    const timer = setTimeout(() => void enqueueSave(json), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [json, savedJson, dragging, enqueueSave])

  // Switchboard: told whether there is anything unsaved, in place of a beforeunload.
  const onDirtyRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyRef.current = onDirtyChange
  })

  // Switching diagram, switching tab or leaving the page unmounts the editor;
  // whatever the debounce was still holding goes out now rather than never.
  useEffect(
    () => () => {
      void flush().finally(() => onDirtyRef.current?.(false))
    },
    [flush],
  )

  // A picture still uploading is a change not yet saved, too.
  const dirty = json !== savedJson || saving || uploading > 0 || documents.dirty
  useEffect(() => {
    onDirtyRef.current?.(dirty)
  }, [dirty])

  // ─── undo ───

  const [past, setPast] = useState<string[]>([])
  const [future, setFuture] = useState<string[]>([])
  const lastRecordAt = useRef(0)

  // Called by every handler just BEFORE it changes the diagram. `typing`
  // folds a burst of keystrokes into the step that began it.
  const record = useCallback((typing = false) => {
    // "3 answers added · Undo" would now undo this change instead.
    setAnswered(null)
    const now = Date.now()
    const coalesce = typing && now - lastRecordAt.current < UNDO_COALESCE_MS
    lastRecordAt.current = now
    if (coalesce) return
    const snapshot = latestRef.current
    setPast((stack) =>
      stack[stack.length - 1] === snapshot
        ? stack
        : [...stack.slice(-(UNDO_LIMIT - 1)), snapshot],
    )
    setFuture([])
  }, [setAnswered])

  // ─── text editing ───

  const store = useStoreApi()

  // ─── Switchboard: where the pinned terminals are ───

  // The pane React Flow draws in, on screen — what canvas coordinates are offset from.
  const paneBounds = useCallback((): DOMRect | null => {
    const pane = store.getState().domNode ?? wrapperRef.current
    return pane ? pane.getBoundingClientRect() : null
  }, [store])

  // A node's outer rect on screen now: its canvas rect through the viewport.
  const clientRectOf = useCallback((node: Node): ClientRect => {
    const pane = paneBounds()
    const [x, y, zoom] = store.getState().transform
    const rect = rectOf(node)
    return {
      left: roundTo((pane?.left ?? 0) + rect.x * zoom + x),
      top: roundTo((pane?.top ?? 0) + rect.y * zoom + y),
      width: roundTo(rect.width * zoom),
      height: roundTo(rect.height * zoom),
    }
  }, [paneBounds, store])

  // Every pinned terminal's slot (TerminalSlot): worked out from the canvas as it
  // is this moment — the nodes, the view, the pane on screen — never from a render.
  const computeSlots = useCallback((): TerminalSlot[] => {
    const terminals = nodesRef.current.filter(isTerminal)
    if (terminals.length === 0) return []
    const pane = paneBounds()
    // Hidden (a board not on screen, a Grid square folded away): nowhere to lay a
    // terminal, so none is live until the pane is back.
    const laidOut = pane !== null && pane.width > 0 && pane.height > 0
    const [x, y, zoom] = store.getState().transform
    const { hidden } = foldOf(nodesRef.current, edgesRef.current)
    const overlays = laidOut
      ? [...(rootRef.current?.querySelectorAll(CANVAS_OVERLAY_SELECTOR) ?? [])]
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
      : []
    // The rail, the undo bar and the zoom controls float over the board in a
    // terminal's place too: they stay on top of its live overlay, through holes.
    const chrome = laidOut
      ? [...(store.getState().domNode?.querySelectorAll(CANVAS_CHROME_SELECTOR) ?? [])]
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
      : []
    return terminals.map((node) => {
      const box = node.data as FlowBoxNodeData
      const wsId = terminalWorkspace(node)
      const rect = rectOf(node)
      const left = (pane?.left ?? 0) + rect.x * zoom + x
      const top = (pane?.top ?? 0) + rect.y * zoom + y
      const header = TERMINAL_HEADER * zoom
      const body: ClientRect = {
        left: roundTo(left + TERMINAL_BODY_INSET),
        top: roundTo(top + header),
        width: roundTo(Math.max(0, rect.width * zoom - TERMINAL_BODY_INSET * 2)),
        height: roundTo(Math.max(0, rect.height * zoom - header - TERMINAL_BODY_INSET)),
      }
      const font = roundTo((box.font ?? TERMINAL_BASE_FONT) * zoom, 3)
      const minimized = box.minimized === true
      const size = box.size ?? FLOW_TERMINAL_DEFAULT_SIZE
      return {
        wsId,
        nodeId: node.id,
        body,
        clip: {
          left: roundTo(pane?.left ?? 0),
          top: roundTo(pane?.top ?? 0),
          right: roundTo(pane?.right ?? 0),
          bottom: roundTo(pane?.bottom ?? 0),
        },
        zoom: roundTo(zoom, 4),
        size: { width: size.width, height: size.height },
        font,
        minimized,
        selected: Boolean(node.selected),
        resizing: terminalResizingRef.current === node.id,
        covered: !minimized && overlays.some((overlay) => intersects(body, overlay)),
        holes: chrome.flatMap((rect) => overlap(body, rect) ?? []),
        live:
          laidOut &&
          !minimized &&
          !hidden.has(node.id) &&
          !terminalGone(wsId, choicesRef.current, freshPinsRef.current) &&
          font >= TERMINAL_MIN_FONT &&
          body.width > 0 &&
          body.height > 0,
      }
    })
  }, [paneBounds, store])

  // Reported at most once a frame, and only when something in them changed. A frame
  // in a hidden window never comes, so a short timer stands in for it.
  const slotsRef = useRef<{ frame: number; timer: ReturnType<typeof setTimeout> | null; last: string }>({
    frame: 0,
    timer: null,
    last: "",
  })
  const scheduleSlots = useCallback(() => {
    const pending = slotsRef.current
    if (pending.frame !== 0 || pending.timer !== null) return
    // Nothing pinned and the host already told so: nothing to say.
    if (pending.last === "[]" && !nodesRef.current.some(isTerminal)) return
    const run = () => {
      cancelAnimationFrame(pending.frame)
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.frame = 0
      pending.timer = null
      const slots = computeSlots()
      const json = JSON.stringify(slots)
      if (json === pending.last) return
      pending.last = json
      onTerminalSlotsRef.current?.(slots)
    }
    pending.frame = requestAnimationFrame(run)
    pending.timer = setTimeout(run, 50)
  }, [computeSlots])

  // What moves a slot: the view panning or zooming (and the pane React Flow draws
  // in), the pane changing size or place (full screen, a Grid square, the window),
  // the canvas's own floating UI opening or closing over it, and its chrome (the
  // panels a slot's holes are cut for) coming, going or changing size. The nodes
  // and the rail's workspaces are watched below, with the render that changes them.
  useEffect(() => {
    const unsubscribe = store.subscribe((state, before) => {
      if (state.transform !== before.transform || state.domNode !== before.domNode) scheduleSlots()
    })
    const resized = new ResizeObserver(() => scheduleSlots())
    if (wrapperRef.current) resized.observe(wrapperRef.current)
    // The chrome's panels change size as their contents do (the undo bar's status,
    // the strip of what an answer is reading) — and a centred one moves as it does.
    const watchChrome = (within: ParentNode) => {
      if (within instanceof Element && within.matches(CANVAS_CHROME_SELECTOR)) resized.observe(within)
      for (const panel of within.querySelectorAll(CANVAS_CHROME_SELECTOR)) resized.observe(panel)
    }
    if (wrapperRef.current) watchChrome(wrapperRef.current)
    const matching = (node: globalThis.Node, selector: string) =>
      node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null)
    const mutations = new MutationObserver((records) => {
      let changed = false
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (matching(node, CANVAS_CHROME_SELECTOR)) watchChrome(node as Element)
        }
        changed ||= [...record.addedNodes, ...record.removedNodes].some(
          (node) => matching(node, CANVAS_OVERLAY_SELECTOR) || matching(node, CANVAS_CHROME_SELECTOR),
        )
      }
      if (changed) scheduleSlots()
    })
    if (rootRef.current) mutations.observe(rootRef.current, { childList: true, subtree: true })
    const onWindow = () => scheduleSlots()
    window.addEventListener("resize", onWindow)
    scheduleSlots()
    const pending = slotsRef.current
    return () => {
      unsubscribe()
      resized.disconnect()
      mutations.disconnect()
      window.removeEventListener("resize", onWindow)
      cancelAnimationFrame(pending.frame)
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.frame = 0
      pending.timer = null
      // Gone from the page: whatever the host laid over the board comes off.
      pending.last = "[]"
      onTerminalSlotsRef.current?.([])
    }
  }, [store, scheduleSlots])
  // Switchboard: a pinned terminal moved, resized, selected, folded or minimized —
  // or its workspace left the rail, or a document opened over it — moves or changes
  // its slot.
  useEffect(() => {
    scheduleSlots()
  }, [nodes, edges, choices, freshPins, documentNodeId, documentView, scheduleSlots])

  // After the editor moves the selection itself (Tab, Shift+Tab, Duplicate,
  // starting to type), two things React Flow keeps would otherwise point at
  // the OLD selection: the rectangle a drag-select leaves over the selected
  // boxes — which would sit on top of the new box and swallow clicks into its
  // text — and keyboard focus on the box you last clicked, whose own Enter
  // and Escape handling would select it again.
  const settleSelection = useCallback(() => {
    store.setState({ nodesSelectionActive: false })
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.matches(".react-flow__node")) focused.blur()
  }, [store])

  // Mirrors editingId for the callbacks below, which must not go stale.
  const editingRef = useRef<string | null>(null)
  // Where Tab moved the boxes around a new free text, by the new text's id —
  // put back if that text is left blank and removed, so the branch it would
  // have joined is centred as it was.
  const tabMovesRef = useRef(new Map<string, Map<string, { x: number; y: number }>>())
  // The box whose second line should take focus as soon as it appears.
  const detailFocusRef = useRef<string | null>(null)
  const requestDetailFocus = useCallback((id: string) => {
    detailFocusRef.current = id
  }, [])
  const takeDetailFocus = useCallback((id: string) => {
    if (detailFocusRef.current !== id) return false
    detailFocusRef.current = null
    return true
  }, [])

  // The one way editing moves from box to box (or ends). `onlyIf` makes a stop
  // a no-op once another box has taken over — a blur from the box Tab just
  // left can arrive after the new box started editing.
  const changeEditing = useCallback((next: string | null, onlyIf?: string) => {
    const current = editingRef.current
    if (onlyIf !== undefined && current !== onlyIf) return
    if (current === next) return
    editingRef.current = next
    setEditingId(next)
    if (next !== null) settleSelection()
    if (current === null) return
    // A free text left empty is gone once you move on — there is nothing to
    // see or select in a text with no words, and Whimsical does the same.
    const left = nodesRef.current.find((node) => node.id === current)
    const leftBox = left?.data as FlowBoxNodeData | undefined
    if (leftBox && isText(leftBox) && !leftBox.label.trim() && !leftBox.detail?.trim()) {
      const moved = tabMovesRef.current.get(current)
      tabMovesRef.current.delete(current)
      setNodes((now) =>
        now
          .filter((node) => node.id !== current)
          .map((node) => {
            const back = moved?.get(node.id)
            return back ? { ...node, position: back } : node
          }),
      )
      setEdges((now) => now.filter((edge) => edge.source !== current && edge.target !== current))
      return
    }
    // The text of the box left, tidied as the save will tidy it — so stray
    // blank lines at either end aren't drawn below a box sized without them —
    // and a second line opened and left empty gone again, with the room the
    // box grew for it, rather than lingering for the next edit.
    setNodes((now) =>
      now.map((node) => {
        if (node.id !== current) return node
        const box = node.data as FlowBoxNodeData
        const label = normalizeFlowText(box.label)
        const detail = box.detail === undefined ? undefined : normalizeFlowText(box.detail) || undefined
        return withBox(node, {
          ...box, label, detail,
          labelRichText: parseFlowRichText(box.labelRichText, label),
          detailRichText: parseFlowRichText(box.detailRichText, detail ?? ""),
        })
      }),
    )
  }, [settleSelection])

  function restore(snapshot: string) {
    // Switchboard: an undo/redo invalidates any pending destructive replacement.
    for (const [serial, run] of [...askRef.current]) {
      if (!run.selectedIds) continue
      askRef.current.delete(serial)
      run.controller.abort()
      doneAsking(serial)
    }
    // Switchboard: where each pinned terminal is now, for the host to float any the
    // step takes off the board exactly there.
    const pinned = new Map(
      nodesRef.current.filter(isTerminal).map((node) => [terminalWorkspace(node), clientRectOf(node)] as const),
    )
    const next = toCanvas(JSON.parse(snapshot) as FlowSpec)
    nodesRef.current = next.nodes
    edgesRef.current = next.edges
    latestRef.current = snapshot
    setAnswered(null)
    setNodes(next.nodes)
    setEdges(next.edges)
    changeEditing(null)
    lastRecordAt.current = 0
    const kept = new Set(next.nodes.filter(isTerminal).map(terminalWorkspace))
    for (const [wsId, rect] of pinned) {
      if (!kept.has(wsId)) onTerminalRemovedRef.current?.(wsId, "undo", rect)
    }
  }

  // Steps back to the most recent snapshot that differs from the canvas. A
  // recorded gesture that changed nothing (a drag that ended where it began)
  // leaves a snapshot identical to the canvas, and stepping "back" to it would
  // look like undo doing nothing.
  function step(from: string[], to: string[]) {
    const current = latestRef.current
    const remaining = [...from]
    let target: string | undefined
    while (remaining.length > 0) {
      const candidate = remaining.pop()
      if (candidate !== undefined && candidate !== current) {
        target = candidate
        break
      }
    }
    return { remaining, target, pushed: target === undefined ? to : [...to, current] }
  }

  function undo() {
    const { remaining, target, pushed } = step(past, future)
    setPast(remaining)
    if (target === undefined) return
    setFuture(pushed)
    restore(target)
  }

  function redo() {
    const { remaining, target, pushed } = step(future, past)
    setFuture(remaining)
    if (target === undefined) return
    setPast(pushed)
    restore(target)
  }

  // ─── changes ───

  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((current) =>
        carryFolded(
          current,
          carryBranches(
            current,
            applyNodeChanges(
              // The last change of a resize carries the size from its last
              // step, which for a text is from before it re-wrapped. resize()
              // has already set the real one.
              changes.filter(
                (change) => !(change.type === "dimensions" && change.resizing === false),
              ),
              current,
            ),
            changes,
          ),
          edgesRef.current,
        ),
      ),
    [],
  )

  // Switchboard: while a box is dragged, what hangs off it comes too, step for step
  // (flowBranches, worked out when the drag began) — unless it is detached.
  const carryRef = useRef<Map<string, string[]> | null>(null)
  function carryBranches(before: Node[], after: Node[], changes: NodeChange[]): Node[] {
    const carry = carryRef.current
    if (!carry) return after
    const dragged = new Set(changes.flatMap((change) => (change.type === "position" ? [change.id] : [])))
    if (dragged.size === 0) return after
    const was = new Map(before.map((node) => [node.id, node.position]))
    const now = new Map(after.map((node) => [node.id, node.position]))
    const shift = new Map<string, { dx: number; dy: number }>()
    for (const [id, below] of carry) {
      const from = was.get(id)
      const to = now.get(id)
      if (!from || !to || (from.x === to.x && from.y === to.y)) continue
      for (const box of below) {
        if (!dragged.has(box)) shift.set(box, { dx: to.x - from.x, dy: to.y - from.y })
      }
    }
    if (shift.size === 0) return after
    return after.map((node) => {
      const by = shift.get(node.id)
      return by ? { ...node, position: { x: node.position.x + by.dx, y: node.position.y + by.dy } } : node
    })
  }
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) return
      record()
      setEdges((current) =>
        addEdge(editableEdge({ id: newEdgeId(), ...connection }, { dashed: false }), current),
      )
    },
    [record],
  )

  const onReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      if (connection.source === connection.target) return
      record()
      setEdges((current) => reconnectEdge(oldEdge, connection, current))
    },
    [record],
  )

  // Switchboard: where the boxes being dragged were when the drag began, for the
  // drop to put them where they belong in their branch.
  const dragFromRef = useRef<Map<string, { x: number; y: number }> | null>(null)

  const startDrag = useCallback(
    (dragging: Node[]) => {
      record()
      const current = nodesRef.current
      const shown = showing(current, edgesRef.current)
      const carry = flowBranches(
        shown.boxes,
        shown.edges,
        dragging.map((node) => node.id),
      )
      carryRef.current = carry.size > 0 ? carry : null
      // Where everything the drag will move starts: the boxes grabbed, and what
      // they carry.
      const from = new Map(dragging.map((node) => [node.id, { ...node.position }]))
      const at = new Map(current.map((node) => [node.id, node.position]))
      for (const below of carry.values()) {
        for (const id of below) {
          const position = at.get(id)
          if (position && !from.has(id)) from.set(id, { ...position })
        }
      }
      dragFromRef.current = from
    },
    [record],
  )

  // Switchboard: a box let go in a branch Tab built takes its place there — between
  // the siblings it was dropped between, back in their column, what hangs off it
  // coming along — and the tree is laid out again as Tab and a delete leave it
  // (tidyAfterMove). A box in no branch stays where it was dropped. The same undo
  // step as the drag.
  const dropBoxes = useCallback(() => {
    const from = dragFromRef.current
    dragFromRef.current = null
    carryRef.current = null
    if (!from || from.size === 0) return
    setNodes((current) => {
      const shown = showing(current, edgesRef.current)
      const moved = tidyAfterMove(shown.boxes, shown.edges, from)
      if (moved.size === 0) return current
      // A free text Tab added and still empty puts the boxes it moved back when
      // it goes; not the ones that have just been settled since.
      for (const pending of tabMovesRef.current.values()) {
        for (const id of moved.keys()) pending.delete(id)
      }
      return carryFolded(
        current,
        current.map((node) => {
          const to = moved.get(node.id)
          return to ? { ...node, position: to } : node
        }),
        edgesRef.current,
      )
    })
  }, [])

  const updateNodes = useCallback(
    (ids: string[], patch: Partial<FlowBoxNodeData>, typing = false) => {
      record(typing)
      const wanted = new Set(ids)
      const apply = (current: Node[]) =>
        current.map((node) => {
          if (!wanted.has(node.id)) return node
          const before = node.data as FlowBoxNodeData
          const box = { ...before, ...patch }
          // Words typed into a box the AI wrote are yours: its mark goes. Not
          // for an empty second line opened or closed, which changes no words;
          // and Escape puts the AI's words back with `ai` in the patch, and
          // the mark with them.
          const ownWords =
            !("ai" in patch) &&
            (!sameWords(before.label, box.label) || !sameWords(before.detail, box.detail))
          // Switchboard: and the tag naming the workspace the AI read goes with it.
          return withBox(node, ownWords ? { ...box, ai: undefined, answeredIn: undefined } : box)
        })
      // Ahead of the render too: Escape reverts a text and stops editing it in
      // one go, and the stop has to judge the text it is reverted to.
      nodesRef.current = apply(nodesRef.current)
      // A text that has words in it is no longer one Tab might take back.
      if (patch.label?.trim()) for (const id of ids) tabMovesRef.current.delete(id)
      setNodes(apply)
    },
    [record],
  )

  const updateNode = useCallback(
    (id: string, patch: Partial<FlowBoxNodeData>, typing = false) =>
      updateNodes([id], patch, typing),
    [updateNodes],
  )

  const updateEdge = useCallback(
    (id: string, patch: Partial<FlowEdgeData>, typing = false) => {
      record(typing)
      setEdges((current) =>
        current.map((edge) =>
          edge.id === id
            ? editableEdge(edge, { ...(edge.data as FlowEdgeData), ...patch })
            : edge,
        ),
      )
    },
    [record],
  )

  const reverseEdge = useCallback(
    (id: string) => {
      record()
      setEdges((current) =>
        current.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                source: edge.target,
                target: edge.source,
                sourceHandle: edge.targetHandle,
                targetHandle: edge.sourceHandle,
              }
            : edge,
        ),
      )
    },
    [record],
  )

  const deleteEdge = useCallback(
    (id: string) => void deleteElements({ edges: [{ id }] }),
    [deleteElements],
  )

  // Set as a resize handle is pressed; the first step of the drag takes the
  // undo step and clears it.
  const resizePendingRef = useRef(false)
  const startResize = useCallback(() => {
    resizePendingRef.current = true
  }, [])
  // Switchboard: the pinned terminal whose resize handle is held — its slot says so.
  const terminalResizingRef = useRef<string | null>(null)

  // Keeps the size a note, text or image was dragged to, then re-sizes it the
  // way the read-only canvas will: a note no shorter than its text needs, a
  // text as tall as its lines. Where the resize handles left the corner is
  // where it stays.
  const resize = useCallback((id: string, size: FlowSize, done: boolean) => {
    if (resizePendingRef.current) {
      resizePendingRef.current = false
      record()
    }
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== id) return node
        const box: FlowBoxNodeData = {
          ...(node.data as FlowBoxNodeData),
          size: {
            width: Math.round(size.width),
            height: Math.round(size.height),
          },
        }
        const drawn = boxSize(box)
        // Mid-drag the size is the resize handle's to set; only a text's
        // height, which follows its re-wrapped lines, is ours. Once let go,
        // the node takes the size the read-only canvas will give it — and
        // React Flow's measurement with it, which its own last word on the
        // drag (sent with the size from before a text re-wrapped) would
        // otherwise leave stale.
        if (done) return { ...node, data: box, ...drawn, measured: { ...drawn } }
        // Switchboard: a pinned terminal's size is written only once it is let go —
        // its slot reports the committed size, and the host sizes the shell to it then.
        if (box.shape === "terminal") return node
        return box.shape === "text"
          ? { ...node, data: box, height: drawn.height }
          : { ...node, data: box }
      }),
    )
    if (done && terminalResizingRef.current === id) {
      terminalResizingRef.current = null
      scheduleSlots()
    }
  }, [record])

  // Pans just far enough that `rect` sits clear of the canvas's own chrome —
  // a box Tab added off the edge of the view is a box you'd be typing into
  // blind. Switchboard: says whether it had to.
  function reveal(rect: FlowRect): boolean {
    const bounds = wrapperRef.current?.getBoundingClientRect()
    if (!bounds) return false
    const { x, y, zoom } = getViewport()
    const left = rect.x * zoom + x
    const right = (rect.x + rect.width) * zoom + x
    const top = rect.y * zoom + y
    const bottom = (rect.y + rect.height) * zoom + y
    const floating = wrapperRef.current?.parentElement?.querySelector(".flow-document-floating")?.getBoundingClientRect()
    const visibleWidth = floating ? Math.min(bounds.width, floating.left - bounds.left - 16) : bounds.width
    let dx = 0
    let dy = 0
    if (right > visibleWidth - REVEAL_MARGIN.right) dx = visibleWidth - REVEAL_MARGIN.right - right
    if (left + dx < REVEAL_MARGIN.left) dx = REVEAL_MARGIN.left - left
    if (bottom > bounds.height - REVEAL_MARGIN.bottom) {
      dy = bounds.height - REVEAL_MARGIN.bottom - bottom
    }
    if (top + dy < REVEAL_MARGIN.top) dy = REVEAL_MARGIN.top - top
    if (dx !== 0 || dy !== 0) void setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 200 })
    return dx !== 0 || dy !== 0
  }

  useEffect(() => {
    if (!documentNodeId || documentView === "focus") return
    let frame = 0
    const show = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const node = nodesRef.current.find((entry) => entry.id === documentNodeId)
        if (node) reveal(rectOf(node))
      })
    }
    // Switchboard: a document panel resized over the canvas may now cover a pinned
    // terminal, or no longer.
    const observer = new ResizeObserver(() => { show(); scheduleSlots() })
    const panel = wrapperRef.current?.parentElement?.querySelector(".flow-document-panel")
    if (panel) observer.observe(panel)
    show()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [documentNodeId, documentView])

  // Makes `node` the whole selection.
  function select(node: Node) {
    settleSelection()
    setNodes((current) =>
      current.map((other) =>
        other.id === node.id
          ? other.selected
            ? other
            : { ...other, selected: true }
          : other.selected
            ? { ...other, selected: false }
            : other,
      ),
    )
    setEdges(deselected)
  }

  // Adds `box` at `position`, selected, with its text open for typing — the
  // common next move is naming it (an image has no text, so it is only
  // selected). `from` also draws the arrow to it. `quiet` adds it without
  // touching the selection or whatever is being typed: for a picture whose
  // upload finished while you had moved on to something else.
  function insertBox(
    box: FlowBoxNodeData,
    position: { x: number; y: number },
    {
      from,
      id = nextFlowNodeId(
        nodesRef.current.map((node) => node.id),
        box.label,
      ),
      quiet = false,
    }: { from?: { id: string; side: "right" }; id?: string; quiet?: boolean } = {},
  ) {
    const { width, height } = boxSize(box)
    const node: Node = {
      id,
      type: EDIT_NODE_TYPE,
      position,
      width,
      height,
      data: box,
      selected: !quiet,
    }
    // Taken at once rather than at the next render: two uploads landing
    // together would otherwise both read the same ids and pick the same one.
    nodesRef.current = [...nodesRef.current, node]
    if (quiet) {
      setNodes((current) => [...current, node])
      return { id, rect: { ...position, width, height } }
    }
    setNodes((current) => [...deselected(current), node])
    setEdges((current) => {
      const cleared = deselected(current)
      if (!from) return cleared
      return [
        ...cleared,
        editableEdge(
          {
            id: newEdgeId(),
            source: from.id,
            target: id,
            sourceHandle: from.side,
            targetHandle: "left",
          },
          { dashed: false },
        ),
      ]
    })
    if (hasText(box)) changeEditing(id)
    else {
      changeEditing(null)
      settleSelection()
    }
    return { id, rect: { ...position, width, height } }
  }

  // Documents open beside the canvas; their Markdown is saved independently.
  function openDocument(node: Node, writing = false) {
    changeEditing(null)
    setImagesOpen(false)
    setImageMenu(false)
    setTool("select")
    setDocumentStartsWriting(writing)
    setDocumentView("floating")
    setDocumentNodeId(node.id)
  }

  async function placeDocument(at: { x: number; y: number }) {
    const result = await documents.create()
    if (!alive.current) return
    if (!result.ok) { toast({ title: result.error, variant: "error" }); return }
    record()
    const box = { ...plainBox({ label: "Untitled document", shape: "rounded", tone: "default" }), shape: "document" as const, documentId: result.data.id }
    const { width, height } = boxSize(box)
    const position = clearOfBoxes({ x: snap(at.x - width / 2), y: snap(at.y - height / 2), width, height }, nodesRef.current.map(rectOf))
    const inserted = insertBox(box, position)
    openDocument(nodesRef.current.find((node) => node.id === inserted.id)!, true)
  }

  // Places a toolbar item at the click or drop, centred except for free text.
  function placeNew(shape: FlowBoxShape | "note" | "text" | "document", at: { x: number; y: number }) {
    if (shape === "document") { void placeDocument(at); return }
    record()
    const item = PALETTE.find((entry) => entry.shape === shape)
    const box =
      shape === "note" || shape === "text"
        ? blankNode(shape)
        : plainBox({
            label: item?.label ?? "Step",
            shape,
            tone: item?.tone ?? "default",
          })
    const { width, height } = boxSize(box)
    // Placing several on one spot shouldn't stack them on top of each other,
    // where the newest hides the rest. Compared by CENTRE, since boxes of
    // different heights dropped on one spot share a centre, not a corner.
    const centre = shape === "text" ? { x: at.x + width / 2, y: at.y } : { x: at.x, y: at.y }
    const crowded = () =>
      nodes.some((node) => {
        const x = node.position.x + (node.width ?? FLOW_NODE_WIDTH) / 2
        const y = node.position.y + (node.height ?? 0) / 2
        return Math.abs(x - centre.x) < 24 && Math.abs(y - centre.y) < 24
      })
    while (crowded()) {
      centre.x += 30
      centre.y += 30
    }
    insertBox(box, {
      x: snap(centre.x - width / 2),
      y: snap(centre.y - height / 2),
    })
  }

  // ─── images ───

  // Uploads each picture, then adds it centred on `at` (the drop point, or the
  // middle of the view), several fanned out a little so none hides another.
  // The canvas stays usable meanwhile; a picture lands once it is stored, as
  // its own undo step.
  async function addImages(files: File[], at?: { x: number; y: number }) {
    const usable = files.filter((file) => {
      const problem = diagramImageProblem(file)
      if (problem) toast({ title: problem, variant: "error" })
      return problem === null
    })
    if (usable.length === 0) return
    const centre = at ?? viewCentre()
    if (!centre) return

    // Counted up front, so "Uploading 3 images…" counts down as they land.
    setUploading((count) => count + usable.length)
    for (const [index, file] of usable.entries()) {
      try {
        const [size, src] = await Promise.all([
          imageDisplaySize(file),
          uploadDiagramImage(file, uploadsRef.current?.signal),
        ])
        const { width, height } = size ?? FLOW_IMAGE_DEFAULT_SIZE
        const label = file.name.replace(/\.[^.]+$/, "").trim() || "Image"
        record()
        // Its own undo step: typing carried on straight after it starts the
        // next one, rather than folding into this.
        lastRecordAt.current = 0
        insertBox(
          {
            ...plainBox({ label, shape: "image", tone: "default" }),
            src,
            size: { width, height },
          },
          {
            x: snap(centre.x - width / 2 + index * IMAGE_CASCADE),
            y: snap(centre.y - height / 2 + index * IMAGE_CASCADE),
          },
          // Typing somewhere by the time it lands? It goes in without taking
          // the keyboard, or the selection, away from you.
          {
            quiet:
              editingRef.current !== null ||
              isTextField(document.activeElement) ||
              toolRef.current === "hand",
          },
        )
      } catch (err) {
        if (uploadsRef.current?.signal.aborted) {
          toast({
            title: `${file.name || "An image"} wasn't added`,
            description: "You left the whiteboard before it finished uploading.",
          })
          setUploading((count) => count - (usable.length - index - 1))
          return
        }
        toast({
          title: `Couldn't upload ${file.name || "the image"}`,
          description: err instanceof Error ? err.message : undefined,
          variant: "error",
        })
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }

  // Switchboard: a picture by its address — dragged out of the Google Images panel
  // (or a browser), or picked there with Add Image to Diagram. A drag out of a web
  // page never carries the file itself, so main fetches it (and converts what the
  // canvas can't keep to PNG); then it goes on exactly as a dropped file does,
  // through addImages: placed at `at` or the middle of the view, uploaded, its own
  // undo step. The fetch counts as uploading too, so the spinner shows from the drop.
  // `urls` best first: one of Google's results is its full picture, then the
  // thumbnail for when that picture's host won't give it up.
  async function addImageFromUrl(urls: readonly string[], at?: { x: number; y: number }, referrer?: string) {
    const tries = urls.filter((url) => url !== "")
    if (tries.length === 0) return
    setUploading((count) => count + 1)
    let fetched = await call("diagramsFetchImage", tries[0], referrer)
    for (const url of tries.slice(1)) {
      if (fetched.ok) break
      const next = await call("diagramsFetchImage", url, referrer)
      // The first refusal is the one to tell: it was the picture asked for.
      if (next.ok) fetched = next
    }
    setUploading((count) => count - 1)
    if (!fetched.ok) {
      toast({ title: "Couldn't add that image", description: fetched.error, variant: "error" })
      return
    }
    // Named for its type, whatever the address ended in, so the label addImages
    // takes from the name (it drops the extension) is main's name, whole.
    const ext = fetched.type === "image/jpeg" ? "jpg" : fetched.type === "image/webp" ? "webp" : "png"
    const base = fetched.name.replace(/\.(?:png|jpe?g|webp|gif|avif|heic|heif|bmp|tiff?)$/i, "") || "Image"
    const file = new File([fetched.bytes as BlobPart], `${base}.${ext}`, { type: fetched.type })
    await addImages([file], at)
  }

  function placeAtCentre() {
    const centre = viewCentre()
    if (!centre || !placing) return
    placeNew(tool === "shape" ? shapeChoice : tool, centre)
    setTool("select")
  }

  function viewCentre(): { x: number; y: number } | null {
    const bounds = wrapperRef.current?.getBoundingClientRect()
    if (!bounds) return null
    return screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    })
  }

  function pickImages() {
    setImageMenu(false)
    fileInputRef.current?.click()
  }

  // Switchboard: G, or the image tool's Search Google Images. With one box
  // selected, its label is searched for (its words, not its second line); with
  // anything else, the panel shows the page it showed last, or Google Images'
  // own first page. Again while open, it searches again, or takes you to its field.
  function openImages() {
    setDocumentNodeId(null)
    setImageMenu(false)
    const chosen = nodesRef.current.filter((node) => node.selected)
    const box = chosen.length === 1 ? (chosen[0].data as FlowBoxNodeData) : null
    const words = box && hasText(box) ? box.label.replace(/\s+/g, " ").trim() : ""
    setImagesAsk((last) => ({ query: words || null, serial: last.serial + 1 }))
    setImagesOpen(true)
  }

  // Switchboard: the canvas narrows as the panel opens, and the box being searched
  // for stays in view rather than ending up past the canvas's new right edge.
  useEffect(() => {
    if (!imagesOpen) return
    const frame = requestAnimationFrame(() => {
      const chosen = nodesRef.current.filter((node) => node.selected)
      if (chosen.length === 1) reveal(rectOf(chosen[0]))
    })
    return () => cancelAnimationFrame(frame)
    // Only as it opens — not each time the box moves while it is open.
  }, [imagesOpen])

  // ─── tools ───

  function chooseTool(next: Tool) {
    // The hand moves the view and nothing else, so nothing stays selected
    // under it; any other tool leaves the selection be.
    if (next === "hand") {
      changeEditing(null)
      settleSelection()
      setNodes(deselected)
      setEdges(deselected)
    }
    // Switchboard: a tool picked, by key or on the rail, puts the image menu away.
    setImageMenu(false)
    setTool(next)
  }

  // Switchboard: the image tool's menu. Opening it puts the shape tool away too,
  // so the shape menu and this one never stand side by side.
  function showImageMenu(open: boolean) {
    if (open && tool === "shape") setTool("select")
    setImageMenu(open)
  }

  // A click on empty canvas with a placing tool out puts the thing there, and
  // the tool goes back to Select — the next click is to type or to arrange.
  function onPaneClick(event: React.MouseEvent) {
    if (!placing) return
    placeNew(
      tool === "shape" ? shapeChoice : tool,
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    )
    setTool("select")
  }

  // Double-clicking empty canvas starts a text there.
  function onCanvasDoubleClick(event: React.MouseEvent) {
    if (tool !== "select") return
    if (!(event.target instanceof Element) || !event.target.classList.contains("react-flow__pane")) {
      return
    }
    placeNew("text", screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }

  // Tab: a box like `parent` (shape, colour and type, but no text) joined to
  // its right side, under the last box already hanging off that side. The
  // boxes around it shuffle up so each branch stays centred on the box it
  // hangs off — one undo step with the new box.
  function addChild(parent: Node) {
    record()
    const from = parent.data as FlowBoxNodeData
    // The next of the same kind — but after a picture, a plain box, since
    // there is no picture to repeat. A note keeps its size; a text runs as
    // wide as its own words.
    // Switchboard: after a pinned terminal too — there is no second shell to add.
    const box: FlowBoxNodeData =
      from.shape === "image" || from.shape === "document" || from.shape === "terminal"
        ? plainBox({ label: "", shape: "rounded", tone: "default" })
        : {
            ...from,
            label: "",
            detail: undefined,
            labelRichText: undefined,
            detailRichText: undefined,
            // No words yet, so none of them are the AI's — nor (Switchboard) the
            // workspace an answer read.
            ai: undefined,
            answeredIn: undefined,
            // Switchboard: in the branch it is added to.
            detached: undefined,
            size: from.shape === "note" ? from.size : undefined,
          }
    const id = nextFlowNodeId(
      nodes.map((node) => node.id),
      box.label,
    )
    // Switchboard: adding to a detached box makes it a branch again.
    const reattach = from.detached === true
    const settle = (node: Node) => (reattach && node.id === parent.id ? attached(node) : node)
    const shown = showing(nodes.map(settle), edges)
    const { position, moved } = placeTabChild(
      shown.boxes,
      shown.edges,
      parent.id,
      { id, ...boxSize(box) },
    )
    if (moved.size > 0 || reattach) {
      if (isText(box) && moved.size > 0) {
        tabMovesRef.current.set(
          id,
          new Map(
            nodes.filter((node) => moved.has(node.id)).map((node) => [node.id, node.position]),
          ),
        )
      }
      setNodes((current) =>
        current.map((node) => {
          const to = moved.get(node.id)
          const box = settle(node)
          return to ? { ...box, position: to } : box
        }),
      )
    }
    reveal(insertBox(box, position, { from: { id: parent.id, side: "right" }, id }).rect)
  }

  // Shift+Tab: back to the box this one hangs off — the arrow that came in on
  // its left side, which is the one Tab draws, or failing that any arrow in.
  function stepBack(id: string) {
    const incoming = edges.filter((edge) => edge.target === id)
    const edge = incoming.find((candidate) => candidate.targetHandle === "left") ?? incoming[0]
    const parent = edge ? nodes.find((node) => node.id === edge.source) : undefined
    changeEditing(null)
    if (!parent) return
    select(parent)
    reveal(rectOf(parent))
    lastStep.current = { from: id, to: parent.id, direction: "left" }
  }

  // The last move between boxes, so the opposite arrow retraces it: Left from
  // the third of three boxes to their parent, then Right, is the third again
  // rather than whichever is most level with the parent.
  const lastStep = useRef<{ from: string; to: string; direction: FlowDirection } | null>(null)

  // Arrow keys: the selection jumps to the next box that way.
  function go(direction: FlowDirection): boolean {
    const current = editingNode ?? soleNode
    if (!current) return false
    const last = lastStep.current
    const retrace =
      last !== null && last.to === current.id && last.direction === OPPOSITE_DIRECTION[direction]
        ? nodes.find((node) => node.id === last.from)
        : undefined
    const nextId =
      retrace?.id ??
      boxInDirection(
        { id: current.id, ...rectOf(current) },
        showing(nodes, edges).boxes,
        direction,
      )?.id
    const next = nodes.find((node) => node.id === nextId)
    // Nothing that way: the key is still spent, rather than stepping to
    // another diagram from under the selection.
    if (!next) return true
    changeEditing(null)
    select(next)
    reveal(rectOf(next))
    lastStep.current = { from: current.id, to: next.id, direction }
    return true
  }

  // Shift+arrow nudges the selected boxes one grid step; a run of nudges is
  // one undo step.
  function nudge(direction: FlowDirection): boolean {
    if (editingNode || !nodes.some((node) => node.selected)) return false
    record(true)
    const [stepX, stepY] = SNAP_GRID
    const dx = direction === "left" ? -stepX : direction === "right" ? stepX : 0
    const dy = direction === "up" ? -stepY : direction === "down" ? stepY : 0
    // Switchboard: what hangs off a nudged box comes too, as it does on a drag.
    const shown = showing(nodes, edges)
    const picked = nodes.filter((node) => node.selected).map((node) => node.id)
    const moving = new Set([...picked, ...[...flowBranches(shown.boxes, shown.edges, picked).values()].flat()])
    setNodes((current) =>
      carryFolded(
        current,
        current.map((node) =>
          moving.has(node.id)
            ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
            : node,
        ),
        edgesRef.current,
      ),
    )
    return true
  }

  // Switchboard: the toolbar's Attached / Detached. Detached, a box is in no branch:
  // it moves on its own and nothing it is joined to moves with it. Attached again,
  // it is laid out in its branch and its branch around it, as Tab would. One undo step.
  function toggleDetached(id: string) {
    const node = nodesRef.current.find((candidate) => candidate.id === id)
    if (!node) return
    record()
    if (!(node.data as FlowBoxNodeData).detached) {
      setNodes((current) =>
        current.map((candidate) =>
          candidate.id === id
            ? { ...candidate, data: { ...(candidate.data as FlowBoxNodeData), detached: true } }
            : candidate,
        ),
      )
      return
    }
    const settle = (candidate: Node) => (candidate.id === id ? attached(candidate) : candidate)
    const shown = showing(nodesRef.current.map(settle), edgesRef.current)
    const moved = tidyFlowTree(shown.boxes, shown.edges, [id])
    for (const pending of tabMovesRef.current.values()) {
      for (const box of moved.keys()) pending.delete(box)
    }
    setNodes((current) =>
      carryFolded(
        current,
        current.map((candidate) => {
          const box = settle(candidate)
          const to = moved.get(candidate.id)
          return to ? { ...box, position: to } : box
        }),
        edgesRef.current,
      ),
    )
  }

  // Escape lets go of the selection.
  function clearSelection(): boolean {
    if (!nodes.some((node) => node.selected) && !edges.some((edge) => edge.selected)) {
      return false
    }
    changeEditing(null)
    settleSelection()
    setNodes(deselected)
    setEdges(deselected)
    return true
  }

  function duplicate(node: Node, documentCopied = false) {
    const original = node.data as FlowBoxNodeData
    // Switchboard: one terminal per workspace on a board — a pinned one has no copy.
    if (original.shape === "terminal") return
    if (original.shape === "document" && original.documentId && !documentCopied) {
      void (async () => {
        const content = await documents.read(original.documentId!)
        if (!content.ok) { toast({ title: content.error, variant: "error" }); return }
        const created = await documents.create(content.data)
        if (!alive.current) return
        if (!created.ok) { toast({ title: created.error, variant: "error" }); return }
        duplicate({ ...node, data: { ...original, documentId: created.data.id } }, true)
      })()
      return
    }
    record()
    const box = node.data as FlowBoxNodeData
    const current = nodesRef.current
    const rect = rectOf(node)
    const position = clearOfBoxes(
      { ...rect, y: rect.y + rect.height + FLOW_TAB_GAP_Y },
      showing(current, edgesRef.current).nodes.map(rectOf),
    )
    const id = nextFlowNodeId(
      current.map((other) => other.id),
      box.label,
    )
    const added: Node = {
      id,
      type: EDIT_NODE_TYPE,
      position,
      width: rect.width,
      height: rect.height,
      data: { ...box },
      selected: true,
    }
    nodesRef.current = [...deselected(current), added]
    setNodes((now) => [...deselected(now), added])
    setEdges(deselected)
    settleSelection()
    reveal({ ...rect, ...position })
  }

  // ─── Switchboard: ⌘C, ⌘X and ⌘V ───

  // Where the pointer last was over the canvas, in the window: where ⌘V puts
  // what was copied.
  const pointerRef = useRef<{ x: number; y: number } | null>(null)

  // ⌘C: the boxes selected, and the arrows between them, kept for ⌘V — and
  // their words, top to bottom, on the clipboard for pasting anywhere else.
  function copyBoxes(): boolean {
    // Switchboard: never a pinned terminal — pasting one would put a second node for
    // its workspace on a board, and there is only the one shell to show in it.
    const chosen = nodesRef.current.filter((node) => node.selected && !isTerminal(node))
    if (chosen.length === 0) return false
    const ids = new Set(chosen.map((node) => node.id))
    const text = [...chosen]
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .map((node) => clipboardWords(node.data as FlowBoxNodeData))
      .join("\n")
    const documentIds = [...new Set(chosen.map((node) => (node.data as FlowBoxNodeData).documentId).filter((id): id is string => !!id))]
    flowCopy = {
      // Capture the words at Copy time, including edits awaiting autosave. A paste
      // into any workspace creates independent Markdown files from this snapshot.
      documents: documentIds.length ? Promise.all(documentIds.map(async (id) => {
        const result = await documents.read(id)
        if (!result.ok) throw new Error(result.error)
        return [id, result.data] as const
      })).then((pairs) => new Map(pairs)) : undefined,
      text,
      nodes: chosen.map((node) => ({
        id: node.id,
        position: { ...node.position },
        width: node.width,
        height: node.height,
        data: { ...(node.data as FlowBoxNodeData) },
      })),
      edges: edgesRef.current
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => ({
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
          data: { ...((edge.data as FlowEdgeData | undefined) ?? { dashed: false }) },
        })),
    }
    void flowCopy.documents?.catch(() => {})
    writeClipboard(text)
    return true
  }

  // ⌘V: what ⌘C copied, as new boxes centred on the pointer — or the middle of
  // the view, before the pointer has been over the canvas — arranged as they
  // were, with the arrows between them, and selected. One undo step.
  function pasteBoxes(text: string, prepared?: FlowCopy, position?: { x: number; y: number }): boolean {
    const copy = prepared ?? flowCopy
    if (!copy || !sameClipboard(text, copy.text)) return false
    const bounds = wrapperRef.current?.getBoundingClientRect()
    const pointer = pointerRef.current
    const spot = position ?? screenToFlowPosition(
      pointer ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : { x: 0, y: 0 }),
    )
    if (copy.documents) {
      void (async () => {
        try {
          const contents = await copy.documents!
          const ids = new Map<string, string>()
          for (const [id, content] of contents) {
            const result = await documents.create(content)
            if (!result.ok) throw new Error(result.error)
            ids.set(id, result.data.id)
          }
          if (!alive.current) return
          pasteBoxes(text, { ...copy, documents: undefined, nodes: copy.nodes.map((node) => ({ ...node, data: { ...node.data, documentId: node.data.documentId ? ids.get(node.data.documentId) : undefined } })) }, spot)
        } catch (error) { if (alive.current) toast({ title: error instanceof Error ? error.message : "Could not copy document", variant: "error" }) }
      })()
      return true
    }
    // Switchboard: a copy taken by an older editor might hold a terminal; never paste one.
    if (copy.nodes.some((node) => node.data.shape === "terminal")) {
      const kept = copy.nodes.filter((node) => node.data.shape !== "terminal")
      if (kept.length === 0) return false
      const ids = new Set(kept.map((node) => node.id))
      return pasteBoxes(text, {
        ...copy,
        nodes: kept,
        edges: copy.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      }, position)
    }
    record()
    lastRecordAt.current = 0
    const left = Math.min(...copy.nodes.map((node) => node.position.x))
    const top = Math.min(...copy.nodes.map((node) => node.position.y))
    const right = Math.max(...copy.nodes.map((node) => node.position.x + (node.width ?? FLOW_NODE_WIDTH)))
    const bottom = Math.max(...copy.nodes.map((node) => node.position.y + (node.height ?? 0)))
    // On the grid, as everything placed or dragged is.
    const snap = (value: number) => Math.round(value / SNAP_GRID[0]) * SNAP_GRID[0]
    const dx = snap(spot.x - (left + right) / 2)
    const dy = snap(spot.y - (top + bottom) / 2)
    const current = nodesRef.current
    const taken = current.map((node) => node.id)
    const renamed = new Map<string, string>()
    const added: Node[] = copy.nodes.map((node) => {
      const id = nextFlowNodeId(taken, node.data.label)
      taken.push(id)
      renamed.set(node.id, id)
      return {
        id,
        type: EDIT_NODE_TYPE,
        position: { x: node.position.x + dx, y: node.position.y + dy },
        width: node.width,
        height: node.height,
        data: { ...node.data },
        selected: true,
      }
    })
    const arrows = copy.edges.map((edge) =>
      editableEdge(
        {
          id: newEdgeId(),
          source: renamed.get(edge.source)!,
          target: renamed.get(edge.target)!,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        },
        { ...edge.data },
      ),
    )
    changeEditing(null)
    nodesRef.current = [...deselected(current), ...added]
    setNodes((now) => [...deselected(now), ...added])
    setEdges((now) => [...deselected(now), ...arrows])
    settleSelection()
    reveal({ x: left + dx, y: top + dy, width: right - left, height: bottom - top })
    return true
  }

  // The second line, from the text toolbar. Added, it takes focus as it
  // mounts; removed, focus moves up to the label BEFORE it goes, so editing
  // never loses its place.
  function toggleDetail(id: string, box: FlowBoxNodeData) {
    if (box.detail === undefined) {
      requestDetailFocus(id)
      updateNode(id, { detail: "" })
    } else {
      wrapperRef.current
        ?.querySelector<HTMLElement>('[data-flow-text="label"]')
        ?.focus()
      updateNode(id, { detail: undefined, detailRichText: undefined })
    }
  }

  // ─── ✦ Answer ───

  // Sends `node`'s text — with the boxes leading up to it, unless that is
  // switched off — to the model picked in the toolbar, then hangs the answer
  // off the box's right side. The canvas stays usable while it thinks.
  async function ask(node: Node) {
    // Switchboard: one answer per box, but any number of boxes at once.
    if (isAnswering(node.id)) return
    const box = node.data as FlowBoxNodeData
    const question = box.label.trim()
    if (!hasText(box) || !question) {
      toast({ title: "Write a question in the box first", variant: "error" })
      return
    }
    // Switchboard: whoever the menu or Settings picked — and if it can't answer on
    // this Mac, the strip says why and what fixes it, without asking anything.
    const known = answerStatus
    const provider = known?.providers.find((option) => option.id === known.settings.provider)
    if (!known || !provider) {
      toast({ title: "Switchboard is still looking for who can answer — try again in a moment" })
      return
    }
    // Switchboard: and a CLI needs a workspace to read — the one this whiteboard names,
    // taken now, so changing it while the answer is on its way changes only the next.
    const workspace = provider.kind === "cli" ? answerWorkspace : null
    const blocked = notReady(provider) ?? noWorkspace(provider, answerWorkspace, answerWorkspaceGone)
    if (blocked) {
      setAnswered(null)
      setFailure({ ...blocked, workspace, nodeId: node.id })
      return
    }
    const settings = known.settings
    const canvasNodes = nodesRef.current
    const canvasEdges = edgesRef.current
    // Named to the model so it doesn't repeat what is already there. Switchboard: a
    // pinned terminal hanging off it says nothing.
    const existing = canvasEdges
      .filter((edge) => edge.source === node.id && edge.sourceHandle === "right")
      .map((edge) => canvasNodes.find((other) => other.id === edge.target))
      .filter((other) => other !== undefined && !isTerminal(other))
      .map((other) => (other?.data as FlowBoxNodeData | undefined)?.label.trim() ?? "")
      .filter((label) => label.length > 0)
      .slice(0, FLOW_AI_MAX_EXISTING)
    const controller = new AbortController()
    askCountRef.current += 1
    const serial = askCountRef.current
    askRef.current.set(serial, { id: node.id, controller })
    // Still this answer's to act on — not stopped, nor the editor gone.
    const live = () => askRef.current.get(serial)?.controller === controller
    const startedAt = Date.now()
    setAnswered(null)
    setFailure(null)
    setSteps((all) => ({ ...all, [serial]: [] }))
    setAskings((list) => [
      ...list,
      {
        id: node.id,
        question,
        startedAt,
        provider: provider.id,
        name: provider.name,
        cli: provider.kind === "cli",
        workspace,
        web: settings.web,
        serial,
      },
    ])
    try {
      const { parts, files } = await requestFlowAnswer(
        {
          provider,
          wsId: answerWorkspace,
          question: {
            question,
            detail: box.detail?.trim() || undefined,
            context: settings.context
              ? flowQuestionPath(
                  canvasNodes as unknown as FlowCanvasNode[],
                  canvasEdges as unknown as FlowCanvasEdge[],
                  node.id,
                )
              : [],
            existing,
            title: diagramName ?? meta.title,
            split: settings.split,
            subtext: settings.subtext,
          },
        },
        controller.signal,
        // What a CLI is doing, a line at a time, for the card over the strip. The last
        // few are all it shows.
        (step) => {
          if (live()) {
            setSteps((all) => ({ ...all, [serial]: [...(all[serial] ?? []).slice(-49), step] }))
          }
        },
      )
      // Stopped, or the editor went away, while it was on its way.
      if (!live()) return
      setAnswerNote({
        by: provider.name,
        files: provider.kind === "cli" ? files : null,
        seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
      })
      addAnswers(node.id, parts, workspace)
    } catch (err) {
      if (!live()) return
      setFailure({
        message: err instanceof Error ? err.message : "Couldn't answer that",
        code: err instanceof AnswerError ? err.code : undefined,
        workspace,
        nodeId: node.id,
      })
    } finally {
      if (live()) {
        askRef.current.delete(serial)
        doneAsking(serial)
      }
    }
  }

  /** Switchboard: whether `id`'s answer is on its way. */
  function isAnswering(id: string): boolean {
    for (const run of askRef.current.values()) {
      if (run.id === id || run.selectedIds?.includes(id)) return true
    }
    return false
  }

  // Switchboard: condense the complete selected discussion in place. Keep the
  // original until a valid summary arrives; edits to its words or connections
  // invalidate the request, while moves and work elsewhere can continue.
  async function condense(selectedIds: string[]) {
    if (selectedIds.some(isAnswering)) return
    const currentSpec = () => JSON.parse(canvasJson(meta, nodesRef.current, edgesRef.current)) as FlowSpec
    const picked = new Set(selectedIds)
    // Include editor-only edges to empty text, which saving intentionally
    // omits. Adding even an unfinished branch invalidates this replacement.
    const wiring = () => JSON.stringify(edgesRef.current
      .filter((edge) => picked.has(edge.source) || picked.has(edge.target))
      .map((edge) => {
        const data = edge.data as FlowEdgeData | undefined
        return JSON.stringify([edge.source, edge.target, edge.sourceHandle, edge.targetHandle, data?.label, data?.dashed, data?.collapsed])
      }).sort())
    const initialWiring = wiring()
    let selection: ReturnType<typeof inspectFlowCondenseSelection>
    try {
      selection = inspectFlowCondenseSelection(currentSpec(), selectedIds)
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Select a connected discussion to condense", variant: "error" })
      return
    }
    const known = answerStatus
    const provider = known?.providers.find((option) => option.id === known.settings.provider)
    if (!known || !provider) {
      toast({ title: "Switchboard is still looking for who can answer — try again in a moment" })
      return
    }
    // Switchboard: Condense reads nothing, so it needs no workspace — only the CLI.
    const workspace = provider.kind === "cli" && !answerWorkspaceGone ? answerWorkspace : null
    const blocked = notReady(provider)
    if (blocked) {
      setAnswered(null)
      setFailure({ ...blocked, workspace })
      return
    }
    const requested = currentSpec()
    const parentNodes = new Map(requested.nodes.map((node) => [node.id, node]))
    const controller = new AbortController()
    const serial = ++askCountRef.current
    askRef.current.set(serial, { id: selection.anchor.id, controller, selectedIds })
    const live = () => askRef.current.get(serial)?.controller === controller
    const startedAt = Date.now()
    setAnswered(null)
    setFailure(null)
    setSteps((all) => ({ ...all, [serial]: [] }))
    setAskings((list) => [...list, {
      id: selection.anchor.id,
      question: `Condense ${selection.nodes.length} nodes`,
      startedAt,
      provider: provider.id,
      name: provider.name,
      cli: provider.kind === "cli",
      workspace,
      web: false,
      serial,
      mode: "condense",
      selectedIds,
    }])
    try {
      const { parts } = await requestFlowCondense({
        provider,
        wsId: workspace,
        selection: {
          nodes: selection.nodes.map(({ id, label, detail }) => ({ id, label, detail })),
          edges: selection.edges,
          parents: selection.incoming.flatMap((edge) => {
            const parent = parentNodes.get(edge.from)
            return parent ? [{ id: parent.id, label: parent.label, detail: parent.detail, arrow: edge.label }] : []
          }),
          title: diagramName ?? meta.title,
          subtext: known.settings.subtext,
        },
      }, controller.signal, (step) => {
        if (live()) setSteps((all) => ({ ...all, [serial]: [...(all[serial] ?? []).slice(-49), step] }))
      })
      if (!live()) return
      const before = currentSpec()
      let unchanged = false
      try {
        unchanged = wiring() === initialWiring && inspectFlowCondenseSelection(before, selectedIds).fingerprint === selection.fingerprint
      } catch { /* A selected node was removed or the discussion was disconnected. */ }
      if (!unchanged) {
        setFailure({ message: "The selected discussion changed while condensing. Select it again and retry." })
        return
      }
      const { spec: condensed, addedIds } = replaceFlowSelection(
        before,
        selectedIds,
        parts,
        nodesRef.current.map((node) => node.id),
      )
      const next = toCanvas(condensed)
      const removed = new Set(selectedIds)
      const originals = new Map(nodesRef.current.map((node) => [node.id, node]))
      const quiet =
        (editingRef.current !== null && !removed.has(editingRef.current)) ||
        isTextField(document.activeElement) ||
        toolRef.current === "hand" ||
        !nodesRef.current.some((node) => node.selected && removed.has(node.id)) ||
        nodesRef.current.some((node) => node.selected && !removed.has(node.id)) ||
        edgesRef.current.some((edge) => edge.selected && !removed.has(edge.source) && !removed.has(edge.target))
      // Take the snapshot of the canvas at completion, so Undo also preserves
      // work done elsewhere while the AI was thinking.
      latestRef.current = JSON.stringify(before)
      record()
      lastRecordAt.current = 0
      if (editingRef.current !== null && removed.has(editingRef.current)) changeEditing(null)
      const added = new Set(addedIds)
      const appliedNodes: Node[] = next.nodes.map((node) => {
        const original = originals.get(node.id)
        return original
          ? { ...original, position: node.position, selected: quiet && original.selected }
          : { ...node, selected: !quiet && added.has(node.id) }
      })
      // Empty free text is intentionally omitted from a saved spec. It is
      // still an in-progress editor node and must survive work elsewhere.
      const savedIds = new Set(before.nodes.map((node) => node.id))
      const unsavedNodes = nodesRef.current.filter((node) => !removed.has(node.id) && !savedIds.has(node.id))
      appliedNodes.push(...unsavedNodes)
      // Keep surviving arrows' UI state and IDs, giving each replacement a
      // fresh ID so React Flow cannot reuse an old arrow's selection.
      const surviving = edgesRef.current.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))
      const edgeKey = (edge: Edge) => {
        const data = edge.data as FlowEdgeData | undefined
        return JSON.stringify([edge.source, edge.target, edge.sourceHandle, edge.targetHandle, data?.label ?? "", data?.dashed === true, data?.collapsed === true])
      }
      const byConnection = new Map<string, Edge[]>()
      for (const edge of surviving) {
        const key = edgeKey(edge)
        byConnection.set(key, [...(byConnection.get(key) ?? []), edge])
      }
      const appliedEdges = next.edges.map((edge) => {
        const original = byConnection.get(edgeKey(edge))?.shift()
        return original ? { ...original, selected: quiet && original.selected } : { ...edge, id: newEdgeId() }
      })
      const unsavedIds = new Set(unsavedNodes.map((node) => node.id))
      for (const edge of edgesRef.current) {
        if (!unsavedIds.has(edge.source) && !unsavedIds.has(edge.target)) continue
        if (removed.has(edge.target)) {
          appliedEdges.push(...addedIds.map((id) => ({ ...edge, id: newEdgeId(), target: id, selected: false })))
        } else if (removed.has(edge.source)) {
          appliedEdges.push({ ...edge, id: newEdgeId(), source: addedIds[addedIds.length - 1], selected: false })
        } else appliedEdges.push(edge)
      }
      for (const id of removed) tabMovesRef.current.delete(id)
      for (const pending of tabMovesRef.current.values()) {
        for (const node of appliedNodes) {
          const previous = originals.get(node.id)
          if (!previous || previous.position.x !== node.position.x || previous.position.y !== node.position.y) pending.delete(node.id)
        }
      }
      nodesRef.current = appliedNodes
      edgesRef.current = appliedEdges
      latestRef.current = canvasJson(meta, appliedNodes, appliedEdges)
      setNodes(appliedNodes)
      setEdges(appliedEdges)
      setAnswerNote({ by: provider.name, files: null, seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)), condensed: selectedIds.length })
      setAnswered(addedIds.length)
      if (!quiet) {
        settleSelection()
        const summaries = appliedNodes.filter((node) => added.has(node.id))
        const left = Math.min(...summaries.map((node) => node.position.x))
        const top = Math.min(...summaries.map((node) => node.position.y))
        reveal({ x: left, y: top, width: Math.max(...summaries.map((node) => node.position.x + (node.width ?? FLOW_NODE_WIDTH))) - left, height: Math.max(...summaries.map((node) => node.position.y + (node.height ?? 0))) - top })
      }
    } catch (err) {
      if (live()) setFailure({ message: err instanceof Error ? err.message : "Couldn't condense that discussion", code: err instanceof AnswerError ? err.code : undefined, workspace })
    } finally {
      if (live()) {
        askRef.current.delete(serial)
        doneAsking(serial)
      }
    }
  }

  // An answer off the list, with what its CLI did.
  function doneAsking(serial: number) {
    setAskings((list) => list.filter((entry) => entry.serial !== serial))
    setSteps((all) => {
      const { [serial]: _gone, ...rest } = all
      return rest
    })
  }

  // Stop, or Escape: drops the answer `id` is waiting for, and cancels the
  // request so it stops costing anything. Switchboard: with no box named,
  // every answer on its way.
  function stopAsking(id?: string): boolean {
    let stopped = false
    for (const [serial, run] of [...askRef.current]) {
      if (id !== undefined && run.id !== id && !run.selectedIds?.includes(id)) continue
      askRef.current.delete(serial)
      run.controller.abort()
      doneAsking(serial)
      stopped = true
    }
    return stopped
  }

  // An answer onto the canvas: a box per part, each joined to the question's
  // right side and placed as Tab would place it, the branch re-centred around
  // them — all one undo step. They arrive selected, so the toolbar restyles
  // them or ⌫ throws them away; but if you are typing somewhere by then, they
  // go in without taking the keyboard, the selection or the view from you.
  // Switchboard: each box carries the workspace a CLI read for it (`workspace`, taken
  // when it was asked) — the tag under its corner. Null for an API's answer.
  function addAnswers(parentId: string, parts: FlowAiPart[], workspace: string | null) {
    // Switchboard: answering a detached box makes it a branch again.
    const settle = (node: Node) => (node.id === parentId ? attached(node) : node)
    const current = nodesRef.current.map(settle)
    if (!current.some((node) => node.id === parentId)) {
      toast({ title: "The answer arrived after its box was deleted, so it wasn't added" })
      return
    }
    latestRef.current = canvasJson(meta, nodesRef.current, edgesRef.current)
    record()
    // Its own step, apart from whatever was typed just before it landed.
    lastRecordAt.current = 0
    const taken = current.map((node) => node.id)
    const fresh = parts.map((part) => {
      const box: FlowBoxNodeData = {
        ...plainBox({ label: part.label, shape: "rounded", tone: "default" }),
        detail: part.detail,
        ai: true,
        answeredIn: workspace ?? undefined,
      }
      const id = nextFlowNodeId(taken, part.label)
      taken.push(id)
      return { id, box, ...boxSize(box) }
    })
    const shown = showing(current, edgesRef.current)
    const { positions, moved } = placeTabChildren(
      shown.boxes,
      shown.edges,
      parentId,
      fresh.map(({ id, width, height }) => ({ id, width, height })),
    )
    // Switchboard: nor while something other than the question is selected —
    // with several answers on their way, the box you moved on to (and asked
    // about next, perhaps) keeps the selection and the view.
    const quiet =
      editingRef.current !== null ||
      isTextField(document.activeElement) ||
      toolRef.current === "hand" ||
      current.some((node) => node.selected && node.id !== parentId) ||
      edgesRef.current.some((edge) => edge.selected)
    const added: Node[] = fresh.map(({ id, box, width, height }) => ({
      id,
      type: EDIT_NODE_TYPE,
      position: positions.get(id) ?? { x: 0, y: 0 },
      width,
      height,
      data: box,
      selected: !quiet,
    }))
    const arrows = fresh.map(({ id }) =>
      editableEdge(
        { id: newEdgeId(), source: parentId, target: id, sourceHandle: "right", targetHandle: "left" },
        { dashed: false },
      ),
    )
    const shift = (node: Node) => {
      const to = moved.get(node.id)
      const box = settle(node)
      return to ? { ...box, position: to } : box
    }
    // A free text Tab added and still empty puts the boxes it moved back when
    // it goes; not the ones the answer has just placed since.
    for (const pending of tabMovesRef.current.values()) {
      for (const id of moved.keys()) pending.delete(id)
    }
    // Switchboard: answers and condensations can land together. Publish both
    // halves to the refs immediately so the next completion sees every arrow.
    const nextNodes = [...(quiet ? current : deselected(current)).map(shift), ...added]
    const nextEdges = [...(quiet ? edgesRef.current : deselected(edgesRef.current)), ...arrows]
    nodesRef.current = nextNodes
    edgesRef.current = nextEdges
    latestRef.current = canvasJson(meta, nextNodes, nextEdges)
    setNodes(nextNodes)
    setEdges(nextEdges)
    setAnswered(added.length)
    // Nor the view, which would carry the box being typed in off screen.
    if (quiet) return
    settleSelection()
    const left = Math.min(...added.map((node) => node.position.x))
    const top = Math.min(...added.map((node) => node.position.y))
    reveal({
      x: left,
      y: top,
      width: Math.max(...added.map((node) => node.position.x + (node.width ?? 0))) - left,
      height: Math.max(...added.map((node) => node.position.y + (node.height ?? 0))) - top,
    })
  }

  // ─── Switchboard: folding a node's outgoing branches ───

  // What the collapsed arrows hide, and the canvas React Flow is handed: the
  // same boxes and arrows with the folded ones marked hidden (it draws no arrow
  // to or from a hidden box). The editor's own state never holds `hidden`; it
  // is worked out from the arrows every time.
  const fold = useMemo(() => foldOf(nodes, edges), [nodes, edges])
  const shownNodes = useMemo(
    () =>
      fold.hidden.size === 0
        ? nodes
        : nodes.map((node) => (fold.hidden.has(node.id) ? { ...node, hidden: true } : node)),
    [nodes, fold],
  )
  const shownEdges = useMemo(
    () =>
      edges.some(isCollapsed)
        ? edges.map((edge) =>
            isCollapsed(edge) || fold.hidden.has(edge.source) || fold.hidden.has(edge.target)
              ? { ...edge, hidden: true }
              : edge,
          )
        : edges,
    [edges, fold],
  )
  // The toolbar and visible +N badges use the same groups as the fold action.
  // Deduplicate shared descendants, including nested and older partial folds.
  // Keep the context stable while nodes are dragged without changing counts.
  const foldsJson = useMemo(() => {
    const groups = flowNodeFoldGroups(
      nodes.map((node) => node.id),
      edges.map((edge) => ({ source: edge.source, target: edge.target, collapsed: isCollapsed(edge) })),
    )
    const result: [string, FoldBadge][] = []
    for (const [id, indexes] of groups) {
      if (fold.hidden.has(id)) continue
      let arrows = 0
      const boxes = new Set<string>()
      for (const index of indexes) {
        if (!isCollapsed(edges[index])) continue
        arrows += 1
        for (const box of fold.folded.get(index) ?? []) boxes.add(box)
      }
      result.push([id, { boxes: boxes.size, arrows, total: indexes.length }])
    }
    return JSON.stringify(result)
  }, [fold, edges, nodes])
  const folds = useMemo(() => new Map(JSON.parse(foldsJson) as [string, FoldBadge][]), [foldsJson])

  // One node click closes every direct branch, or reopens them all. Fold flags
  // remain on the edges so older diagrams (including partial folds) load as
  // they were. The whole action is one undo step and one layout pass.
  //
  // Switchboard: the change itself is commitFold — the arrows at `toggled` collapsed
  // (or opened), the trees of `anchors` laid out again — which revealTerminal's
  // unfoldTo shares.
  const commitFold = useCallback(
    (
      toggled: ReadonlySet<number>,
      collapsed: boolean,
      anchors: string[],
      hiddenAfter: ReadonlySet<string>,
      newlyShown: Iterable<string>,
    ) => {
      const current = nodesRef.current
      const before = edgesRef.current
      const next = before.map((edge, index) => {
        const folded = toggled.has(index)
          ? editableEdge(edge, { ...(edge.data as FlowEdgeData), collapsed: collapsed || undefined })
          : edge
        return toggled.has(index) || hiddenAfter.has(edge.source) || hiddenAfter.has(edge.target)
          ? { ...folded, selected: false }
          : folded
      })
      record()
      const shown = showing(current, next, new Set(hiddenAfter))
      const moved = tidyFlowTree(
        shown.boxes,
        shown.edges,
        anchors,
        newlyShown,
        { pinImages: true },
      )
      for (const pending of tabMovesRef.current.values()) {
        for (const box of moved.keys()) pending.delete(box)
      }
      changeEditing(null)
      edgesRef.current = next
      setEdges(next)
      setNodes((now) =>
        carryFolded(
          now,
          now.map((node) => {
            const to = moved.get(node.id)
            const selected = Boolean(node.selected) && !hiddenAfter.has(node.id)
            if (!to && Boolean(node.selected) === selected) return node
            return { ...node, ...(to ? { position: to } : {}), selected }
          }),
          next,
        ),
      )
      settleSelection()
    },
    [record, changeEditing, settleSelection],
  )
  const toggleFold = useCallback(
    (id: string, expand = false) => {
      const action = toggleFlowNodeFold(
        nodesRef.current.map((node) => node.id),
        edgesRef.current.map((edge) => ({ source: edge.source, target: edge.target, collapsed: isCollapsed(edge) })),
        id,
        { expand },
      )
      if (!action.changed) return
      commitFold(new Set(action.edgeIndexes), action.collapsed, [id], action.hiddenAfter, action.newlyShown)
    },
    [commitFold],
  )
  const expandFold = useCallback((id: string) => toggleFold(id, true), [toggleFold])

  // Switchboard: opens whatever folds the box `id` away — the collapsed arrows out of
  // the showing box that hides it, as a click on its +N would, then those of the box
  // that brings into view, and so on in — as one fold change. Says whether `id` is
  // showing now. revealTerminal's: a pinned terminal can sit behind a fold, as any
  // box an arrow points at can.
  function unfoldTo(id: string): boolean {
    const ids = nodesRef.current.map((node) => node.id)
    let arrows: FlowFoldEdge[] = edgesRef.current.map((edge) => ({
      source: edge.source,
      target: edge.target,
      collapsed: isCollapsed(edge),
    }))
    const before = foldFlow(ids, arrows).hidden
    let hidden = before
    const toggled = new Set<number>()
    const anchors: string[] = []
    for (let step = 0; step < arrows.length && hidden.has(id); step += 1) {
      const { folded } = foldFlow(ids, arrows)
      const index = arrows.findIndex(
        (arrow, at) => arrow.collapsed === true && !hidden.has(arrow.source) && (folded.get(at)?.has(id) ?? false),
      )
      if (index < 0) break
      const action = toggleFlowNodeFold(ids, arrows, arrows[index].source, { expand: true })
      if (!action.changed) break
      for (const at of action.edgeIndexes) toggled.add(at)
      anchors.push(arrows[index].source)
      arrows = action.edges
      hidden = action.hiddenAfter
    }
    if (toggled.size > 0) {
      commitFold(toggled, false, anchors, hidden, [...before].filter((box) => !hidden.has(box)))
    }
    return !hidden.has(id)
  }

  // The boxes folded away behind any of `going`, which go with them.
  function foldedBehind(going: Node[]): Node[] {
    const ids = new Set(going.map((node) => node.id))
    const list = edgesRef.current
    const { folded } = foldOf(nodesRef.current, list)
    const behind = new Set<string>()
    for (const [index, boxes] of folded) {
      if (!ids.has(list[index].source)) continue
      for (const box of boxes) if (!ids.has(box)) behind.add(box)
    }
    return nodesRef.current.filter((node) => behind.has(node.id))
  }

  // Where each answer will land, while it is awaited: right of the question,
  // under any answers it already has — worked out from the canvas as it is
  // now, so it follows the question if moved. (Where the branch is re-centred
  // to once the answer is in isn't shown: it would sit on the answers there.)
  const ghosts = useMemo(() => askings.flatMap((asking) => {
    if (asking.mode === "condense") return []
    const parent = nodes.find((node) => node.id === asking.id)
    if (!parent) return []
    // The boxes hanging off it the way Tab hangs them: right side to left
    // side, onto a box further right.
    const children = edges
      .filter(
        (edge) =>
          edge.source === parent.id && edge.sourceHandle === "right" && edge.targetHandle === "left",
      )
      .map((edge) => nodes.find((node) => node.id === edge.target))
      .filter(
        (node): node is Node =>
          node !== undefined && !fold.hidden.has(node.id) && node.position.x > parent.position.x,
      )
      .map(rectOf)
    const position = nextChildPosition(
      rectOf(parent),
      children,
      nodes.filter((node) => !fold.hidden.has(node.id)).map(rectOf),
      ANSWER_GHOST_SIZE,
    )
    const from = rectOf(parent)
    const [path] = getSmoothStepPath({
      sourceX: from.x + from.width,
      sourceY: from.y + from.height / 2,
      sourcePosition: Position.Right,
      targetX: position.x,
      targetY: position.y + ANSWER_GHOST_SIZE.height / 2,
      targetPosition: Position.Left,
    })
    return [{ serial: asking.serial, rect: { ...position, ...ANSWER_GHOST_SIZE }, path, workspace: asking.workspace }]
  }), [askings, nodes, edges, fold])

  // What the canvas accepts dropped on it: a box, note or text dragged off
  // the toolbar, or picture files from the desktop. Switchboard: or a picture's
  // address, dragged out of the Google Images panel or a browser — which a box's
  // own text field keeps for itself, as words.
  function onDragOver(event: React.DragEvent) {
    const types = event.dataTransfer.types
    if (!types.includes(DRAG_MIME) && !types.includes("Files") && !isAddressDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  /**
   * Switchboard: a drag that may be a picture's address, over the canvas proper.
   * "Files" beside it doesn't rule it out — a page's drag may list one it never
   * hands over — so a drop takes the files when there are any, and else this.
   */
  function isAddressDrag(event: React.DragEvent): boolean {
    const types = event.dataTransfer.types
    return !types.includes(DRAG_MIME) && isUrlDrag(types) && !isTextField(event.target)
  }

  // Switchboard: the ring shows for a picture — files, or an address — and not
  // for a box dragged off the toolbar, which is already part of the canvas.
  function onDragEnter(event: React.DragEvent) {
    const types = event.dataTransfer.types
    if (types.includes(DRAG_MIME) || !(types.includes("Files") || isUrlDrag(types))) return
    dragDepthRef.current += 1
    setDropping(true)
  }

  function onDragLeave() {
    if (dragDepthRef.current === 0) return
    dragDepthRef.current -= 1
    if (dragDepthRef.current === 0) setDropping(false)
  }

  // On the wrapper, for a drop anywhere in the canvas, and for a drag given up.
  function endDrag() {
    dragDepthRef.current = 0
    setDropping(false)
  }

  function onDrop(event: React.DragEvent) {
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const files = [...event.dataTransfer.files]
    if (files.length > 0) {
      event.preventDefault()
      void addImages(files, at)
      return
    }
    if (isAddressDrag(event)) {
      // Switchboard: ALWAYS taken, picture or not. Let through, the window would
      // navigate to the address — which main would open in the browser instead.
      event.preventDefault()
      const urls = imageUrlsFromDrop({
        uriList: event.dataTransfer.getData("text/uri-list"),
        html: event.dataTransfer.getData("text/html"),
        plain: event.dataTransfer.getData("text/plain"),
      })
      if (urls.length > 0) void addImageFromUrl(urls, at)
      else {
        toast({
          title: "Couldn't add that image",
          description: "There's no picture in what was dropped",
          variant: "error",
        })
      }
      return
    }
    const dropped = event.dataTransfer.getData(DRAG_MIME)
    const shape =
      dropped === "note" || dropped === "text" || dropped === "document"
        ? dropped
        : FLOW_BOX_SHAPES.find((option) => option === dropped)
    if (!shape) return
    event.preventDefault()
    placeNew(shape, at)
    setTool("select")
  }

  // The arrow's label field, in its toolbar — at once when the toolbar is
  // already up, otherwise once it has rendered.
  function focusEdgeLabel() {
    const field = () =>
      wrapperRef.current?.querySelector<HTMLInputElement>("[data-flow-edge-label]")
    const now = field()
    if (now) now.focus()
    else requestAnimationFrame(() => field()?.focus())
  }

  // ─── Switchboard: pinned terminals ───

  const onTerminalFloatRef = useRef(onTerminalFloat)
  useEffect(() => {
    onTerminalFloatRef.current = onTerminalFloat
  })

  /** The board's pinned terminal for `wsId` — there is never more than one. */
  function terminalNodeFor(wsId: string): Node | undefined {
    return nodesRef.current.find((node) => isTerminal(node) && terminalWorkspace(node) === wsId)
  }

  // Folds a pinned terminal to its title bar, or opens it out again — in place, as
  // one undo step.
  const setTerminalMinimized = useCallback((id: string, minimized: boolean) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id)
    if (!node || !isTerminal(node)) return
    if (((node.data as FlowBoxNodeData).minimized === true) === minimized) return
    record()
    lastRecordAt.current = 0
    const apply = (current: Node[]) =>
      current.map((candidate) =>
        candidate.id === id
          ? withBox(candidate, { ...(candidate.data as FlowBoxNodeData), minimized: minimized || undefined })
          : candidate,
      )
    nodesRef.current = apply(nodesRef.current)
    latestRef.current = canvasJson(meta, nodesRef.current, edgesRef.current)
    setNodes(apply)
  }, [record, meta])

  const terminalContext = useMemo<TerminalContextValue>(
    () => ({
      status: workspaceStatus,
      gone: (wsId) => terminalGone(wsId, choices, freshPins),
      float: (wsId) => onTerminalFloatRef.current(wsId),
      toggleMinimized: (id) => {
        const node = nodesRef.current.find((candidate) => candidate.id === id)
        if (node) setTerminalMinimized(id, (node.data as FlowBoxNodeData).minimized !== true)
      },
      // As Delete would: one undo step, and the host closes the terminal.
      close: (id) => void deleteElements({ nodes: [{ id }] }),
      // To the zoom its type reads at the Terminal tab's size, centred on it.
      zoomTo: (id) => {
        const node = nodesRef.current.find((candidate) => candidate.id === id)
        if (!node) return
        const rect = rectOf(node)
        const font = (node.data as FlowBoxNodeData).font ?? TERMINAL_BASE_FONT
        const zoom = clampNumber(TERMINAL_BASE_FONT / font, FIT_VIEW_OPTIONS.minZoom, 2.5)
        void setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, { zoom, duration: 200 })
      },
      startResize: (id) => {
        terminalResizingRef.current = id
        scheduleSlots()
      },
      endResize: (id) => {
        if (terminalResizingRef.current !== id) return
        terminalResizingRef.current = null
        scheduleSlots()
      },
    }),
    [workspaceStatus, choices, freshPins, setTerminalMinimized, deleteElements, setCenter, scheduleSlots],
  )

  // The handle's pinTerminal: the floating panel's rect becomes a node in the same
  // place on screen, its type the same size — so the shell needs no resize. Given
  // where the live terminal sits inside the panel (`body`), the node is fitted round
  // that instead: computeSlots' body worked backwards — the header above it, the
  // inset on the other three sides — so the text itself doesn't move by a pixel.
  // Never clamped up to what the resize handles allow: at a high zoom that would
  // make the node bigger on screen than the panel it replaces.
  function pinTerminal(wsId: string, rect: ClientRect, body?: ClientRect | null): boolean {
    if (normalizeWorkspaceId(wsId) !== wsId) return false
    if (terminalNodeFor(wsId)) {
      revealTerminal(wsId)
      return false
    }
    const zoom = store.getState().transform[2]
    const outer: ClientRect | null = isClientRect(body)
      ? {
          left: body.left - TERMINAL_BODY_INSET,
          top: body.top - TERMINAL_HEADER * zoom,
          width: body.width + TERMINAL_BODY_INSET * 2,
          height: body.height + TERMINAL_HEADER * zoom + TERMINAL_BODY_INSET,
        }
      : isClientRect(rect)
        ? rect
        : null
    // Nowhere on screen to put it: nothing is pinned, and the panel stays.
    if (outer === null || !(zoom > 0)) return false
    const at = screenToFlowPosition({ x: outer.left, y: outer.top }, { snapToGrid: false })
    const box: FlowBoxNodeData = {
      ...plainBox({ label: wsId, shape: "terminal", tone: "default" }),
      workspace: wsId,
      // Whole canvas units, as the spec keeps them — so undo and a reopen give back
      // this very node — rounded up, so the body is never less than the grid of
      // rows and columns the terminal keeps (exact at zoom 1; at another zoom, under
      // a unit more on the right and at the foot, never anywhere the text is).
      size: {
        width: wholeUp(clampNumber(outer.width / zoom, FLOW_TERMINAL_FLOOR.width, FLOW_SIZE_MAX)),
        height: wholeUp(clampNumber(outer.height / zoom, FLOW_TERMINAL_FLOOR.height, FLOW_SIZE_MAX)),
      },
      font: roundTo(clampNumber(TERMINAL_BASE_FONT / zoom, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX), 3),
    }
    record()
    lastRecordAt.current = 0
    const node: Node = {
      id: nextFlowNodeId(nodesRef.current.map((other) => other.id), `terminal ${wsId}`),
      type: EDIT_NODE_TYPE,
      // Exactly where worked out above — not on the grid, which would nudge it.
      position: { x: at.x, y: at.y },
      ...boxSize(box),
      data: box,
    }
    // A workspace these choices don't list was just floated through the host's own
    // picker, so it is newer than them, not gone: live meanwhile, and main asked.
    const over = choicesRef.current
    if (workspaceGone(wsId, over)) {
      const before = freshPinsRef.current
      const fresh: FreshPins = { over, ids: new Set([...(before.over === over ? before.ids : []), wsId]) }
      freshPinsRef.current = fresh
      setFreshPins(fresh)
      refreshChoices()
    }
    nodesRef.current = [...nodesRef.current, node]
    latestRef.current = canvasJson(meta, nodesRef.current, edgesRef.current)
    setNodes((current) => [...current, node])
    scheduleSlots()
    return true
  }

  // The handle's unpinTerminal: off the board, as one undo step, saying where it was
  // so the floating panel can take its place. Not a delete — the host hears nothing
  // more about it (onTerminalRemoved is for every other way a terminal leaves).
  function unpinTerminal(wsId: string): ClientRect | null {
    const node = terminalNodeFor(wsId)
    if (!node) return null
    const rect = clientRectOf(node)
    record()
    lastRecordAt.current = 0
    const keep = (current: Node[]) => current.filter((candidate) => candidate.id !== node.id)
    const unwire = (current: Edge[]) =>
      current.filter((edge) => edge.source !== node.id && edge.target !== node.id)
    nodesRef.current = keep(nodesRef.current)
    edgesRef.current = unwire(edgesRef.current)
    latestRef.current = canvasJson(meta, nodesRef.current, edgesRef.current)
    setNodes(keep)
    setEdges(unwire)
    scheduleSlots()
    return rect
  }

  // The handle's revealTerminal: a tray chip or Open terminal… for a pinned one —
  // restored if it was minimized (one undo step), selected, and panned into view.
  function revealTerminal(wsId: string): boolean {
    const node = terminalNodeFor(wsId)
    if (!node) return false
    // One whose workspace had left the rail may be back in it (the host just offered
    // it): main is asked, and its answer brings the terminal back to life.
    if (workspaceGone(wsId, choicesRef.current)) refreshChoices()
    // Folded away behind a collapsed arrow (one can point at a terminal): opened
    // first. A node that can't be brought into view is never selected — the next
    // Delete would take what nobody can see.
    if (!unfoldTo(node.id)) return false
    if ((node.data as FlowBoxNodeData).minimized) setTerminalMinimized(node.id, false)
    const shown = nodesRef.current.find((candidate) => candidate.id === node.id) ?? node
    changeEditing(null)
    if (tool === "hand") setTool("select")
    select(shown)
    reveal(rectOf(shown))
    return true
  }

  useEffect(() => {
    terminalsRef.current = {
      pin: pinTerminal,
      unpin: unpinTerminal,
      reveal: revealTerminal,
      slots: computeSlots,
    }
  })

  // ─── Switchboard: the workspace ✦ Answer reads ───

  // "Choose workspace…" in the strip opens the who-answers menu over the box that
  // asked, with its picker already showing. A box that is gone (or folded away) has
  // no menu to open, so the picker opens over the strip instead.
  const [aiMenuRequest, setAiMenuRequest] = useState(0)
  const aiMenuTakenRef = useRef(0)
  const takeAiMenuRequest = useCallback((serial: number) => {
    if (serial <= aiMenuTakenRef.current) return false
    aiMenuTakenRef.current = serial
    return true
  }, [])
  const pickerFirstRef = useRef(false)
  const takePickerFirst = useCallback(() => {
    const first = pickerFirstRef.current
    pickerFirstRef.current = false
    return first
  }, [])
  const [stripPicker, setStripPicker] = useState(false)

  const aiMenuSerialRef = useRef(0)

  function chooseWorkspace() {
    const asked = failure?.nodeId
      ? nodesRef.current.find((node) => node.id === failure.nodeId)
      : undefined
    // Its toolbar offers who answers only while the box is idle: one being answered
    // shows Stop, and one in a condense on its way shows Condense — no menu there to
    // take the request, so the picker opens over the strip, as for a box that's gone.
    if (
      !asked ||
      !hasText(asked.data as FlowBoxNodeData) ||
      fold.hidden.has(asked.id) ||
      answeringIds.has(asked.id)
    ) {
      setStripPicker(true)
      return
    }
    changeEditing(null)
    if (tool !== "select") setTool("select")
    select(asked)
    pickerFirstRef.current = true
    // Once the toolbar has come up over the box — and the view stopped, if it had to
    // move: the menu closes whenever the toolbar moves.
    const delay = reveal(rectOf(asked)) ? 260 : 60
    const serial = (aiMenuSerialRef.current += 1)
    setTimeout(() => setAiMenuRequest(serial), delay)
    // Not taken (the box was unselected first): the request lapses — counted as
    // taken, or the next who-answers menu to come up (the box selected again, maybe
    // minutes later) would open by itself — and the next menu opened by hand opens as
    // it always does.
    setTimeout(() => {
      if (aiMenuTakenRef.current < serial) aiMenuTakenRef.current = serial
      if (aiMenuSerialRef.current === serial) pickerFirstRef.current = false
    }, delay + 1_000)
  }

  function pickAnswerWorkspace(wsId: string) {
    setStripPicker(false)
    // Fixed now, so the strip's "Pick a workspace" isn't left saying so.
    if (failure?.code === "no-workspace") setFailure(null)
    onAnswerWorkspaceChange(wsId)
  }

  // What the who-answers menu shows and changes about the board's workspace.
  const answerWorkspaceBar = {
    workspace: answerWorkspace,
    workspaceGone: answerWorkspaceGone,
    choices,
    refreshChoices,
    workspaceStatus,
    onWorkspace: pickAnswerWorkspace,
    openRequest: aiMenuRequest,
    takeOpenRequest: takeAiMenuRequest,
    takePickerFirst,
  }

  // Where Open Terminal (a CLI to sign in) goes: the workspace the answer was to
  // read, or the board's — and only one still in the rail.
  const failureTerminalCandidate = failure?.workspace ?? answerWorkspace
  const failureTerminal =
    failureTerminalCandidate && !workspaceGone(failureTerminalCandidate, choices)
      ? failureTerminalCandidate
      : null

  // ─── what is selected ───

  const selectedNodes = nodes.filter((node) => node.selected)
  const selectedEdges = edges.filter((edge) => edge.selected)
  const selectedIds = selectedNodes.map((node) => node.id)
  const condensingSelection = askings.find((entry) => entry.selectedIds?.some((id) => selectedIds.includes(id)))
  const condenseProblem = useMemo(() => {
    if (selectedNodes.length < 2) return null
    try {
      inspectFlowCondenseSelection(JSON.parse(json) as FlowSpec, selectedNodes.map((node) => node.id))
      return null
    } catch (err) {
      return err instanceof Error ? err.message : "Select a connected discussion to condense"
    }
  }, [json, nodes])
  const soleNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null
  // Each in its own memo, so the context below can depend on a plain string.
  const soleNodeId = useMemo(() => {
    if (edges.some((edge) => edge.selected)) return null
    const ids = nodes.filter((node) => node.selected).map((node) => node.id)
    return ids.length === 1 ? ids[0] : null
  }, [nodes, edges])
  const soleEdgeId = useMemo(() => {
    if (nodes.some((node) => node.selected)) return null
    const ids = edges.filter((edge) => edge.selected).map((edge) => edge.id)
    return ids.length === 1 ? ids[0] : null
  }, [nodes, edges])
  const editingNode =
    editingId === null ? null : (nodes.find((node) => node.id === editingId) ?? null)
  // Switchboard: the CLI answer whose steps the card over the strip follows —
  // the selected box's, or else the one asked for last.
  const followed = useMemo(() => {
    // A CLI from the start; an API once it has gone on the web, the one step it reports.
    const shown = askings.filter((entry) => entry.mode === "condense" || entry.cli || (steps[entry.serial]?.length ?? 0) > 0)
    return shown.find((entry) => entry.id === soleNodeId) ?? shown[shown.length - 1] ?? null
  }, [askings, soleNodeId, steps])

  function deleteSelection() {
    void deleteElements({ nodes: selectedNodes, edges: selectedEdges })
  }

  // Switchboard: a box deleted from a branch Tab built takes its gap with it —
  // what is left of the tree closes up and re-centres on the boxes it hangs
  // off, as Tab would have laid it out (tidyAfterDelete). Called just before
  // React Flow removes them, so it is the same undo step as the delete.
  function closeUp(going: Node[], goingEdges: Edge[]) {
    if (going.length === 0) return
    const cut = new Set(goingEdges.map((edge) => edge.id))
    const shown = showing(nodesRef.current, edgesRef.current)
    const moved = tidyAfterDelete(
      shown.boxes,
      shown.edges,
      new Set(going.map((node) => node.id)),
      shown.edges.filter((edge) => !cut.has(edge.id)),
    )
    if (moved.size === 0) return
    // A free text Tab added and still empty puts the boxes it moved back when
    // it goes; not the ones that have just closed up since.
    for (const pending of tabMovesRef.current.values()) {
      for (const id of moved.keys()) pending.delete(id)
    }
    setNodes((now) =>
      now.map((node) => {
        const to = moved.get(node.id)
        return to ? { ...node, position: to } : node
      }),
    )
  }

  // ─── keyboard ───

  // Tab and Shift+Tab work from the box being typed in, or the one selected.
  function tab(back: boolean): boolean {
    const current = editingNode ?? soleNode
    if (!current) return false
    // A free text with nothing in it yet is about to go (it's removed as
    // editing moves off it), so nothing hangs off it — the key is spent.
    const box = current.data as FlowBoxNodeData
    if (!back && isText(box) && !box.label.trim() && !box.detail?.trim()) return true
    if (back) stepBack(current.id)
    else addChild(current)
    return true
  }

  // Enter opens the selection for typing: a box's text, an arrow's label. With
  // a placing tool out it places that in the middle of the view instead —
  // the keyboard's way to put the first thing on an empty canvas.
  function editSelection(): boolean {
    if (placing) {
      placeAtCentre()
      return true
    }
    if (soleNode) {
      if ((soleNode.data as FlowBoxNodeData).shape === "document") { openDocument(soleNode); return true }
      if (!hasText(soleNode.data as FlowBoxNodeData)) return false
      changeEditing(soleNode.id)
      return true
    }
    if (soleEdgeId) {
      focusEdgeLabel()
      return true
    }
    return false
  }

  const shortcutsRef = useRef<{
    undo: () => void
    redo: () => void
    flush: () => Promise<void>
    tab: (back: boolean) => boolean
    editSelection: () => boolean
    go: (direction: FlowDirection) => boolean
    nudge: (direction: FlowDirection) => boolean
    clearSelection: () => boolean
    duplicate: () => boolean
    tool: (key: string) => boolean
    paste: (files: File[]) => void
    answer: () => boolean
    escapeAsking: () => boolean
    copy: () => boolean
    cut: () => boolean
    pasteBoxes: (text: string) => boolean
  }>({
    undo,
    redo,
    flush,
    tab,
    editSelection,
    go,
    nudge,
    clearSelection,
    duplicate: () => false,
    tool: () => false,
    paste: () => {},
    answer: () => false,
    escapeAsking: () => false,
    copy: () => false,
    cut: () => false,
    pasteBoxes: () => false,
  })
  useEffect(() => {
    shortcutsRef.current = {
      undo,
      redo,
      flush,
      tab,
      editSelection,
      go,
      nudge,
      clearSelection,
      duplicate: () => {
        if (!soleNode || editingNode) return false
        duplicate(soleNode)
        return true
      },
      // A tool's letter, or Escape to put a placing tool (or the hand) away.
      tool: (key) => {
        if (key === "Escape") {
          if (tool === "select") return false
          setTool("select")
          return true
        }
        const next = TOOL_KEYS[key]
        if (next === undefined) return false
        if (next === "image") pickImages()
        // Switchboard: G opens Google Images.
        else if (next === "images") openImages()
        else chooseTool(next)
        return true
      },
      paste: (files) => void addImages(files),
      copy: copyBoxes,
      cut: () => {
        if (!copyBoxes()) return false
        deleteSelection()
        return true
      },
      pasteBoxes,
      // ⌘↵ or ⌘I: ✦ Answer for the box selected — or the one being typed in, which
      // it finishes first.
      answer: () => {
        if (!editingNode && selectedNodes.length > 1) {
          if (condensingSelection || selectedIds.some(isAnswering)) return true
          void condense(selectedIds)
          return true
        }
        const current = editingNode ?? soleNode
        if (!current || !hasText(current.data as FlowBoxNodeData)) return false
        // Switchboard: one answer per box, any number of boxes at once — on
        // the box already being answered, the key just finishes the edit.
        changeEditing(null)
        if (isAnswering(current.id)) return true
        void ask(current)
        return true
      },
      escapeAsking: () => {
        if (askRef.current.size === 0) return false
        if (condensingSelection) return stopAsking(condensingSelection.id)
        // Switchboard: the selected box's answer — or, with nothing selected,
        // the one answer on its way. With several, Escape needs to know which.
        if (soleNode) return isAnswering(soleNode.id) && stopAsking(soleNode.id)
        const anything = nodes.some((node) => node.selected) || edges.some((edge) => edge.selected)
        if (anything || askRef.current.size > 1) return false
        return stopAsking()
      },
    }
  })

  useEffect(() => {
    if (!keyboardEnabled) return
    // The canvas's keys only apply while focus is on the canvas — or nowhere
    // in particular (the page, or the full-screen pane around the canvas) —
    // so they never hijack Tab from the rest of the page.
    function onCanvas(target: EventTarget | null): boolean {
      const wrapper = wrapperRef.current
      if (!wrapper || !(target instanceof globalThis.Node)) return false
      return target === document.body || wrapper.contains(target) || target.contains(wrapper)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest("[data-flow-document-panel]")) return
      const shortcuts = shortcutsRef.current
      const inField = isTextField(event.target)
      const inControl =
        event.target instanceof Element &&
        Boolean(event.target.closest("button, a, [role=button], [role=radio], [role=menuitem]"))
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey

      if (event.key === "Tab" && plain && !event.isComposing) {
        // List fields consume Tab first, including at an indentation limit.
        // Only an unhandled Tab from a box's text reaches the canvas behavior.
        if (event.defaultPrevented) return
        const boxText =
          event.target instanceof HTMLElement && event.target.dataset.flowText !== undefined
        if (inControl || (inField && !boxText) || !onCanvas(event.target)) return
        if (shortcuts.tab(event.shiftKey)) event.preventDefault()
        return
      }

      if (event.key === "Enter" && plain && !event.shiftKey && !inField) {
        // A focused button, menu item or option keeps its own Enter.
        if (!inControl && onCanvas(event.target) && shortcuts.editSelection()) {
          event.preventDefault()
        }
        return
      }

      if (plain && !event.shiftKey && !inField && event.key.length === 1) {
        if (!inControl && onCanvas(event.target) && shortcuts.tool(event.key.toLowerCase())) {
          event.preventDefault()
        }
        return
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      // ⌘S saves now, from anywhere — including mid-rename — instead of
      // opening the browser's "save page" dialog.
      if (key === "s") {
        event.preventDefault()
        void shortcuts.flush()
        return
      }
      // Switchboard: ⌘I answers too, exactly as ⌘↵ does.
      if ((key === "enter" || key === "i") && !event.shiftKey && !event.isComposing) {
        // A box's own text fields hand ⌘↵ and ⌘I to the canvas; other fields keep them.
        const boxText =
          event.target instanceof HTMLElement && event.target.dataset.flowText !== undefined
        if ((inField && !boxText) || !onCanvas(event.target)) return
        if (shortcuts.answer()) event.preventDefault()
        return
      }
      // Inside a text field, ⌘Z belongs to the field.
      if (inField) return
      if (key === "z" && !event.shiftKey) {
        event.preventDefault()
        shortcuts.undo()
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault()
        shortcuts.redo()
      } else if (key === "d" && !event.shiftKey && onCanvas(event.target)) {
        // Instead of the browser's "bookmark this page".
        if (shortcuts.duplicate()) event.preventDefault()
      }
    }

    // The arrows and Escape listen in the capture phase, ahead of the page's
    // own keys — ←/→ step between diagrams and Escape leaves full screen —
    // so that while something is selected, the canvas has them first.
    function onSelectionKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTextField(event.target) || !onCanvas(event.target)) return
      const inControl =
        event.target instanceof Element &&
        Boolean(event.target.closest("button, a, [role=button], [role=radio], [role=menuitem]"))
      const shortcuts = shortcutsRef.current
      const direction = ARROW_DIRECTIONS[event.key]
      if (direction) {
        if (inControl) return
        const handled = event.shiftKey ? shortcuts.nudge(direction) : shortcuts.go(direction)
        if (handled) event.preventDefault()
      } else if (
        event.key === "Escape" &&
        !event.shiftKey &&
        // An open menu or panel closes first (its own listener does that),
        // then a tool goes away, then an answer being waited for is stopped
        // (only from its own box, or with nothing selected — a deselecting
        // Escape mustn't throw away minutes of thinking), then the selection,
        // then (the page's own Escape) full screen.
        !wrapperRef.current?.querySelector("[data-flow-popover]") &&
        (shortcuts.tool("Escape") || shortcuts.escapeAsking() || shortcuts.clearSelection())
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    // A picture pasted while the canvas has the keyboard goes onto it. Text
    // pasted into a field is the field's.
    function onPaste(event: ClipboardEvent) {
      if (isTextField(event.target) || !onCanvas(event.target)) return
      const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
        file.type.startsWith("image/"),
      )
      if (files.length === 0) return
      event.preventDefault()
      shortcutsRef.current.paste(files)
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keydown", onSelectionKey, true)
    window.addEventListener("paste", onPaste)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keydown", onSelectionKey, true)
      window.removeEventListener("paste", onPaste)
    }
  }, [keyboardEnabled])

  // Re-frame the drawing when full screen changes the size of the pane. Not on
  // mount — the fitView prop has that covered.
  // Switchboard: animated here, a frame at a time, rather than by fitView's own
  // d3 transition — which measures the pane only as its first frame begins, a frame
  // or two after the call. A board taken off screen in between (left right after
  // full screen; the host leaving full screen for a board no longer on screen) was
  // interpolated over a pane of no size, and every frame of it was NaN. Here the
  // frame is worked out once, from the pane on screen, and each step is set
  // outright; a pane that goes away part-way jumps to the end, and one already off
  // screen is framed — at once, not animated — as soon as it is back.
  const refitRef = useRef<{ pending: boolean; stop: () => void }>({ pending: false, stop: () => {} })
  const paneOnScreen = useCallback((): HTMLElement | null => {
    const pane = store.getState().domNode
    return pane && pane.isConnected && pane.offsetWidth > 0 && pane.offsetHeight > 0 ? pane : null
  }, [store])
  const refit = useCallback(
    (animate: boolean) => {
      const state = refitRef.current
      state.stop()
      const pane = paneOnScreen()
      state.pending = pane === null
      if (pane === null) return
      // What fitView would land on: every box drawn, framed in the pane as it is now.
      const drawn = [...store.getState().nodeLookup.values()].filter(
        (node) => !node.hidden && node.measured.width && node.measured.height,
      )
      if (drawn.length === 0) return
      const width = pane.offsetWidth
      const height = pane.offsetHeight
      const to = getViewportForBounds(
        getNodesBounds(drawn),
        width,
        height,
        FIT_VIEW_OPTIONS.minZoom,
        FIT_VIEW_OPTIONS.maxZoom,
        FIT_VIEW_OPTIONS.padding,
      )
      const from = getViewport()
      if (!animate || !(from.zoom > 0)) {
        void setViewport(to)
        return
      }
      const start = performance.now()
      let last = from
      let frame = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      const stop = () => {
        cancelAnimationFrame(frame)
        if (timer !== null) clearTimeout(timer)
        frame = 0
        timer = null
        state.stop = () => {}
      }
      const step = () => {
        const now = getViewport()
        // Panned or zoomed by hand meanwhile: the hand wins.
        if (Math.abs(now.x - last.x) > 0.01 || Math.abs(now.y - last.y) > 0.01 || Math.abs(now.zoom - last.zoom) > 1e-4) {
          stop()
          return
        }
        const t = (performance.now() - start) / REFIT_DURATION_MS
        if (t >= 1 || paneOnScreen() === null) {
          stop()
          void setViewport(to)
          return
        }
        last = viewBetween(from, to, easeInOutCubic(t), width, height)
        void setViewport(last)
        frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
      // A hidden window draws no frames: it still ends up where it was going.
      timer = setTimeout(step, REFIT_DURATION_MS + 100)
      state.stop = stop
    },
    [paneOnScreen, store, getNodesBounds, getViewport, setViewport],
  )
  const fittedFor = useRef(fitKey)
  useEffect(() => {
    if (fittedFor.current === fitKey) return
    fittedFor.current = fitKey
    // A frame later, once the pane has its new size.
    const frame = requestAnimationFrame(() => refit(true))
    return () => cancelAnimationFrame(frame)
  }, [fitKey, refit])
  // A re-frame that found the board off screen waits for it to be back: shown again,
  // or the pane given a size again.
  useEffect(() => {
    const pane = wrapperRef.current
    let frame = 0
    const retry = () => {
      if (!refitRef.current.pending) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (refitRef.current.pending) refit(false)
      })
    }
    const back = new ResizeObserver(retry)
    if (pane) back.observe(pane)
    if (shown) retry()
    return () => {
      back.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [shown, refit])
  useEffect(() => {
    const state = refitRef.current
    return () => state.stop()
  }, [])

  const context = useMemo<EditorContextValue>(
    () => ({
      editingId,
      startEditing: (id) => changeEditing(id),
      stopEditing: (id) => changeEditing(null, id),
      updateNode,
      requestDetailFocus,
      takeDetailFocus,
      soleEdgeId,
      updateEdge,
      reverseEdge,
      deleteEdge,
      startResize,
      resize,
      soleNodeId,
      interactive: tool !== "hand",
      answeringIds,
      folds,
      expandFold,
    }),
    [
      editingId,
      changeEditing,
      updateNode,
      requestDetailFocus,
      takeDetailFocus,
      soleEdgeId,
      updateEdge,
      reverseEdge,
      deleteEdge,
      startResize,
      resize,
      soleNodeId,
      tool,
      answeringIds,
      folds,
      expandFold,
    ],
  )

  // The boxes the floating toolbar sits over: the one being typed in, or the
  // selection.
  const barNodes = editingNode ? [editingNode] : selectedNodes
  // Switchboard: a pinned terminal has its own buttons in its header; with nothing
  // but terminals selected there is nothing for the toolbar to offer.
  const terminalsOnly =
    !editingNode && selectedEdges.length === 0 && selectedNodes.length > 0 && selectedNodes.every(isTerminal)

  return (
    <DiagramFileCopyContext.Provider value={documents.getPath}>
    <EditorContext.Provider value={context}>
    <TerminalContext.Provider value={terminalContext}>
      {/* Switchboard: a row — the canvas, and Google Images docked on its right
          while open, so the canvas narrows beside the panel rather than hiding
          under it. Everything measured from wrapperRef is the canvas alone. In a
          narrow window the panel gives way first: the canvas keeps 360px, room
          for the rail and the menus beside it, which it clips. */}
      <div ref={rootRef} className="relative flex size-full min-w-0" data-board-id={boardId}>
        <div
          ref={wrapperRef}
          className={cx(
            "relative h-full flex-1 bg-gray-50 dark:bg-gray-900",
            imagesOpen ? "min-w-[360px]" : "min-w-0",
            FLOW_EDGE_THEME,
            // A placing tool aims rather than points.
            placing && "[&_.react-flow__pane]:!cursor-crosshair",
          )}
          onDoubleClick={onCanvasDoubleClick}
          onPointerMove={(event) => {
            pointerRef.current = { x: event.clientX, y: event.clientY }
          }}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragEnd={endDrag}
          onDropCapture={endDrag}
        >
          {nodes.length === 0 && uploading === 0 ? (
            // Under the canvas (which is transparent) rather than over it, so the
            // toolbar's menus open on top of it — and transparent to the pointer
            // either way.
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <p className="max-w-xs rounded-lg border border-dashed border-gray-300 bg-white/80 px-5 py-4 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-950/80 dark:text-gray-400">
                Pick a shape, a sticky note or text from the toolbar and click
                the canvas to place it, or drop an image here — then press Tab
                to add the next box.
              </p>
            </div>
          ) : null}
          <ReactFlow
            nodes={shownNodes}
            edges={shownEdges}
            nodeTypes={EDITOR_NODE_TYPES}
            edgeTypes={EDITOR_EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeDragStart={(_, __, dragging) => startDrag(dragging)}
            onNodeDragStop={dropBoxes}
            onSelectionDragStart={(_, dragging) => startDrag(dragging)}
            onSelectionDragStop={dropBoxes}
            onBeforeDelete={async ({ nodes: going, edges: goingEdges }) => {
              record()
              closeUp(going, goingEdges)
              // Switchboard: a box takes the branch folded away behind it with it,
              // rather than leaving it to reappear somewhere with nothing pointing
              // at it.
              const behind = foldedBehind(going)
              // Switchboard: a pinned terminal deleted (Delete, Cut, its Close, or
              // folded away behind a box deleted) is closed by the host — told
              // where it was, while it still is.
              for (const node of [...going, ...behind]) {
                const pinned = nodesRef.current.find((candidate) => candidate.id === node.id)
                if (pinned && isTerminal(pinned)) {
                  onTerminalRemovedRef.current?.(terminalWorkspace(pinned), "delete", clientRectOf(pinned))
                }
              }
              if (behind.length === 0) return true
              const ids = new Set(behind.map((node) => node.id))
              const cutting = new Set(goingEdges.map((edge) => edge.id))
              return {
                nodes: [...going, ...behind],
                edges: [
                  ...goingEdges,
                  ...edgesRef.current.filter(
                    (edge) => !cutting.has(edge.id) && (ids.has(edge.source) || ids.has(edge.target)),
                  ),
                ],
              }
            }}
            onNodeDoubleClick={(_, node) => {
              if (tool !== "hand" && (node.data as FlowBoxNodeData).shape === "document") openDocument(node)
              if (tool !== "hand" && hasText(node.data as FlowBoxNodeData)) changeEditing(node.id)
            }}
            onPaneClick={onPaneClick}
            onEdgeDoubleClick={() => {
              if (tool !== "hand") focusEdgeLabel()
            }}
            isValidConnection={(connection) => connection.source !== connection.target}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            // Dropping an arrow anywhere near a dot counts — hitting an 11px
            // target at the end of a long drag is fiddly.
            connectionRadius={36}
            snapToGrid
            snapGrid={SNAP_GRID}
            // Only a diagram that opens with something on it is framed. React
            // Flow holds the first fit until there are boxes to fit, so on an
            // empty one it would land on the first thing placed — and move the
            // view out from under the click that placed it.
            fitView={initial.nodes.length > 0}
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={FIT_VIEW_OPTIONS.minZoom}
            maxZoom={2.5}
            // Off while a menu or dialog has the keyboard: React Flow listens on
            // the whole document, and Backspace on a menu item would otherwise
            // delete the boxes selected behind it.
            deleteKeyCode={keyboardEnabled ? DELETE_KEYS : null}
            // React Flow's own keys on a focused box — arrows nudging it,
            // Enter and Escape selecting it — are the editor's to handle.
            disableKeyboardA11y
            // Select drags out a selection box; the hand drags the view, and
            // leaves the boxes alone.
            selectionOnDrag={tool === "select"}
            // Switchboard: every box the selection box touches, not only the
            // ones wholly inside it.
            selectionMode={SelectionMode.Partial}
            panOnDrag={tool === "hand" ? true : PAN_BUTTONS}
            nodesDraggable={tool !== "hand"}
            nodesConnectable={tool !== "hand"}
            edgesReconnectable={tool !== "hand"}
            elementsSelectable={tool !== "hand"}
            panOnScroll
            zoomOnDoubleClick={false}
            onDragOver={onDragOver}
            onDrop={onDrop}
            attributionPosition="bottom-left"
            aria-label="Whiteboard editor"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              className="text-gray-300 dark:text-gray-700"
              color="currentColor"
            />
            {/* Bottom right, clear of the toolbar down the left on a short canvas. */}
            <Controls showInteractive={false} position="bottom-right" />

            {/* Switchboard: centred for real. React Flow lifts a centred panel by the
                15px margin !my-0 takes away, which on a short canvas (a Grid square)
                pushed the rail's first tool off the top. */}
            <Panel position="center-left" className="!my-0 !ml-4 ![transform:translateY(-50%)]">
              <ToolRail
                tool={tool}
                shape={shapeChoice}
                uploading={uploading > 0}
                onTool={chooseTool}
                onShape={(shape) => {
                  setShapeChoice(shape)
                  setTool("shape")
                }}
                imageMenu={imageMenu}
                onImageMenu={showImageMenu}
                onImageFile={pickImages}
                onImageSearch={openImages}
              />
            </Panel>

            <FloatingBar nodes={barNodes} hidden={dragging || tool === "hand" || terminalsOnly}>
              {editingNode ? (
                <TextBar
                  box={editingNode.data as FlowBoxNodeData}
                  onChange={(patch) => updateNode(editingNode.id, patch)}
                  onToggleDetail={() =>
                    toggleDetail(editingNode.id, editingNode.data as FlowBoxNodeData)
                  }
                  onDone={() => changeEditing(null)}
                />
              ) : (
                <BoxBar
                  boxes={selectedNodes.map((node) => node.data as FlowBoxNodeData)}
                  count={selectedNodes.length + selectedEdges.length}
                  onChange={(patch) =>
                    updateNodes(
                      selectedNodes.map((node) => node.id),
                      patch,
                    )
                  }
                  onEditText={
                    soleNode && hasText(soleNode.data as FlowBoxNodeData)
                      ? () => changeEditing(soleNode.id)
                      : undefined
                  }
                  onOpenDocument={soleNode && (soleNode.data as FlowBoxNodeData).shape === "document" ? () => openDocument(soleNode) : undefined}
                  onDuplicate={soleNode && !isTerminal(soleNode) ? () => duplicate(soleNode) : undefined}
                  onDelete={deleteSelection}
                  branch={
                    soleNode && inBranch(soleNode, edges)
                      ? {
                          detached: (soleNode.data as FlowBoxNodeData).detached === true,
                          onToggle: () => toggleDetached(soleNode.id),
                        }
                      : undefined
                  }
                  fold={soleNode && folds.has(soleNode.id)
                    ? {
                        state: folds.get(soleNode.id)!,
                        nodeLabel: (soleNode.data as FlowBoxNodeData).label,
                        onToggle: () => toggleFold(soleNode.id),
                      }
                    : undefined}
                  ai={
                    selectedNodes.length > 1
                      ? {
                          mode: "condense",
                          state: condensingSelection ? "answering" : "idle",
                          hasQuestion: !condenseProblem && !selectedIds.some(isAnswering),
                          disabledReason: condenseProblem ?? (selectedIds.some(isAnswering) ? "Wait for the selected nodes' answers or stop them first" : undefined),
                          status: answerStatus,
                          ...answerWorkspaceBar,
                          onSettings: (patch) => void updateAnswerSettings(patch),
                          onOpenSettings,
                          onAnswer: () => void condense(selectedIds),
                          onStop: () => stopAsking(condensingSelection?.id),
                        }
                      : soleNode && hasText(soleNode.data as FlowBoxNodeData)
                      ? {
                          mode: condensingSelection ? "condense" : "answer",
                          state: answeringIds.has(soleNode.id) ? "answering" : "idle",
                          hasQuestion: (soleNode.data as FlowBoxNodeData).label.trim().length > 0,
                          status: answerStatus,
                          ...answerWorkspaceBar,
                          onSettings: (patch) => void updateAnswerSettings(patch),
                          onOpenSettings,
                          onAnswer: () => void ask(soleNode),
                          onStop: () => stopAsking(soleNode.id),
                        }
                      : undefined
                  }
                />
              )}
            </FloatingBar>

            {ghosts.map((ghost) => (
              <ViewportPortal key={ghost.serial}>
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-0 overflow-visible"
                  width={1}
                  height={1}
                >
                  <path
                    d={ghost.path}
                    fill="none"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    className="stroke-violet-400"
                  />
                </svg>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-0 flex flex-col justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-400 bg-white/75 px-4 dark:bg-gray-950/70"
                  style={{
                    transform: `translate(${ghost.rect.x}px, ${ghost.rect.y}px)`,
                    width: ghost.rect.width,
                    height: ghost.rect.height,
                  }}
                >
                  <span className="h-2 w-4/5 animate-pulse rounded bg-violet-200 dark:bg-violet-900/70" />
                  <span className="h-2 w-3/5 animate-pulse rounded bg-violet-100 dark:bg-violet-900/50" />
                  {/* Switchboard: the workspace the answer is reading, dashed until it lands. */}
                  {ghost.workspace ? <WorkspaceTag id={ghost.workspace} ghost /> : null}
                </div>
              </ViewportPortal>
            ))}

            <Panel position="bottom-center">
              {/* Switchboard: Choose workspace… when the box that asked has no menu to
                  open — the same picker, over the strip. */}
              {stripPicker ? (
                <StripPicker
                  choices={choices}
                  onOpen={refreshChoices}
                  current={answerWorkspace}
                  status={workspaceStatus}
                  onPick={pickAnswerWorkspace}
                  onClose={() => setStripPicker(false)}
                />
              ) : null}
              {/* Switchboard: while a CLI reads the workspace, what it is doing — over the
                  strip, so a minute-long wait never looks stuck. */}
              {followed !== null ? (
                <AnswerActivity
                  key={followed.serial}
                  asking={followed}
                  steps={steps[followed.serial] ?? []}
                  others={askings.length - 1}
                />
              ) : null}
              <div className="mx-auto flex w-fit items-center gap-1 rounded-md border border-gray-200 bg-white/95 p-1 text-xs shadow-sm backdrop-blur-sm dark:border-gray-800 dark:bg-gray-950/95">
                <ToolButton label="Undo · ⌘Z" disabled={past.length === 0} onClick={undo}>
                  <RiArrowGoBackLine className="size-4" aria-hidden="true" />
                </ToolButton>
                <ToolButton label="Redo · ⇧⌘Z" disabled={future.length === 0} onClick={redo}>
                  <RiArrowGoForwardLine className="size-4" aria-hidden="true" />
                </ToolButton>
                <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-800" aria-hidden="true" />
                {/* Always on the page, so a screen reader hears it change — one
                    added already holding its words often isn't announced. */}
                <span className="sr-only" role="status">
                  {askings.length > 0
                    ? askingLabel(askings)
                    : failure !== null
                      ? failure.message
                      : answered !== null
                        ? answerNote?.condensed
                          ? `${answerNote.condensed} nodes condensed to ${answered}`
                          : answered === 1
                          ? "Answer added"
                          : `${answered} answers added`
                        : ""}
                </span>
                {/* Switchboard: what is on its way and how the last one went, side by
                    side — with several answers at once, one can land or fail while
                    the others are still coming. */}
                {askings.length > 0 ? (
                  <>
                    <AskingStatus
                      key={askings.length === 1 ? askings[0].serial : "several"}
                      askings={askings}
                      onStop={() => stopAsking()}
                    />
                    <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-800" aria-hidden="true" />
                  </>
                ) : null}
                {failure !== null ? (
                  <>
                    <AnswerFailureLine
                      failure={failure}
                      onOpenSettings={onOpenSettings}
                      onOpenTerminal={failureTerminal ? () => onOpenTerminal(failureTerminal) : undefined}
                      onChooseWorkspace={chooseWorkspace}
                      onDismiss={() => setFailure(null)}
                    />
                    <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-800" aria-hidden="true" />
                  </>
                ) : answered !== null ? (
                  <>
                    <span className="flex items-center gap-1.5 px-1 text-violet-700 dark:text-violet-300">
                      <RiSparkling2Fill className="size-3.5 text-violet-500" aria-hidden="true" />
                      {answerNote?.condensed
                        ? `${answerNote.condensed} nodes condensed to ${answered}`
                        : answered === 1 ? "Answer added" : `${answered} answers added`}
                      {answerNote ? (
                        <span className="text-violet-600/80 dark:text-violet-300/80">
                          {" · "}
                          {answerNote.files !== null
                            ? `${answerNote.by} read ${answerNote.files === 1 ? "1 file" : `${answerNote.files} files`} in ${answerNote.seconds}s`
                            : `${answerNote.by}, ${answerNote.seconds}s`}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setAnswered(null)
                          undo()
                        }}
                        className={cx(
                          "rounded px-1 font-medium text-gray-900 underline underline-offset-2 dark:text-gray-50",
                          focusRing,
                        )}
                      >
                        Undo
                      </button>
                    </span>
                    <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-800" aria-hidden="true" />
                  </>
                ) : null}
                {uploading > 0 ? (
                  <span className="flex items-center gap-1.5 pr-1.5 text-gray-500 dark:text-gray-400" role="status">
                    <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
                    Uploading {uploading === 1 ? "image" : `${uploading} images`}…
                  </span>
                ) : null}
                <SaveStatus
                  saving={saving || documents.saving}
                  dirty={dirty}
                  error={saveError ?? documents.problem?.error ?? null}
                  onRetry={() => {
                    const failedId = documents.problem?.id
                    const problem = failedId ? nodesRef.current.find((node) => (node.data as FlowBoxNodeData).documentId === failedId) : undefined
                    if (problem) openDocument(problem)
                    void flush()
                  }}
                />
              </div>
            </Panel>
          </ReactFlow>


          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // Cleared, so picking the same file again still fires a change.
              event.target.value = ""
              if (files.length > 0) void addImages(files)
            }}
          />

          {dropping ? (
            // Switchboard: over everything, and transparent to the pointer — a ring,
            // not a drop target of its own.
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10"
              style={{ boxShadow: "inset 0 0 0 2px rgba(59,130,246,.35)" }}
            />
          ) : null}
        </div>
        {documentBox?.documentId && documentNode ? (
          <DocumentPanel
            key={documentNode.id}
            buffer={documents.active}
            title={documentBox.label}
            diagramName={diagramName}
            view={documentView}
            onView={setDocumentView}
            initialWrite={documentStartsWriting}
            onRename={(label) => updateNode(documentNode.id, { label }, true)}
            onEdit={(text) => documents.edit(documentBox.documentId!, text)}
            onSave={() => void documents.save(documentBox.documentId!)}
            onCopyPath={() => documents.getPath(documentBox.documentId!)}
            onRetry={() => void documents.retry(documentBox.documentId!, true)}
            onResolve={(overwrite) => void documents.resolve(documentBox.documentId!, overwrite)}
            onClose={() => { void documents.flush(); setDocumentNodeId(null) }}
          />
        ) : null}
        {imagesOpen ? (
          <ImageSearchPanel
            ask={imagesAsk}
            shown={shown}
            onClose={() => setImagesOpen(false)}
            onAddImage={(urls, referrer) => void addImageFromUrl(urls, undefined, referrer)}
          />
        ) : null}
      </div>
    </TerminalContext.Provider>
    </EditorContext.Provider>
    </DiagramFileCopyContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────────
// The floating toolbar
// ─────────────────────────────────────────────────────────────────────

// Above the selection, the size it is whatever the zoom — or below it when
// there's no room above. Out of the way while anything is being dragged or an
// arrow drawn.
function FloatingBar({
  nodes,
  hidden,
  children,
}: {
  nodes: Node[]
  hidden: boolean
  children: React.ReactNode
}) {
  const connecting = useConnection((connection) => connection.inProgress)
  const offsetY = useStore((state) => state.transform[1])
  const zoom = useStore((state) => state.transform[2])
  if (nodes.length === 0 || hidden || connecting) return null

  const top = Math.min(...nodes.map((node) => node.position.y)) * zoom + offsetY
  return (
    <NodeToolbar
      nodeId={nodes.map((node) => node.id)}
      isVisible
      position={top < 64 ? Position.Bottom : Position.Top}
      offset={14}
      className="nodrag nopan nowheel"
    >
      {children}
    </NodeToolbar>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="toolbar"
      // Switchboard: floating over the canvas — a pinned terminal under it steps aside.
      data-canvas-overlay
      className="pointer-events-auto flex items-center gap-0.5 rounded-xl bg-gray-900 p-1 text-gray-100 shadow-lg ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10"
      // Buttons never take focus, so pressing one mid-edit leaves you typing
      // where you were. A text input in the bar still can.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
      }}
      // Kept from the arrow underneath (the toolbar renders inside its tree),
      // which would otherwise treat a click here as a click on itself.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

function BarDivider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-white/15" aria-hidden="true" />
}

function BarButton({
  label,
  active,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string
  /** Set for toggles only: whether it is on. */
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-lg px-1.5 transition-colors",
        active
          ? "bg-brand text-white"
          : "text-gray-300 hover:bg-white/10 hover:text-white",
        "disabled:pointer-events-none disabled:opacity-35",
        focusRing,
        className,
      )}
    >
      {children}
    </button>
  )
}

// A toolbar button that opens a small panel under itself. Closes on a pick,
// a click anywhere else, or Escape (which then goes no further — not out of
// full screen, not out of the selection).
function BarMenu({
  label,
  trigger,
  children,
  className,
  openClassName = "bg-white/10",
  panelClassName,
  openRequest,
  takeOpenRequest,
}: {
  label: string
  trigger: React.ReactNode
  children: (close: () => void) => React.ReactNode
  /** On the trigger, merged over BarButton's own. */
  className?: string
  /** On the trigger while the panel is open. */
  openClassName?: string
  /** On the panel, merged over its own (e.g. to anchor it left, not centred). */
  panelClassName?: string
  /**
   * Switchboard: opens the panel from outside — each new number once, the first
   * time a menu here takes it (`takeOpenRequest` says whether this one did).
   */
  openRequest?: number
  takeOpenRequest?: (serial: number) => boolean
}) {
  // Open where the toolbar was when it opened, and only there: panning,
  // zooming or the selection moving (arrow keys, a nudge) carries the toolbar
  // off, and the panel — placed for where it was — closes rather than hang
  // somewhere it no longer belongs.
  const at = useStore(toolbarPlace)
  const [openAt, setOpenAt] = useState<string | null>(null)
  const open = openAt === at
  const setOpen = (next: boolean) => setOpenAt(next ? at : null)
  const ref = useRef<HTMLDivElement | null>(null)
  // …and stays closed: the toolbar coming back to the same spot (← after →)
  // mustn't open it again by itself.
  const store = useStoreApi()
  useEffect(() => {
    if (openAt === null) return
    return store.subscribe((state) => {
      if (toolbarPlace(state) !== openAt) setOpenAt(null)
    })
  }, [openAt, store])

  // Switchboard: Choose workspace… in the strip asks for the who-answers menu.
  useEffect(() => {
    if (!openRequest || !takeOpenRequest?.(openRequest)) return
    setOpenAt(toolbarPlace(store.getState()))
  }, [openRequest, takeOpenRequest, store])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!(event.target instanceof globalThis.Node) || !ref.current?.contains(event.target)) {
        setOpenAt(null)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      // Switchboard: a workspace picker open in the panel closes first, on its own.
      if (ref.current?.querySelector("[data-workspace-picker]")) return
      event.stopPropagation()
      setOpenAt(null)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <BarButton
        label={label}
        onClick={() => setOpen(!open)}
        className={cx(className, open && openClassName)}
      >
        {trigger}
        <RiArrowDownSLine className="size-3.5 opacity-60" aria-hidden="true" />
      </BarButton>
      {open ? (
        <div
          ref={keepInCanvas}
          data-flow-popover
          data-canvas-overlay
          className={cx(
            "absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 rounded-xl bg-gray-900 p-1.5 shadow-lg ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10",
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}

// Where a toolbar is: the view, and what is selected and where it sits. A
// string, so a menu can compare it with where it was opened.
function toolbarPlace(state: ReactFlowState): string {
  const [x, y, zoom] = state.transform
  let place = `${x},${y},${zoom}`
  for (const node of state.nodes) {
    if (node.selected) place += `|${node.id}@${node.position.x},${node.position.y}`
  }
  for (const edge of state.edges) if (edge.selected) place += `|${edge.id}`
  return place
}

// The canvas clips whatever hangs past its edges, menus included. As a menu
// opens, slide it sideways back inside, and open it upwards instead when there
// is more room above the toolbar than below. Done to the element directly, on
// mount: it is measuring the page, not anything React renders from.
//
// Switchboard: once per panel (marked `data-placed`). React attaches the panel's
// ref only after every layout effect inside it has run, so something inside that
// measures the panel as it mounts — the Workspace row's picker, when Choose
// workspace… opens the menu with it showing — places the panel first by calling
// this itself, and the ref's call then leaves it be.
function keepInCanvas(panel: HTMLElement | null) {
  if (!panel || panel.hasAttribute("data-placed")) return
  const bounds = panel.closest(".react-flow")?.getBoundingClientRect()
  if (!bounds) return
  panel.setAttribute("data-placed", "")
  const margin = 8
  // From where the classes put it.
  panel.style.marginLeft = ""
  panel.style.maxHeight = ""
  panel.style.overflowY = ""
  const rect = panel.getBoundingClientRect()
  // Back from the right edge, then — winning when the panel is wider than the
  // canvas — off the left one.
  const shift = Math.max(
    Math.min(0, bounds.right - margin - rect.right),
    bounds.left + margin - rect.left,
  )
  if (shift !== 0) panel.style.marginLeft = `${shift}px`
  // Switchboard: the strip along the canvas's foot — undo, redo, saved, and the card
  // over it while an answer is on its way — is drawn over the toolbar, so where the
  // panel would run under it (where it is after the shift), the room ends where the
  // strip starts.
  const strip = panel
    .closest(".react-flow")
    ?.querySelector(".react-flow__panel.bottom.center")
    ?.getBoundingClientRect()
  const floor =
    strip && strip.height > 0 && strip.left < rect.right + shift && strip.right > rect.left + shift
      ? Math.min(bounds.bottom, strip.top)
      : bounds.bottom
  const anchor = panel.parentElement?.getBoundingClientRect()
  if (!anchor || rect.bottom <= floor - margin) return
  const up = anchor.top - bounds.top > floor - anchor.bottom
  if (up) {
    panel.style.top = "auto"
    panel.style.bottom = "100%"
    panel.style.marginTop = "0"
    panel.style.marginBottom = `${margin}px`
  }
  // Switchboard: taller than the room on either side — the ✦ Answer menu holds four
  // ways to answer, and Switchboard's canvas is shorter than the admin's page — so it
  // scrolls within the room on the side it opened to, rather than running off the
  // canvas, which clips it.
  const room = up
    ? anchor.top - bounds.top - margin * 2
    : floor - anchor.bottom - margin * 2
  if (rect.height > room) {
    panel.style.maxHeight = `${Math.max(140, room)}px`
    panel.style.overflowY = "auto"
  }
}

/** The value every one of `items` shares, or undefined when they differ. */
function shared<T, K extends keyof T>(items: T[], key: K): T[K] | undefined {
  const first = items[0]?.[key]
  return items.every((item) => item[key] === first) ? first : undefined
}

// The colours on offer, drawn as what they turn a node into: a box's fill and
// border, a note's paper, or free text's ink.
function ToneSwatch({
  tone,
  kind,
  small,
}: {
  tone: FlowTone
  kind: "box" | "note" | "text"
  small?: boolean
}) {
  if (kind === "text") {
    // Ink on paper — the dark toolbar would swallow the darker inks.
    return (
      <span
        className={cx(
          "flex size-full items-center justify-center rounded-full bg-white font-bold leading-none",
          small ? "text-[10px]" : "text-sm",
          TEXT_TONE_STYLES[tone],
        )}
        aria-hidden="true"
      >
        A
      </span>
    )
  }
  return (
    <span
      className={cx(
        "block size-full rounded-full",
        kind === "note" ? cx(NOTE_TONE_STYLES[tone], "border border-black/10") : cx("border-2", TONE_STYLES[tone]),
      )}
      aria-hidden="true"
    />
  )
}

// For a selected box, or several: shape, colour and outline (applied to every
// box selected), plus editing its text and duplicating it when there is one.
// A note or a text has a colour and no shape or outline; an image has
// neither, only Duplicate and Delete.
function BoxBar({
  boxes,
  count,
  onChange,
  onEditText,
  onOpenDocument,
  onDuplicate,
  onDelete,
  ai,
  branch,
  fold,
}: {
  boxes: FlowBoxNodeData[]
  /** Everything selected, arrows included — what Delete removes. */
  count: number
  onChange: (patch: Partial<FlowBoxNodeData>) => void
  onOpenDocument?: () => void
  onEditText?: () => void
  onDuplicate?: () => void
  onDelete: () => void
  /** ✦ Answer, for one box with text selected on its own. */
  ai?: AiBar
  /** Switchboard: Attached / Detached, for one box in a branch (or detached from one). */
  branch?: { detached: boolean; onToggle: () => void }
  /** Collapse or expand all outgoing branches of the one selected node. */
  fold?: { state: FoldBadge; nodeLabel: string; onToggle: () => void }
}) {
  const sharedShape = shared(boxes, "shape")
  const shape = sharedShape !== undefined && isFlowBoxShape(sharedShape) ? sharedShape : undefined
  const tone = shared(boxes, "tone")
  const dashed = shared(boxes, "dashed")
  const allBoxes = boxes.every((box) => isFlowBoxShape(box.shape))
  // Switchboard: nor a pinned terminal, which is the terminal's colours.
  const colourable = boxes.every((box) => box.shape !== "image" && box.shape !== "document" && box.shape !== "terminal")
  // Swatches drawn as notes or ink only when every node selected is one.
  const swatch: "box" | "note" | "text" =
    sharedShape === "note" ? "note" : sharedShape === "text" ? "text" : "box"
  const toneNames = swatch === "note" ? NOTE_TONE_NAMES : TONE_NAMES
  const folded = fold !== undefined && fold.state.arrows === fold.state.total
  const foldLabel = fold
    ? `${folded ? "Expand" : "Collapse"} all ${fold.state.total} outgoing ${fold.state.total === 1 ? "branch" : "branches"} from ${fold.nodeLabel.trim().slice(0, 48) || "this node"}`
    : ""

  return (
    <Bar>
      {ai ? (
        <>
          <AiControls ai={ai} />
          <BarDivider />
        </>
      ) : null}
      {onOpenDocument ? <BarButton label="Open document · Enter" onClick={onOpenDocument}><RiFileTextLine className="size-4" aria-hidden="true" /></BarButton> : null}
      {onEditText ? (
        <>
          <BarButton label="Edit text · Enter" onClick={onEditText}>
            <RiText className="size-4" aria-hidden="true" />
          </BarButton>
          <BarDivider />
        </>
      ) : null}
      {allBoxes ? (
        <BarMenu
          label="Shape"
          trigger={
            shape ? (
              <ShapeGlyph shape={shape} className="h-4 w-5" />
            ) : (
              <RiShapesLine className="size-4" aria-hidden="true" />
            )
          }
        >
          {(close) => (
            <div className="flex gap-0.5" role="radiogroup" aria-label="Shape">
              {FLOW_BOX_SHAPES.map((option) => (
                <BarButton
                  key={option}
                  label={SHAPE_NAMES[option]}
                  active={shape === option}
                  onClick={() => {
                    onChange({ shape: option })
                    close()
                  }}
                  className="h-9 w-11"
                >
                  <ShapeGlyph shape={option} />
                </BarButton>
              ))}
            </div>
          )}
        </BarMenu>
      ) : null}
      {colourable ? (
        <BarMenu
          label="Colour"
          trigger={
            tone ? (
              <span className="flex size-4 items-center justify-center">
                <ToneSwatch tone={tone} kind={swatch} small />
              </span>
            ) : (
              <span className="size-4 rounded-full border border-dashed border-gray-400" aria-hidden="true" />
            )
          }
        >
          {(close) => (
            <div className="flex gap-1 p-0.5" role="radiogroup" aria-label="Colour">
              {FLOW_TONES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={tone === option}
                  aria-label={toneNames[option]}
                  title={toneNames[option]}
                  onClick={() => {
                    onChange({ tone: option })
                    close()
                  }}
                  className={cx(
                    "flex size-7 items-center justify-center rounded-full",
                    tone === option &&
                      "ring-2 ring-brand ring-offset-2 ring-offset-gray-900 dark:ring-offset-gray-800",
                    focusRing,
                  )}
                >
                  <ToneSwatch tone={option} kind={swatch} />
                </button>
              ))}
            </div>
          )}
        </BarMenu>
      ) : null}
      {allBoxes ? (
        <>
          <BarDivider />
          <BarButton label="Solid outline" active={dashed === false} onClick={() => onChange({ dashed: false })}>
            <StrokeGlyph kind="outline" dashed={false} />
          </BarButton>
          <BarButton label="Dashed outline" active={dashed === true} onClick={() => onChange({ dashed: true })}>
            <StrokeGlyph kind="outline" dashed />
          </BarButton>
        </>
      ) : null}
      {allBoxes || colourable ? <BarDivider /> : null}
      {branch ? (
        <BarButton
          label={
            branch.detached
              ? "Detached: moves on its own · click to attach it to its branch"
              : "Attached: moves with its branch · click to detach"
          }
          active={branch.detached}
          onClick={branch.onToggle}
        >
          {branch.detached ? (
            <RiLinkUnlinkM className="size-4" aria-hidden="true" />
          ) : (
            <RiLinkM className="size-4" aria-hidden="true" />
          )}
        </BarButton>
      ) : null}
      {fold ? (
        <BarButton label={foldLabel} active={folded} onClick={fold.onToggle}>
          {folded ? (
            <RiExpandRightLine className="size-4" aria-hidden="true" />
          ) : (
            <RiContractRightLine className="size-4" aria-hidden="true" />
          )}
        </BarButton>
      ) : null}
      {onDuplicate ? (
        <BarButton label="Duplicate · ⌘D" onClick={onDuplicate}>
          <RiFileCopyLine className="size-4" aria-hidden="true" />
        </BarButton>
      ) : null}
      <BarButton label={count > 1 ? `Delete ${count} items · ⌫` : "Delete · ⌫"} onClick={onDelete}>
        <RiDeleteBinLine className="size-4" aria-hidden="true" />
        {count > 1 ? <span className="px-0.5 text-xs font-medium">{count}</span> : null}
      </BarButton>
    </Bar>
  )
}

type AiBar = {
  mode?: "answer" | "condense"
  disabledReason?: string
  /** Idle, or waiting on this box's answer. Switchboard: other boxes' answers don't hold this one up. */
  state: "idle" | "answering"
  /** Whether the box has any words to ask about. */
  hasQuestion: boolean
  /** Switchboard: who can answer on this Mac, and the settings — null until main has said. */
  status: AnswerStatus | null
  /** Switchboard: the workspace a CLI reads for this whiteboard, for "Reads sample-2 first". */
  workspace: string | null
  /** Switchboard: that workspace has left the rail. */
  workspaceGone: boolean
  /** Switchboard: the rail's workspaces and their branches, for the Workspace row's picker. */
  choices: WorkspaceChoices | null
  /** Switchboard: asks main for the rail's workspaces again, as the picker opens. */
  refreshChoices: () => void
  workspaceStatus: WorkspaceStatus
  onWorkspace: (wsId: string) => void
  /** Switchboard: Choose workspace… — the menu opens with the picker showing. */
  openRequest: number
  takeOpenRequest: (serial: number) => boolean
  takePickerFirst: () => boolean
  onSettings: (patch: Partial<AnswerSettings>) => void
  onOpenSettings?: () => void
  onAnswer: () => void
  onStop: () => void
}

// The violet the AI's controls are picked out in — the same whatever the
// product, because some products' brand colour is as dark as the toolbar.
const AI_TINT = "bg-violet-500/20 text-white hover:bg-violet-500/30 hover:text-white"

// The box toolbar's lead: ✦ Answer and, split off it, the chevron that holds
// who answers and how. While this box's answer is on its way: Answering… and
// Stop.
function AiControls({ ai }: { ai: AiBar }) {
  const condensing = ai.mode === "condense"
  if (ai.state === "answering") {
    return (
      <div className="flex items-center">
        <span className="flex h-8 items-center gap-1.5 rounded-l-lg bg-violet-500/30 pl-2 pr-2.5 text-xs font-medium text-white">
          <RiLoader4Line className="size-4 animate-spin text-violet-200" aria-hidden="true" />
          {condensing ? "Condensing…" : "Answering…"}
        </span>
        <BarButton
          label="Stop · Esc"
          onClick={ai.onStop}
          className="ml-px rounded-l-none bg-violet-500/30 text-white hover:bg-violet-500/45 hover:text-white"
        >
          <RiStopFill className="size-3.5" aria-hidden="true" />
        </BarButton>
      </div>
    )
  }
  const provider = ai.status?.providers.find((option) => option.id === ai.status?.settings.provider)
  const label = ai.hasQuestion
    ? condensing
      ? `Condense selection with ${provider?.name ?? "AI"} · ⌘I · replaces selected nodes, undoable`
      : `Answer with ${provider?.name ?? "AI"} · ⌘I`
    : ai.disabledReason ?? "Write a question in the box first"
  return (
    <div className="flex items-center">
      <BarButton
        label={label}
        disabled={!ai.hasQuestion}
        onClick={ai.onAnswer}
        className={cx(
          "gap-1.5 rounded-r-none pl-1.5 pr-2 text-xs font-medium",
          AI_TINT,
          // Hoverable while disabled, so its title says why.
          "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-violet-500/20",
        )}
      >
        <RiSparkling2Fill className="size-4 text-violet-300" aria-hidden="true" />
        {condensing ? "Condense" : "Answer"}
      </BarButton>
      <BarMenu
        label="Who answers"
        trigger={null}
        className={cx("ml-px rounded-l-none px-1", AI_TINT)}
        openClassName="bg-violet-500/40"
        panelClassName="left-0 translate-x-0"
        openRequest={condensing ? undefined : ai.openRequest}
        takeOpenRequest={ai.takeOpenRequest}
      >
        {(close) => (
          <AiSettingsMenu
            condensing={condensing}
            status={ai.status}
            workspace={ai.workspace}
            workspaceGone={ai.workspaceGone}
            choices={ai.choices}
            refreshChoices={ai.refreshChoices}
            workspaceStatus={ai.workspaceStatus}
            onWorkspace={ai.onWorkspace}
            takePickerFirst={ai.takePickerFirst}
            onChange={ai.onSettings}
            onOpenSettings={
              ai.onOpenSettings
                ? () => {
                    close()
                    ai.onOpenSettings?.()
                  }
                : undefined
            }
          />
        )}
      </BarMenu>
    </div>
  )
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </p>
  )
}

// One option in the menu's segmented rows.
function Segment({
  label,
  checked,
  disabled,
  title,
  onClick,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        "rounded-md px-1.5 py-1 text-xs font-medium transition-colors",
        checked ? "bg-white text-gray-900 shadow-sm" : "text-gray-300 hover:bg-white/10 hover:text-white",
        // Hoverable while disabled, so its title says why.
        "disabled:cursor-not-allowed disabled:text-gray-600 disabled:line-through disabled:hover:bg-transparent disabled:hover:text-gray-600",
        focusRing,
      )}
    >
      {label}
    </button>
  )
}

// Switchboard: CLI or API, beside each way to answer.
function KindTag({ kind }: { kind: ProviderStatus["kind"] }) {
  return (
    <span
      className={cx(
        "rounded px-1 py-0.5 text-[9.5px] font-semibold uppercase leading-none tracking-wide",
        kind === "cli" ? "bg-white/10 text-gray-300" : "bg-violet-500/25 text-violet-200",
      )}
    >
      {kind}
    </span>
  )
}

/**
 * The line under each way to answer: what it does, or why it can't right now.
 * Switchboard: a CLI reads the whiteboard's workspace — or says there is none to
 * read, or that it has left the rail; an API sees only the whiteboard.
 */
function providerLine(provider: ProviderStatus, workspace: string | null, gone: boolean): string {
  if (provider.kind === "cli") {
    if (provider.state === "missing") return "Not installed on this Mac"
    if (provider.state === "signed-out") return "Not signed in on this Mac"
    if (!workspace) return "Pick a workspace to read"
    if (gone) return `${workspace} is no longer in the rail`
    return `Reads ${workspace} first, then answers`
  }
  if (!provider.ready) return "No key yet · add one in Settings"
  const model = provider.models?.find((option) => option.id === provider.model)
  return `${model?.name ?? provider.model} · sees only the whiteboard · fast`
}

// One on/off line in the menu below: what it is, a hint, and the switch.
function MenuSwitch({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string
  hint: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={cx("flex items-center gap-3 rounded-lg px-2 py-1 text-left hover:bg-white/5", focusRing)}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-gray-200">{label}</span>
        <span className="block text-[11px] leading-4 text-gray-400">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={cx("flex h-[18px] w-8 shrink-0 rounded-full p-0.5 transition-colors", on ? "bg-violet-500" : "bg-white/20")}
      >
        <span className={cx("size-3.5 rounded-full bg-white transition-transform", on && "translate-x-3.5")} />
      </span>
    </button>
  )
}

// Under the chevron: who answers — the four ways, each saying whether it can on
// this Mac — and how: a CLI's effort, an API's model; then whether it reads the boxes
// before the question, writes a line under each box, and may go on the web. Kept by
// main, on this Mac, for every diagram; the Settings screen shows and changes the same
// things.
// Switchboard: and which workspace a CLI reads — the whiteboard's own, kept with the
// whiteboard rather than on this Mac — in a row of its own, whose Change… opens a
// short picker beside the menu.
function AiSettingsMenu({
  status,
  condensing = false,
  workspace,
  workspaceGone: gone,
  choices,
  refreshChoices,
  workspaceStatus,
  onWorkspace,
  takePickerFirst,
  onChange,
  onOpenSettings,
}: {
  status: AnswerStatus | null
  condensing?: boolean
  workspace: string | null
  workspaceGone: boolean
  choices: WorkspaceChoices | null
  refreshChoices?: () => void
  workspaceStatus: WorkspaceStatus
  onWorkspace: (wsId: string) => void
  /** True once, when the menu was opened to choose a workspace. */
  takePickerFirst?: () => boolean
  onChange: (patch: Partial<AnswerSettings>) => void
  onOpenSettings?: () => void
}) {
  const [picking, setPicking] = useState(() => !condensing && (takePickerFirst?.() ?? false))
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const changeRef = useRef<HTMLButtonElement | null>(null)
  // The rail as it is now, each time the picker opens.
  useEffect(() => {
    if (picking) refreshChoices?.()
  }, [picking, refreshChoices])
  if (!status) {
    return (
      <p className="flex w-[32rem] items-center gap-2 p-3 text-sm text-gray-300">
        <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
        Looking for who can answer on this Mac…
      </p>
    )
  }
  const settings = status.settings
  const current = status.providers.find((option) => option.id === settings.provider) ?? null
  // An API reads no workspace: the row stays, dimmed, saying so.
  const api = current?.kind === "api"
  const dir = workspaceDir(workspace, choices)
  return (
    <div
      className="relative w-[33rem] text-sm text-gray-200"
      // A click elsewhere in the menu puts the picker away (outside it, the menu goes too).
      onPointerDown={(event) => {
        if (!picking || !(event.target instanceof globalThis.Node)) return
        if (pickerRef.current?.contains(event.target) || changeRef.current?.contains(event.target)) return
        setPicking(false)
      }}
    >
      {/* Switchboard: minmax(0, …) — a bare fr track can't shrink below its longest
          unbreakable line, and the Workspace row's folder runs as long as a path is,
          which would take the menu's width from the right column. */}
      <div className="grid grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col pr-1.5">
          <div role="radiogroup" aria-label="Answer with" className="flex flex-col gap-0.5">
            <MenuHeading>Answer with</MenuHeading>
            {status.providers.map((option) => {
              const checked = settings.provider === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => onChange({ provider: option.id })}
                  className={cx(
                    "flex items-start gap-2 rounded-lg px-2 py-1 text-left transition-colors",
                    checked
                      ? "bg-white/15 text-white"
                      : option.ready
                        ? "text-gray-300 hover:bg-white/10 hover:text-white"
                        : "text-gray-500 hover:bg-white/5 hover:text-gray-300",
                    focusRing,
                  )}
                >
                  <RiCheckLine
                    className={cx("mt-0.5 size-4 shrink-0", checked ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium">
                      {option.name}
                      <KindTag kind={option.kind} />
                    </span>
                    <span
                      className={cx(
                        "block text-[11px] leading-4",
                        option.ready ? "text-gray-400" : "text-gray-500",
                      )}
                    >
                      {condensing && option.ready ? "Condenses the selected discussion" : providerLine(option, workspace, gone)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {/* Whichever of the four answers — the workspace a CLI reads, and what it may
              do, beside who it is (and outside the radio group, which holds only the
              four). Condensing reads nothing, so neither is offered then. */}
          {!condensing ? (
            <div className="mt-auto border-t border-white/10 pt-1">
              <MenuHeading>Workspace</MenuHeading>
              <div
                className={cx(
                  "mx-0.5 mb-1 flex items-center gap-2 rounded-[9px] border border-white/10 bg-white/[.07] px-2 py-[7px]",
                  api && "opacity-60",
                )}
              >
                <PickerGlyph name="folderOpen" className={gone ? "text-amber-300" : "text-violet-300"} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      "block truncate text-xs font-semibold",
                      workspace ? "font-mono text-white" : "text-gray-300",
                    )}
                  >
                    {workspace ?? "None chosen"}
                  </span>
                  <span
                    className={cx(
                      "block truncate text-[11px] leading-4",
                      gone && !api ? "text-amber-300" : "text-gray-400",
                    )}
                    // Cut short to the row, so the whole folder is a hover away.
                    title={!api && !gone && workspace && dir ? dir : undefined}
                  >
                    {api
                      ? "Claude API and OpenAI API see only the whiteboard"
                      : gone
                        ? "No longer in the rail — choose another"
                        : workspace
                          ? `${dir ? `${dir} · ` : ""}what a CLI reads`
                          : "What Claude Code and Codex read"}
                  </span>
                </span>
                <button
                  ref={changeRef}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={picking}
                  onClick={() => setPicking((open) => !open)}
                  className={cx(
                    "flex shrink-0 items-center gap-0.5 rounded px-0.5 text-xs font-medium text-violet-300 hover:text-violet-200",
                    focusRing,
                  )}
                >
                  Change…
                  <PickerGlyph name="chev" />
                </button>
              </div>
              <MenuSwitch
                label="Web access"
                hint="Opens links and searches when needed"
                on={settings.web}
                onToggle={() => onChange({ web: !settings.web })}
              />
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1 border-l border-white/10 pl-2.5">
          {current ? <HowItAnswers provider={current} settings={settings} onChange={onChange} /> : null}
          {!condensing ? (
            <>
              <MenuHeading>Answer as</MenuHeading>
              <div role="radiogroup" aria-label="Answer as" className="grid grid-cols-2 gap-0.5 rounded-lg bg-white/5 p-0.5">
                <Segment label="Let it decide" checked={settings.split === "auto"} onClick={() => onChange({ split: "auto" })} />
                <Segment label="One box" checked={settings.split === "one"} onClick={() => onChange({ split: "one" })} />
              </div>
            </>
          ) : (
            <p className="px-2 py-2 text-xs text-gray-400">
              A few readable concepts replace the selected discussion. Its parent stays connected.
            </p>
          )}
          <div className="mt-1 flex flex-col">
            {!condensing ? (
              <MenuSwitch
                label="Read the boxes before it"
                hint="The arrows leading to the question"
                on={settings.context}
                onToggle={() => onChange({ context: !settings.context })}
              />
            ) : null}
            <MenuSwitch
              label="Subtext"
              hint="A line of detail under each box"
              on={settings.subtext}
              onToggle={() => onChange({ subtext: !settings.subtext })}
            />
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-white/10 px-2 pb-0.5 pt-2 text-[11px] text-gray-400">
        <span>
          {condensing
            ? "Uses the selected nodes and their parent. Undo restores the discussion."
            : "A box for each part an answer has. Workspace is kept with this whiteboard; the rest on this Mac."}
        </span>
        {onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={cx("flex shrink-0 items-center gap-1.5 rounded font-medium text-violet-300 hover:text-violet-200", focusRing)}
          >
            Settings…
            <kbd className="rounded bg-white/10 px-1 font-sans text-[10px] text-gray-200">⌘ ,</kbd>
          </button>
        ) : null}
      </div>
      {picking && !condensing ? (
        <BesideMenu pickerRef={pickerRef}>
          <WorkspacePicker
            choices={choices}
            current={workspace}
            currentLabel="This whiteboard's workspace"
            title="Workspace for this whiteboard"
            footer="Applies to the next answers on this whiteboard. Boxes already answered keep their tag."
            tone="dark"
            status={workspaceStatus}
            onPick={(wsId) => {
              setPicking(false)
              onWorkspace(wsId)
              changeRef.current?.focus({ preventScroll: true })
            }}
            onClose={() => {
              setPicking(false)
              changeRef.current?.focus({ preventScroll: true })
            }}
          />
        </BesideMenu>
      ) : null}
    </div>
  )
}

/**
 * Switchboard: where the Workspace row's picker sits — a child of the menu's own
 * panel, so a click in it is a click in the menu, placed just past the menu's right
 * edge as the mock-up has it. The canvas clips whatever hangs past its edges, so
 * with no room there (or a menu cut short and scrolling) it lies over the menu's
 * right-hand column instead; and it is moved up as far as it must be to end above
 * the canvas's foot.
 */
function BesideMenu({
  pickerRef,
  children,
}: {
  pickerRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}) {
  const [place, setPlace] = useState<{ beside: boolean; top: number }>({ beside: true, top: -6 })
  useLayoutEffect(() => {
    const picker = pickerRef.current
    const menu = picker?.parentElement
    if (!picker || !menu) return
    const canvas = menu.closest(".react-flow")?.getBoundingClientRect()
    const panel = menu.closest<HTMLElement>("[data-flow-popover]")
    // Opened with the menu (Choose workspace…), this runs before the panel's own
    // ref has slid it, flipped it or made it scroll: place it now, so what is
    // measured here is where it will be.
    keepInCanvas(panel)
    const box = menu.getBoundingClientRect()
    const width = picker.offsetWidth
    const height = picker.offsetHeight
    // A scrolling panel clips sideways too, and would scroll the picker's search
    // box into view, taking the menu's left column out of it.
    const scrolls = panel ? getComputedStyle(panel).overflowY !== "visible" : false
    const beside = !scrolls && (!canvas || box.right + 14 + width <= canvas.right - 8)
    let top = beside ? -6 : 0
    // Within what shows of the menu: the canvas, or a scrolling panel's own box.
    const room = scrolls && panel ? panel.getBoundingClientRect() : canvas
    if (room) {
      const bottom = box.top + top + height
      if (bottom > room.bottom - 8) top -= bottom - (room.bottom - 8)
      if (box.top + top < room.top + 8) top = room.top + 8 - box.top
    }
    setPlace((last) => (last.beside === beside && last.top === top ? last : { beside, top }))
  }, [pickerRef])
  return (
    <div
      ref={pickerRef}
      className={cx("absolute z-20", place.beside ? "left-[calc(100%+14px)]" : "right-0")}
      style={{ top: place.top }}
    >
      {children}
    </div>
  )
}

// The right-hand column's top: what can be tuned for the way picked. A CLI keeps
// its own model (Claude Code takes an effort); an API names its model, and OpenAI's
// its effort too — only the ones that model takes.
function HowItAnswers({
  provider,
  settings,
  onChange,
}: {
  provider: ProviderStatus
  settings: AnswerSettings
  onChange: (patch: Partial<AnswerSettings>) => void
}) {
  if (provider.id === "codex") {
    return (
      <>
        <MenuHeading>Model and effort</MenuHeading>
        <p className="mx-1 mb-1 rounded-lg bg-white/5 px-2.5 py-2 text-xs leading-4 text-gray-200">
          Codex&apos;s own
          <span className="block text-[11px] text-gray-400">Whatever it&apos;s set to use. Change it in Codex.</span>
        </p>
      </>
    )
  }
  if (provider.id === "claude-code") {
    return (
      <>
        <MenuHeading>Effort</MenuHeading>
        <div role="radiogroup" aria-label="Effort" className="grid grid-cols-3 gap-0.5 rounded-lg bg-white/5 p-0.5">
          {(provider.efforts ?? []).map((effort) => (
            <Segment
              key={effort.id}
              label={effort.name}
              checked={settings.claudeCodeEffort === effort.id}
              title={effort.id === "own" ? "Whatever Claude Code is set to use" : undefined}
              onClick={() => onChange({ claudeCodeEffort: effort.id })}
            />
          ))}
        </div>
        <p className="px-2 text-[11px] leading-4 text-gray-400">Model: Claude Code&apos;s own.</p>
      </>
    )
  }
  const models = provider.models ?? []
  const selected = provider.id === "claude-api" ? settings.claudeApiModel : settings.openaiModel
  const model = models.find((option) => option.id === selected)
  return (
    <>
      <MenuHeading>Model</MenuHeading>
      <div role="radiogroup" aria-label="Model" className="grid grid-cols-2 gap-0.5 rounded-lg bg-white/5 p-0.5">
        {models.map((option) => (
          <Segment
            key={option.id}
            label={option.name}
            checked={selected === option.id}
            title={option.id}
            onClick={() =>
              onChange(provider.id === "claude-api" ? { claudeApiModel: option.id } : { openaiModel: option.id })
            }
          />
        ))}
      </div>
      {provider.id === "openai-api" ? (
        <>
          <MenuHeading>Effort</MenuHeading>
          <div role="radiogroup" aria-label="Effort" className="grid grid-cols-3 gap-0.5 rounded-lg bg-white/5 p-0.5">
            {["none", "low", "medium", "high", "xhigh", "max"].map((effort) => {
              const offered = model?.efforts?.find((option) => option.id === effort)
              return (
                <Segment
                  key={effort}
                  label={offered?.name ?? EFFORT_LABELS[effort] ?? effort}
                  checked={settings.openaiEffort === effort}
                  disabled={!offered}
                  title={offered ? undefined : `${model?.name ?? "This model"} doesn't take ${EFFORT_LABELS[effort] ?? effort}`}
                  onClick={() => onChange({ openaiEffort: effort })}
                />
              )
            })}
          </div>
        </>
      ) : null}
    </>
  )
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
}

/**
 * A ticking "· 12s" since `since`. Switchboard: counted from when the answer was
 * asked for rather than from when it was first shown, so the card can switch
 * between answers on their way without restarting anyone's count.
 */
function useSeconds(since: number): number {
  const elapsed = () => Math.max(0, Math.floor((Date.now() - since) / 1000))
  const [seconds, setSeconds] = useState(elapsed)
  useEffect(() => {
    setSeconds(elapsed())
    const timer = setInterval(() => setSeconds(elapsed()), 1_000)
    return () => clearInterval(timer)
  }, [since])
  return seconds
}

// "Answering with Claude Code · 12s" and a Stop, in the strip at the bottom of
// the canvas. Switchboard: with several on their way, "Answering 3 boxes · 40s"
// (the oldest's count) and a Stop that stops them all — each box's own toolbar
// stops just its own.
function askingLabel(askings: Asking[]): string {
  if (askings.length === 1) {
    const asking = askings[0]
    return asking.mode === "condense"
      ? `Condensing ${asking.selectedIds?.length ?? 0} nodes with ${asking.name}`
      : `Answering with ${asking.name}`
  }
  return askings.some((asking) => asking.mode === "condense")
    ? `${askings.length} AI requests in progress`
    : `Answering ${askings.length} boxes`
}

function AskingStatus({ askings, onStop }: { askings: Asking[]; onStop: () => void }) {
  const seconds = useSeconds(askings[0].startedAt)
  return (
    <span className="flex items-center gap-1.5 px-1 text-violet-700 dark:text-violet-300">
      <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
      {askingLabel(askings)}
      {/* Not announced: a screen reader would read the whole line out every second. */}
      <span aria-hidden="true" className="tabular-nums">
        · {seconds}s
      </span>
      <button
        type="button"
        onClick={onStop}
        className={cx(
          "rounded px-1 font-medium text-gray-900 underline underline-offset-2 dark:text-gray-50",
          focusRing,
        )}
      >
        {askings.length === 1 ? "Stop" : "Stop all"}
      </button>
    </span>
  )
}

// What each step a CLI took is called once it is done.
const DONE_TEXT: Record<AnswerStep["kind"], string> = {
  read: "Read",
  search: "Searched for",
  list: "Looked for",
  run: "Ran",
  think: "Thought it over",
  write: "Wrote the answer",
  fetch: "Opened",
  web: "Searched the web for",
  other: "",
}

// Switchboard: the card over the strip while a CLI answers — the last few things it
// did, the one it is doing now, and that it can only read. An API gets it too, once it
// has gone on the web.
function AnswerActivity({
  asking,
  steps,
  others,
}: {
  asking: Asking
  steps: AnswerStep[]
  /** Switchboard: how many other answers are on their way too. */
  others: number
}) {
  const seconds = useSeconds(asking.startedAt)
  const shown = steps.slice(-4)
  const reads = steps.filter((step) => step.kind === "read").length
  const done = steps.filter((step) => step.kind !== "think").length
  return (
    <div
      data-canvas-overlay
      className="mx-auto mb-2 w-[27rem] max-w-[calc(100vw-6rem)] rounded-xl border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-800 dark:bg-gray-950"
    >
      <p className="mb-1.5 flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-50">
        <RiSparkling2Fill className="size-3.5 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="truncate">
          {asking.mode === "condense"
            ? `${asking.name} is condensing ${asking.selectedIds?.length ?? 0} nodes`
            : asking.cli ? `${asking.name} is reading ${asking.workspace ?? "the workspace"}` : `${asking.name} is looking it up`}
        </span>
        <span className="ml-auto font-medium tabular-nums text-gray-500" aria-hidden="true">
          {seconds}s
        </span>
      </p>
      {/* Switchboard: which box this is, once there is more than one to tell apart. */}
      {others > 0 ? (
        <p className="mb-1.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
          For “{asking.question}” · {others === 1 ? "1 more answer" : `${others} more answers`} on the way
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="flex items-center gap-2 py-0.5 text-gray-500 dark:text-gray-400">
          <RiLoader4Line className="size-3.5 animate-spin text-violet-500" aria-hidden="true" />
          Starting {asking.name}…
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map((step, index) => {
            const now = index === shown.length - 1
            return (
              <li
                key={steps.length - shown.length + index}
                className={cx(
                  "flex min-w-0 items-center gap-2 py-0.5",
                  now ? "text-gray-900 dark:text-gray-50" : "text-gray-600 dark:text-gray-400",
                )}
              >
                {now ? (
                  <RiLoader4Line className="size-3.5 shrink-0 animate-spin text-violet-500" aria-hidden="true" />
                ) : (
                  <RiCheckLine className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                )}
                <span className="shrink-0">{now ? step.text : DONE_TEXT[step.kind] || step.text}</span>
                {step.target ? (
                  <code className="min-w-0 truncate rounded bg-gray-100 px-1.5 py-px font-mono text-[11px] text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                    {step.target}
                  </code>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {reads > 0
          ? `${reads === 1 ? "1 file" : `${reads} files`} read so far · `
          : done > 0
            ? `${done === 1 ? "1 step" : `${done} steps`} so far · `
            : ""}
        {asking.mode === "condense"
          ? "The original discussion stays until its summary is ready. You can undo the replacement."
          : !asking.cli
          ? "It sees only the whiteboard, and the web when the question needs it."
          : asking.web
            ? "Read-only: it can open and search files, never change them, and look things up on the web."
            : "Read-only: it can open and search files, never change them."}
      </p>
    </div>
  )
}

// Switchboard: why the last answer didn't come, with the one thing that fixes it —
// and for a CLI with no workspace to read, Choose workspace….
function AnswerFailureLine({
  failure,
  onOpenSettings,
  onOpenTerminal,
  onChooseWorkspace,
  onDismiss,
}: {
  failure: AnswerFailure
  onOpenSettings?: () => void
  onOpenTerminal?: () => void
  onChooseWorkspace?: () => void
  onDismiss: () => void
}) {
  const action =
    failure.code === "signed-out"
      ? onOpenTerminal
        ? { label: "Open Terminal", run: onOpenTerminal }
        : null
      : failure.code === "missing" || failure.code === "no-key" || failure.code === "bad-key"
        ? onOpenSettings
          ? { label: "Settings", run: onOpenSettings }
          : null
        : failure.code === "no-workspace" && onChooseWorkspace
          ? { label: "Choose workspace…", run: onChooseWorkspace }
          : null
  return (
    <span className="flex max-w-[34rem] items-center gap-1.5 px-1 text-red-600 dark:text-red-400" title={failure.message}>
      <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{failure.message}</span>
      {action ? (
        <button
          type="button"
          onClick={action.run}
          className={cx(
            "shrink-0 rounded px-1 font-medium text-gray-900 underline underline-offset-2 dark:text-gray-50",
            focusRing,
          )}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className={cx("shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200", focusRing)}
      >
        <RiCloseLine className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

/**
 * Switchboard: the Workspace picker over the strip — Choose workspace… when the box
 * that asked is no longer there to open the who-answers menu over. Closes on a pick,
 * a click anywhere else, or Escape (the picker's own).
 */
function StripPicker({
  choices,
  onOpen,
  current,
  status,
  onPick,
  onClose,
}: {
  choices: WorkspaceChoices | null
  /** As it opens: the rail as it is now. */
  onOpen: () => void
  current: string | null
  status: WorkspaceStatus
  onPick: (wsId: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    onOpen()
  }, [onOpen])
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof globalThis.Node && ref.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [onClose])
  return (
    <div ref={ref} data-flow-popover className="mx-auto mb-2 w-fit">
      <WorkspacePicker
        choices={choices}
        current={current}
        currentLabel="This whiteboard's workspace"
        title="Workspace for this whiteboard"
        footer="Applies to the next answers on this whiteboard. Boxes already answered keep their tag."
        tone="dark"
        status={status}
        onPick={onPick}
        onClose={onClose}
      />
    </div>
  )
}

// While a box's text is being edited: its size, weight, slant and alignment,
// and the second line.
function TextBar({
  box,
  onChange,
  onToggleDetail,
  onDone,
}: {
  box: FlowBoxNodeData
  onChange: (patch: Partial<FlowBoxNodeData>) => void
  onToggleDetail: () => void
  onDone: () => void
}) {
  const size = FLOW_TEXT_SIZES.indexOf(box.textSize)
  const [marks, setMarks] = useState({ bold: false, italic: false, bullet: false, checklist: false, indent: false, outdent: false })
  useEffect(() => {
    const refresh = () => {
      const focused = document.activeElement
      const element = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-flow-text]") : null
      if (!element?.isContentEditable) return
      setMarks({
        ...flowListState(element),
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
      })
    }
    refresh()
    document.addEventListener("selectionchange", refresh)
    document.addEventListener("input", refresh)
    document.addEventListener("focusin", refresh)
    return () => {
      document.removeEventListener("selectionchange", refresh)
      document.removeEventListener("input", refresh)
      document.removeEventListener("focusin", refresh)
    }
  }, [])
  const format = (command: FlowTextCommand) => formatActiveFlowText(command)
  return (
    <Bar>
      <BarButton label="Done · Enter" onClick={onDone}>
        <RiArrowLeftSLine className="size-4" aria-hidden="true" />
      </BarButton>
      <BarDivider />
      <div className="flex items-center rounded-lg bg-white/5">
        <BarButton
          label="Smaller text"
          disabled={size <= 0}
          onClick={() => onChange({ textSize: FLOW_TEXT_SIZES[size - 1] })}
        >
          <RiSubtractLine className="size-4" aria-hidden="true" />
        </BarButton>
        <span className="w-5 text-center text-xs font-semibold" title="Text size">
          {TEXT_SIZE_NAMES[box.textSize] ?? "M"}
        </span>
        <BarButton
          label="Larger text"
          disabled={size >= FLOW_TEXT_SIZES.length - 1}
          onClick={() => onChange({ textSize: FLOW_TEXT_SIZES[size + 1] })}
        >
          <RiAddLine className="size-4" aria-hidden="true" />
        </BarButton>
      </div>
      <BarDivider />
      <BarButton label="Bold · ⌘B" active={marks.bold} onClick={() => format("bold")}>
        <RiBold className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Italic" active={marks.italic} onClick={() => format("italic")}>
        <RiItalic className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Bullet list · ⌘⇧8" active={marks.bullet} onClick={() => format("insertUnorderedList")}>
        <RiListUnordered className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Checkbox list" active={marks.checklist} onClick={() => format("checklist")}>
        <RiCheckboxLine className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Indent list · Tab" disabled={!marks.indent} onClick={() => format("indent")}>
        <RiIndentIncrease className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Outdent list · ⇧Tab" disabled={!marks.outdent} onClick={() => format("outdent")}>
        <RiIndentDecrease className="size-4" aria-hidden="true" />
      </BarButton>
      <BarDivider />
      {FLOW_TEXT_ALIGNS.map((align) => {
        const Icon = ALIGN_ICONS[align]
        return (
          <BarButton
            key={align}
            label={`Align ${align}`}
            active={box.align === align}
            onClick={() => onChange({ align })}
          >
            <Icon className="size-4" aria-hidden="true" />
          </BarButton>
        )
      })}
      <BarDivider />
      <BarButton
        label="Second line"
        active={box.detail !== undefined}
        onClick={onToggleDetail}
      >
        <RiTextBlock className="size-4" aria-hidden="true" />
      </BarButton>
    </Bar>
  )
}

// For a selected arrow: its label, solid or dashed, which way it points.
function EdgeBar({
  id,
  line,
  editor,
}: {
  id: string
  line: FlowEdgeData
  editor: EditorContextValue
}) {
  return (
    <Bar>
      <input
        data-flow-edge-label
        value={line.label ?? ""}
        maxLength={DIAGRAM_TEXT_MAX_LENGTH}
        placeholder="Add a label"
        aria-label="Arrow label"
        onChange={(event) => editor.updateEdge(id, { label: event.target.value }, true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return
          event.preventDefault()
          // Escape stops here rather than also leaving full screen.
          event.stopPropagation()
          event.currentTarget.blur()
        }}
        className="nodrag h-8 w-36 rounded-lg bg-white/10 px-2 text-sm text-white outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-brand"
      />
      <BarDivider />
      <BarButton
        label="Solid line"
        active={!line.dashed}
        onClick={() => editor.updateEdge(id, { dashed: false })}
      >
        <StrokeGlyph kind="line" dashed={false} />
      </BarButton>
      <BarButton
        label="Dashed line"
        active={line.dashed}
        onClick={() => editor.updateEdge(id, { dashed: true })}
      >
        <StrokeGlyph kind="line" dashed />
      </BarButton>
      <BarDivider />
      <BarButton label="Reverse direction" onClick={() => editor.reverseEdge(id)}>
        <RiArrowLeftRightLine className="size-4" aria-hidden="true" />
      </BarButton>
      <BarButton label="Delete · ⌫" onClick={() => editor.deleteEdge(id)}>
        <RiDeleteBinLine className="size-4" aria-hidden="true" />
      </BarButton>
    </Bar>
  )
}

// The original +N remains visible on collapsed nodes, independent of selection.
// Clicking it reveals the hidden branches, including an older partial fold.
function FoldButton({ fold, label: nodeLabel, disabled, onClick }: {
  fold: FoldBadge
  label: string
  disabled: boolean
  onClick: () => void
}) {
  const name = nodeLabel.trim().slice(0, 48) || "this node"
  const label = `Show ${fold.boxes} hidden ${fold.boxes === 1 ? "node" : "nodes"} from ${name}`
  return (
    <button
      type="button"
      data-flow-fold-badge
      aria-expanded={false}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onClick() }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cx(
        "nodrag nopan absolute -right-2.5 -top-2.5 z-10 flex h-6 min-w-6 items-center justify-center whitespace-nowrap rounded-full bg-gray-900 px-1.5 text-[11px] font-semibold tabular-nums text-white shadow-sm ring-2 ring-white hover:bg-brand dark:bg-gray-100 dark:text-gray-900 dark:ring-gray-950",
        focusRing,
      )}
    >
      +{fold.boxes}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Chrome
// ─────────────────────────────────────────────────────────────────────

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex size-7 items-center justify-center rounded text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900",
        "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-50",
        "disabled:pointer-events-none disabled:opacity-35",
        focusRing,
      )}
    >
      {children}
    </button>
  )
}

function SaveStatus({
  saving,
  dirty,
  error,
  onRetry,
}: {
  saving: boolean
  dirty: boolean
  error: string | null
  onRetry: () => void
}) {
  if (error !== null && !saving) {
    return (
      <span className="flex items-center gap-1.5 pr-1 text-red-600 dark:text-red-400" title={error}>
        <RiErrorWarningLine className="size-4 shrink-0" aria-hidden="true" />
        <span className="max-w-56 truncate">Couldn&apos;t save — {error}</span>
        <button
          type="button"
          onClick={onRetry}
          className={cx("rounded px-1.5 py-0.5 font-medium underline underline-offset-2", focusRing)}
        >
          Retry
        </button>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 pr-1.5 text-gray-500 dark:text-gray-400" role="status">
      {saving ? (
        <>
          <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
          Saving…
        </>
      ) : dirty ? (
        "Unsaved changes"
      ) : (
        <>
          <RiCheckLine className="size-3.5" aria-hidden="true" />
          Saved
        </>
      )}
    </span>
  )
}

// The toolbar down the left of the canvas, after Whimsical's: what a click on
// the canvas does (select or pan), the things you can put on it, and the
// keyboard shortcuts. The box, note and text tools can also be dragged
// straight onto the canvas.
function ToolRail({
  tool,
  shape,
  uploading,
  onTool,
  onShape,
  imageMenu,
  onImageMenu,
  onImageFile,
  onImageSearch,
}: {
  tool: Tool
  shape: FlowBoxShape
  uploading: boolean
  onTool: (tool: Tool) => void
  onShape: (shape: FlowBoxShape) => void
  // Switchboard: the image tool is a menu — a file, or Google Images — where the
  // admin's opens the file picker straight away. Its open state is the editor's,
  // so the I and G keys, and every other tool, close it too.
  imageMenu: boolean
  onImageMenu: (open: boolean) => void
  onImageFile: () => void
  onImageSearch: () => void
}) {
  // The shape menu is open while the shape tool is out, so the box it will
  // place can be swapped before clicking the canvas.
  const [helpOpen, setHelpOpen] = useState(false)
  // Switchboard: how much height the canvas gives the rail. Only a change of it
  // re-renders the rail; a Grid square or a short window is where it runs short.
  const fit = railFit(useStore((state) => state.height))
  // In two columns, what a tool opens sits beside the whole rail (its wrapper is
  // not positioned then) rather than over the tool in the next column.
  const anchor = fit === "columns" ? undefined : "relative"

  return (
    <RailFitContext.Provider value={fit}>
      <div
        role="toolbar"
        aria-label="Tools"
        aria-orientation="vertical"
        data-rail-fit={fit}
        className={cx(
          "relative rounded-xl bg-gray-900 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10",
          fit === "full" && "flex flex-col items-center gap-1 p-1",
          fit === "compact" && "flex flex-col items-center gap-0.5 p-0.5",
          fit === "columns" && "grid grid-cols-2 place-items-center gap-0.5 p-0.5",
        )}
      >
        <RailButton label="Select" shortcut="V" active={tool === "select"} onClick={() => onTool("select")}>
          <RiCursorLine className="size-4" aria-hidden="true" />
        </RailButton>
        <RailButton label="Pan" shortcut="H" active={tool === "hand"} onClick={() => onTool("hand")}>
          <RiHand className="size-4" aria-hidden="true" />
        </RailButton>

        <RailDivider />

        <div className={anchor}>
          <RailButton
            label="Shape"
            shortcut="R"
            active={tool === "shape"}
            onClick={() => onTool(tool === "shape" ? "select" : "shape")}
            drag={shape}
            // Its menu sits where the tip would.
            tip={tool !== "shape"}
          >
            <ShapeGlyph shape={shape} className="h-4 w-5" />
          </RailButton>
          {tool === "shape" ? (
            <div
              role="radiogroup"
              aria-label="Which shape"
              data-canvas-overlay
              className="absolute left-full top-1/2 ml-3 flex -translate-y-1/2 flex-col gap-0.5 rounded-xl bg-gray-900 p-1.5 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10"
            >
              {PALETTE.map((item) => (
                <button
                  key={item.shape}
                  type="button"
                  role="radio"
                  aria-checked={shape === item.shape}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_MIME, item.shape)
                    event.dataTransfer.effectAllowed = "copy"
                  }}
                  onClick={() => onShape(item.shape)}
                  title="Click the canvas to place it, or drag it there"
                  className={cx(
                    "flex items-center gap-2.5 whitespace-nowrap rounded-lg py-1.5 pl-2 pr-3 text-left text-sm transition-colors",
                    shape === item.shape
                      ? "bg-white/15 text-white"
                      : "text-gray-300 hover:bg-white/10 hover:text-white",
                    focusRing,
                  )}
                >
                  <ShapeGlyph shape={item.shape} />
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <RailButton label="Sticky note" shortcut="S" active={tool === "note"} onClick={() => onTool(tool === "note" ? "select" : "note")} drag="note">
          <RiStickyNoteLine className="size-4" aria-hidden="true" />
        </RailButton>
        <RailButton label="Text" shortcut="T" active={tool === "text"} onClick={() => onTool(tool === "text" ? "select" : "text")} drag="text">
          <RiText className="size-4" aria-hidden="true" />
        </RailButton>
        <RailButton label="Document" active={tool === "document"} onClick={() => onTool(tool === "document" ? "select" : "document")} drag="document">
          <RiFileTextLine className="size-4" aria-hidden="true" />
        </RailButton>
        <div className={anchor}>
          <RailButton
            label={uploading ? "Uploading…" : "Image"}
            shortcut="I"
            active={imageMenu}
            expanded={imageMenu}
            onClick={() => onImageMenu(!imageMenu)}
            // Its menu sits where the tip would.
            tip={!imageMenu}
          >
            {uploading ? (
              <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RiImageAddLine className="size-4" aria-hidden="true" />
            )}
          </RailButton>
          {imageMenu ? (
            <ImageMenu
              onFile={onImageFile}
              onSearch={onImageSearch}
              onClose={() => onImageMenu(false)}
            />
          ) : null}
        </div>

        {/* In two columns the image tool and this one share the last row. */}
        {fit === "columns" ? null : <RailDivider />}

        <div className={anchor}>
          <RailButton
            label="Keyboard shortcuts"
            active={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
            tip={!helpOpen}
          >
            <RiKeyboardLine className="size-4" aria-hidden="true" />
          </RailButton>
          {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
        </div>
      </div>
    </RailFitContext.Provider>
  )
}

/**
 * Switchboard: how the tool rail fits the canvas's height — at full size; with
 * smaller tools packed closer ("compact"); or, shorter still, in two columns —
 * rather than running off the top and bottom of a short canvas (a Grid square,
 * a small window), where its first tools would be out of reach.
 */
type RailFit = "full" | "compact" | "columns"
const RailFitContext = createContext<RailFit>("full")
// The rail's height in the first two, from the classes above, RailButton's and
// RailDivider's — 8 tools, 9 gaps, 2 dividers, the padding — with 8px clear above
// and below. In two columns it is 125px.
const RAIL_FULL_HEIGHT = 8 * 32 + 9 * 4 + 2 * 5 + 8 + 16
const RAIL_COMPACT_HEIGHT = 8 * 28 + 9 * 2 + 2 * 1 + 4 + 16
function railFit(paneHeight: number): RailFit {
  // Not measured yet: as it always was.
  if (!(paneHeight > 0) || paneHeight >= RAIL_FULL_HEIGHT) return "full"
  return paneHeight >= RAIL_COMPACT_HEIGHT ? "compact" : "columns"
}

function RailDivider() {
  const fit = useContext(RailFitContext)
  return (
    <span
      className={cx(
        "h-px bg-white/15",
        fit === "full" && "my-0.5 w-5",
        fit === "compact" && "w-5",
        fit === "columns" && "col-span-2 w-10",
      )}
      aria-hidden="true"
    />
  )
}

// Switchboard: the image tool's menu, laid out as the shape menu is, to the
// tool's right. Closes on a pick, a click anywhere else, or Escape (which then
// goes no further — not out of full screen, not out of the selection). Two
// buttons the tool shows and hides, as the shape menu's are — not an ARIA menu,
// whose arrow keys would be the canvas's. Tab reaches them from the tool.
function ImageMenu({
  onFile,
  onSearch,
  onClose,
}: {
  onFile: () => void
  onSearch: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // A pick or Escape made from these buttons hands the keyboard back to the
  // tool, rather than dropping it as they go.
  function done(then: () => void) {
    if (ref.current?.contains(document.activeElement)) {
      ref.current.parentElement?.querySelector("button")?.focus()
    }
    then()
  }
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!(event.target instanceof globalThis.Node)) return
      // The button that opened it toggles it shut itself.
      if (ref.current?.parentElement?.contains(event.target)) return
      onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.stopPropagation()
      done(onClose)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Add an image"
      data-flow-popover
      data-canvas-overlay
      className="absolute left-full top-1/2 ml-3 flex -translate-y-1/2 flex-col gap-0.5 rounded-xl bg-gray-900 p-1.5 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10"
    >
      <ImageMenuItem label="Choose a file…" shortcut="I" onClick={() => done(onFile)}>
        <RiFolderImageLine className="size-4" aria-hidden="true" />
      </ImageMenuItem>
      <ImageMenuItem label="Search Google Images" shortcut="G" onClick={() => done(onSearch)}>
        <RiSearchLine className="size-4" aria-hidden="true" />
      </ImageMenuItem>
    </div>
  )
}

function ImageMenuItem({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      className={cx(
        "flex items-center gap-2.5 whitespace-nowrap rounded-lg py-1.5 pl-2 pr-2 text-left text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white",
        focusRing,
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">{children}</span>
      <span className="flex-1">{label}</span>
      <kbd
        className="ml-4 rounded bg-white/15 px-1 font-sans text-[10px] text-gray-200"
        aria-hidden="true"
      >
        {shortcut}
      </kbd>
    </button>
  )
}

// A tool: an icon with its name and key in a tip beside it. `drag` makes it
// one you can also drag onto the canvas.
function RailButton({
  label,
  shortcut,
  active,
  expanded,
  onClick,
  drag,
  tip = true,
  children,
}: {
  label: string
  shortcut?: string
  active?: boolean
  /**
   * Switchboard: set for a tool that shows choices beside it — whether they are
   * showing — in place of pressed.
   */
  expanded?: boolean
  onClick: () => void
  drag?: FlowBoxShape | "note" | "text" | "document"
  /** False while something it opened is showing where the tip would go. */
  tip?: boolean
  children: React.ReactNode
}) {
  const fit = useContext(RailFitContext)
  return (
    <button
      type="button"
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      onClick={onClick}
      draggable={drag !== undefined}
      onDragStart={
        drag === undefined
          ? undefined
          : (event) => {
              event.dataTransfer.setData(DRAG_MIME, drag)
              event.dataTransfer.effectAllowed = "copy"
            }
      }
      className={cx(
        "group/tool relative flex items-center justify-center rounded-lg transition-colors",
        // Switchboard: a little smaller on a canvas too short for the rail (railFit).
        fit === "full" ? "size-8" : "size-7",
        // White rather than the brand colour, which for some products is as
        // dark as the toolbar itself.
        active ? "bg-white text-gray-900 shadow-sm" : "text-gray-300 hover:bg-white/10 hover:text-white",
        "outline outline-0 outline-offset-2 outline-white focus-visible:outline-2",
      )}
    >
      {children}
      {tip ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-20 ml-3 hidden -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 group-hover/tool:flex group-focus-visible/tool:flex dark:bg-gray-800 dark:ring-white/10"
        >
          {label}
          {shortcut ? (
            <kbd className="rounded bg-white/15 px-1 font-sans text-[10px] text-gray-200">{shortcut}</kbd>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}

const SHORTCUTS: [string, string][] = [
  ["Tab", "Next connected box"],
  ["⇧ Tab", "Back to the parent"],
  ["Enter", "Edit the text"],
  ["⌘ B", "Bold selected text"],
  ["⌘ ⇧ 8", "Bullet list"],
  ["↑ ↓ ← →", "Jump between boxes"],
  ["⇧ ↑ ↓ ← →", "Nudge the selection"],
  ["⌘ I", "Answer or condense with AI"],
  ["⌘ D", "Duplicate"],
  ["⌘ C  ⌘ V", "Copy, paste at the pointer"],
  ["⌘ Z", "Undo"],
  ["⌫", "Delete"],
  ["Space", "Hold and drag to pan"],
]

// The keyboard and mouse moves that aren't on a button anywhere. Closes on a
// click elsewhere or Escape.
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!(event.target instanceof globalThis.Node)) return
      // The button that opened it toggles it shut itself.
      if (ref.current?.parentElement?.contains(event.target)) return
      onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      data-flow-popover
      data-canvas-overlay
      className="absolute bottom-0 left-full z-20 ml-3 w-64 rounded-xl bg-gray-900 p-3 text-xs text-gray-300 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10"
    >
      <p className="mb-2 font-semibold text-white">Shortcuts</p>
      <dl className="flex flex-col gap-1.5">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="flex items-center justify-between gap-3">
            <dt className="text-gray-300">{what}</dt>
            <dd>
              <kbd className="whitespace-nowrap rounded bg-white/10 px-1.5 py-0.5 font-sans text-[11px] text-gray-100">
                {keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-white/10 pt-2 leading-4 text-gray-400">
        Drag from a box&apos;s dot to draw an arrow. Double-click the canvas to
        type anywhere. Drop or paste an image to add it.
      </p>
    </div>
  )
}
