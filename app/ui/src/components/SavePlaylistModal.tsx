import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Save } from "lucide-react";

// Save Playlist modal — name field + click an existing name to overwrite.
export function SavePlaylistModal({
  open, names, onSave, onClose,
}: { open: boolean; names: string[]; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(""); }, [open]);
  const commit = () => { const n = name.trim(); if (n) { onSave(n); onClose(); } };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="modal pl-modal" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }} transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2>Save Playlist</h2>
              <div className="field-label">NAME</div>
              <input className="text wide" autoFocus value={name} placeholder="My playlist"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
              {names.length > 0 && (
                <div className="pl-names">
                  {names.map((n) => (
                    <button key={n} className={`pl-name${n === name.trim() ? " sel" : ""}`} onClick={() => setName(n)}>{n}</button>
                  ))}
                </div>
              )}
              <div className="modal-actions">
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn accent ico" disabled={!name.trim()} onClick={commit}><Save size={15} /> Save</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
