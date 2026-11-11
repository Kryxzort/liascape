import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CloudCheck, CloudOff, CloudDownload, LoaderCircle } from "lucide-react";
import { api, type WorkshopSubState } from "../api/client";
import { useStore } from "../store";
import { useMotion } from "./motion";

// The Browse sidebar's Subscribe / Unsubscribe toggle for a Workshop item ("Wallpaper Engine (Local)" and "Wallpaper Engine
// (Workshop)" alike). State = POST /workshop/state (disk + the unsubscribe queue + the Steam to-do —
// never the Steam client), re-read on every event that can change it (the store's wsStateTick) and every 4 s while something is
// still moving (pending, or an unsubscribed folder Steam hasn't deleted yet). Unsubscribe (danger) = the Library's Delete from
// source for an item the library has (trash + unsubscribe, undoable — the sub-line says so), else the unsubscribe alone; Subscribe
// (accent) subscribes without importing (a Download stays the way to get it into the library). A WE-local item whose folder
// Steam deleted → the Browse list reloads (it leaves). Motion: the line + button swap slide in (transform + opacity), the
// progress row eases in / out, the box glides to its new height (framer `layout`); none under `no-motion`, no glow under `no-glow`.
export function SubToggle({ id, title, weLocal }: { id: string; title: string; weLocal: boolean }) {
  const tick = useStore((s) => s.wsStateTick);
  const prog = useStore((s) => s.subProgress[id]);
  const subscribe = useStore((s) => s.subscribeWorkshop);
  const unsubscribe = useStore((s) => s.unsubscribeWorkshop);
  const motionOn = useMotion();
  const [st, setSt] = useState<WorkshopSubState | null>(null);
  const [busy, setBusy] = useState(false);
  const [readTick, setReadTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.workshopState([id]).then((r) => { if (alive) setSt(r[id] ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [id, tick, readTick]);
  // still moving: Steam's own pace (no event when it deletes a folder)
  const moving = !!st && (!!st.pending || (!st.subscribed && st.onDisk && weLocal));
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setReadTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [moving]);
  // a WE-local item Steam has deleted: the list drops it (once)
  const reloaded = useRef(false);
  useEffect(() => {
    if (weLocal && st && !st.onDisk && !st.pending && !reloaded.current) { reloaded.current = true; useStore.getState().reload(); }
  }, [weLocal, st]);

  if (!st) return <div className="side-sub" data-side-sub data-state="loading" aria-busy="true" />;
  const pending = prog ? "subscribe" : st.pending;
  const state = pending === "subscribe" ? "subscribing" : pending === "unsubscribe" ? "unsubscribing"
    : st.subscribed ? "subscribed" : weLocal && st.onDisk ? "unsubscribed" : "not-subscribed";
  const label = { subscribing: "Subscribing…", unsubscribing: "Unsubscribing…", subscribed: "Subscribed",
    unsubscribed: "Unsubscribed", "not-subscribed": "Not subscribed" }[state];
  const hint = state === "subscribing" ? (prog?.status && prog.status !== "Subscribing…" ? prog.status : "Steam takes it from here")
    : state === "unsubscribing" ? "Waiting for Steam"
    : state === "subscribed" ? (st.inLibrary ? "Unsubscribing also removes it from your library" : "Steam keeps it up to date")
    : state === "unsubscribed" ? "Steam removes its folder soon"
    : st.inLibrary ? "Subscribe to let Steam keep it up to date" : "Subscribe without adding it to your library";
  const icon = state === "subscribed" ? <CloudCheck size={16} /> : pending ? <LoaderCircle size={16} className="side-sub-spin" /> : <CloudOff size={16} />;
  const click = async () => {
    setBusy(true);
    try { if (st.subscribed) await unsubscribe(id, title); else await subscribe(id, title); }
    finally { setBusy(false); setReadTick((n) => n + 1); }
  };
  const slide = motionOn ? { initial: { opacity: 0, x: 14 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -14 },
    transition: { duration: 0.22, ease: [0.2, 0.9, 0.3, 1] as const } } : { initial: false as const, transition: { duration: 0 } };
  const pct = prog && prog.value > 0 ? Math.round(prog.value * 100) : null;
  return (
    <motion.div className="side-sub" data-side-sub data-state={state} layout={motionOn} transition={{ duration: motionOn ? 0.24 : 0 }}>
      <motion.div className="side-sub-line" layout={motionOn ? "position" : false}>
        <span className={`side-sub-ico ${state}`} aria-hidden="true">{icon}</span>
        <span className="side-sub-text">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.b key={state} data-side-sub-label {...slide}>{label}</motion.b>
          </AnimatePresence>
        </span>
        {!pending && (
          <button className={`btn ico side-sub-btn ${st.subscribed ? "danger" : "accent"}`} data-side-sub-btn={st.subscribed ? "unsubscribe" : "subscribe"}
            disabled={busy} onClick={click}>
            {st.subscribed ? <CloudOff size={14} /> : <CloudDownload size={14} />}{st.subscribed ? "Unsubscribe" : "Subscribe"}
          </button>
        )}
      </motion.div>
      {/* the sub-line under the whole row (the label stays one line beside the button) */}
      <div className="side-sub-hintrow">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={hint} className="side-sub-hint" data-side-sub-hint {...slide}>{hint}</motion.span>
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {state === "subscribing" && prog && (
          <motion.div key="bar" className={`dl-bar side-sub-bar${pct == null ? " indet" : ""}`} data-side-sub-progress
            initial={motionOn ? { opacity: 0, scaleX: 0.6 } : false} animate={{ opacity: 1, scaleX: 1 }}
            exit={motionOn ? { opacity: 0, scaleX: 0.6 } : { opacity: 0, transition: { duration: 0 } }} transition={{ duration: motionOn ? 0.2 : 0 }}>
            <div className="dl-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
