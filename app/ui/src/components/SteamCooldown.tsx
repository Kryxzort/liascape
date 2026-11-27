import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Hourglass } from "lucide-react";
import { useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { glideFlip, glideY, snapFlip } from "./flipGlide";

// Steam's cooldown, said once wherever Steam's data is missing because of it: "Steam is limiting requests from this
// connection — back in N min", counting down to the backend's own end (store steamCoolUntil / steamCoolLeft, from
// Helpers/SteamGate.cs: a `steam-status` read or event, a 429's body), gone when it ends, and what it skipped then asks again
// by itself (hooks/useAfterCooldown.ts, the store's browseCooled). One notice per surface, each in that surface's notice
// look: Browse's over the grid (WsSetLoad.tsx, the favourites' line: the list it refused), the item sidebar's among the
// body's notices (SideCooldownNotice: its creator, favourite and comments), the Author field's own error state
// (WorkshopListFields.tsx). Guard: probe-steam cool:*

// The words, the count cross-fading as it changes (index.css .cool-n; motion off: the fade alone). A notice still fading out
// after the end keeps its last words (the store keeps them). `short`: a one-line slot's (the Author field's error line, which
// can't wrap and would cut the count off).
export function CooldownWords({ short = false }: { short?: boolean }) {
  const n = useStore((s) => s.steamCoolLeft);
  return (
    <>{short ? "Steam is limiting requests" : "Steam is limiting requests from this connection"} — back in{" "}
      <span key={n} className="cool-n" data-cool-left={n}>{n}</span></>
  );
}

// the crash notice's exit length (ItemSide.tsx CRASH_OUT_MS: index.css side-crash-out)
const OUT_MS = 220;
// what glides when the notice comes or goes: the body's blocks and the Playback section's rows (ItemSide.tsx CRASH_FLIP)
const FLIP = ":scope > *, .side-sec[data-sec=\"playback\"] > *";

// The item sidebar's notice (a Workshop item's: `on`), in the body's notice block (the preset notice's: a warn stripe, the
// glyph, the words) among its other notices, above the action area. One there when the sidebar opens comes in with the body;
// one that turns up while it shows rises in and what follows glides down; at the end it fades out and what followed glides
// into its room (motion off: the fades alone, the rest takes its place at once). `body` = the sidebar's body.
// Guard: probe-steam cool:side, cool:sideOff
export function SideCooldownNotice({ on, body }: { on: boolean; body: RefObject<HTMLDivElement | null> }) {
  const cooling = useStore((s) => s.steamCoolUntil > 0);
  const motion = useMotion();
  const note = useLinger(on && cooling ? "cool" : null, OUT_MS, motion);
  const [atOpen] = useState(() => on && cooling);
  const flip = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (note.closing && motion) flip.current = snapFlip(body.current, FLIP); }, [note.closing, motion, body]);
  const shown = useRef(note.value != null);
  useLayoutEffect(() => {
    const now = note.value != null, was = shown.current;
    shown.current = now;
    if (!now && flip.current) { glideFlip(flip.current, body.current, FLIP); flip.current = null; return; }
    if (!now || was || !motion) return;
    const n = body.current?.querySelector<HTMLElement>("[data-cool-side]");
    if (!n) return;
    const h = n.offsetHeight + parseFloat(getComputedStyle(n).marginTop || "0");
    for (let el = n.nextElementSibling; el; el = el.nextElementSibling) glideY(el, -h);
  }, [note.value, motion, body]);
  if (!note.value) return null;
  return (
    <div className={`side-crash side-preset side-cool${note.closing ? " leaving" : ""}${atOpen ? "" : " arrive"}`} data-cool-side role="status">
      <span className="side-crash-ico"><Hourglass size={16} /></span>
      <span className="side-crash-text" data-cool-words><CooldownWords /></span>
    </div>
  );
}
