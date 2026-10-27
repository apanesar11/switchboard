import { useEffect, useRef, useState } from "react"
import { RiVideoLine } from "@remixicon/react"
import { VIDEO_BAR } from "@/lib/diagrams/types"

/** A saved recording uses the browser's player, including pause, seek and volume. */
export function LocalVideoFace({
  src,
  label,
  shown = true,
  interactive = true,
}: {
  src: string
  label: string
  shown?: boolean
  interactive?: boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const name = label.trim() || "Camera recording"

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
        <b title={name}>{name}</b>
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
