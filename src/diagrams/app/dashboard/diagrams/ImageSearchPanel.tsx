"use client"

// Switchboard: Google Images beside the canvas — the panel the Image tool's Search
// Google Images (or G) opens, docked on the right of the editor so the canvas
// narrows rather than hides under it. The admin has nothing like it.
//
// It shows Google's own results page in an Electron <webview> on a session of its
// own (lib/diagrams/image-search.ts says which, and how main fences it in). A
// picture goes onto the diagram two ways: dragged out of the page onto the canvas
// (FlowEditor's drop reads its address), or right-clicked ▸ Add Image to Diagram —
// main's menu, which sends the address back here (onDiagramsImageOffer). Either
// way FlowEditor has main fetch the bytes and adds them as a dropped file is added.
//
// Main owns everything the page itself may do: its session (user agent,
// permissions, downloads), its pop-ups (sent to the browser, one per click), its
// dialogs (none), its right-click menu, and the Edit menu's keys while it has the
// keyboard. This file only shows it.

import { useEffect, useId, useRef, useState } from "react"
import {
  RiArrowLeftLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiSearchLine,
} from "@remixicon/react"
import { Button } from "@/components/Button"
import { toast } from "@/components/Toast"
import { call, listen } from "@/lib/bridge"
import {
  GOOGLE_IMAGES_HOME,
  GOOGLE_IMAGES_PARTITION,
  googleImagesUrl,
  isUrlDrag,
  opensInPanel,
  queryFromUrl,
} from "@/lib/diagrams/image-search"
import { cx, focusInput, focusRing } from "@/lib/utils"

/**
 * Electron's <webview>, as far as the panel uses it. @types/react has the tag
 * itself; its methods are in Electron's own typings, which the bundle doesn't load.
 */
type WebviewElement = HTMLElement & {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  goBack(): void
  getWebContentsId(): number
}

/**
 * What the panel is asked to show: a box's words to search for, or null for the
 * page it showed last. `serial` tells one ask from the next, so asking again with
 * the same words, or none, still counts.
 */
export type ImageSearchAsk = { query: string | null; serial: number }

// The page the panel last showed, so that closing it and opening it again this
// session comes back to the same place — the session itself keeps Google's
// cookies. Only a page main lets the panel open at (opensInPanel): a site followed
// out of the results can be browsed to, but not started on.
let lastPage: string | null = null

/** A page that didn't load: the address Try again loads again. */
type LoadFailure = { url: string }

// Before the first dom-ready a <webview>'s methods throw rather than answer.
function canGoBackIn(view: WebviewElement): boolean {
  try {
    return view.canGoBack()
  } catch {
    return false
  }
}

function contentsIdOf(view: WebviewElement): number | null {
  try {
    return view.getWebContentsId()
  } catch {
    return null
  }
}

export function ImageSearchPanel({
  ask,
  shown,
  onClose,
  onAddImage,
}: {
  ask: ImageSearchAsk
  /** Whether the Diagrams tab is on screen. */
  shown: boolean
  onClose: () => void
  /**
   * A picture picked with the page's Add Image to Diagram: its addresses, best first
   * (a Google result's full picture, then its thumbnail), and the page it was on.
   */
  onAddImage: (urls: string[], referrer: string) => void
}) {
  const viewRef = useRef<WebviewElement | null>(null)
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const fieldId = useId()
  // The <webview> (`made` keys it) and the page it opens at, given to it once as
  // it mounts. Every page after it is a navigation (load), so React never has to
  // touch src again — until the tab comes back and it is made anew (below).
  const [page, setPage] = useState(() => ({
    made: 0,
    start: ask.query ? googleImagesUrl(ask.query) : (lastPage ?? GOOGLE_IMAGES_HOME),
  }))
  const [field, setField] = useState(() => ask.query ?? queryFromUrl(page.start) ?? "")
  const [loading, setLoading] = useState(true)
  const [canGoBack, setCanGoBack] = useState(false)
  const [failed, setFailed] = useState<LoadFailure | null>(null)
  // loadURL() only once the page has been ready once; src before that.
  const readyRef = useRef(false)
  // A guest paints no background of its own, so a page that sets none would show
  // the panel through it — black text on near-black in dark mode. Once a page is
  // ready it has a browser's white behind it; not before, so dark mode doesn't
  // flash white while the first one loads.
  const [ready, setReady] = useState(false)
  const onAddImageRef = useRef(onAddImage)
  useEffect(() => {
    onAddImageRef.current = onAddImage
  })

  function load(url: string) {
    const view = viewRef.current
    if (!view) return
    setFailed(null)
    if (!readyRef.current) {
      view.src = url
      return
    }
    // A load cut short by the next one rejects too; did-fail-load says which
    // failures are real.
    view.loadURL(url).catch(() => {})
  }

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    function domReady() {
      readyRef.current = true
      setReady(true)
      setCanGoBack(canGoBackIn(view!))
    }
    function started() {
      setLoading(true)
    }
    function stopped() {
      setLoading(false)
      setCanGoBack(canGoBackIn(view!))
    }
    // A page arrived — a new one, or the same one with a new #fragment (Google
    // changes it as a result is opened): the field follows what it searches for,
    // unless it is being typed in. Main's frame only; an error page never arrives.
    function arrived(event: Event) {
      const { url, isMainFrame } = event as Event & { url: string; isMainFrame?: boolean }
      if (isMainFrame === false) return
      setFailed(null)
      if (opensInPanel(url)) lastPage = url
      const words = queryFromUrl(url)
      if (words !== null && document.activeElement !== fieldRef.current) setField(words)
      setCanGoBack(canGoBackIn(view!))
    }
    function failedToLoad(event: Event) {
      const { errorCode, validatedURL, isMainFrame } = event as Event & {
        errorCode: number
        validatedURL: string
        isMainFrame: boolean
      }
      // -3 is a load cut short — by the next search, by Back, by main keeping a
      // link to some other scheme out of the panel. Nothing went wrong.
      if (errorCode === -3 || !isMainFrame) return
      setFailed({ url: validatedURL })
    }
    view.addEventListener("dom-ready", domReady)
    view.addEventListener("did-start-loading", started)
    view.addEventListener("did-stop-loading", stopped)
    view.addEventListener("did-navigate", arrived)
    view.addEventListener("did-navigate-in-page", arrived)
    view.addEventListener("did-fail-load", failedToLoad)
    return () => {
      view.removeEventListener("dom-ready", domReady)
      view.removeEventListener("did-start-loading", started)
      view.removeEventListener("did-stop-loading", stopped)
      view.removeEventListener("did-navigate", arrived)
      view.removeEventListener("did-navigate-in-page", arrived)
      view.removeEventListener("did-fail-load", failedToLoad)
    }
  }, [page.made])

  // Leaving the Diagrams tab takes its root out of the window (app.js shows one
  // screen at a time), and Electron destroys a <webview>'s page as it leaves the
  // document and never makes another when it is put back. Measured in this
  // Electron: blank from then on, every method answering "Invalid
  // guestInstanceId". So the tab coming back makes a new <webview>, at the last
  // page the panel showed — always one main lets it start on.
  const shownRef = useRef(shown)
  useEffect(() => {
    const back = shown && !shownRef.current
    shownRef.current = shown
    if (!back) return
    readyRef.current = false
    setReady(false)
    setFailed(null)
    setLoading(true)
    setCanGoBack(false)
    setPage((current) => ({ made: current.made + 1, start: lastPage ?? current.start }))
  }, [shown])

  // Add Image to Diagram, from main's right-click menu — for THIS page's pictures
  // only, which the guest's webContents id tells apart.
  useEffect(
    () =>
      listen("onDiagramsImageOffer", (offer) => {
        const view = viewRef.current
        if (!view || offer.guestId !== contentsIdOf(view)) return
        onAddImageRef.current([offer.url, offer.fallback ?? ""], offer.referrer)
      }),
    [],
  )

  // Each ask: a box's words are searched for — the first time by the page it
  // opened at, after that by loading their results. With no words, the field
  // takes the keyboard, ready for some.
  const askedRef = useRef<number | null>(null)
  useEffect(() => {
    if (askedRef.current === ask.serial) return
    const opening = askedRef.current === null
    askedRef.current = ask.serial
    if (ask.query === null) {
      fieldRef.current?.focus()
      fieldRef.current?.select()
      return
    }
    if (opening) return
    setField(ask.query)
    load(googleImagesUrl(ask.query))
  }, [ask])

  function search(event: React.FormEvent) {
    event.preventDefault()
    load(googleImagesUrl(field))
  }

  function goBack() {
    const view = viewRef.current
    if (!view) return
    try {
      view.goBack()
    } catch {
      // Not ready yet: there is nothing to go back to.
    }
  }

  async function openInBrowser() {
    const view = viewRef.current
    let url = ""
    try {
      url = view?.getURL() ?? ""
    } catch {
      // Not ready yet: the page it is opening.
    }
    const result = await call("openExternal", url || lastPage || page.start)
    if (!result.ok) {
      toast({ title: "Couldn't open your browser", description: result.error, variant: "error" })
    }
  }

  // A picture let go of over the panel's own header, field row or footer — short of
  // the canvas — is taken here and dropped. Let through, the window would navigate
  // to its address (which main sends to the browser). The search field keeps a
  // drop of words, and the page below takes its own drops.
  function keepDrag(event: React.DragEvent) {
    if (event.target instanceof HTMLInputElement || !isUrlDrag(event.dataTransfer.types)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "none"
  }

  function keepDrop(event: React.DragEvent) {
    if (event.target instanceof HTMLInputElement || !isUrlDrag(event.dataTransfer.types)) return
    event.preventDefault()
  }

  // 400px, and less only in a window too narrow to spare that beside the canvas
  // (FlowEditor keeps the canvas 360px). Not an <aside>: the window's own
  // stylesheet styles every aside as the sidebar — its padding, and hidden with it
  // (View ▸ Hide Sidebar).
  return (
    <div
      role="complementary"
      aria-label="Google Images"
      className="flex h-full w-[400px] flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
      onDragOver={keepDrag}
      onDrop={keepDrop}
    >
      <div className="flex h-[46px] shrink-0 items-center gap-0.5 pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-50">
          Google Images
        </h2>
        <PanelButton label="Open in your browser" onClick={() => void openInBrowser()}>
          <RiExternalLinkLine className="size-4" aria-hidden="true" />
        </PanelButton>
        <PanelButton label="Close" onClick={onClose}>
          <RiCloseLine className="size-4" aria-hidden="true" />
        </PanelButton>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <PanelButton label="Back" disabled={!canGoBack} onClick={goBack}>
          <RiArrowLeftLine className="size-4" aria-hidden="true" />
        </PanelButton>
        <form role="search" className="relative min-w-0 flex-1" onSubmit={search}>
          <label htmlFor={fieldId} className="sr-only">
            Search Google Images
          </label>
          <RiSearchLine
            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            ref={fieldRef}
            id={fieldId}
            type="text"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={field}
            onChange={(event) => setField(event.target.value)}
            onKeyDown={(event) => {
              // Esc in the field closes the panel, and goes no further — not out of
              // full screen, not back a screen.
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }}
            placeholder="Search Google Images"
            className={cx(
              "h-8 w-full rounded-md border bg-white pl-7 pr-2 text-sm outline-hidden",
              "border-gray-300 text-gray-900 placeholder-gray-400",
              "dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50 dark:placeholder-gray-500",
              focusInput,
            )}
          />
        </form>
      </div>

      <div className="relative min-h-0 flex-1 border-t border-gray-200 dark:border-gray-800">
        {/* Its display is the <webview>'s own (flex), which its page needs to fill
            it; only where it sits is set here, and the white behind a ready page
            (above). A link that opens a new window is main's: it lets those
            through to the guest, and sends the one the user clicked to the
            browser. */}
        <webview
          key={page.made}
          ref={viewRef}
          partition={GOOGLE_IMAGES_PARTITION}
          src={page.start}
          className={cx("absolute inset-0", ready && "bg-white")}
        />
        {loading && failed === null ? (
          <div
            role="progressbar"
            aria-label="Loading Google Images"
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-brand"
          />
        ) : null}
        {failed !== null ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-white p-6 text-center dark:bg-gray-950"
          >
            <RiErrorWarningLine className="mb-1 size-5 text-gray-400" aria-hidden="true" />
            <p className="text-sm font-medium text-gray-900 dark:text-gray-50">
              Couldn&apos;t load Google Images
            </p>
            <Button
              variant="secondary"
              className="mt-2 h-[30px] px-3 text-[13px]"
              onClick={() => load(failed.url)}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </div>

      <p className="flex h-10 shrink-0 items-center border-t border-gray-200 px-4 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Drag onto the canvas, or right-click ▸ Add Image to Diagram
      </p>
    </div>
  )
}

function PanelButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900",
        "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-50",
        "disabled:pointer-events-none disabled:opacity-35",
        focusRing,
      )}
    >
      {children}
    </button>
  )
}
