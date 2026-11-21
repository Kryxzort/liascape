import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CloudOff, Trash2 } from "lucide-react";
import { useFadeOff } from "./motion";
import { useBaseConfirm, type BaseAsk } from "./baseConfirm";

// The question before a scene that presets play goes (components/baseConfirm.ts confirmBaseRemoval): the app's modal shell
// (ErrorModal.tsx's backdrop, panel and actions; motion off: a fade in place), the playlist popups' compact panel. "Keep it" is
// focused and Escape / a click outside answer it: a delete is never the default. Guard: probe-sidebar lib:baseDelete,
// lib:baseDeleteOff
export function BaseSceneConfirm() {
  const fadeOff = useFadeOff();
  const ask = useBaseConfirm((s) => s.ask);
  useEffect(() => {
    if (!ask) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ask.answer(false); } };
    addEventListener("keydown", h, true);
    return () => removeEventListener("keydown", h, true);
  }, [ask]);
  return (
    <AnimatePresence>
      {ask && (
        <motion.div className="modal-backdrop" data-base-confirm {...fadeOff({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })}
          onClick={() => ask.answer(false)}>
          <motion.div className="modal pl-modal base-confirm" role="alertdialog" aria-modal="true" aria-labelledby="base-confirm-h" aria-describedby="base-confirm-p"
            {...fadeOff({ initial: { scale: 0.96, opacity: 0 }, animate: { scale: 1, opacity: 1 }, exit: { scale: 0.96, opacity: 0 },
              transition: { type: "spring", stiffness: 320, damping: 28 } })}
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2 id="base-confirm-h">{heading(ask)}</h2>
              <p className="base-confirm-text" id="base-confirm-p" data-base-confirm-text>{words(ask)}</p>
              <div className="modal-actions">
                <button className="btn ghost" data-base-confirm-keep autoFocus onClick={() => ask.answer(false)}>{ask.items > 1 ? "Keep them" : "Keep it"}</button>
                <button className="btn danger ico" data-base-confirm-go onClick={() => ask.answer(true)}>
                  {ask.verb === "unsubscribe" ? <><CloudOff size={15} /> Unsubscribe</> : <><Trash2 size={15} /> Delete</>}</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const heading = (a: BaseAsk) => {
  const what = a.title != null ? `“${a.title}”` : `${a.items} wallpapers`;
  return a.verb === "unsubscribe" ? `Unsubscribe from ${what}?` : `Delete ${what}?`;
};
// "2 presets in your library use this scene. They stay, greyed out, until you download it again."
const words = (a: BaseAsk) => {
  const scene = a.bases > 1 ? "these scenes" : "this scene", it = a.bases > 1 ? "them" : "it";
  return a.n === 1 ? `1 preset in your library uses ${scene}. It stays, greyed out, until you download ${it} again.`
    : `${a.n} presets in your library use ${scene}. They stay, greyed out, until you download ${it} again.`;
};
