"use client"

import { useState, type RefObject } from "react"
import { RiErrorWarningLine } from "@remixicon/react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/Dialog"
import { Button } from "@/components/Button"
import { toast } from "@/components/Toast"
import { deleteDiagram } from "@/lib/diagrams/actions"

type Target = {
  id: string
  name: string
  archived: boolean
}

type Props = {
  target: Target | null
  productId: string
  onOpenChange: (open: boolean) => void
  onDeleted: (id: string) => void
  /**
   * Where focus goes when the dialog closes: the Actions menu trigger that
   * opened it. Left to Radix it would land on <body> — the dialog has no
   * DialogTrigger of its own to hand it back to. After a delete the trigger
   * is gone with the diagram, and focus falls to <body>.
   */
  returnFocusRef: RefObject<HTMLElement | null>
}

// One confirmation before the permanent step. For a diagram still in use it
// points at Archive, the way to put a diagram away without losing it.
export function DeleteDiagramDialog({
  target,
  productId,
  onOpenChange,
  onDeleted,
  returnFocusRef,
}: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setSubmitting(false)
    setError(null)
  }

  async function handleDelete() {
    if (!target || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const result = await deleteDiagram({ productId, id: target.id })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast({ title: `Deleted ${target.name}`, variant: "success" })
      reset()
      onOpenChange(false)
      onDeleted(target.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (submitting) return
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusRef.current?.focus()
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-500">
              <RiErrorWarningLine className="size-5" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle>
                {target?.archived ? "Delete this archived diagram?" : "Delete this diagram?"}
              </DialogTitle>
              <DialogDescription>
                This permanently deletes{" "}
                <span className="font-medium text-gray-900 dark:text-gray-50">
                  {target?.name}
                </span>{" "}
                and its spec. It can&apos;t be undone
                {target?.archived
                  ? "."
                  : " — to put it away without losing it, archive it instead."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {error ? (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : null}

        <DialogFooter className="mt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              // reset() first: this bypasses the Radix onOpenChange wrapper
              // below, so without it a failed delete's error would survive and
              // be shown pre-populated the next time the dialog opens.
              reset()
              onOpenChange(false)
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={submitting}
          >
            {submitting ? "Deleting…" : "Delete diagram"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
