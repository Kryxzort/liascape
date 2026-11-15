import { useState, type ButtonHTMLAttributes } from "react";
import { Volume2, VolumeX } from "lucide-react";

// The mute chip the item sidebar's preview volume (SidePanel.tsx) and Settings → Sound's Volume row (views/Settings.tsx) share:
// `.side-mute` in index.css (32 px, the sidebar tiles' material; accent-filled while sound plays), so the same action
// looks and acts the same on both. `what` names what it mutes ("the preview", "wallpapers") for the aria-label.
// The new glyph pops once on the user's click (icon motion: toggle), never when the chip first shows; `popped` lets the
// caller say another control of its own changed the state (the sidebar's slider).
// Guard: probe-settings mute:row, mute:motion, mute:look; probe-sidebar preview:volume, preview:volumeLook.
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "onClick" | "aria-label" | "aria-pressed"> & {
  muted: boolean; what: string; onToggle: () => void; popped?: boolean;
};
export function MuteButton({ muted, what, onToggle, popped = false, ...rest }: Props) {
  const [clicked, setClicked] = useState(false);
  return (
    <button {...rest} className={`side-mute${muted ? "" : " on"}`} aria-pressed={!muted} aria-label={`${muted ? "Unmute" : "Mute"} ${what}`}
      onClick={() => { setClicked(true); onToggle(); }}>
      {/* keyed by the state: the new glyph is a fresh element, so its pop restarts on every change */}
      <span className={`side-mute-ico${clicked || popped ? " ico-pop" : ""}`} key={muted ? "off" : "on"}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</span>
    </button>
  );
}
