import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FolderOpen } from "lucide-react";

// Load Playlist modal — pick a saved playlist; Load stays disabled until a selection;
// "No saved playlists" empty state.
export function LoadPlaylistModal({
  open, names, onLoad, onClose,
}: { open: boolean; names: string[]; onLoad: (name: string) => void; onClose: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (open) setSel(null); }, [open]);
  const commit = () => { if (sel) { onLoad(sel); onClose(); } };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="modal pl-modal" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }} transition={{ type: "spring", stiffness: 320, damping: 28 }}
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
                <button className="btn accent ico" disabled={!sel} onClick={commit}><FolderOpen size={15} /> Load</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
