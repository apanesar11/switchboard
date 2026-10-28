import type { FlowTimer } from "./types"

export const FLOW_TIMER_DEFAULT_MS = 25 * 60 * 1000
export const FLOW_TIMER_MIN_MS = 1000
export const FLOW_TIMER_MAX_MS = 24 * 60 * 60 * 1000

function validDuration(durationMs: number): number {
  if (!Number.isInteger(durationMs) || durationMs < FLOW_TIMER_MIN_MS || durationMs > FLOW_TIMER_MAX_MS) {
    throw new Error("Timer duration must be between 1 second and 24 hours")
  }
  return durationMs
}

export function createFlowTimer(durationMs = FLOW_TIMER_DEFAULT_MS, sound = true): FlowTimer {
  return { durationMs: validDuration(durationMs), remainingMs: durationMs, status: "idle", sound }
}

/** Validates saved state without advancing time or changing an expired deadline. */
export function parseFlowTimer(value: unknown): FlowTimer {
  if (value === undefined) return createFlowTimer()
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error('"timer" must be an object')
  const raw = value as Record<string, unknown>
  const durationMs = validDuration(raw.durationMs as number)
  const remainingMs = raw.remainingMs
  if (typeof remainingMs !== "number" || !Number.isInteger(remainingMs) || remainingMs < 0 || remainingMs > durationMs) {
    throw new Error('Timer "remainingMs" must be between zero and its duration')
  }
  if (!["idle", "running", "paused", "finished"].includes(raw.status as string)) throw new Error("Timer status is invalid")
  if (typeof raw.sound !== "boolean") throw new Error('Timer "sound" must be true or false')
  const status = raw.status as FlowTimer["status"]
  // A just-expired timer paused before main sees its deadline keeps that deadline
  // as the alarm identity. Reset/Dismiss clears it; other stopped states omit it.
  if (status === "running" || (status === "finished" && raw.endsAt !== undefined)) {
    if (typeof raw.endsAt !== "number" || !Number.isSafeInteger(raw.endsAt) || raw.endsAt <= 0 || raw.endsAt > 8.64e15) {
      throw new Error('Timer "endsAt" must be a valid deadline')
    }
    return { durationMs, remainingMs: status === "finished" ? 0 : remainingMs, status, sound: raw.sound, endsAt: raw.endsAt }
  }
  return { durationMs, remainingMs: status === "idle" ? durationMs : status === "finished" ? 0 : remainingMs, status, sound: raw.sound }
}

export function flowTimerRemaining(timer: FlowTimer, now = Date.now()): number {
  return timer.status === "running"
    ? Math.max(0, Math.min(timer.durationMs, (timer.endsAt ?? now) - now))
    : timer.status === "finished" ? 0 : timer.remainingMs
}

export function flowTimerStatus(timer: FlowTimer, now = Date.now()): FlowTimer["status"] {
  return timer.status === "running" && flowTimerRemaining(timer, now) === 0 ? "finished" : timer.status
}

export function startFlowTimer(timer: FlowTimer, now = Date.now()): FlowTimer {
  if (flowTimerStatus(timer, now) === "running") return timer
  const remainingMs = timer.status === "paused" && timer.remainingMs > 0 ? timer.remainingMs : timer.durationMs
  return { ...timer, status: "running", remainingMs, endsAt: now + remainingMs }
}

export function pauseFlowTimer(timer: FlowTimer, now = Date.now()): FlowTimer {
  if (timer.status !== "running") return timer
  const remainingMs = flowTimerRemaining(timer, now)
  if (remainingMs === 0) return { ...timer, remainingMs: 0, status: "finished" }
  const { endsAt: _endsAt, ...rest } = timer
  return { ...rest, remainingMs, status: "paused" }
}

/** Used by Reset, Dismiss and duplication, so a copy never starts an extra alarm. */
export function resetFlowTimer(timer: FlowTimer): FlowTimer {
  return createFlowTimer(timer.durationMs, timer.sound)
}

export function setFlowTimerDuration(timer: FlowTimer, durationMs: number): FlowTimer {
  return createFlowTimer(durationMs, timer.sound)
}

export function formatFlowTimer(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const last = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${last}` : `${String(minutes).padStart(2, "0")}:${last}`
}

/** A plain number means minutes; colon forms are m:ss and h:mm:ss. */
export function parseFlowTimerDuration(text: string): number | null {
  const input = text.trim()
  let durationMs: number
  if (/^\d+(?:\.\d+)?$/.test(input)) durationMs = Math.round(Number(input) * 60_000)
  else if (/^\d+:\d{2}(?::\d{2})?$/.test(input)) {
    const parts = input.split(":").map(Number)
    if (parts.slice(1).some((part) => part >= 60)) return null
    durationMs = parts.reduce((total, part) => total * 60 + part, 0) * 1000
  } else return null
  return Number.isInteger(durationMs) && durationMs >= FLOW_TIMER_MIN_MS && durationMs <= FLOW_TIMER_MAX_MS ? durationMs : null
}
