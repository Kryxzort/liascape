import { useId } from "react";

// Playlist toggle — unchecked = rounded-square accent ring;
// checked = accent fill with a checkmark *cut clean through* (see-through, shows the thumbnail).
// Uses a <mask> (white box minus black checkmark) — guaranteed transparent tick in Chromium, where
// a single evenodd path can render filled. currentColor → parent button brightens accent→hover.
export function PlaylistToggle({ on, size = 18 }: { on: boolean; size?: number }) {
  const id = "pt" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg className="pl-toggle-svg" width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
      {on ? (
        <>
          <defs>
            <mask id={id}>
              <rect x="0" y="0" width="20" height="20" rx="3.3" ry="3.3" fill="white" />
              <path d="M3 10L7 16L18 5L17 4L7 13L4 9Z" fill="black" />
            </mask>
          </defs>
          <rect x="0" y="0" width="20" height="20" rx="3.3" ry="3.3" fill="currentColor" mask={`url(#${id})`} />
        </>
      ) : (
        <rect x="1" y="1" width="18" height="18" rx="3" ry="3" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}
