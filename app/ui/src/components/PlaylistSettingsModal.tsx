import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import type { PlaylistSettings } from "../api/client";
import { TransitionPicker } from "./TransitionPicker";
import { PlayTimeInput, ROT_HINT } from "./PlayTimeInput";

// Playlist Settings overlay. Centered modal:
// order (Sequential/Shuffle), auto-add-new-library-items (global), override-global, and (when
// override) its own rotation: "Switch when video ends" off → "Switch every" (H-M-S); on → the same field as
// "Minimum play time" + "Maximum play time" + "Separate timing for scenes" (→ "Switch scenes after"; player-adapter.md
// § Rotation; every limit 0 = off), and its transitions.
export function PlaylistSettingsModal({
  open, ps, setPS, autoAdd, setAutoAdd, onClose,
}: {
  open: boolean; ps: PlaylistSettings; setPS: (p: Partial<PlaylistSettings>) => void;
  autoAdd: boolean; setAutoAdd: (v: boolean) => void; onClose: () => void;
}) {
  const ovr = ps.overrideGlobalSettings;
  const aoe = ps.advanceOnVideoEnd;
  const sep = ps.separateSceneTiming ?? true;
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
                <label className="ck"><input type="checkbox" disabled={!ovr} checked={aoe} onChange={(e) => setPS({ advanceOnVideoEnd: e.target.checked })} /> Switch when video ends</label>
                {/* one interval field: "Switch every" (a timer) — or, under "Switch when video ends", the minimum play
                    time, with the maximum right below */}
                <div className="field-label" title={aoe ? ROT_HINT.min + (sep ? "" : ROT_HINT.minScenes) : ROT_HINT.every}>{aoe ? "MINIMUM PLAY TIME" : "SWITCH EVERY"}</div>
                <PlayTimeInput label={aoe ? "Minimum play time" : "Switch every"} zeroText={aoe ? "off" : undefined} disabled={!ovr}
                  value={ps.intervalSeconds ?? 0} onChange={(v) => setPS({ intervalSeconds: v })} />
                {aoe && <>
                  <div className="field-label" title={ROT_HINT.max + (sep ? "" : ROT_HINT.maxScenes)}>MAXIMUM PLAY TIME</div>
                  <PlayTimeInput label="Maximum play time" zeroText="off" disabled={!ovr}
                    value={ps.maxPlaySeconds ?? 0} onChange={(v) => setPS({ maxPlaySeconds: v })} />
                  <label className="ck" title={ROT_HINT.separate}><input type="checkbox" disabled={!ovr} checked={sep}
                    onChange={(e) => setPS({ separateSceneTiming: e.target.checked })} /> Separate timing for scenes</label>
                  {sep && <>
                    <div className="field-label" title={ROT_HINT.scenesAfter}>SWITCH SCENES AFTER</div>
                    <PlayTimeInput label="Switch scenes after" zeroText="off" disabled={!ovr}
                      value={ps.switchScenesAfterSeconds ?? 1800} onChange={(v) => setPS({ switchScenesAfterSeconds: v })} />
                  </>}
                </>}

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
