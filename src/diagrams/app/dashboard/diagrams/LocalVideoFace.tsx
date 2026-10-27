import { useEffect, useRef, useState } from "react"
import { RiPencilLine, RiVideoLine } from "@remixicon/react"
import { FLOW_BOX_TEXT_MAX_LENGTH, VIDEO_BAR } from "@/lib/diagrams/types"

/** A saved recording uses the browser's player, including pause, seek and volume. */
export function LocalVideoFace({
  src,
  label,
  shown = true,
  interactive = true,
  onRename,
}: {
  src: string
  label: string
  shown?: boolean
  interactive?: boolean
  onRename?: (name: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const renameButton = useRef<HTMLButtonElement>(null)
  const editing = useRef(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState("")
  const [failed, setFailed] = useState(false)
  const name = label.trim() || "Camera recording"
  const canRename = interactive && !!onRename

  function beginRename() {
    setDraft(name)
    editing.current = true
    setRenaming(true)
  }

  function finishRename(keep: boolean) {
    if (!editing.current) return
    editing.current = false
    setRenaming(false)
    const next = draft.trim().replace(/\s+/g, " ")
    if (keep && next && next !== name) onRename?.(next)
  }

  useEffect(() => {
    if (renaming) { nameInput.current?.focus(); nameInput.current?.select() }
  }, [renaming])

  useEffect(() => {
    if (!shown || !canRename) {
      editing.current = false
      setRenaming(false)
    }
  }, [shown, canRename])

  useEffect(() => {
    setFailed(false)
    const element = video.current
    return () => element?.pause()
  }, [src])

  useEffect(() => {
    if (!shown) video.current?.pause()
  }, [shown])

  return (
    <div className={interactive ? "flow-video" : "flow-video flow-video-still"} role="group" aria-label={name} data-local-video>
      <div className="flow-video-head" style={{ height: VIDEO_BAR }}>
        <RiVideoLine className="size-3.5 shrink-0 text-[#0969da]" aria-hidden="true" />
        {renaming ? (
          <input
            ref={nameInput}
            className="flow-video-name nodrag nopan nowheel"
            aria-label="Video name"
            maxLength={FLOW_BOX_TEXT_MAX_LENGTH}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onDoubleClick={event => event.stopPropagation()}
            onBlur={() => finishRename(true)}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.nativeEvent.isComposing) return
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault()
                finishRename(event.key === "Enter")
                renameButton.current?.focus()
              }
            }}
          />
        ) : <b title={canRename ? `${name} · Double-click to rename` : name} onDoubleClick={canRename ? event => { event.stopPropagation(); beginRename() } : undefined}>{name}</b>}
        {canRename ? (
          <button
            ref={renameButton}
            type="button"
            className="flow-video-btn nodrag nopan"
            aria-label="Rename video"
            title="Rename video"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); beginRename() }}
            onDoubleClick={event => event.stopPropagation()}
          >
            <RiPencilLine className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="flow-video-body">
        {failed ? (
          <div className="flex size-full items-center justify-center px-5 text-center text-xs text-gray-300" role="status">
            This recording is unavailable. Its local file may have been moved or removed.
          </div>
        ) : (
          <video
            ref={video}
            className="nodrag nopan nowheel flow-local-video-player"
            style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
            // A small media fragment asks Chromium for a visible first frame while
            // leaving playback paused; no separate thumbnail file is needed.
            src={`${src}#t=0.01`}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            onError={() => setFailed(true)}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onDoubleClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
            onWheel={event => event.stopPropagation()}
          />
        )}
      </div>
    </div>
  )
}
