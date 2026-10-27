import { call, listen, type Result } from "./bridge"

export type RecordingSnapshot = {
  boardId: string | null
  phase: "idle" | "starting" | "recording" | "saving" | "saved" | "error"
  stream: MediaStream | null
  startedAt: number | null
  saved: { path: string } | null
  error: string | null
  micMuted: boolean
}

type RecordingFile = { id: string; path: string; mimeType: string }
type FinishedFile = Result<{ path: string; src: string; bytes: number }> | { ok: false; error: string; recoveryPath?: string }
type Session = {
  onSaved?: (file: { path: string; src: string }) => Promise<void>
  canceled: boolean
  started: boolean
  stream: MediaStream | null
  recorder: MediaRecorder | null
  file: RecordingFile | null
  fileRequest: Promise<Result<RecordingFile>> | null
  finishPromise: Promise<FinishedFile> | null
  startPromise: Promise<void> | null
  stopPromise: Promise<void> | null
  stopped: Promise<void>
  markStopped: () => void
  removeTrackListeners: () => void
  pending: Promise<void>
  pendingBytes: number
  sequence: number
  failure: string | null
  acceptsData: boolean
  writerFailed: boolean
}

// One recorder belongs to the window, so navigating between whiteboards does not
// end it. Bytes are written in order as they arrive instead of keeping a video in
// React state or waiting for Stop to allocate the whole recording in memory.
const EMPTY: RecordingSnapshot = {
  boardId: null, phase: "idle", stream: null, startedAt: null, saved: null, error: null, micMuted: false,
}
const WRITE_CHUNK = 4 * 1024 * 1024
const MAX_PENDING = 32 * 1024 * 1024
let snapshot: RecordingSnapshot = EMPTY
let active: Session | null = null
const listeners = new Set<() => void>()

function update(patch: Partial<RecordingSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

export function subscribeRecording(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRecordingSnapshot(): RecordingSnapshot {
  return snapshot
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Allow Switchboard to use your camera and microphone in System Settings, then try again."
    }
    if (error.name === "NotFoundError") return "No camera or microphone was found. Connect them and try again."
    if (error.name === "NotReadableError") return "The camera or microphone is unavailable. Close other apps using it and try again."
  }
  return error instanceof Error ? error.message : String(error || "The recording could not be saved.")
}

function stopTracks(session: Session): void {
  session.removeTrackListeners()
  for (const track of session.stream?.getTracks() ?? []) track.stop()
}

function finishFile(session: Session): Promise<FinishedFile> {
  if (!session.finishPromise) {
    session.finishPromise = session.file
      ? call("recordingFinish", session.file.id)
      : Promise.resolve({ ok: false, error: "No recording file was opened." })
  }
  return session.finishPromise
}

function keptFile(finished: FinishedFile | null): { path: string } | null {
  if (!finished) return null
  if (finished.ok) return finished.data.bytes > 0 ? { path: finished.data.path } : null
  return "recoveryPath" in finished && typeof finished.recoveryPath === "string"
    ? { path: finished.recoveryPath }
    : null
}

function stopSession(session: Session, failure?: string): Promise<void> {
  if (failure && !session.failure) session.failure = failure
  if (session.stopPromise) return session.stopPromise

  // Stop the devices synchronously; disk writes may take longer. The recorder's
  // stop event follows its final dataavailable event, so that last chunk joins the
  // same queue before we finish the file.
  if (active === session) update({ phase: "saving", stream: null })
  session.stopPromise = (async () => {
    await session.stopped
    await session.pending
    const finished = await finishFile(session)
    if (!finished.ok && !session.failure) session.failure = finished.error
    let addedToBoard = false
    if (finished.ok && session.onSaved) {
      try {
        if (typeof finished.data.src !== "string") throw new Error("The saved video has no local address.")
        await session.onSaved({ path: finished.data.path, src: finished.data.src })
        addedToBoard = true
      } catch (error) {
        session.failure = `The video was saved, but could not be added to the whiteboard. ${errorMessage(error)}`
      }
    }
    if (active !== session) return
    active = null
    update({
      phase: session.failure ? "error" : addedToBoard ? "idle" : "saved",
      stream: null,
      saved: keptFile(finished),
      error: session.failure,
    })
  })()
  try {
    if (session.recorder?.state !== "inactive") session.recorder?.stop()
  } catch (error) {
    session.failure ||= errorMessage(error)
    session.markStopped()
  }
  stopTracks(session)
  return session.stopPromise
}

function enqueue(session: Session, blob: Blob): void {
  if (!blob.size || !session.acceptsData) return
  if (session.pendingBytes + blob.size > MAX_PENDING) {
    session.acceptsData = false
    void stopSession(session, "The disk could not keep up with recording. Recording stopped; the saved portion is kept.")
    return
  }
  session.pendingBytes += blob.size
  session.pending = session.pending.then(async () => {
    if (session.writerFailed) return
    // Chromium can emit a large chunk after sleep. Slice it before reading into
    // an ArrayBuffer so every IPC message stays small.
    for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + WRITE_CHUNK).arrayBuffer())
      const result = await call("recordingAppend", session.file!.id, session.sequence++, bytes)
      if (!result.ok) throw new Error(result.error)
    }
  }).catch(error => {
    session.writerFailed = true
    session.acceptsData = false
    void stopSession(session, errorMessage(error))
  }).finally(() => {
    session.pendingBytes -= blob.size
  })
}

async function begin(session: Session): Promise<void> {
  try {
    const permitted = await call("recordingPermissions")
    if (session.canceled) return
    if (!permitted.ok) throw new Error(permitted.error)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("This version of Switchboard cannot record video. Update the app and try again.")
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    })
    session.stream = stream
    if (session.canceled) { stopTracks(session); return }
    if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) {
      throw new Error("A camera and microphone are needed to record.")
    }
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
      .find(type => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error("This version of Switchboard has no supported video recorder.")
    const recorder = new MediaRecorder(stream, { mimeType })
    session.recorder = recorder
    recorder.addEventListener("dataavailable", event => enqueue(session, event.data))
    recorder.addEventListener("stop", () => {
      session.markStopped()
      if (session.started && !session.stopPromise) void stopSession(session)
    })
    recorder.addEventListener("error", () => {
      void stopSession(session, "The camera recorder stopped unexpectedly. The saved portion is kept.")
    })
    session.fileRequest = call("recordingStart", recorder.mimeType || mimeType)
    const opened = await session.fileRequest
    if (!opened.ok) throw new Error(opened.error)
    session.file = opened.data
    if (session.canceled) {
      stopTracks(session)
      const finished = await finishFile(session)
      // An empty file is expected when Start was canceled before the recorder ran.
      if (!finished.ok && finished.error !== "The recording contained no video.") session.failure = finished.error
      return
    }
    const deviceEnded = () => {
      void stopSession(session, "The camera or microphone disconnected. The saved portion is kept.")
    }
    for (const track of stream.getTracks()) track.addEventListener("ended", deviceEnded)
    session.removeTrackListeners = () => {
      for (const track of stream.getTracks()) track.removeEventListener("ended", deviceEnded)
    }
    recorder.start(1000)
    session.started = true
    update({ phase: "recording", stream, startedAt: Date.now() })
  } catch (error) {
    stopTracks(session)
    const finished = session.file ? await finishFile(session) : null
    if (session.canceled || active !== session) return
    session.failure = errorMessage(error)
    active = null
    update({
      phase: "error", stream: null, error: session.failure,
      saved: keptFile(finished),
    })
  }
}

export function startRecording(boardId: string | null = null, onSaved?: Session["onSaved"]): Promise<void> {
  if (active) return Promise.resolve()
  let markStopped!: () => void
  const stopped = new Promise<void>(resolve => { markStopped = resolve })
  const session: Session = {
    onSaved,
    canceled: false, started: false, stream: null, recorder: null, file: null,
    fileRequest: null, finishPromise: null, startPromise: null, stopPromise: null,
    stopped, markStopped, removeTrackListeners: () => {},
    pending: Promise.resolve(), pendingBytes: 0, sequence: 0, failure: null,
    acceptsData: true, writerFailed: false,
  }
  active = session
  update({ ...EMPTY, boardId, phase: "starting" })
  session.startPromise = begin(session)
  return session.startPromise
}

export function stopRecording(): Promise<void> {
  const session = active
  if (!session) return Promise.resolve()
  if (session.stopPromise) return session.stopPromise
  if (session.started) return stopSession(session)
  session.canceled = true
  stopTracks(session)
  if (session.fileRequest) {
    // A new Start must wait for this file to close. A pending camera/permission
    // request alone owns no file and can be canceled immediately below.
    update({ phase: "saving", stream: null })
    session.stopPromise = session.startPromise!.then(() => {
      if (active !== session) return
      active = null
      update(session.failure ? { ...EMPTY, phase: "error", error: session.failure } : EMPTY)
    })
    return session.stopPromise
  }
  active = null
  update(EMPTY)
  // A permissions prompt or getUserMedia request cannot be canceled. Its late
  // stream is stopped by begin(), with no file created.
  return Promise.resolve()
}

export function toggleRecordingMicrophone(): void {
  if (!active?.started || snapshot.phase !== "recording") return
  const micMuted = !snapshot.micMuted
  for (const track of active.stream?.getAudioTracks() ?? []) track.enabled = !micMuted
  update({ micMuted })
}

export function dismissRecording(): void {
  if (!active) update(EMPTY)
}

listen("onRecordingFlush", id => {
  const session = active
  void stopRecording().then(() => {
    void call("recordingFlushed", id, session?.failure
      ? { ok: false, error: session.failure }
      : { ok: true })
  }).catch(error => {
    void call("recordingFlushed", id, { ok: false, error: errorMessage(error) })
  })
})
