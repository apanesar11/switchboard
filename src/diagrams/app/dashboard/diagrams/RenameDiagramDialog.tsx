"use client"

// Switchboard: Actions ▸ Rename. The admin has no rename; here a whiteboard is a
// file you keep working on, and its name should be able to follow what it became.
// Only the name is written — the drawing on disk is whatever the last autosave put
// there, so a board whose spec can't be read can still be renamed — and a name
// another whiteboard in the same folder already has is refused, the same rule as
// New whiteboard.

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
import { DIAGRAM_NAME_MAX_LENGTH } from "@/lib/diagrams/types"

type Props = {
  /** The whiteboard being renamed, or null while the dialog is closed. */
  target: { id: string; name: string } | null
  onOpenChange: (open: boolean) => void
  /** Writes the new name; resolves to why it couldn't, or null once it has. */
  onRename: (id: string, name: string) => Promise<string | null>
  /** Where focus goes back to once the dialog closes — the Actions button. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export function RenameDiagramDialog({ target, onOpenChange, onRename, returnFocusRef }: Props) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current?.isConnected) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        {/* Remounted on every open, so the field starts from the current name. */}
        {target ? (
          <RenameForm
            key={target.id}
            target={target}
            onCancel={() => onOpenChange(false)}
            onRename={onRename}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  target,
  onCancel,
  onRename,
  onDone,
}: {
  target: { id: string; name: string }
  onCancel: () => void
  onRename: (id: string, name: string) => Promise<string | null>
  onDone: () => void
}) {
  const [name, setName] = useState(target.name)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unchanged = name.trim().replace(/\s+/g, " ") === target.name

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting || name.trim().length === 0) return
    if (unchanged) {
      onDone()
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const problem = await onRename(target.id, name)
      if (problem) setError(problem)
      else onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename the whiteboard")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Rename whiteboard</DialogTitle>
        <DialogDescription>
          The drawing stays as it is; only its name changes.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-5 flex flex-col gap-2">
        <Label htmlFor="rename-whiteboard-name">Name</Label>
        <Input
          id="rename-whiteboard-name"
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          value={name}
          maxLength={DIAGRAM_NAME_MAX_LENGTH}
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
          {submitting ? "Renaming…" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  )
}
