// Radix content stays in the editor instance's own scoped CSS root. Several React
// roots live at once — one per open whiteboard, kept mounted while off screen — so a
// module-global portal would send every picker and dialog to whichever board was
// mounted most recently.
import { createContext, createElement, useContext, type ReactNode } from "react"

const PortalContext = createContext<HTMLElement | null>(null)

export function PortalProvider({ container, children }: {
  container: HTMLElement
  children: ReactNode
}) {
  return createElement(PortalContext.Provider, { value: container }, children)
}

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContext) ?? undefined
}
