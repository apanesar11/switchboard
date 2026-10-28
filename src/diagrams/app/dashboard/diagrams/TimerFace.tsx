"use client"

import { useEffect, useRef, useState } from "react"
import { RiTimerLine, RiVolumeUpLine, RiVolumeMuteLine, RiPlayFill, RiPauseFill, RiRestartLine } from "@remixicon/react"
import type { FlowTimer } from "@/lib/diagrams/types"
import { createFlowTimer, flowTimerRemaining, flowTimerStatus, formatFlowTimer, parseFlowTimerDuration, pauseFlowTimer, resetFlowTimer, setFlowTimerDuration, startFlowTimer } from "@/lib/diagrams/timers"

const DEFAULT_TIMER = createFlowTimer()

/** The clock only paints elapsed time. Main owns alarms, including off-screen boards. */
export function TimerFace({ id, label, timer = DEFAULT_TIMER, shown = true, onChange, onRename }: {
  id?: string
  label: string
  timer?: FlowTimer
  shown?: boolean
  onChange?: (timer: FlowTimer) => void
  onRename?: (label: string) => void
}) {
  const [now, setNow] = useState(Date.now)
  const cancelName = useRef(false)
  const [name, setName] = useState(label)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  useEffect(() => setName(label), [label])
  useEffect(() => {
    setNow(Date.now())
    if (!shown || timer.status !== "running" || flowTimerRemaining(timer) === 0) return
    const tick = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (flowTimerRemaining(timer, at) === 0) clearInterval(tick)
    }, 250)
    return () => clearInterval(tick)
  }, [shown, timer])
  const status = flowTimerStatus(timer, now)
  const left = flowTimerRemaining(timer, now)
  const editable = Boolean(onChange)
  const finished = status === "finished"
  function change(next: FlowTimer) { setNow(Date.now()); onChange?.(next) }
  function commitDuration() {
    const duration = parseFlowTimerDuration(draft)
    if (duration === null) { setError("Enter 1 second to 24 hours, as minutes or mm:ss."); return }
    change(setFlowTimerDuration(timer, duration))
    setEditing(false)
    setError("")
  }
  return (
    <div className="flow-timer" data-flow-timer={id} data-status={status}>
      <div className="flow-timer-header">
        <RiTimerLine size={17} aria-hidden="true" />
        {onRename ? <input className="nodrag nopan nowheel" aria-label="Timer name" maxLength={120} value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (cancelName.current) { cancelName.current = false; setName(label); return } const next = name.trim() || "Timer"; setName(next); if (next !== label) onRename(next) }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); cancelName.current = true; setName(label); e.currentTarget.blur() } }} /> : <span>{label}</span>}
        {editable ? <button type="button" className="nodrag nopan" aria-label={timer.sound ? "Mute timer" : "Unmute timer"} aria-pressed={timer.sound} title={timer.sound ? "Sound on" : "Sound off"} onClick={() => change({ ...timer, sound: !timer.sound })}>{timer.sound ? <RiVolumeUpLine size={17} /> : <RiVolumeMuteLine size={17} />}</button> : null}
      </div>
      <div className="flow-timer-body nodrag nopan nowheel" onDoubleClick={e => e.stopPropagation()}>
        {editing ? <div className="flow-timer-edit">
          <input autoFocus aria-label="Timer duration" aria-invalid={Boolean(error)} value={draft} onChange={e => { setDraft(e.target.value); setError("") }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitDuration() } else if (e.key === "Escape") { e.stopPropagation(); setEditing(false); setError("") } }} />
          <span>{error || "Minutes, mm:ss or h:mm:ss"}</span>
          <button type="button" onClick={commitDuration}>Set duration</button>
        </div> : <>
          <button type="button" className="flow-timer-clock" disabled={!editable || status === "running"} aria-label={editable && status !== "running" ? "Edit timer duration" : "Time remaining"} title={status !== "running" && editable ? "Edit duration" : undefined} onClick={() => { setDraft(formatFlowTimer(status === "paused" ? left : timer.durationMs)); setEditing(true) }}><span role="timer" aria-live="off">{formatFlowTimer(left)}</span></button>
          <div className="flow-timer-status" role="status">{finished ? "Time’s up" : status === "running" ? "Counting down" : status === "paused" ? "Paused" : "Ready when you are"}</div>
          {editable && status === "idle" ? <div className="flow-timer-presets" aria-label="Timer presets">{[5, 15, 25, 60].map(minutes => <button type="button" key={minutes} aria-pressed={timer.durationMs === minutes * 60000} onClick={() => change(setFlowTimerDuration(timer, minutes * 60000))}>{minutes}m</button>)}</div> : <div className="flow-timer-duration">{formatFlowTimer(timer.durationMs)} session</div>}
          {editable ? <div className="flow-timer-actions">
            <button type="button" className="flow-timer-primary" onClick={() => change(status === "running" ? pauseFlowTimer(timer) : startFlowTimer(finished ? resetFlowTimer(timer) : timer))}>{status === "running" ? <RiPauseFill size={16} /> : <RiPlayFill size={16} />}{status === "running" ? "Pause" : finished ? "Restart" : status === "paused" ? "Resume" : "Start"}</button>
            <button type="button" aria-label={finished ? "Dismiss timer" : "Reset timer"} title={finished ? "Dismiss" : "Reset"} onClick={() => change(resetFlowTimer(timer))}>{finished ? "Dismiss" : <RiRestartLine size={17} />}</button>
          </div> : null}
        </>}
      </div>
      <div className="flow-timer-progress" aria-hidden="true"><div style={{ width: `${Math.min(100, Math.max(0, 100 * (1 - left / timer.durationMs)))}%` }} /></div>
    </div>
  )
}
