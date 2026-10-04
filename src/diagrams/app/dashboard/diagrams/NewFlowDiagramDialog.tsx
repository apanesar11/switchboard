"use client"

// "New diagram": a name, then straight onto an empty canvas. No JSON on the
// way in — the drawing is what gets made here, by putting shapes on it, so all
// the dialog needs is what to call it.

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/Dialog"
import { Button } from "@/components/Button"
import { Input } from "@/components/Input"
import { Label } from "@/components/Label"
import { createDiagram } from "@/lib/diagrams/actions"
import { BLANK_FLOW } from "@/lib/diagrams/templates"
import {
  DIAGRAM_NAME_MAX_LENGTH,
  type DiagramDetail,
} from "@/lib/diagrams/types"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  productId: string
  onCreated: (created: DiagramDetail) => void
}

export function NewFlowDiagramDialog({
  open,
  onOpenChange,
  productId,
  onCreated,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Remounted on every open (Radix unmounts the portal on close), so
            the name and any error start fresh each time. */}
        <NewFlowForm
          productId={productId}
          onCancel={() => onOpenChange(false)}
          onCreated={(created) => {
            onOpenChange(false)
            onCreated(created)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function NewFlowForm({
  productId,
  onCancel,
  onCreated,
}: {
  productId: string
  onCancel: () => void
  onCreated: (created: DiagramDetail) => void
}) {
  const [name, setName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting || name.trim().length === 0) return
    setError(null)
    setSubmitting(true)
    try {
      const result = await createDiagram({ productId, name, spec: BLANK_FLOW })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onCreated(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the diagram")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>New diagram</DialogTitle>
        <DialogDescription>
          It opens on an empty canvas — put boxes, notes, text and images on
          it and connect them. Changes save as you go.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-5 flex flex-col gap-2">
        <Label htmlFor="new-flow-name">Name</Label>
        <Input
          id="new-flow-name"
          autoFocus
          value={name}
          maxLength={DIAGRAM_NAME_MAX_LENGTH}
          placeholder="e.g. Refund approval"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {error ? (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      <DialogFooter className="mt-6">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || name.trim().length === 0}>
          {submitting ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  )
}
