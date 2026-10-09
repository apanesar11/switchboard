"use client"

// The whiteboard quick switcher: one trigger showing the board on screen and its
// folder, opening a popover with a search box and the boards of THAT folder. A
// sibling of the admin's MockupPicker, and deliberately the same control.
//
// Results are two groups: active boards, then an "Archived" section pinned below
// them. An archived board never outranks an active one however well it matches —
// see searchDiagrams. Rows are navigation only: picking one asks the host to open
// it (the page shows exactly one board); archive and delete live in the Actions
// menu of the board you have open.
//
// Switchboard: the folder's list comes after the board itself, so the trigger is
// drawn from the board on screen (`current`) and the rows from `boards` once they
// arrive. Every board in Switchboard's Whiteboards screen is a click away; this
// is for hopping between related ones without leaving the canvas.

import { useEffect, useMemo, useState } from "react"
import * as PopoverPrimitives from "@radix-ui/react-popover"
import {
  RiArchiveLine,
  RiCheckLine,
  RiSearchLine,
} from "@remixicon/react"
import { cx, focusInput, focusRing } from "@/lib/utils"
// Switchboard: portalled into the bundle's own root, where its styles reach.
import { usePortalContainer } from "@/lib/portal"
import { searchDiagrams } from "@/lib/diagrams/search"
import type { DiagramSummary } from "@/lib/diagrams/types"
import { Glyph } from "@/components/Glyph"

type Props = {
  /** The boards of the current board's folder; null while that list loads. */
  boards: DiagramSummary[] | null
  /** The board on screen — drawn in the trigger before the folder's list comes. */
  current: DiagramSummary
  /** "Architecture", or "No folder"; null while the folder list loads. */
  folderLabel: string | null
  onSelect: (id: string) => void
  // Owned by the page so the ← / → arrows step through what a search left.
  search: string
  onSearchChange: (value: string) => void
  formatRelative: (iso: string) => string
  active: boolean
}

export function DiagramPicker({
  boards,
  current,
  folderLabel,
  onSelect,
  search,
  onSearchChange,
  formatRelative,
  active,
}: Props) {
  const [open, setOpen] = useState(false)
  const selectedId = current.id

  // The portal remains attached to body while its canvas is parked off screen.
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  const list = useMemo(() => boards ?? [], [boards])
  const results = useMemo(
    () => searchDiagrams(list, search),
    [list, search],
  )
  const total = results.active.length + results.archived.length

  const archivedCount = useMemo(
    () => list.filter((d) => d.archivedAt !== null).length,
    [list],
  )

  function handleSelect(id: string) {
    onSelect(id)
    setOpen(false)
  }

  function renderRow(diagram: DiagramSummary) {
    const active = diagram.id === selectedId
    const isArchived = diagram.archivedAt !== null
    return (
      <button
        key={diagram.id}
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => handleSelect(diagram.id)}
        className={cx(
          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
          focusRing,
          active
            ? "bg-brand-faint text-brand dark:bg-brand/15 dark:text-brand-light"
            : "text-gray-900 hover:bg-gray-100 dark:text-gray-50 dark:hover:bg-gray-900",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {active ? <RiCheckLine className="size-4" aria-hidden="true" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{diagram.name}</span>
            {isArchived ? (
              <RiArchiveLine
                className="size-3.5 shrink-0 text-gray-400"
                aria-label="Archived"
              />
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
            {isArchived && diagram.archivedAt
              ? `Archived ${formatRelative(diagram.archivedAt)}`
              : `Updated ${formatRelative(diagram.updatedAt)}`}
          </span>
        </span>
      </button>
    )
  }

  return (
    <PopoverPrimitives.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitives.Trigger asChild>
        <button
          type="button"
          // Composed, not static: a bare aria-label would override the visible
          // board name in the accessible-name computation, so this control —
          // the only one that displays the current board — would announce
          // the same string no matter which board is open.
          aria-label={`Switch whiteboard — currently ${current.name}${
            current.archivedAt !== null ? ", archived" : ""
          }${folderLabel ? `, in ${folderLabel}` : ""}`}
          className={cx(
            // A fixed width, not flex-1: the toolbar arrows sit either side of
            // this trigger, and a width that tracked the board's name would
            // shift them under the cursor on every step.
            "flex h-[30px] w-[22rem] min-w-0 items-center gap-2 rounded-lg border pl-3 pr-2.5 text-[13px] transition-colors",
            "border-black/[.13] bg-white text-gray-900 hover:bg-[#f5f5f7]",
            "dark:border-white/15 dark:bg-gray-950 dark:text-gray-50 dark:hover:bg-gray-900",
            focusRing,
          )}
        >
          {current.archivedAt !== null ? (
            <RiArchiveLine className="size-[14px] shrink-0 text-gray-400" aria-hidden="true" />
          ) : (
            <Glyph name="board" className="shrink-0 text-[#86868b]" />
          )}
          <span className="truncate font-medium">{current.name}</span>
          {folderLabel ? (
            <span className="shrink truncate text-[#86868b]">· {folderLabel}</span>
          ) : null}
          <Glyph name="chevD" className="ml-auto shrink-0 text-gray-400" />
        </button>
      </PopoverPrimitives.Trigger>

      <PopoverPrimitives.Portal container={usePortalContainer()}>
        <PopoverPrimitives.Content
          align="start"
          sideOffset={6}
          className={cx(
            "z-50 w-[22rem] overflow-hidden rounded-md border shadow-xl shadow-black/[2.5%]",
            "bg-white dark:bg-gray-950",
            "border-gray-200 dark:border-gray-800",
            "text-gray-900 dark:text-gray-50",
            "will-change-[transform,opacity]",
            "data-[state=closed]:animate-hide",
            "data-[side=bottom]:animate-slideDownAndFade data-[side=left]:animate-slideLeftAndFade data-[side=right]:animate-slideRightAndFade data-[side=top]:animate-slideUpAndFade",
          )}
        >
          <div className="border-b border-gray-200 p-2 dark:border-gray-800">
            <div className="relative">
              <RiSearchLine
                className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                autoFocus
                aria-label="Search whiteboards by name"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search by name…"
                className={cx(
                  "h-8 w-full rounded-md border bg-white pl-7 pr-2 text-sm outline-hidden",
                  "border-gray-300 text-gray-900 placeholder-gray-400",
                  "dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50 dark:placeholder-gray-500",
                  focusInput,
                )}
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto p-1">
            {boards === null ? (
              <p className="px-2 py-6 text-center text-xs text-gray-400">
                Loading whiteboards…
              </p>
            ) : total === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-gray-400">
                {list.length === 0
                  ? "No whiteboards in this folder yet"
                  : `No whiteboards match “${search.trim()}”`}
              </p>
            ) : (
              <>
                {results.active.map(renderRow)}

                {results.archived.length > 0 ? (
                  <>
                    {/* The Archive section. Always last, so archived boards
                        stay reachable without ever crowding the live ones. */}
                    <div
                      className={cx(
                        "mt-1 flex items-center gap-1.5 border-t border-gray-200 px-2 pb-1 pt-2 dark:border-gray-800",
                        results.active.length === 0 && "mt-0 border-t-0",
                      )}
                    >
                      <RiArchiveLine
                        className="size-3.5 text-gray-400"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Archived
                      </span>
                      <span className="text-xs tabular-nums text-gray-400">
                        {results.archived.length}
                      </span>
                    </div>
                    {results.archived.map(renderRow)}
                  </>
                ) : null}
              </>
            )}
          </div>

          <div className="truncate border-t border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            {folderLabel ? `${folderLabel} · ` : ""}
            {boards === null ? "…" : `${list.length - archivedCount} active`}
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
          </div>
        </PopoverPrimitives.Content>
      </PopoverPrimitives.Portal>
    </PopoverPrimitives.Root>
  )
}
