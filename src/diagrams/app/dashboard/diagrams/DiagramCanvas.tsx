"use client"

// The canvas: a validated spec in, a pannable/zoomable React Flow drawing out.
//
// Everything visual is decided by layoutDiagram() before React Flow sees it, so
// this component owns exactly three things — the read-only interaction posture,
// the canvas chrome (background, controls, minimap, the title overlay), and
// re-fitting the view when the diagram changes.
//
// Read-only is enforced on every axis React Flow offers rather than by leaving
// handlers off: no dragging nodes, no connecting, no selecting, no deleting.
// Panning and zooming are the only gestures, which is the whole interaction
// budget for something you are reading.

import { useMemo, useState } from "react"
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
} from "@xyflow/react"
import { layoutDiagram, type FlowBoxNodeData } from "@/lib/diagrams/layout"
import { DocumentPanel, type DocumentView } from "./DocumentPanel"
import { useFlowDocuments } from "./useFlowDocuments"
import { cx } from "@/lib/utils"
import type { DiagramSpec } from "@/lib/diagrams/types"
import { diagramNodeTypes } from "./DiagramNodes"
import { FLOW_EDGE_THEME } from "./DiagramEdges"

// React Flow's own stylesheet. `style.css` (rather than `base.css`) because the
// Controls and MiniMap chrome comes with it; the node styling it also carries
// only targets React Flow's BUILT-IN node types, so none of it reaches the
// custom types in DiagramNodes.tsx.
import "@xyflow/react/dist/style.css"

// Exported for the editor, which frames a diagram the same way.
export const FIT_VIEW_OPTIONS = {
  padding: 0.14,
  // Never blow a small diagram up past life size — a three-box diagram
  // scaled to fill a 1400px pane looks like a mistake.
  maxZoom: 1,
  minZoom: 0.15,
}

type Props = {
  spec: DiagramSpec
  /**
   * Changes whenever the canvas should be rebuilt and re-fitted from scratch —
   * a different diagram, or the same one just saved. It keys the ReactFlow
   * element, because `fitView` is an initialisation prop: remounting is what
   * makes it run again, and dropping the old pan/zoom is the desired behaviour
   * in both of those cases anyway.
   */
  resetKey: string
  workspace?: string
  diagramName?: string
}

export function DiagramCanvas({ spec, resetKey, workspace = "", diagramName }: Props) {
  const layout = useMemo(() => layoutDiagram(spec), [spec])
  const [document, setDocument] = useState<FlowBoxNodeData | null>(null)
  const [view, setView] = useState<DocumentView>("floating")
  const documents = useFlowDocuments(workspace, document?.documentId)

  return (
    <div className={cx("relative flex size-full min-w-0 bg-gray-50 dark:bg-gray-900", FLOW_EDGE_THEME)}>
      <div className="h-full min-w-0 flex-1">
      <ReactFlow
        key={resetKey}
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={diagramNodeTypes}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={FIT_VIEW_OPTIONS.minZoom}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        // A flow box's handles are all "source" handles, one per side; loose
        // mode is what lets an edge LAND on one. See FlowBoxNode.
        connectionMode={ConnectionMode.Loose}
        nodesFocusable={false}
        onNodeDoubleClick={(_, node) => {
          const box = node.data as FlowBoxNodeData
          if (workspace && box.shape === "document") { setDocument(box); setView("floating") }
        }}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
        // Nothing on this canvas responds to Backspace, and swallowing it would
        // be actively wrong while a dialog's fields are focused above it.
        deleteKeyCode={null}
        attributionPosition="bottom-right"
        aria-label={layout.title ?? "Diagram"}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="text-gray-300 dark:text-gray-700"
          color="currentColor"
        />
        <Controls showInteractive={false} position="bottom-left" />
        {/* Worth its space only once the diagram is taller or wider than a
            pane — below that the minimap is a picture of what you can already
            see. */}
        {layout.height > 900 || layout.width > 1500 ? (
          <MiniMap
            pannable
            zoomable
            position="top-right"
            className="!bg-white/80 dark:!bg-gray-950/80"
            maskColor="rgb(243 244 246 / 0.6)"
            nodeColor="#9ca3af"
          />
        ) : null}

        {layout.title || layout.summary ? (
          // A Panel, not a node: the heading is chrome that should stay put and
          // stay legible, rather than something that pans away with the drawing
          // and skews `fitView`'s bounds.
          <Panel
            position="top-left"
            className="pointer-events-none max-w-md rounded-md border border-gray-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm dark:border-gray-800 dark:bg-gray-950/90"
          >
            {layout.title ? (
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-50">
                {layout.title}
              </p>
            ) : null}
            {layout.summary ? (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {layout.summary}
              </p>
            ) : null}
          </Panel>
        ) : null}
      </ReactFlow>
      </div>
      {document?.documentId ? <DocumentPanel key={document.documentId} title={document.label} diagramName={diagramName} buffer={documents.active} view={view} onView={setView} readOnly onRename={() => {}} onEdit={() => {}} onSave={() => {}} onResolve={() => {}} onRetry={() => void documents.retry(document.documentId!, true)} onClose={() => setDocument(null)} /> : null}
    </div>
  )
}
