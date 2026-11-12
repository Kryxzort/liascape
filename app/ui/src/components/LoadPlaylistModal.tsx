import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useFadeOff } from "./motion";
import { FolderFlap } from "./icons";
import { magnetRef } from "./magnet";

// Load Playlist modal — pick a saved playlist; Load stays disabled until a selection;
// "No saved playlists" empty state.
export function LoadPlaylistModal({
  open, names, onLoad, onClose,
}: { open: boolean; names: string[]; onLoad: (name: string) => void; onClose: () => void }) {
  const fadeOff = useFadeOff(); // motion off: the zoom / rise below becomes a fade in place
  const [sel, setSel] = useState<string | null>(null);
  // each opening starts with nothing picked (reset during render on the change — no frame shows the old pick)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (open) setSel(null); }
  const commit = () => { if (sel) { onLoad(sel); onClose(); } };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" {...fadeOff({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })} onClick={onClose}>
          <motion.div className="modal pl-modal" {...fadeOff({ initial: { scale: 0.96, opacity: 0 }, animate: { scale: 1, opacity: 1 },
            exit: { scale: 0.96, opacity: 0 }, transition: { type: "spring", stiffness: 320, damping: 28 } })}
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2>Load Playlist</h2>
              <div className="field-label">PLAYLIST</div>
              {names.length === 0
                ? <p className="muted">No saved playlists</p>
                : (
                  <div className="pl-names">
                    {names.map((n) => (
                      <button key={n} className={`pl-name${n === sel ? " sel" : ""}`}
                        onClick={() => setSel(n)} onDoubleClick={() => { onLoad(n); onClose(); }}>{n}</button>
                    ))}
                  </div>
                )}
              <div className="modal-actions">
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn accent ico" ref={magnetRef} disabled={!sel} onClick={commit}><FolderFlap size={15} /> Load</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
