import { createContext, useContext, useEffect, useRef, useState } from "react"
import { RiCheckLine, RiFileCopyLine } from "@remixicon/react"
import { toast } from "@/components/Toast"
import { call, type Result } from "@/lib/bridge"
import { cx } from "@/lib/utils"
import type { FlowBoxNodeData } from "@/lib/diagrams/layout"

// Kept outside node data so paths and callbacks never enter the saved spec.
export const DiagramFileCopyContext = createContext<((id: string) => Promise<Result<string>>) | null>(null)

export function CopyPathButton({ label, onPath, className, children, disabled = false }: {
  label: string
  onPath(): Promise<Result<string>>
  className?: string
  children?: React.ReactNode
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setCopied(false)
    try {
      const path = await onPath()
      if (!path.ok) throw new Error(path.error)
      const result = await call("writeClipboard", path.data)
      if (!result.ok) throw new Error(result.error)
      setCopied(true)
    } catch (error) {
      toast({ title: "Couldn't copy file path", description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <button
    type="button"
    className={cx("nodrag nopan nowheel", className)}
    aria-label={label}
    title={busy ? "Preparing file…" : copied ? "Path copied" : label}
    disabled={disabled || busy}
    data-copied={copied}
    aria-busy={busy}
    onPointerDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); void copy() }}
  >
    {copied ? <RiCheckLine size={14} aria-hidden="true" /> : <RiFileCopyLine size={14} aria-hidden="true" />}
    {children}
    <span className="sr-only" role="status">{copied ? "Path copied" : ""}</span>
  </button>
}

export function DiagramFileCopy({ box }: { box: FlowBoxNodeData }) {
  const documentPath = useContext(DiagramFileCopyContext)
  if (box.shape === "image" && box.src) return <CopyPathButton
    className="flow-file-copy"
    label="Copy image file path"
    onPath={() => call("diagramsGetImagePath", box.src!)}
  />
  if (box.shape === "document" && box.documentId && documentPath) return <CopyPathButton
    className="flow-file-copy"
    label="Copy Markdown file path"
    onPath={() => documentPath(box.documentId!)}
  />
  return null
}
