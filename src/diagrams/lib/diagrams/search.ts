// Search + ordering for the diagram picker. Pure and dependency-free (no
// lib/db, no next/*) so it is unit tested in a plain node environment — see
// search.test.ts. The picker only ever renders what these functions return.
//
// Deliberately a sibling of lib/mockups/search.ts rather than a shared
// generic: diagrams have no ticket links, so matching is name-only and the
// signatures differ. Two small pure modules beat one parameterised one here.

import type { DiagramSummary } from "./types"

// Switchboard: what searching and stepping read of a row — so a whiteboard's own
// summary (bridge.ts WhiteboardSummary, which has more) comes back as itself.
type Searchable = Pick<DiagramSummary, "id" | "name" | "updatedAt" | "archivedAt">

// Newest-touched first, which is the order the list has always used.
function byUpdatedDesc(a: Searchable, b: Searchable): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

// Most-recently-archived first, so the thing you just archived is the easiest
// one to find again (and to unarchive). Falls back to updatedAt for rows whose
// archivedAt is somehow absent, which keeps the sort total either way.
function byArchivedDesc(a: Searchable, b: Searchable): number {
  const left = a.archivedAt ?? a.updatedAt
  const right = b.archivedAt ?? b.updatedAt
  return right.localeCompare(left)
}

export type DiagramSearchResult<T extends Searchable = DiagramSummary> = {
  active: T[]
  archived: T[]
}

// Split the diagrams matching `query` into the two groups the picker renders.
// A diagram matches when the query is a substring of its name, case-insensitively.
//
// Archived results are always returned separately so the UI can pin them below
// the active ones — an archived diagram never outranks an active one, however
// well it matches.
export function searchDiagrams<T extends Searchable = DiagramSummary>(
  diagrams: T[],
  query: string,
): DiagramSearchResult<T> {
  const q = query.trim().toUpperCase()

  const active: T[] = []
  const archived: T[] = []
  for (const diagram of diagrams) {
    if (q && !diagram.name.toUpperCase().includes(q)) continue
    if (diagram.archivedAt === null) active.push(diagram)
    else archived.push(diagram)
  }

  active.sort(byUpdatedDesc)
  archived.sort(byArchivedDesc)
  return { active, archived }
}

// The id the picker should land on, given a set of results and what is
// currently selected. Keeping the current selection wins whenever it is still
// in the results; otherwise prefer an ACTIVE diagram, so a ?diagram= deep link
// never drops the viewer onto an archived one while a live one matches.
// Returns null only when nothing matched at all.
export function preferredSelection<T extends Searchable>(
  results: DiagramSearchResult<T>,
  selectedId: string | null,
): string | null {
  if (selectedId !== null) {
    const stillThere =
      results.active.some((d) => d.id === selectedId) ||
      results.archived.some((d) => d.id === selectedId)
    if (stillThere) return selectedId
  }
  return results.active[0]?.id ?? results.archived[0]?.id ?? null
}

export type DiagramNavigation<T extends Searchable = DiagramSummary> = {
  /** Every result in the order the picker renders them, as one flat list. */
  ordered: T[]
  /** 1-based position of the selection, or null when it isn't in the results. */
  position: number | null
  previous: T | null
  next: T | null
}

// What the toolbar's ← / → arrows need: the diagram one step either side of the
// current selection, in the exact order the picker lists them — active diagrams
// first, then the Archived section. Stepping past the last active diagram
// therefore walks into the archive, which is what "the next one in the
// dropdown" means; the buttons name their destination so it isn't a surprise.
//
// Deliberately clamps rather than wrapping: null at either end lets the caller
// disable the button, so the ends of the list are visible instead of silently
// looping back around.
export function diagramNavigation<T extends Searchable>(
  results: DiagramSearchResult<T>,
  selectedId: string | null,
): DiagramNavigation<T> {
  const ordered = [...results.active, ...results.archived]
  const index = ordered.findIndex((d) => d.id === selectedId)

  // The selection isn't in the results at all — a query that filtered it out
  // (the canvas keeps showing it while you type), or a ?diagram= id that
  // matched nothing. Step in from the matching end rather than going dead.
  if (index === -1) {
    return {
      ordered,
      position: null,
      previous: ordered[ordered.length - 1] ?? null,
      next: ordered[0] ?? null,
    }
  }

  return {
    ordered,
    position: index + 1,
    // Negative and past-the-end indexes both read as undefined, so the ends of
    // the list fall out of the same lookup.
    previous: ordered[index - 1] ?? null,
    next: ordered[index + 1] ?? null,
  }
}
