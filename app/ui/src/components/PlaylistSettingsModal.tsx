import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import type { PlaylistSettings } from "../api/client";
import { TransitionPicker } from "./TransitionPicker";
import { PlayTimeInput } from "./PlayTimeInput";
import { NumInput } from "./NumInput";

// Playlist Settings overlay. Centered modal:
// order (Sequential/Shuffle), auto-add-new-library-items (global), override-global, and (when
// override) advance-on-end / wait-for-end / H-M-S interval.
export function PlaylistSettingsModal({
  open, ps, setPS, autoAdd, setAutoAdd, onClose,
}: {
  open: boolean; ps: PlaylistSettings; setPS: (p: Partial<PlaylistSettings>) => void;
  autoAdd: boolean; setAutoAdd: (v: boolean) => void; onClose: () => void;
}) {
  const iv = ps.intervalSeconds;
  const H = Math.floor(iv / 3600), M = Math.floor((iv % 3600) / 60), S = iv % 60;
  const setIv = (h: number, m: number, s: number) => setPS({ intervalSeconds: h * 3600 + m * 60 + s });
  const ovr = ps.overrideGlobalSettings;
  const [picker, setPicker] = useState(false);
  const trN = ps.transitionEffectIds?.length ?? 0;
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="modal pl-modal" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }} transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2>Playlist Settings</h2>

              <div className="field-label">ORDER</div>
              <div className="seg">
                <button className={`segbtn${ps.order === 0 ? " on" : ""}`} onClick={() => setPS({ order: 0 })}>Sequential</button>
                <button className={`segbtn${ps.order === 1 ? " on" : ""}`} onClick={() => setPS({ order: 1 })}>Shuffle</button>
              </div>

              <label className="ck"><input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} /> Auto-add newly added library items to playlist</label>
              <label className="ck"><input type="checkbox" checked={ovr} onChange={(e) => setPS({ overrideGlobalSettings: e.target.checked })} /> Override global rotation settings</label>

              <div className={`ovr${ovr ? "" : " dim"}`}>
                <label className="ck"><input type="checkbox" disabled={!ovr} checked={ps.advanceOnVideoEnd} onChange={(e) => setPS({ advanceOnVideoEnd: e.target.checked })} /> Switch when video ends</label>
                {/* the advance-on-end play-time limits (wall-clock seconds, 0 = off) — only with "Switch when video ends" */}
                <div className={`pl-playtime${ovr && ps.advanceOnVideoEnd ? "" : " dim"}`}>
                  <label title="a shorter video loops until it, then switches at the end of that loop · 0 = off">Min play time
                    <PlayTimeInput label="minimum play time (s)" value={ps.minPlaySeconds ?? 0} disabled={!ovr || !ps.advanceOnVideoEnd} onChange={(v) => setPS({ minPlaySeconds: v })} /></label>
                  <label title="a longer video (or a scene) switches once it played this long · 0 = off">Max play time
                    <PlayTimeInput label="maximum play time (s)" value={ps.maxPlaySeconds ?? 0} disabled={!ovr || !ps.advanceOnVideoEnd} onChange={(v) => setPS({ maxPlaySeconds: v })} /></label>
                </div>
                <label className="ck"><input type="checkbox" disabled={!ovr} checked={ps.waitForVideoEnd} onChange={(e) => setPS({ waitForVideoEnd: e.target.checked })} /> Wait for video to end after interval</label>
                <div className="field-label">SWITCH EVERY</div>
                <div className="hms">
                  <NumInput min={0} max={99} disabled={!ovr} value={H} onChange={(v) => setIv(v, M, S)} /><span>h</span>
                  <NumInput min={0} max={59} disabled={!ovr} value={M} onChange={(v) => setIv(H, v, S)} /><span>m</span>
                  <NumInput min={0} max={59} disabled={!ovr} value={S} onChange={(v) => setIv(H, M, v)} /><span>s</span>
                </div>

                <div className="field-label">TRANSITIONS</div>
                <button className="btn ghost ico tr-open" disabled={!ovr} onClick={() => setPicker(true)}>
                  <Sparkles size={15} />
                  {ps.transitionEnabled ? `On · ${trN} effect${trN === 1 ? "" : "s"}` : "Off"}
                </button>
              </div>

              <TransitionPicker open={picker} value={ps} onChange={setPS} onClose={() => setPicker(false)}
                title="Playlist Transitions" />

              <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
