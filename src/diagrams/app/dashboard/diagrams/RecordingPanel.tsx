import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react"
import { RiCloseLine, RiMicLine, RiMicOffLine } from "@remixicon/react"
import { call } from "@/lib/bridge"
import { cx } from "@/lib/utils"
import {
  dismissRecording,
  getRecordingSnapshot,
  stopRecording,
  subscribeRecording,
  toggleRecordingMicrophone,
} from "@/lib/recording"

function useRecording() {
  return useSyncExternalStore(subscribeRecording, getRecordingSnapshot)
}

function elapsed(startedAt: number | null, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

type PanelGeometry = { left: number; top: number; width: number }
type Gesture = PanelGeometry & { kind: "move" | "resize"; x: number; y: number }
const MARGIN = 8
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const CHROME_HEIGHT = 86

/** This board owns its preview; canvas zoom never changes its screen size. */
export function RecordingPanel({ boardId, shown }: { boardId: string; shown: boolean }) {
  const state = useRecording()
  const panel = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [geometry, setGeometry] = useState<PanelGeometry | null>(null)
  const [now, setNow] = useState(Date.now)
  const [revealError, setRevealError] = useState<string | null>(null)
  const visible = shown && state.boardId === boardId && state.phase !== "idle"
  const recording = state.phase === "recording"
  const busy = state.phase === "starting" || state.phase === "saving"

  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = state.stream
    if (state.stream) void element.play().catch(() => {})
    return () => { element.srcObject = null }
  }, [state.stream, visible])

  useEffect(() => {
    setNow(Date.now())
    if (!recording || !visible) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recording, visible])

  useEffect(() => { setRevealError(null) }, [state.phase])

  function fit(next: PanelGeometry | null): PanelGeometry {
    const host = panel.current?.parentElement
    const hostWidth = host?.clientWidth ?? DEFAULT_WIDTH + MARGIN * 2
    const hostHeight = host?.clientHeight ?? 400
    const maxWidth = Math.max(1, Math.min(hostWidth - MARGIN * 2,
      recording ? (hostHeight - MARGIN * 2 - CHROME_HEIGHT) * 16 / 9 + 2 : Infinity))
    const width = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), next?.width ?? DEFAULT_WIDTH))
    const height = recording ? (width - 2) * 9 / 16 + CHROME_HEIGHT : panel.current?.offsetHeight ?? 110
    const maxLeft = Math.max(MARGIN, hostWidth - width - MARGIN)
    const maxTop = Math.max(MARGIN, hostHeight - height - MARGIN)
    return {
      width,
      left: Math.max(MARGIN, Math.min(next?.left ?? maxLeft, maxLeft)),
      top: Math.max(MARGIN, Math.min(next?.top ?? maxTop, maxTop)),
    }
  }

  useLayoutEffect(() => {
    if (!visible) return
    const host = panel.current?.parentElement
    if (!host) return
    const adjust = () => setGeometry(previous => {
      const next = fit(previous)
      return previous && next.left === previous.left && next.top === previous.top && next.width === previous.width ? previous : next
    })
    adjust()
    const observer = new ResizeObserver(adjust)
    observer.observe(host)
    observer.observe(panel.current!)
    return () => observer.disconnect()
  }, [visible, recording])

  function startGesture(event: PointerEvent<HTMLElement>, kind: Gesture["kind"]) {
    if (event.button !== 0 || (kind === "move" && (event.target as HTMLElement).closest("button"))) return
    const element = panel.current!
    gesture.current = { kind, x: event.clientX, y: event.clientY,
      left: element.offsetLeft, top: element.offsetTop, width: element.getBoundingClientRect().width }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    event.preventDefault()
  }

  function resize(next: PanelGeometry, width: number) {
    // Growing at a board edge moves the panel inward rather than making its
    // default bottom-right placement impossible to enlarge.
    setGeometry(fit({ ...next, width }))
  }

  function moveGesture(event: PointerEvent<HTMLElement>) {
    const start = gesture.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (start.kind === "move") setGeometry(fit({ ...start, left: start.left + dx, top: start.top + dy }))
    else resize(start, start.width + (Math.abs(dx) > Math.abs(dy * 16 / 9) ? dx : dy * 16 / 9))
    event.stopPropagation()
  }

  if (!visible) return null

  return (
    <section
      ref={panel}
      className="sb-recording-panel nodrag nopan nowheel"
      data-recording-panel
      data-phase={state.phase}
      aria-label="Camera recording"
      style={geometry ? { left: geometry.left, top: geometry.top, width: geometry.width, right: "auto", bottom: "auto" } : undefined}
      onKeyDown={event => event.stopPropagation()}
    >
      <header
        className="sb-recording-head"
        onPointerDown={event => startGesture(event, "move")}
        onPointerMove={moveGesture}
        onPointerUp={() => { gesture.current = null }}
        onLostPointerCapture={() => { gesture.current = null }}
      >
        <span className={cx("sb-recording-dot", recording && "is-recording")} aria-hidden="true" />
        <b>{recording ? "Camera recording" : state.phase === "saved" ? "Recording saved" : state.phase === "error" ? "Recording stopped" : state.phase === "saving" ? "Saving recording…" : "Starting camera…"}</b>
        {recording ? <span className="sb-recording-time" role="timer" aria-label="Recording duration">{elapsed(state.startedAt, now)}</span> : null}
        {!recording && !busy ? (
          <button className="sb-recording-icon" type="button" aria-label="Dismiss recording" data-recording-dismiss onClick={dismissRecording}>
            <RiCloseLine className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {recording ? (
        <>
          <video ref={video} className="sb-recording-preview" autoPlay muted playsInline aria-label="Your camera preview" />
          <div className="sb-recording-controls">
            <button
              type="button"
              className="sb-recording-mic"
              aria-label={state.micMuted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={state.micMuted}
              title={state.micMuted ? "Microphone muted" : "Microphone on"}
              data-recording-mute
              onClick={toggleRecordingMicrophone}
            >
              {state.micMuted ? <RiMicOffLine className="size-4" aria-hidden="true" /> : <RiMicLine className="size-4" aria-hidden="true" />}
              {state.micMuted ? "Muted" : "Mic on"}
            </button>
            <button type="button" className="sb-recording-stop" data-recording-stop onClick={() => void stopRecording()}>
              <span aria-hidden="true" /> Stop & save
            </button>
          </div>
          <button
            type="button"
            className="sb-recording-resize"
            aria-label="Resize camera preview"
            title="Drag to resize; arrow keys also resize"
            data-recording-resize
            onPointerDown={event => startGesture(event, "resize")}
            onPointerMove={moveGesture}
            onPointerUp={() => { gesture.current = null }}
            onLostPointerCapture={() => { gesture.current = null }}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
              event.preventDefault()
              event.stopPropagation()
              const current = geometry ?? fit(null)
              resize(current, current.width + (["ArrowRight", "ArrowDown"].includes(event.key) ? 24 : -24))
            }}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 13 7-7m-3 7 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </>
      ) : (
        <div className="sb-recording-message" role="status">
          {state.phase === "starting" ? <p>Allow camera and microphone access to start recording.</p> : null}
          {state.phase === "saving" ? <p>Finishing the video on this laptop…</p> : null}
          {state.error ? <p className="sb-recording-error">{state.error}</p> : null}
          {state.saved ? (
            <>
              <p>{state.phase === "saved" ? "Saved locally in Movies / Switchboard." : "The saved portion is available on this laptop."}</p>
              <button type="button" className="sb-recording-reveal" data-recording-reveal onClick={async () => {
                const result = await call("recordingReveal")
                if (!result.ok) setRevealError(result.error)
              }}>Show in Finder</button>
            </>
          ) : null}
          {revealError ? <p className="sb-recording-error">{revealError}</p> : null}
          {state.phase === "starting" ? <button type="button" className="sb-recording-reveal" data-recording-stop onClick={() => void stopRecording()}>Cancel</button> : null}
        </div>
      )}
    </section>
  )
}
