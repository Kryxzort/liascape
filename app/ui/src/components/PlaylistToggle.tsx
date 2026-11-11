import { useState } from "react";

// Playlist toggle — unchecked = a rounded-square accent ring; checked = an accent square with the tick in the theme's
// contrast colour (`--accent-fg`). Never a tick CUT THROUGH the square (an SVG mask — the thumbnail showing in it):
// on hover the square turns the paler `--accent-hover`, and a see-through tick (a mid-grey thumbnail, say) all but
// vanishes into it (rendered in Electron 42: the masked tick loses its contrast, the square itself stays). A solid dark
// tick keeps it on any thumbnail.
// COOL: a change the user makes pops the new state once (toggle role — docs/superpowers/specs/2026-11-12-icon-motion-design.md);
// a card mounting already on never pops (a page of 170 cards would all bounce). Guard: probe-icons icon:toggle.
export function PlaylistToggle({ on, size = 18 }: { on: boolean; size?: number }) {
  const [seen, setSeen] = useState(on);
  const [changed, setChanged] = useState(false);
  if (seen !== on) { setSeen(on); setChanged(true); }
  return (
    <svg className={`pl-toggle-svg${changed ? (on ? " pop-on" : " pop-off") : ""}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
      {on ? (
        <>
          <rect x="0" y="0" width="20" height="20" rx="3.3" ry="3.3" fill="currentColor" />
          <path d="M3 10L7 16L18 5L17 4L7 13L4 9Z" fill="var(--accent-fg)" />
        </>
      ) : (
        <rect x="1" y="1" width="18" height="18" rx="3" ry="3" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}
