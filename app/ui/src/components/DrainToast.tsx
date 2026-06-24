import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store";

// The unsub drain is a *view* — Dismiss hides this toast but the drain keeps running
// server-side (progress still flows to the status bar via WS).
export function DrainToast() {
  const unsub = useStore((s) => s.unsub);
  const setUnsub = useStore((s) => s.setUnsub);
  const show = !!unsub?.active;
  return (
    <AnimatePresence>
      {show && unsub && (
        <motion.div className="drain-toast" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }} transition={{ type: "spring", stiffness: 300, damping: 26 }}>
          <div className="drain-bar"><div className="drain-fill" /></div>
          <span>Removing from Steam{unsub.total ? ` — ${unsub.done}/${unsub.total}` : "…"}
            {unsub.currentId && <em> (id {unsub.currentId})</em>}</span>
          <button className="mini" onClick={() => setUnsub({ ...unsub, active: false })}>Dismiss</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
