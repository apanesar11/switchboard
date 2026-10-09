// Switchboard: the app's own 14px line glyphs (src/renderer/icons.js), for the bar and
// the Actions menu over a whiteboard, so they read as part of the window around them
// rather than as the admin's Remix icons. The paths are the approved Whiteboards
// mock-up's, as drawn; `unarchive` is its archive box with the slot turned into an
// arrow out, in the same stroke.

import type { SVGProps } from "react"

const PATHS = {
  board: (
    <>
      <rect x="1.5" y="2.6" width="13" height="9.6" rx="1.6" />
      <path d="M4.4 9.4l2.4-2.6 1.8 1.7 2.9-3.2" />
      <path d="M6 12.2l-1 1.9M10 12.2l1 1.9" />
    </>
  ),
  term: (
    <>
      <rect x="1.9" y="3" width="12.2" height="10" rx="2.2" />
      <path d="M4.6 6.6L6.9 8.8 4.6 11" />
      <path d="M8.6 11.2h3" />
    </>
  ),
  termStack: (
    <>
      <rect x="1.9" y="4.6" width="10.6" height="8.6" rx="2" />
      <path d="M4.4 4.6V3.9a1.6 1.6 0 0 1 1.6-1.6h6.5a1.6 1.6 0 0 1 1.6 1.6v5.6a1.6 1.6 0 0 1-1.1 1.5" />
      <path d="M4.3 7.8l1.9 1.7-1.9 1.7M7.6 11.3h2.6" />
    </>
  ),
  folder: (
    <path d="M1.9 12.6V4.2a1 1 0 0 1 1-1h3.1l1.4 1.7h5.7a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z" />
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  full: <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9.3 6.7M2.5 13.5l4.2-4.2" />,
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx=".8" />
      <path d="M3 6v6.3a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8V6M6.5 9h3" />
    </>
  ),
  unarchive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx=".8" />
      <path d="M3 6v6.3a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8V6" />
      <path d="M8 11.4V7.9M6.5 9.3L8 7.8l1.5 1.5" />
    </>
  ),
  edit: (
    <>
      <path d="M3 13l.9-3.3L11 2.6a1.3 1.3 0 0 1 1.9 0l.5.5a1.3 1.3 0 0 1 0 1.9L6.3 12.1z" />
      <path d="M9.6 4l2.4 2.4" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
      <path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" />
    </>
  ),
  trash: (
    <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.3M6.6 7v4M9.4 7v4" />
  ),
} as const

// The chevrons and the check are drawn heavier and smaller, as the mock-up has them.
const BOLD = {
  chev: <path d="M6 3.5l4.5 4.5L6 12.5" />,
  chevL: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  chevD: <path d="M3.5 6l4.5 4.5L12.5 6" />,
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
} as const

export type GlyphName = keyof typeof PATHS | keyof typeof BOLD

export function Glyph({
  name,
  size,
  ...props
}: { name: GlyphName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const bold = name in BOLD
  const side = size ?? (name === "check" ? 13 : bold ? 11 : 14)
  return (
    <svg
      viewBox="0 0 16 16"
      width={side}
      height={side}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "check" ? 1.9 : bold ? 1.8 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {bold ? BOLD[name as keyof typeof BOLD] : PATHS[name as keyof typeof PATHS]}
    </svg>
  )
}
