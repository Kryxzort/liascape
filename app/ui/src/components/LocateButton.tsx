import { LocateFixed } from "lucide-react";
import { glideTo } from "../hooks/travelToPlaying";
import { useBrowseFocusShown } from "../hooks/useBrowseFocusShown";

// The crosshair that glides a list to one item and spotlights it (hooks/travelToPlaying.ts glideTo): the Library's and the
// playlist bar's "go to playing", Browse's "go to the selected card". One look and one icon motion for all of them (index.css
// `.go-playing`, the crosshair's hold in § icon motion). `title` says why it's disabled, when it is.
export function LocateButton({ target, label, title, disabled, size = 16, className, onClick }: {
  target: "library" | "bar" | "browse"; label: string; title: string; disabled: boolean; size?: number; className?: string;
  onClick: () => void;
}) {
  return (
    <button className={`mini go-playing${className ? ` ${className}` : ""}`} data-go-playing={target} aria-label={label}
      title={title} disabled={disabled} onClick={onClick}>
      <LocateFixed size={size} />
    </button>
  );
}

// Browse's: the card whose sidebar is open. Disabled with nothing selected, and while the shown list doesn't hold that card
// (a new search, sort or source replaced it, the "In my library" switch or a local tag filter hides it — the sidebar keeps
// its last copy): Browse loads pages as you scroll and never virtualises, so a card that is in the list is in the document.
// The spotlight takes the accent, the colour the focused card is already ringed in. Guard: probe-layout browse:locate*
export function BrowseLocate({ focus, motion }: { focus: string | null; motion: boolean }) {
  const shownUrl = useBrowseFocusShown();
  const shown = !!focus && shownUrl === focus;
  return (
    <LocateButton target="browse" label="Go to the selected wallpaper" disabled={!focus || !shown}
      title={!focus ? "No wallpaper selected" : shown ? "Show the selected wallpaper" : "The selected wallpaper isn't in this list"}
      onClick={() => glideTo(document.querySelector<HTMLElement>(".br-scroll"), ".card.focused", "y", motion, "focus")} />
  );
}
