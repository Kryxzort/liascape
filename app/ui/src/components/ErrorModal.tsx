import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store";

// Dedicated error modal (download failures etc.).
export function ErrorModal() {
  const error = useStore((s) => s.error);
  const dismiss = useStore((s) => s.dismissError);
  return (
    <AnimatePresence>
      {error && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={dismiss}>
          <motion.div className="modal err-modal" initial={{ scale: 0.95, y: 10, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }} transition={{ type: "spring", stiffness: 320, damping: 26 }}
            onClick={(e) => e.stopPropagation()}>
            <h2>Something went wrong</h2>
            <p className="err-text">{error}</p>
            <div className="modal-actions"><button className="btn accent" onClick={dismiss}>OK</button></div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
