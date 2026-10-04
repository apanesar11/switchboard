// Where Radix puts what it portals — the Dialogs, the Actions menu and the diagram
// picker. Not document.body: the bundle's stylesheet is scoped to `.sbdg` so that it
// can never restyle the rest of Switchboard, and anything outside that element would
// render unstyled. index.tsx sets this to an element inside the root before rendering.

let container: HTMLElement | null = null

export function setPortalContainer(element: HTMLElement | null): void {
  container = element
}

export function portalContainer(): HTMLElement | undefined {
  return container ?? undefined
}
