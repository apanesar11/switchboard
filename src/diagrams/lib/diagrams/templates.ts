// Starter specs. BLANK_FLOW is what "New diagram" starts from; FLOW_TEMPLATE
// is a small but complete flow of the kind Claude writes — the box shapes,
// tones and edge styles — kept here so the parser and layout tests exercise
// it, and a spec in that shape that no longer validates fails a test.

import type { FlowSpec } from "./types"

export const FLOW_TEMPLATE: FlowSpec = {
  kind: "flow",
  title: "Publish a post",
  direction: "down",
  nodes: [
    { id: "draft", label: "Draft", shape: "pill", tone: "muted" },
    { id: "review", label: "Review", detail: "an editor reads it" },
    { id: "ready", label: "Ready?", shape: "diamond", tone: "accent" },
    { id: "publish", label: "Publish", tone: "success" },
    { id: "revise", label: "Send back", tone: "warning" },
  ],
  edges: [
    { from: "draft", to: "review" },
    { from: "review", to: "ready" },
    { from: "ready", to: "publish", label: "yes" },
    { from: "ready", to: "revise", label: "no" },
    { from: "revise", to: "review", dashed: true },
  ],
}

// What "New flow diagram" starts from: an empty canvas, ready for shapes to be
// put on it. The validator allows a flow with no nodes
// for exactly this.
export const BLANK_FLOW: FlowSpec = {
  kind: "flow",
  nodes: [],
  edges: [],
}
