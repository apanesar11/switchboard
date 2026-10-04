"use client"

// ← / → stepping, shared by the two things on this screen that step through a
// list. The shift key is what tells them apart:
//
//   ← / →          step through the SLIDES of the mockup you're looking at
//   ⇧← / ⇧→        step to the previous / next MOCKUP in the picker's order
//
// Both variants deliberately ignore the keypress while the user is typing (the
// comment composer and the ticket search live next to the canvas) and whenever
// ⌘/ctrl/alt is held — ⌘← and alt+← are browser navigation.

import { useEffect, useRef } from "react"

type Options = {
  /** true = require shift, false (the default) = require no modifier at all. */
  shift?: boolean
}

export function useArrowKeys(
  enabled: boolean,
  step: (delta: -1 | 1) => void,
  { shift = false }: Options = {},
) {
  // Kept in a ref, and refreshed AFTER each commit rather than during render,
  // so a new inline callback every render doesn't re-subscribe the listener.
  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  })

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Something nearer the keypress already acted on it — on the Flow
      // editor's canvas, the arrow keys move the selection between boxes.
      if (event.defaultPrevented) return
      // An exact match, not "at least": without this the slide handler would
      // also fire on ⇧→ and the two listeners would both act on one keypress.
      if (event.shiftKey !== shift) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return
      }
      event.preventDefault()
      stepRef.current(event.key === "ArrowLeft" ? -1 : 1)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, shift])
}
