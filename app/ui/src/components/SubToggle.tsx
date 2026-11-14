import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CloudCheck, CloudOff, CloudDownload, LoaderCircle } from "lucide-react";
import { api, type WorkshopSubState } from "../api/client";
import { useStore } from "../store";
import { useMotion, FADE } from "./motion";
import { useLinger } from "../hooks/useLinger";
import { glideY } from "./flipGlide";
import { magnetRef } from "./magnet";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { keepMenuItem, menuAt } from "./menuItems";

// how long a leaving card stays mounted (its fade out: enterLeave)
const SUB_OUT_MS = 200;

type SubState = "loading" | "subscribing" | "unsubscribing" | "subscribed" | "unsubscribed" | "not-subscribed";
function stateOf(st: WorkshopSubState | null, prog: unknown, weLocal: boolean): SubState {
  if (!st) return "loading";
  const pending = prog ? "subscribe" : st.pending;
  return pending === "subscribe" ? "subscribing" : pending === "unsubscribe" ? "unsubscribing"
    : st.subscribed ? "subscribed" : weLocal && st.onDisk ? "unsubscribed" : "not-subscribed";
}

// the blocks after `el` in its parent and the room `el` takes from them (its height + the next one's margin): offsets,
// never transformed boxes, so a card mid-rise measures as where it lands
function following(el: HTMLElement): { els: Element[]; dy: number } | null {
  const next = el.nextElementSibling as HTMLElement | null;
  if (!next) return null;
  const els: Element[] = [];
  for (let n: Element | null = next; n; n = n.nextElementSibling) els.push(n);
  return { els, dy: next.offsetTop - el.offsetTop };
}

// framer props for the gated card: rises in / falls back out (motion off: a fade in place); `enter` false = no appear
function enterLeave(on: boolean, enter: boolean, leaving: boolean) {
  const out = on ? { opacity: 0, y: -6, scale: 0.98 } : { opacity: 0 };
  return {
    initial: enter ? out : false as const,
    animate: leaving ? out : on ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 },
    transition: on ? { duration: leaving ? SUB_OUT_MS / 1000 : 0.26, ease: [0.2, 0.9, 0.3, 1] as const } : FADE.transition,
  };
}

// The Subscribe / Unsubscribe toggle for a Workshop item — the Browse sidebar's, and the Library sidebar's for one it holds
// unsubscribed (`only`, below) ("Wallpaper Engine (Local)" and "Wallpaper Engine
// (Workshop)" alike). State = POST /workshop/state (disk + the unsubscribe queue + the Steam to-do —
// never the Steam client), re-read on every event that can change it (the store's wsStateTick) and every 4 s while something is
// still moving (pending, or an unsubscribed folder Steam hasn't deleted yet). Unsubscribe (danger) = the Library's Delete from
// source for an item the library has (trash + unsubscribe, undoable — the sub-line says so), else the unsubscribe alone; Subscribe
// (accent) subscribes without importing (a Download stays the way to get it into the library). A WE-local item whose folder
// Steam deleted → the Browse list reloads (it leaves). Motion: the line + button swap slide in (transform + opacity), the
// progress row eases in / out, the box glides to its new height (framer `layout`); under `no-motion` the swaps and the row
// cross-fade in place (components/motion.ts FADE) and the height changes at once; no glow under `no-glow`.
// A library item's Unsubscribe also has a right-click menu (components/ContextMenu.tsx) with "Unsubscribe without deleting"
// (POST /workshop/unsubscribe-keep: the library keeps its copy, nothing is trashed); the plain click stays the one above.
// Guard: probe-steam steam:subToggle:keepMenu, steam:subToggle:keepMenuOff
// `only` shows the card in some states and lets it appear / leave like any block of the body (rises in or fades out; what
// follows glides into or out of its room; motion off: a fade, the rest jumps): "subscribed" (the Browse sidebar with
// auto-import on + the "subscribe" download mode, whose Subscribe button is the subscription) — while subscribed or
// unsubscribing; "unsubscribed" (the Library sidebar of a Workshop item it holds as its own copy, whose Unsubscribe is the
// Delete tile once subscribed) — while not subscribed or subscribing. `likely` reserves its place while the state loads.
// Guard: probe-steam steam:subMerge:*, side:resub:*
export function SubToggle({ id, title, weLocal, only, likely = false }: {
  id: string; title: string; weLocal: boolean; only?: "subscribed" | "unsubscribed"; likely?: boolean;
}) {
  const tick = useStore((s) => s.wsStateTick);
  const liveProg = useStore((s) => s.subProgress[id]);
  const subscribe = useStore((s) => s.subscribeWorkshop);
  const unsubscribe = useStore((s) => s.unsubscribeWorkshop);
  const unsubscribeKeep = useStore((s) => s.unsubscribeKeepWorkshop);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const setBtn = useCallback((el: HTMLButtonElement | null) => {
    btnRef.current = el; const off = magnetRef(el);
    return () => { btnRef.current = null; off?.(); };
  }, []);
  // "Unsubscribe without deleting" running: the library's copy is being made before the unsubscribe
  const [keeping, setKeeping] = useState(false);
  const motionOn = useMotion();
  const [liveSt, setSt] = useState<WorkshopSubState | null>(null);
  const [busy, setBusy] = useState(false);
  const [readTick, setReadTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.workshopState([id]).then((r) => { if (alive) setSt(r[id] ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [id, tick, readTick]);
  // still moving: Steam's own pace (no event when it deletes a folder)
  const moving = !!liveSt && (!!liveSt.pending || (!liveSt.subscribed && liveSt.onDisk && weLocal));
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setReadTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [moving]);
  // a WE-local item Steam has deleted: the list drops it (once)
  const reloaded = useRef(false);
  useEffect(() => {
    if (weLocal && liveSt && !liveSt.onDisk && !liveSt.pending && !reloaded.current) { reloaded.current = true; useStore.getState().reload(); }
  }, [weLocal, liveSt]);

  const liveState = stateOf(liveSt, liveProg, weLocal);
  const visible = !only || (!liveSt ? likely : only === "subscribed" ? liveState === "subscribed" || liveState === "unsubscribing"
    : liveState === "not-subscribed" || liveState === "subscribing");
  // a leaving card keeps showing what it showed (never "Not subscribed" and a Subscribe button on its way out)
  const [held, setHeld] = useState({ st: liveSt, prog: liveProg });
  if (visible && (held.st !== liveSt || held.prog !== liveProg)) setHeld({ st: liveSt, prog: liveProg });
  const { st, prog } = visible ? { st: liveSt, prog: liveProg } : held;
  const pending = !st ? null : prog ? "subscribe" : st.pending;
  const state = stateOf(st, prog, weLocal);
  const shown = useLinger(visible || null, SUB_OUT_MS, motionOn);
  // a card that mounts after the sidebar opened enters; the one the sidebar opened with comes with the sidebar's own slide
  const [enter, setEnter] = useState(!visible);
  if (!shown.value && !enter) setEnter(true);
  // what follows the card glides into the room it leaves (measured as it starts leaving) and out of the room it takes
  const boxRef = useRef<HTMLDivElement | null>(null);
  const room = useRef<{ els: Element[]; dy: number } | null>(null);
  const wasShown = useRef(!!shown.value);
  useLayoutEffect(() => {
    if (shown.closing && motionOn && boxRef.current) room.current = following(boxRef.current);
  }, [shown.closing, motionOn]);
  useLayoutEffect(() => {
    const on = !!shown.value;
    if (on === wasShown.current) return;
    wasShown.current = on;
    const r = on && boxRef.current ? following(boxRef.current) : room.current;
    room.current = null;
    if (motionOn && r) for (const el of r.els) glideY(el, on ? -r.dy : r.dy);
  }, [shown.value, motionOn]);
  if (!shown.value) return null;
  const box = { ref: boxRef, ...(only ? enterLeave(motionOn, enter, shown.closing) : {}) };
  if (!st || state === "loading") return <motion.div className="side-sub" data-side-sub data-state="loading" aria-busy="true" {...box} />;
  const label = { subscribing: "Subscribing…", unsubscribing: "Unsubscribing…", subscribed: "Subscribed",
    unsubscribed: "Unsubscribed", "not-subscribed": "Not subscribed" }[state];
  const hint = state === "subscribing" ? (prog?.status && prog.status !== "Subscribing…" ? prog.status : "Steam takes it from here")
    : state === "unsubscribing" ? "Waiting for Steam"
    : keeping ? "Keeping a copy in your library…"
    : state === "subscribed" ? (st.inLibrary ? "Also removes it from your library; right-click keeps it" : "Steam keeps it up to date")
    : state === "unsubscribed" ? "Steam removes its folder soon"
    : st.inLibrary ? "Subscribe to let Steam keep it up to date" : "Subscribe without adding it to your library";
  const icon = state === "subscribed" ? <CloudCheck size={16} /> : pending ? <LoaderCircle size={16} className="side-sub-spin" /> : <CloudOff size={16} />;
  const click = async () => {
    setBusy(true);
    try { if (st.subscribed) await unsubscribe(id, title); else await subscribe(id, title); }
    finally { setBusy(false); setReadTick((n) => n + 1); }
  };
  const keep = async () => {
    setBusy(true); setKeeping(true);
    try { await unsubscribeKeep(id, title); }
    finally { setBusy(false); setKeeping(false); setReadTick((n) => n + 1); }
  };
  // a right-click (or the context-menu key: no pointer position, so under the button) on a library item's Unsubscribe
  const onMenu = (e: MouseEvent<HTMLButtonElement>) => {
    if (!st.subscribed || !st.inLibrary) return;
    e.preventDefault();
    setMenu(menuAt(e));
  };
  const slide = motionOn ? { initial: { opacity: 0, x: 14 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -14 },
    transition: { duration: 0.22, ease: [0.2, 0.9, 0.3, 1] as const } } : FADE;
  const pct = prog && prog.value > 0 ? Math.round(prog.value * 100) : null;
  return (
    <motion.div className="side-sub" data-side-sub data-state={state} data-leaving={shown.closing || undefined} layout={motionOn}
      transition={{ duration: motionOn ? 0.24 : 0 }} {...box}>
      <motion.div className="side-sub-line" layout={motionOn ? "position" : false}>
        <span className={`side-sub-ico ${state}`} aria-hidden="true">{icon}</span>
        <span className="side-sub-text">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.b key={state} data-side-sub-label {...slide}>{label}</motion.b>
          </AnimatePresence>
        </span>
        {!pending && (
          <button ref={setBtn} className={`btn ico side-sub-btn ${st.subscribed ? "danger" : "accent"}`}
            data-side-sub-btn={st.subscribed ? "unsubscribe" : "subscribe"} aria-haspopup={st.subscribed && st.inLibrary ? "menu" : undefined}
            disabled={busy || shown.closing} onClick={click} onContextMenu={onMenu}>
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
      <ContextMenu at={menu} onClose={closeMenu} returnTo={btnRef} label="Unsubscribe"
        items={[keepMenuItem(keep)]} />
      <AnimatePresence initial={false}>
        {state === "subscribing" && prog && (
          <motion.div key="bar" className={`dl-bar side-sub-bar${pct == null ? " indet" : ""}`} data-side-sub-progress
            {...(motionOn ? { initial: { opacity: 0, scaleX: 0.6 }, animate: { opacity: 1, scaleX: 1 }, exit: { opacity: 0, scaleX: 0.6 },
              transition: { duration: 0.2 } } : FADE)}>
            <div className="dl-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
