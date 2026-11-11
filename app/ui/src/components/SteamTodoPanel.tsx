import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronDown, ChevronUp, ExternalLink, SkipForward, Square } from "lucide-react";
import { api, type SteamTodo } from "../api/client";
import { useStore } from "../store";
import { useMotion } from "./motion";

type Active = Exclude<SteamTodo, { finished: true }>;

// The "Steam to-do" (owner 2026-11-11, "Guided" — the mockup he picked; backend Web/SteamTodo.cs): the Workshop pages the user
// has to click in the Steam app, ONE at a time — a bulk download / bulk Delete from source used to open every page at once (Steam
// showed one) or the whole subscriptions list. Floating bottom-right (portal'd to <body>, above the item sidebar), it says which
// step ("Subscribe in Steam · 2 of 5"), the item, a bar, and the user's buttons: Done — next (the only thing that moves on:
// nothing is detected — owner "lets just have them click 'next'"), Open again, Skip, Stop; "Let the Steam app do all N" while
// two or more are left (the remaining ones through the Steam client — that batch only, the saved mode stays). The chevron
// folds it to a pill (the to-do goes on). Enter/exit on transform + opacity only; none under `no-motion`; no glow under `no-glow`.
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
      setLift(bar ? Math.round(window.innerHeight - bar.getBoundingClientRect().top) : 0);
    };
    measure();
    const t = setInterval(measure, 500);
    return () => clearInterval(t);
  }, [show]);
  useEffect(() => { if (!show) setFolded(false); }, [show]);

  const act = async (a: "next" | "reopen" | "skip" | "stop" | "use-steam-app") => {
    setBusy(a);
    try { await api.steamTodoAction(a); } catch (e) { useStore.getState().setStatus(`Steam to-do: ${(e as Error).message}`, true); }
    finally { setBusy(null); }
  };

  const verb = todo?.action === "unsubscribe" ? "Unsubscribe" : "Subscribe";
  const step = todo ? `${verb} in Steam · ${todo.index} of ${todo.total}` : "";
  const t = motionOn ? { type: "spring" as const, stiffness: 320, damping: 28 } : { duration: 0 };
  return createPortal(
    <AnimatePresence>
      {show && todo && (
        <motion.section key="steam-todo" className={`steam-todo${folded ? " folded" : ""}`} role="region" aria-label="Steam to-do"
          data-steam-todo style={{ bottom: 16 + lift }}
          initial={motionOn ? { y: 24, opacity: 0 } : false} animate={{ y: 0, opacity: 1 }}
          exit={motionOn ? { y: 24, opacity: 0, transition: { duration: 0.16 } } : { opacity: 0, transition: { duration: 0 } }}
          transition={t}>
          <div className="st-head">
            <span className="st-name">Steam to-do</span>
            {folded && <span className="st-step" data-st-step>{step}</span>}
            <button className="mini st-fold" aria-label={folded ? "Show the Steam to-do" : "Fold the Steam to-do"} aria-expanded={!folded}
              onClick={() => setFolded(!folded)}>{folded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
          </div>
          {!folded && (
            <>
              <div className="st-step" data-st-step>{step}</div>
              <div className="st-title" data-st-title>{todo.current.title}</div>
              <div className="dl-bar st-bar"><div className="dl-fill" style={{ width: `${Math.round((todo.index / Math.max(1, todo.total)) * 100)}%` }} /></div>
              <p className="st-hint" data-st-hint>
                {todo.delivered ? "Steam has it — click Done to go on."
                  : `Click ${verb} on the page Steam opened, then ${todo.remaining > 1 ? "Done — next" : "Done"}.`}
              </p>
              {todo.message && <p className="st-msg" role="alert" data-st-msg>{todo.message}</p>}
              <div className="st-btns">
                <button className="btn accent ico st-next" data-st="next" disabled={!!busy} onClick={() => act("next")}>
                  {todo.remaining > 1 ? "Done — next" : "Done"}{todo.remaining > 1 && <ArrowRight size={14} />}</button>
                <button className="btn ghost ico" data-st="reopen" disabled={!!busy} onClick={() => act("reopen")}><ExternalLink size={14} />Open again</button>
                <button className="btn ghost ico" data-st="skip" disabled={!!busy} onClick={() => act("skip")}><SkipForward size={14} />Skip</button>
                <button className="btn ghost ico st-stop" data-st="stop" disabled={!!busy} onClick={() => act("stop")}><Square size={12} />Stop</button>
              </div>
              {todo.remaining >= 2 && (
                <button className="st-use" data-st="use-steam-app" disabled={!!busy || !!todo.busy} onClick={() => act("use-steam-app")}>
                  {todo.busy || busy === "use-steam-app" ? "Asking the Steam app…" : <>Let the Steam app do all {todo.remaining}<ArrowRight size={14} /></>}
                </button>
              )}
            </>
          )}
        </motion.section>
      )}
    </AnimatePresence>,
    document.body,
  );
}
