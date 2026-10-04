"use client"

// The diagram selector: one trigger showing the current diagram, opening a
// popover with a search box and a results list. A sibling of MockupPicker, and
// deliberately the same control — the two pages sit next to each other in the
// sidebar and switching between them shouldn't mean learning a second widget.
//
// Results are two groups: active diagrams, then an "Archived" section pinned
// below them. An archived diagram never outranks an active one however well it
// matches — see searchDiagrams. Rows are selection only; archive and delete
// live in the Actions menu of the diagram you have actually selected.

import { useMemo, useState } from "react"
import * as PopoverPrimitives from "@radix-ui/react-popover"
import {
  RiArchiveLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiSearchLine,
} from "@remixicon/react"
import { cx, focusInput, focusRing } from "@/lib/utils"
// Switchboard: portalled into the bundle's own root, where its styles reach.
import { portalContainer } from "@/lib/portal"
import { searchDiagrams } from "@/lib/diagrams/search"
import type { DiagramSummary } from "@/lib/diagrams/types"

type Props = {
  diagrams: DiagramSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  // Owned by the page so a ?q= deep link can seed it.
  search: string
  onSearchChange: (value: string) => void
  formatRelative: (iso: string) => string
}

export function DiagramPicker({
  diagrams,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  formatRelative,
}: Props) {
  const [open, setOpen] = useState(false)

  const results = useMemo(
    () => searchDiagrams(diagrams, search),
    [diagrams, search],
  )
  const selected = diagrams.find((d) => d.id === selectedId) ?? null
  const total = results.active.length + results.archived.length

  const archivedCount = useMemo(
    () => diagrams.filter((d) => d.archivedAt !== null).length,
    [diagrams],
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
          // diagram name in the accessible-name computation, so this control —
          // the only one that displays the current selection — would announce
          // the same string no matter what is selected.
          aria-label={
            selected
              ? `Select a diagram — currently ${selected.name}${
                  selected.archivedAt !== null ? ", archived" : ""
                }`
              : "Select a diagram"
          }
          className={cx(
            // A fixed width, not flex-1: the toolbar arrows sit either side of
            // this trigger, and a width that tracked the selected diagram's
            // name would shift them under the cursor on every step.
            "flex h-9 w-[22rem] min-w-0 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors",
            "border-gray-300 bg-white text-gray-900 hover:bg-gray-50",
            "dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50 dark:hover:bg-gray-900",
            focusRing,
          )}
        >
          {selected === null ? (
            <span className="text-gray-500 dark:text-gray-400">
              Select a diagram
            </span>
          ) : (
            <>
              {selected.archivedAt !== null ? (
                <RiArchiveLine
                  className="size-4 shrink-0 text-gray-400"
                  aria-hidden="true"
                />
              ) : null}
              <span className="truncate font-medium">{selected.name}</span>
            </>
          )}
          <RiArrowDownSLine
            className="ml-auto size-4 shrink-0 text-gray-400"
            aria-hidden="true"
          />
        </button>
      </PopoverPrimitives.Trigger>

      <PopoverPrimitives.Portal container={portalContainer()}>
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
                aria-label="Search diagrams by name"
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
            {total === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-gray-400">
                {diagrams.length === 0
                  ? "No diagrams yet"
                  : `No diagrams match “${search.trim()}”`}
              </p>
            ) : (
              <>
                {results.active.map(renderRow)}

                {results.archived.length > 0 ? (
                  <>
                    {/* The Archive section. Always last, so archived diagrams
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

          <div className="border-t border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            {diagrams.length - archivedCount} active
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
          </div>
        </PopoverPrimitives.Content>
      </PopoverPrimitives.Portal>
    </PopoverPrimitives.Root>
  )
}
