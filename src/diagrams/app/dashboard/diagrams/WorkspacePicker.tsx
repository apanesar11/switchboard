"use client"

// Switchboard: the short workspace picker every whiteboard surface shares — beside
// ✦ Answer's "who answers" menu (which workspace a CLI reads for this whiteboard),
// under Actions ▸ Open terminal… and the terminal tray's + (which workspace to open a
// terminal in). Switchboard's own; the admin has nothing like it.
//
// Never every workspace inline: the board's own first, then the recent ones, then the
// rest in the rail's order, with a search box that has the keyboard from the start.
// ↑/↓ move, Enter picks, Escape closes — and goes no further, so a menu this sits in
// closes on the next Escape rather than this one. The rows are options in a listbox,
// which is also what tells the app's ⌘A (Show or hide terminals) to leave Select All
// to the search box.
//
// Tone: dark inside the canvas's dark menus, light in the app's own popovers.
// `data-canvas-overlay` marks it as the canvas's floating UI, so a pinned terminal
// under it steps aside while it is open (FlowEditor's TerminalSlot.covered).

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { cx } from "@/lib/utils"
import type { WorkspaceChoice, WorkspaceChoices, WorkspaceStatus } from "@/lib/bridge"

type Props = {
  /** null while the rail's workspaces are still being fetched. */
  choices: WorkspaceChoices | null
  /** Listed first, under `currentLabel`, with a check — unless it is no longer in the rail. */
  current?: string | null
  currentLabel?: string
  title: string
  footer?: string
  tone?: "dark" | "light"
  /** Each row's branch, when the rail knows it; the folder stands in until then. */
  status?: WorkspaceStatus
  onPick: (wsId: string) => void
  onClose: () => void
  className?: string
}

/** Whether `id` names a workspace that has left the rail (false while still loading). */
export function workspaceGone(id: string | null | undefined, choices: WorkspaceChoices | null): boolean {
  return !!id && choices !== null && !choices.workspaces.some((choice) => choice.id === id)
}

/** The folder a workspace is in, as a picker or the ✦ Answer menu shows it. */
export function workspaceDir(id: string | null | undefined, choices: WorkspaceChoices | null): string | null {
  if (!id || !choices) return null
  return choices.workspaces.find((choice) => choice.id === id)?.dirLabel ?? null
}

// The app's own line glyphs (src/renderer/icons.js), as the approved mock-up draws
// them, so the picker reads as part of the window around it.
export function PickerGlyph({
  name,
  className,
}: {
  name: "search" | "check" | "folderOpen" | "chev"
  className?: string
}) {
  const bold = name === "check" || name === "chev"
  return (
    <svg
      viewBox="0 0 16 16"
      width={name === "chev" ? 11 : bold ? 13 : 14}
      height={name === "chev" ? 11 : bold ? 13 : 14}
      fill="none"
      stroke="currentColor"
      strokeWidth={bold ? (name === "check" ? 1.9 : 1.8) : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx("shrink-0", className)}
    >
      {name === "search" ? (
        <>
          <circle cx="7" cy="7" r="4.3" />
          <path d="M10.2 10.2L13.5 13.5" />
        </>
      ) : name === "check" ? (
        <path d="M3 8.5l3.2 3L13 4.5" />
      ) : name === "chev" ? (
        <path d="M6 3.5l4.5 4.5L6 12.5" />
      ) : (
        <>
          <path d="M1.9 12.6V4.2a1 1 0 0 1 1-1h3.1l1.4 1.7h5.7a1 1 0 0 1 1 1v1.4" />
          <path d="M1.9 12.6l1.7-5h11l-1.7 5z" />
        </>
      )}
    </svg>
  )
}

type Group = { label: string; items: WorkspaceChoice[] }

export function WorkspacePicker({
  choices,
  current = null,
  currentLabel = "This whiteboard's workspace",
  title,
  footer,
  tone = "dark",
  status,
  onPick,
  onClose,
  className,
}: Props) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()
  const dark = tone === "dark"

  // The current workspace (when it is still in the rail), the recent ones, then the
  // rest in the rail's order — each one once, all of them filtered by the search.
  const groups = useMemo<Group[]>(() => {
    if (!choices) return []
    const byId = new Map(choices.workspaces.map((choice) => [choice.id, choice]))
    const q = query.trim().toLowerCase()
    const matches = (choice: WorkspaceChoice) =>
      !q ||
      choice.id.toLowerCase().includes(q) ||
      choice.project.toLowerCase().includes(q) ||
      choice.dirLabel.toLowerCase().includes(q)
    const taken = new Set<string>()
    const out: Group[] = []
    const here = current ? byId.get(current) : undefined
    if (here) {
      taken.add(here.id)
      if (matches(here)) out.push({ label: currentLabel, items: [here] })
    }
    const recent: WorkspaceChoice[] = []
    for (const id of choices.recent) {
      const choice = byId.get(id)
      if (!choice || taken.has(choice.id)) continue
      taken.add(choice.id)
      if (matches(choice)) recent.push(choice)
    }
    if (recent.length > 0) out.push({ label: "Recent", items: recent })
    const rest = choices.workspaces.filter((choice) => !taken.has(choice.id) && matches(choice))
    if (rest.length > 0) out.push({ label: "All workspaces", items: rest })
    return out
  }, [choices, current, currentLabel, query])
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const highlighted = Math.min(active, Math.max(0, flat.length - 1))
  const optionId = (index: number) => `${listId}-option-${index}`

  // The search box has the keyboard from the start: typing narrows, arrows move.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // The row the keys are on stays in view as they move it.
  useEffect(() => {
    if (flat.length === 0) return
    document.getElementById(`${listId}-option-${highlighted}`)?.scrollIntoView({ block: "nearest" })
  }, [highlighted, flat.length, listId])

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      // Closes the picker and nothing else: a menu it sits in closes on the next one.
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      if (flat.length === 0) return
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((highlighted + step + flat.length) % flat.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const choice = flat[highlighted]
      if (choice) onPick(choice.id)
    }
  }

  const q = query.trim()
  let index = -1
  return (
    <div
      role="dialog"
      aria-label={title}
      data-canvas-overlay
      data-workspace-picker
      onKeyDown={onKeyDown}
      className={cx(
        "nodrag nopan nowheel flex w-72 flex-col rounded-xl p-2 text-[12.5px]",
        dark
          ? "bg-gray-900 text-gray-200 shadow-[0_18px_50px_rgba(0,0,0,.4)] ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10"
          : "border border-black/[.13] bg-white text-gray-900 shadow-[0_12px_40px_rgba(0,0,0,.16)] dark:border-white/10 dark:bg-gray-900 dark:text-gray-100",
        className,
      )}
    >
      <p
        className={cx(
          "px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide",
          dark ? "text-gray-400" : "text-gray-500 dark:text-gray-400",
        )}
      >
        {title}
      </p>
      <label
        className={cx(
          "mx-1 mb-1.5 flex h-[30px] shrink-0 items-center gap-2 rounded-lg border px-2.5",
          dark
            ? "border-white/10 bg-white/[.08] text-gray-400 focus-within:border-violet-400/70"
            : "border-black/[.13] bg-gray-50 text-gray-500 focus-within:border-[#0969da] dark:border-white/10 dark:bg-white/5 dark:text-gray-400",
        )}
      >
        <PickerGlyph name="search" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat.length > 0 ? optionId(highlighted) : undefined}
          aria-autocomplete="list"
          aria-label="Search workspaces"
          placeholder="Search workspaces"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          className={cx(
            "min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] outline-none focus:[box-shadow:none]",
            dark ? "text-white placeholder:text-gray-500" : "text-gray-900 placeholder:text-gray-400 dark:text-gray-50",
          )}
        />
      </label>
      <div
        id={listId}
        role="listbox"
        aria-label={title}
        className="max-h-64 overflow-y-auto overscroll-contain"
      >
        {choices === null ? (
          <p className={cx("px-2 py-2", dark ? "text-gray-400" : "text-gray-500")}>Loading workspaces…</p>
        ) : choices.workspaces.length === 0 ? (
          <p className={cx("px-2 py-2 leading-snug", dark ? "text-gray-400" : "text-gray-500")}>
            No workspaces in the rail yet — add one in Settings
          </p>
        ) : flat.length === 0 ? (
          <p className={cx("truncate px-2 py-2", dark ? "text-gray-400" : "text-gray-500")}>
            No workspace matches “{q}”
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p
                aria-hidden="true"
                className={cx(
                  "px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide",
                  dark ? "text-gray-400" : "text-gray-500 dark:text-gray-400",
                )}
              >
                {group.label}
              </p>
              {group.items.map((choice) => {
                index += 1
                const at = index
                const isCurrent = choice.id === current
                const branch = status?.[choice.id]?.branch
                return (
                  <div
                    key={choice.id}
                    id={optionId(at)}
                    role="option"
                    aria-selected={isCurrent}
                    title={choice.dirLabel}
                    onMouseMove={() => {
                      if (highlighted !== at) setActive(at)
                    }}
                    // Keeps the keyboard in the search box, so the next key still narrows.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(choice.id)}
                    className={cx(
                      "flex h-[30px] cursor-default items-center gap-2 rounded-lg px-2",
                      dark ? "text-gray-300" : "text-gray-900 dark:text-gray-100",
                      isCurrent && (dark ? "bg-white/15 text-white" : "bg-[#dcdce1] dark:bg-white/15"),
                      at === highlighted &&
                        !isCurrent &&
                        (dark ? "bg-white/10 text-white" : "bg-black/[.06] dark:bg-white/10"),
                      at === highlighted && isCurrent && (dark ? "ring-1 ring-white/25" : "ring-1 ring-black/15"),
                    )}
                  >
                    <PickerGlyph
                      name="check"
                      className={cx(dark ? "text-white" : "text-gray-900 dark:text-white", isCurrent ? "opacity-100" : "opacity-0")}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium">{choice.id}</span>
                    <span
                      className={cx(
                        "max-w-[45%] shrink-0 truncate text-[11px]",
                        dark ? "text-gray-400" : "text-gray-500 dark:text-gray-400",
                      )}
                    >
                      {branch || choice.dirLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
      {footer ? (
        <p
          className={cx(
            "mx-1 mt-1.5 border-t pt-2 text-[11px] leading-snug",
            dark ? "border-white/10 text-gray-400" : "border-black/[.06] text-gray-500 dark:border-white/10 dark:text-gray-400",
          )}
        >
          {footer}
        </p>
      ) : null}
    </div>
  )
}
