import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react"
import { createRoot } from "react-dom/client"
import { RiCloseLine, RiMicLine, RiMicOffLine, RiVideoLine } from "@remixicon/react"
import { Button } from "@/components/Button"
import { call } from "@/lib/bridge"
import { cx } from "@/lib/utils"
import {
  dismissRecording,
  getRecordingSnapshot,
  startRecording,
  stopRecording,
  subscribeRecording,
  toggleRecordingMicrophone,
} from "@/lib/recording"

function useRecording() {
  return useSyncExternalStore(subscribeRecording, getRecordingSnapshot)
}

/** A single entry point in the whiteboard bar, including while in full screen. */
export function RecordingButton({ className }: { className?: string }) {
  const { phase } = useRecording()
  const recording = phase === "recording"
  return (
    <Button
      variant="secondary"
      className={cx(className, recording && "text-red-600 dark:text-red-400")}
      disabled={phase === "starting" || phase === "saving"}
      data-recording-start
      aria-label={recording ? "Stop recording" : "Record camera and microphone"}
      title={recording ? "Stop and save recording" : "Record your camera and microphone to this laptop"}
      onClick={() => void (recording ? stopRecording() : startRecording())}
    >
      {recording ? <span className="size-2 rounded-sm bg-red-500" aria-hidden="true" /> : <RiVideoLine className="size-4" aria-hidden="true" />}
      {recording ? "Stop recording" : phase === "starting" ? "Starting…" : phase === "saving" ? "Saving…" : "Record"}
    </Button>
  )
}

function elapsed(startedAt: number | null, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

function RecordingPanel() {
  const state = useRecording()
  const panel = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [now, setNow] = useState(Date.now)
  const [revealError, setRevealError] = useState<string | null>(null)
  const recording = state.phase === "recording"
  const busy = state.phase === "starting" || state.phase === "saving"

  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = state.stream
    if (state.stream) void element.play().catch(() => {})
    return () => { element.srcObject = null }
  }, [state.stream])

  useEffect(() => {
    setNow(Date.now())
    if (!recording) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  useEffect(() => { setRevealError(null) }, [state.phase])

  function clamp(left: number, top: number) {
    const rect = panel.current?.getBoundingClientRect()
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - (rect?.width ?? 256) - 8)),
      top: Math.max(52, Math.min(top, window.innerHeight - (rect?.height ?? 240) - 8)),
    }
  }

  useEffect(() => {
    const resize = () => setPosition(value => value ? clamp(value.left, value.top) : null)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return
    const rect = panel.current!.getBoundingClientRect()
    drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  if (state.phase === "idle") return null

  return (
    <section
      ref={panel}
      className="sb-recording-panel"
      data-recording-panel
      data-phase={state.phase}
      aria-label="Camera recording"
      style={position ? { left: position.left, top: position.top, right: "auto", bottom: "auto" } : undefined}
      onKeyDown={event => event.stopPropagation()}
    >
      <header
        className="sb-recording-head"
        onPointerDown={startDrag}
        onPointerMove={event => {
          if (!drag.current) return
          setPosition(clamp(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y))
        }}
        onPointerUp={() => { drag.current = null }}
        onLostPointerCapture={() => { drag.current = null }}
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

/** The preview outlives every board and stays reachable when another screen opens. */
export function installRecordingOverlay() {
  if (document.getElementById("sb-recording-overlay")) return
  const host = document.createElement("div")
  host.id = "sb-recording-overlay"
  host.className = "sbdg sbdg-portal-root"
  document.body.appendChild(host)
  createRoot(host).render(<RecordingPanel />)
}
