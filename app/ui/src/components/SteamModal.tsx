import { AnimatePresence, motion } from "framer-motion";
import { useFadeOff } from "./motion";
import { useStore } from "../store";

// Steam QR sign-in modal. QR png arrives over WS (steam-qr); steam-signed-in closes it.
export function SteamModal() {
  const fadeOff = useFadeOff(); // motion off: the zoom / rise below becomes a fade in place
  const open = useStore((s) => s.qrOpen);
  const png = useStore((s) => s.qrPng);
  const cancel = useStore((s) => s.cancelQr);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" {...fadeOff({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })}
          onClick={cancel}>
          <motion.div className="modal qr-modal" {...fadeOff({ initial: { scale: 0.95, opacity: 0 }, animate: { scale: 1, opacity: 1 },
            exit: { scale: 0.95, opacity: 0 }, transition: { type: "spring", stiffness: 320, damping: 28 } })}
            onClick={(e) => e.stopPropagation()}>
            <h2>Sign in to Steam</h2>
            <p className="muted">Scan with the Steam mobile app</p>
            <div className="qr-box">
              {png ? <motion.img src={png} alt="QR" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
                : <span className="muted">Waiting for Steam…</span>}
            </div>
            <button className="btn ghost" onClick={cancel}>Cancel</button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
