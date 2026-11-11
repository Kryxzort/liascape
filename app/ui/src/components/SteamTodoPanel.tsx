import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronDown, ExternalLink, SkipForward, Square } from "lucide-react";
import { api, type SteamTodo } from "../api/client";
import { useStore } from "../store";
import { useMotion } from "./motion";

type Active = Exclude<SteamTodo, { finished: true }>;

// The "Steam to-do" (docs/decisions.md § "Queue the Steam pages the user must click, one at a time, advanced by Next";
// backend Web/SteamTodo.cs): the Workshop pages the user has to click in the Steam app, ONE at a time — given every page at
// once, Steam shows one. Floating bottom-right (portal'd to <body>, above the item sidebar), it says which
// step ("Subscribe in Steam · 2 of 5"), the item, a bar, and the user's buttons: Done — next, Open again, Skip, Stop; a subscribe
// entry whose files weren't on disk when its page opened also moves on by itself once Steam delivers them (`autoNext`); "Let the
// Steam app do all N" while two or more are left (the remaining ones through the Steam client — that batch only, the saved mode
// stays), with what that means under it (it needs WE owned, and Steam shows the user as playing it).
// Motion: the dock
// GLIDES over the playlist bar (`.steam-todo-dock`'s translateY, eased — the bar showing / folding / a tab switch / a resize);
// fold ⇄ unfold MORPHS the panel's box (framer `layout`: size + corners; the head rides with `layout="position"`, the body fades
// out first / in after) with the chevron ROTATING 0 ↔ 180° on a springy curve; a new current entry (Next / Skip / auto) SLIDES
// like the item sidebar's carousel — the old step + title + hint out to the left, the new in from the right. Transform +
// opacity only; `useMotion()` off → all of it instant; no glow under `no-glow`.
export function SteamTodoPanel() {
  const todo = useStore((s) => s.steamTodo) as Active | null;
  const motionOn = useMotion();
  const [folded, setFolded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // sits above the playlist bar when one is showing (Library) — its height changes with the window and its dock state
  const [lift, setLift] = useState(0);
  const show = !!todo && !todo.finished;
  useEffect(() => {
    if (!show) return;
    const measure = () => {
      const bar = document.querySelector<HTMLElement>(".playlist-bar");
      const r = bar?.getBoundingClientRect();
      const next = r && r.height > 0 ? Math.max(0, Math.round(window.innerHeight - r.top)) : 0;
      setLift((was) => (was === next ? was : next));
    };
    measure();
    // a tab switch / the bar folding / a resize: re-measured often (cheap — one rect); the CSS transition glides to it
    const t = setInterval(measure, 150);
    window.addEventListener("resize", measure);
    return () => { clearInterval(t); window.removeEventListener("resize", measure); };
  }, [show]);
  useEffect(() => { if (!show) setFolded(false); }, [show]);

  const act = async (a: "next" | "reopen" | "skip" | "stop" | "use-steam-app") => {
    setBusy(a);
    try { await api.steamTodoAction(a); } catch (e) { useStore.getState().setStatus(`Steam to-do: ${(e as Error).message}`, true); }
    finally { setBusy(null); }
  };

  const verb = todo?.action === "unsubscribe" ? "Unsubscribe" : "Subscribe";
  const step = todo ? `${verb} in Steam · ${todo.index} of ${todo.total}` : "";
  const entryKey = todo ? `${todo.action}:${todo.current.id}:${todo.index}` : "";
  const spring = { type: "spring" as const, stiffness: 320, damping: 28 };
  const t = motionOn ? spring : { duration: 0 };
  const layoutT = motionOn ? { type: "spring" as const, stiffness: 380, damping: 32 } : { duration: 0 };
  // the carousel: out to the left, in from the right
  const slide = motionOn
    ? { initial: { x: 48, opacity: 0 }, animate: { x: 0, opacity: 1 }, exit: { x: -48, opacity: 0 }, transition: { duration: 0.28, ease: [0.2, 0.9, 0.3, 1] } }
    : { initial: false as const, animate: { x: 0, opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } }, transition: { duration: 0 } };
  const fade = motionOn
    ? { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0, transition: { duration: 0.2, delay: 0.08 } }, exit: { opacity: 0, transition: { duration: 0.1 } } }
    : { initial: false as const, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, transition: { duration: 0 } } };
  const hint = !todo ? "" : todo.delivered ? "Steam has it — click Done to go on."
    : todo.autoNext ? `Click ${verb} on the page Steam opened — this moves on by itself once Steam downloads it.`
    : `Click ${verb} on the page Steam opened, then ${todo.remaining > 1 ? "Done — next" : "Done"}.`;
  return createPortal(
    <div className={`steam-todo-dock${motionOn ? "" : " still"}`} data-steam-todo-dock style={{ transform: `translateY(${-lift}px)` }}>
      <AnimatePresence>
        {show && todo && (
          <motion.section key="steam-todo" className={`steam-todo${folded ? " folded" : ""}`} role="region" aria-label="Steam to-do"
            data-steam-todo data-folded={folded || undefined} layout={motionOn} style={{ borderRadius: folded ? 20 : 14 }}
            initial={motionOn ? { y: 24, opacity: 0 } : false} animate={{ y: 0, opacity: 1 }}
            exit={motionOn ? { y: 24, opacity: 0, transition: { duration: 0.16 } } : { opacity: 0, transition: { duration: 0 } }}
            transition={{ ...t, layout: layoutT }}>
            <motion.div className="st-head" layout={motionOn ? "position" : false} transition={{ layout: layoutT }}>
              <span className="st-name">Steam to-do</span>
              <AnimatePresence mode="popLayout" initial={false}>
                {folded && <motion.span key={`f-${entryKey}`} className="st-step" data-st-step {...slide}>{step}</motion.span>}
              </AnimatePresence>
              <button className="mini st-fold" aria-label={folded ? "Show the Steam to-do" : "Fold the Steam to-do"} aria-expanded={!folded}
                onClick={() => setFolded(!folded)}><ChevronDown size={15} className="st-chev" /></button>
            </motion.div>
            <AnimatePresence initial={false} mode="popLayout">
              {!folded && (
                <motion.div key="body" className="st-body" {...fade}>
                  <div className="st-track">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.div key={entryKey} className="st-entry" data-st-entry={todo.current.id} {...slide}>
                        <div className="st-step" data-st-step>{step}</div>
                        <div className="st-title" data-st-title>{todo.current.title}</div>
                        <p className="st-hint" data-st-hint>{hint}</p>
                      </motion.div>
                    </AnimatePresence>
                  </div>
                  <div className="dl-bar st-bar"><div className="dl-fill" style={{ width: `${Math.round((todo.index / Math.max(1, todo.total)) * 100)}%` }} /></div>
                  {todo.message && <p className="st-msg" role="alert" data-st-msg>{todo.message}</p>}
                  <div className="st-btns">
                    <button className="btn accent ico st-next" data-st="next" disabled={!!busy} onClick={() => act("next")}>
                      {todo.remaining > 1 ? "Done — next" : "Done"}{todo.remaining > 1 && <ArrowRight size={14} />}</button>
                    <button className="btn ghost ico" data-st="reopen" disabled={!!busy} onClick={() => act("reopen")}><ExternalLink size={14} />Open again</button>
                    <button className="btn ghost ico" data-st="skip" disabled={!!busy} onClick={() => act("skip")}><SkipForward size={14} />Skip</button>
                    <button className="btn ghost ico st-stop" data-st="stop" disabled={!!busy} onClick={() => act("stop")}><Square size={12} />Stop</button>
                  </div>
                  {todo.remaining >= 2 && (
                    <div className="st-use-wrap">
                      <button className="st-use" data-st="use-steam-app" disabled={!!busy || !!todo.busy} onClick={() => act("use-steam-app")}>
                        {todo.busy || busy === "use-steam-app" ? "Asking the Steam app…" : <>Let the Steam app do all {todo.remaining}<ArrowRight size={14} /></>}
                      </button>
                      <p className="st-use-note" data-st-use-note>Needs Steam running with Wallpaper Engine in your account — Steam shows you as playing it meanwhile.</p>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.section>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
