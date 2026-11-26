import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Lightbulb, X } from "lucide-react";
import { useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { FADE_MS, useMotion } from "./motion";
import { glideY } from "./flipGlide";
import { useTipOpen, type TipId } from "./tips";

// One-time tips: a single dismissible line, in the notice look of Settings' "tucked away" note (`.help` + a `.mini` button),
// shown where the user first meets something that isn't obvious, until they dismiss it. Dismissed ones are remembered in
// settings (`seenTips`, saved like any other setting); Settings → Getting started → "Show tips again" forgets them
// (components/tips.ts: the ids). Guard: --probe probe-firstrun.js tip:*

// its leave (index.css `tip-out`); motion off a fade (useLinger: FADE_EXIT_MS)
const TIP_OUT_MS = 220;

// `when`: the context it belongs to holds (an item focused, a playlist with items…). `inline`: a tip in a row (the playlist
// bar's head), where nothing follows it down the page; otherwise what follows it in its parent glides into the room it
// leaves, and out of the room it takes when it arrives later than its page (after "Show tips again"). One that shows from
// its page's first frame just is there: no appear, so a page shown again by <Activity> replays nothing.
export function Tip({ id, when = true, inline = false, action, children }: {
  id: TipId; when?: boolean; inline?: boolean; action?: { label: string; onClick: () => void }; children: ReactNode;
}) {
  const open = useTipOpen(id) && when;
  const motion = useMotion();
  const shown = useLinger(open ? id : null, TIP_OUT_MS, motion);
  const seeTip = useStore((s) => s.seeTip);
  const ref = useRef<HTMLDivElement>(null);
  // the room it takes: from its top to the next element's (its margins and the parent's gap included), read where the layout
  // is done anyway (its ResizeObserver), never forced
  const room = useRef(0);
  const followers = useRef<Element[]>([]);
  // arriving after its page was already up: its first frame starts its fade (the ResizeObserver's first callback runs after
  // layout, before that frame's paint)
  const [was, setWas] = useState(shown.value);
  const [arrive, setArrive] = useState(false);
  if (shown.value !== was) { setWas(shown.value); if (shown.value && !was) setArrive(true); }
  const arriveRef = useRef(arrive);
  const motionRef = useRef(motion);
  useLayoutEffect(() => { arriveRef.current = arrive; motionRef.current = motion; });

  const on = !!shown.value;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const ro = new ResizeObserver(() => {
      const next = inline ? null : el.nextElementSibling;
      if (next) room.current = next.getBoundingClientRect().top - el.getBoundingClientRect().top;
      if (!arriveRef.current || !el.getClientRects().length) return;
      arriveRef.current = false;
      if (motionRef.current) {
        el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
        if (!inline) for (let n = el.nextElementSibling; n; n = n.nextElementSibling) glideY(n, -room.current);
      } else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "linear" });
      setArrive(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [on, inline]);
  // leaving: what follows it is taken while it is still in the page; once it is gone they glide up from where they were
  // (motion off: they take its place at once)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown.closing || inline || !el) return;
    const f: Element[] = [];
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) f.push(n);
    followers.current = f;
  }, [shown.closing, inline]);
  useLayoutEffect(() => {
    if (!on) return;
    return () => {
      const f = followers.current;
      followers.current = [];
      if (motionRef.current && f.length && room.current > 0) for (const n of f) if (n.isConnected) glideY(n, room.current);
    };
  }, [on]);

  if (!shown.value) return null;
  return (
    <div ref={ref} className={`help tip${inline ? " inline" : ""}${shown.closing ? " leaving" : ""}${arrive ? " arriving" : ""}`}
      data-tip={id} data-tip-state={shown.closing ? "leaving" : "shown"} role="note">
      <Lightbulb size={13} className="tip-ico" aria-hidden />
      <span className="tip-text">{children}</span>
      {action && <button type="button" className="mini tip-act" data-tip-action onClick={action.onClick}>{action.label}</button>}
      <button type="button" className="mini ico tip-x" aria-label="Dismiss tip" data-tip-dismiss disabled={shown.closing}
        onClick={() => seeTip(id)}><X size={12} /></button>
    </div>
  );
}
