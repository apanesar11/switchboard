"use client"

// "New whiteboard": a name, then straight onto an empty canvas. No JSON on the
// way in — the drawing is what gets made here, by putting shapes on it, so all
// the dialog needs is what to call it.
//
// Switchboard: the board lands in the folder of the one it was made from (or in
// none), and main gives it the workspace ✦ Answer used last — the page then opens
// it, by asking the host to change the route.

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
import { createWhiteboard, type SavedWhiteboard } from "@/lib/diagrams/actions"
import { BLANK_FLOW } from "@/lib/diagrams/templates"
import { DIAGRAM_NAME_MAX_LENGTH } from "@/lib/diagrams/types"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The folder it is made in — the current board's — or null for No folder. */
  folderId: string | null
  /** That folder's name, once the folder list has come; null for No folder. */
  folderName?: string | null
  onCreated: (created: SavedWhiteboard) => void
  /** Where focus goes back to once the dialog closes without making one. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export function NewFlowDiagramDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  onCreated,
  returnFocusRef,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current?.isConnected) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        {/* Remounted on every open (Radix unmounts the portal on close), so
            the name and any error start fresh each time. */}
        <NewFlowForm
          folderId={folderId}
          folderName={folderName}
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
  folderId,
  folderName,
  onCancel,
  onCreated,
}: {
  folderId: string | null
  folderName?: string | null
  onCancel: () => void
  onCreated: (created: SavedWhiteboard) => void
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
      // The workspace is left out on purpose: main fills in the one used last.
      const result = await createWhiteboard({ folderId, name, spec: BLANK_FLOW })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onCreated(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the whiteboard")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>New whiteboard</DialogTitle>
        <DialogDescription>
          It opens on an empty canvas — put boxes, notes, text and images on
          it and connect them. Changes save as you go.{" "}
          {folderId === null ? (
            "Like this one, it isn't in a folder."
          ) : folderName ? (
            <>
              It goes in{" "}
              <span className="font-medium text-gray-900 dark:text-gray-50">{folderName}</span>,
              with this one.
            </>
          ) : (
            "It goes in this one's folder."
          )}
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
