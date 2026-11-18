import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Film, ImagePlay, Image as ImageIcon, Layers, LoaderCircle, Upload } from "lucide-react";
import { useStore } from "../store";
import { api, type FoundItem, type ImportScan } from "../api/client";
import { useFadeOff, useMotion, FADE } from "./motion";
import { magnetRef } from "./magnet";
import { FolderFlap } from "./icons";
import { hasPicker, pickFolder } from "./importPick";

// The Library's import (the Import button's folder or files, a folder or files dropped on the window, Settings' "Add folder"):
// what the paths hold, before anything lands (POST /library/scan, Helpers/FolderScanner.cs), grouped by kind with a tick
// each; what the library already has is listed unticked and can't be ticked. Import N imports the ticked ones in the
// background (the top bar's progress line); Cancel, Escape or a click outside lands nothing. One scanned folder can be kept
// watched (Settings → Watched folders), and every import is linked or copied ("Copy files instead of linking", the Workshop
// folder's own choice, as its default). With no native picker (a plain browser) the dialog asks for the folder's path.
// Guard: --probe probe-import.js (import:*)
const GROUPS: { kind: FoundItem["kind"]; label: string; one: string; many: string; icon: React.ReactNode }[] = [
  { kind: "video", label: "Videos", one: "video", many: "videos", icon: <Film size={14} /> },
  { kind: "gif", label: "GIFs", one: "GIF", many: "GIFs", icon: <ImagePlay size={14} /> },
  { kind: "image", label: "Pictures", one: "picture", many: "pictures", icon: <ImageIcon size={14} /> },
  { kind: "scene", label: "Scenes", one: "scene", many: "scenes", icon: <Layers size={14} /> },
];
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

// "12 videos, 3 scenes, 2 already in your library"
function scanSummary(scan: ImportScan): string {
  const parts = GROUPS.map((g) => [g, scan.items.filter((i) => i.kind === g.kind && !i.inLibrary).length] as const)
    .filter(([, c]) => c > 0).map(([g, c]) => n(c, g.one, g.many));
  const have = scan.items.filter((i) => i.inLibrary).length;
  if (have) parts.push(`${have} already in your library`);
  return parts.length ? parts.join(", ") : "No wallpapers here";
}

// an item the user can tick: not in the library yet, and a scene only while scenes can play
const tickable = (i: FoundItem, scan: ImportScan) => !i.inLibrary && !(i.kind === "scene" && scan.scenesOff);

export function ImportDialog() {
  const req = useStore((s) => s.importAt);
  const close = useStore((s) => s.closeImport);
  const setStatus = useStore((s) => s.setStatus);
  const copyDefault = useStore((s) => !!s.settings?.copyFilesInsteadOfSymlinking);
  const fadeOff = useFadeOff();
  const motionOn = useMotion();
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [copy, setCopy] = useState(false);
  const [watch, setWatch] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  // each request starts clean (reset during render on the change: no frame shows the last one's list); `last` keeps a
  // closing dialog's request, so its exit shows what it showed
  const [shownReq, setShownReq] = useState(req);
  const [last, setLast] = useState(req);
  if (req !== shownReq) {
    setShownReq(req);
    if (req) { setLast(req); setScan(null); setFailed(null); setTicked(new Set()); setCopy(copyDefault); setWatch(req.watch); setTyped(""); setBusy(false); }
  }
  useEffect(() => {
    if (!req?.paths.length) return;
    let alive = true;
    api.scanImport(req.paths).then((r) => {
      if (!alive) return;
      setScan(r);
      setTicked(new Set(r.items.filter((i) => tickable(i, r)).map((i) => i.path)));
      setCopy(r.copy);
    }).catch((e) => { if (alive) setFailed((e as Error).message || "The folder couldn't be read"); });
    return () => { alive = false; };
  }, [req]);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [req, close]);

  const open = req != null;
  const root = scan && scan.roots.length === 1 && scan.folders.length === 1 ? scan.folders[0] : null;
  const watchedAlready = !!root && !!scan?.watched.includes(root);
  const canWatch = !!root && !watchedAlready;
  const picked = scan ? scan.items.filter((i) => ticked.has(i.path)) : [];
  const doImport = async () => {
    if (!scan || busy) return;
    setBusy(true);
    const w = watch && canWatch ? root : null;
    const skip = w ? scan.items.filter((i) => tickable(i, scan) && !ticked.has(i.path)).map((i) => i.path) : [];
    try {
      await api.importFound({ paths: picked.map((i) => i.path), copy, watch: w, skip });
      setStatus(picked.length ? `Importing ${n(picked.length, "wallpaper", "wallpapers")}` : `Watching ${root}`);
      close();
    } catch (e) { setBusy(false); setFailed((e as Error).message); }
  };
  const tick = (paths: string[], on: boolean) => setTicked((t) => {
    const s = new Set(t);
    for (const p of paths) if (on) s.add(p); else s.delete(p);
    return s;
  });
  const look = () => { const p = typed.trim(); if (p) useStore.getState().openImport([p], last?.watch ?? false); };
  const browse = async () => { const p = await pickFolder(); if (p) useStore.getState().openImport([p], last?.watch ?? false); };
  const label = picked.length ? `Import ${picked.length}` : watch && canWatch ? "Watch folder" : "Import";
  const state = !last?.paths.length ? "ask" : failed ? "failed" : scan ? "found" : "scanning";

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" {...fadeOff({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })} onClick={close}>
          <motion.div className="modal imp-modal" data-import-dialog={state} role="dialog" aria-label="Import"
            layout={motionOn}
            {...fadeOff({ initial: { scale: 0.96, opacity: 0 }, animate: { scale: 1, opacity: 1 },
              exit: { scale: 0.96, opacity: 0 }, transition: { type: "spring", stiffness: 320, damping: 28, layout: { type: "spring", stiffness: 320, damping: 30 } } })}
            onClick={(e) => e.stopPropagation()}>
            <motion.div className="imp-inner" layout={motionOn ? "position" : false}>
              <h2>{last?.watch ? "Watch a folder" : "Import"}</h2>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={state} className="imp-state" {...(motionOn
                  ? { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: 0.16 } }
                  : FADE)}>
                  {state === "ask" && (
                    <div className="imp-ask">
                      <p className="muted">The folder to look through:</p>
                      <div className="imp-ask-row">
                        <input className="text wide" autoFocus placeholder="/home/you/Videos/Wallpapers" value={typed} data-import-path
                          onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") look(); }} />
                        <button className="btn ghost" disabled={!typed.trim()} onClick={look}>Look</button>
                      </div>
                    </div>
                  )}
                  {state === "scanning" && (
                    <p className="imp-scanning muted"><LoaderCircle size={14} className="side-sub-spin" /> Looking through {last!.paths.length === 1 ? last!.paths[0] : n(last!.paths.length, "item", "items")}…</p>
                  )}
                  {state === "failed" && <p className="imp-note" data-import-failed>{failed}</p>}
                  {state === "found" && scan && (
                    <ScanList scan={scan} ticked={ticked} tick={tick} />
                  )}
                </motion.div>
              </AnimatePresence>
              {state === "found" && scan && (
                <div className="imp-opts">
                  <label className="ck imp-opt">
                    <input type="checkbox" checked={copy} data-import-copy onChange={(e) => setCopy(e.target.checked)} />
                    <span><span className="imp-opt-name">Copy files instead of linking</span>
                      <span className="shint">{copy ? "the library keeps its own copy (uses more disk)." : "the library links to the files where they are."}</span></span>
                  </label>
                  {canWatch && (
                    <label className="ck imp-opt">
                      <input type="checkbox" checked={watch} data-import-watch onChange={(e) => setWatch(e.target.checked)} />
                      <span><span className="imp-opt-name">Keep watching this folder</span>
                        <span className="shint">new or changed files come in by themselves, removed ones leave. Unticked ones stay out.</span></span>
                    </label>
                  )}
                  {watchedAlready && <p className="shint imp-watched">This folder is watched already.</p>}
                </div>
              )}
              <div className="modal-actions imp-actions">
                {state === "ask" && <button className="btn ghost ico" onClick={browse} hidden={!hasPicker()}><FolderFlap size={14} /> Browse</button>}
                <span className="spacer" />
                <button className="btn ghost" onClick={close}>Cancel</button>
                <button className="btn accent ico" ref={magnetRef} data-import-go disabled={state !== "found" || busy || (!picked.length && !(watch && canWatch))}
                  onClick={doImport}><Upload size={15} /> {label}</button>
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// The found items by kind: a group's tick ticks all it can (mixed: some), each item's its own; the library's own and (with
// "Play scenes" off) the scenes are shown unticked and can't be ticked, each saying why.
function ScanList({ scan, ticked, tick }: { scan: ImportScan; ticked: ReadonlySet<string>; tick: (paths: string[], on: boolean) => void }) {
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: scan.items.filter((i) => i.kind === g.kind) })).filter((g) => g.items.length), [scan]);
  const notes = [
    scan.unreadable.length ? `${n(scan.unreadable.length, "folder", "folders")} couldn't be read.` : "",
    scan.unsupported ? `${n(scan.unsupported, "Wallpaper Engine item is", "Wallpaper Engine items are")} a kind the app can't play (web, application).` : "",
    scan.duplicates ? `${n(scan.duplicates, "item is", "items are")} in the folder twice, listed once.` : "",
    scan.truncated ? "There's more than the app looks through at once: pick a smaller folder for the rest." : "",
  ].filter(Boolean);
  return (
    <>
      <p className="imp-summary" data-import-summary>{scanSummary(scan)}</p>
      {groups.length > 0 && (
        <div className="imp-list" data-import-list>
          {groups.map((g) => {
            const can = g.items.filter((i) => tickable(i, scan));
            const on = can.filter((i) => ticked.has(i.path)).length;
            return (
              <div key={g.kind} className="imp-group" data-import-group={g.kind}>
                <GroupTick label={g.label} icon={g.icon} count={g.items.length} on={on} of={can.length}
                  note={g.kind === "scene" && scan.scenesOff ? "turn on Play scenes in Settings to import them" : null}
                  onChange={(v) => tick(can.map((i) => i.path), v)} />
                {g.items.map((i) => {
                  const off = !tickable(i, scan);
                  return (
                    <label key={i.path} className={`ck imp-item${off ? " off" : ""}`} data-import-item={i.path} title={i.path}>
                      <input type="checkbox" checked={!off && ticked.has(i.path)} disabled={off} onChange={(e) => tick([i.path], e.target.checked)} />
                      <span className="imp-title">{i.title}</span>
                      {i.dir && <span className="imp-dir">{i.dir}</span>}
                      {i.inLibrary && <span className="imp-have">In your library</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {notes.length > 0 && <p className="shint imp-notes" data-import-notes>{notes.join(" ")}</p>}
    </>
  );
}

// a group's tick: on when every tickable item is, mixed when some are (the checkbox's own indeterminate state)
function GroupTick({ label, icon, count, on, of, note, onChange }: {
  label: string; icon: React.ReactNode; count: number; on: number; of: number; note: string | null; onChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = on > 0 && on < of; }, [on, of]);
  return (
    <label className="ck imp-head">
      <input ref={ref} type="checkbox" checked={of > 0 && on === of} disabled={of === 0} onChange={(e) => onChange(e.target.checked)} />
      <span className="imp-gico" aria-hidden>{icon}</span>
      <span className="imp-gname">{label}</span>
      <span className="imp-count">{count}</span>
      {note && <span className="imp-gnote">{note}</span>}
    </label>
  );
}
