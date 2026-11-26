import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CloudCheck, Film, ImagePlay, Image as ImageIcon, Layers, Link2, LoaderCircle, Upload } from "lucide-react";
import { useStore } from "../store";
import { api, type FoundItem, type ImportScan, type LinkTarget } from "../api/client";
import { shortDownloadStatus } from "./downloadStatus";
import { downloadHint } from "./subscribeMode";
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
// What sits in Steam's own Workshop folder is listed apart, "From your Steam subscriptions", unticked and disabled: Steam
// deletes those files on an unsubscribe, so the WE auto-import is their one way in (Settings' "Import new Workshop
// wallpapers"); the backend refuses them too.
// An import from a link (the Import menu's "Import from a link…", a link pasted on the Library or dropped on the window) is
// the same dialog with a link field: what the link names shows as soon as it is typed (POST /library/link: the item, its
// kind and source, "In your library", the download mode's refusal, or why it can't be imported, in its own words), and
// Import downloads it by that source's own path (Web/LinkImportOps.cs) with the progress bar a Browse card shows; Close
// leaves it running (the top bar's words, then the status line or the error modal). An import that fails says why under the
// item, which stays: Import tries again as it is (a server that was down), an edit of the link clears the note.
// Guard: --probe probe-import.js (import:*, import:steam, import:link:*)
const GROUPS: { kind: FoundItem["kind"]; label: string; one: string; many: string; icon: React.ReactNode }[] = [
  { kind: "video", label: "Videos", one: "video", many: "videos", icon: <Film size={14} /> },
  { kind: "gif", label: "GIFs", one: "GIF", many: "GIFs", icon: <ImagePlay size={14} /> },
  { kind: "image", label: "Pictures", one: "picture", many: "pictures", icon: <ImageIcon size={14} /> },
  { kind: "scene", label: "Scenes", one: "scene", many: "scenes", icon: <Layers size={14} /> },
];
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

// "12 videos, 3 scenes, 2 already in your library, 4 from your Steam subscriptions"
function scanSummary(scan: ImportScan): string {
  const own = scan.items.filter((i) => !i.subscription);
  const parts = GROUPS.map((g) => [g, own.filter((i) => i.kind === g.kind && !i.inLibrary).length] as const)
    .filter(([, c]) => c > 0).map(([g, c]) => n(c, g.one, g.many));
  const have = own.filter((i) => i.inLibrary).length;
  if (have) parts.push(`${have} already in your library`);
  const subs = scan.items.length - own.length;
  if (subs) parts.push(`${subs} from your Steam subscriptions`);
  return parts.length ? parts.join(", ") : "No wallpapers here";
}

// an item the user can tick: not in the library yet, not a Steam subscription, and a scene only while scenes can play
const tickable = (i: FoundItem, scan: ImportScan) => !i.inLibrary && !i.subscription && !(i.kind === "scene" && scan.scenesOff);

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
  // an import from a link: the field's text, what the backend said the trimmed text names (kept with that text: a newer text
  // shows "Checking…" until its own answer), the link importing now, and why its last import failed (shown under what the
  // link names, which stays: Import tries again; an edit or the next try clears it)
  const [linkText, setLinkText] = useState("");
  const [resolved, setResolved] = useState<{ text: string; target: LinkTarget | null; error: string | null } | null>(null);
  const [importing, setImporting] = useState<LinkTarget | null>(null);
  const [importFailed, setImportFailed] = useState<string | null>(null);
  // each request starts clean (reset during render on the change: no frame shows the last one's list); `last` keeps a
  // closing dialog's request, so its exit shows what it showed. Starts at none, not at `req`: the dialog is lazy-loaded, so its
  // first mount already has the request that opened it (a pasted link's text) and must take it in like any later one
  const [shownReq, setShownReq] = useState<typeof req>(null);
  const [last, setLast] = useState(req);
  if (req !== shownReq) {
    setShownReq(req);
    if (req) {
      setLast(req); setScan(null); setFailed(null); setTicked(new Set()); setCopy(copyDefault); setWatch(req.watch); setTyped(""); setBusy(false);
      setLinkText(req.link ?? ""); setResolved(null); setImporting(null); setImportFailed(null);
    }
  }
  const isLink = req?.link !== undefined;
  const linkTrim = linkText.trim();
  const found = resolved && resolved.text === linkTrim ? resolved : null;
  // what the link names, asked once typing pauses (at once for a link the dialog opened with: a paste, a drop); a newer text
  // drops the older ask. Not tied to the import: its end (a refusal shown in this line) asks nothing again
  useEffect(() => {
    if (!isLink || !linkTrim) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api.resolveLink(linkTrim, ctrl.signal).then((r) => setResolved({ text: linkTrim, target: r, error: null }),
        (e) => { if (!ctrl.signal.aborted) setResolved({ text: linkTrim, target: null, error: (e as Error).message || "That link can't be imported." }); });
    }, linkTrim === req?.link?.trim() ? 0 : 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [isLink, linkTrim, req]);
  const linkReady = !!found?.target && !found.target.inLibrary && !importing;
  const goLink = async () => {
    const t = found?.target;
    if (!t || !linkReady) return;
    setImporting(t); setImportFailed(null);
    const why = await useStore.getState().importLink(linkTrim, t, req);
    // closed meanwhile: the status line or the error modal said how it ended
    if (useStore.getState().importAt !== req) return;
    if (why == null) close();
    else { setImporting(null); setImportFailed(why); }
  };
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
    // what the user unticked, watched or not: a ticked preset never brings an unticked base scene along
    const skip = scan.items.filter((i) => tickable(i, scan) && !ticked.has(i.path)).map((i) => i.path);
    try {
      await api.importFound({ paths: picked.map((i) => i.path), copy, watch: w, skip, roots: scan.folders });
      setStatus(picked.length ? `Importing ${n(picked.length, "wallpaper", "wallpapers")}` : `Watching ${root} for new wallpapers`);
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
  const state = last?.link !== undefined ? "link" : !last?.paths.length ? "ask" : failed ? "failed" : scan ? "found" : "scanning";
  const label = state === "link" ? (importing ? "Importing…" : "Import")
    : picked.length ? `Import ${picked.length}` : watch && canWatch ? "Watch folder" : "Import";
  const goOff = state === "link" ? !linkReady : state !== "found" || busy || (!picked.length && !(watch && canWatch));

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
              <h2>{state === "link" ? "Import from a link" : last?.watch ? "Watch a folder" : "Import"}</h2>
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
                  {state === "link" && (
                    <div className="imp-link">
                      <p className="muted">A Steam Workshop item, a MoeWalls, DesktopHut or MotionBgs page, or a link straight to a video or picture:</p>
                      <input className="text wide" autoFocus placeholder="https://…" value={linkText} data-import-link spellCheck={false}
                        disabled={!!importing} aria-label="Link to import"
                        onChange={(e) => { setLinkText(e.target.value); setImportFailed(null); }} onKeyDown={(e) => { if (e.key === "Enter") void goLink(); }} />
                      <LinkLine text={linkTrim} found={found} importing={importing} failed={importFailed} />
                    </div>
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
                {/* an import from a link goes on once the dialog is closed: the button says so */}
                <button className="btn ghost" onClick={close}>{importing ? "Close" : "Cancel"}</button>
                <button className="btn accent ico" ref={magnetRef} data-import-go disabled={goOff}
                  onClick={state === "link" ? goLink : doImport}>
                  <Upload size={15} /> {label}</button>
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// The line under the link field: "Checking the link…" while the backend looks, then what it names (its kind's chip, its
// title, where it comes from; "In your library"; the download mode's refusal) or why it can't be imported. A change of what
// it says cross-fades (motion on: a short rise). Importing, the item's progress shows under it as a Browse card's does: its
// download-progress fill (none known: the sweeping segment) and, for a Workshop item, the step it is at.
const MEDIA: Record<string, { word: string; icon: React.ReactNode }> = {
  video: { word: "Video", icon: <Film size={14} /> }, gif: { word: "GIF", icon: <ImagePlay size={14} /> },
  image: { word: "Picture", icon: <ImageIcon size={14} /> }, scene: { word: "Scene", icon: <Layers size={14} /> },
  preset: { word: "Preset", icon: <Layers size={14} /> },
};
function linkWhere(t: LinkTarget): string {
  const what = (t.media && MEDIA[t.media]?.word) ?? "A file";
  return t.kind === "workshop" ? `${what} on the Steam Workshop` : t.kind === "site" ? `${what} on ${t.source}` : `${what} from ${t.source}`;
}
function LinkLine({ text, found, importing, failed }: {
  text: string; found: { target: LinkTarget | null; error: string | null } | null; importing: LinkTarget | null; failed: string | null;
}) {
  const motionOn = useMotion();
  const fadeOff = useFadeOff();
  const progress = useStore((s) => (importing ? s.downloads[importing.id] : undefined));
  const step = useStore((s) => (importing ? s.downloadStatus[importing.id] : undefined));
  const t = found?.target;
  const wsHint = useStore((s) => (t?.kind === "workshop" ? downloadHint(s.settings, s.steam) : null));
  const key = !found ? "checking" : t ? `found:${t.id}` : `error:${found.error}`;
  // always mounted, so the first line in (the field's first character) fades in like every later change
  return (
    <AnimatePresence mode="wait" initial={false}>
      {text && <motion.div key={key} className="imp-link-line" data-import-link-line={!found ? "checking" : t ? "found" : "error"}
        {...(motionOn ? { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: 0.14 } } : FADE)}>
        {!found && <p className="imp-scanning muted"><LoaderCircle size={14} className="side-sub-spin" /> Checking the link…</p>}
        {found && !t && <p className="imp-note" data-import-link-error>{found.error}</p>}
        {t && (
          <>
            <div className="imp-link-row">
              <span className="imp-gico" aria-hidden>{(t.media && MEDIA[t.media]?.icon) ?? <Link2 size={14} />}</span>
              <span className="imp-link-what">
                <span className="imp-title" data-import-link-title>{t.title}</span>
                <span className="imp-dir" data-import-link-where>{linkWhere(t)}</span>
              </span>
              {t.inLibrary && <span className="imp-have">In your library</span>}
            </div>
            {/* a Workshop item: which way its download goes in the chosen mode and sign-in, the Browse sidebar's line (the
                page when there's no usable sign-in under "Subscribe with Steam login"). Guard: probe-import import:link:workshop */}
            {wsHint && !t.inLibrary && <p className="imp-link-hint" data-import-link-hint>{wsHint}</p>}
            {/* the last import's failure: under the item, which stays so Import can try again */}
            <AnimatePresence initial={false}>
              {failed && !importing && (
                <motion.p key="failed" className="imp-note imp-link-failed" data-import-link-failed
                  {...fadeOff({ initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0 }, transition: { duration: 0.16 } })}>{failed}</motion.p>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {importing && (
                <motion.div key="dl" className="imp-link-dl" data-import-link-progress
                  {...fadeOff({ initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0 }, transition: { duration: 0.16 } })}>
                  <span className="imp-link-step">{shortDownloadStatus(step)}</span>
                  <div className={`dl-bar${progress! > 0 ? "" : " indet"}`}><div className="dl-fill" style={progress! > 0 ? { width: `${Math.round(progress! * 100)}%` } : undefined} /></div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </motion.div>}
    </AnimatePresence>
  );
}

// The found items by kind: a group's tick ticks all it can (mixed: some), each item's its own; the library's own and (with
// "Play scenes" off) the scenes are shown unticked and can't be ticked, each saying why. Steam's subscriptions come last, in
// a group of their own whose line says how they reach the library.
const STEAM = { kind: "steam", label: "From your Steam subscriptions", icon: <CloudCheck size={14} /> } as const;
function ScanList({ scan, ticked, tick }: { scan: ImportScan; ticked: ReadonlySet<string>; tick: (paths: string[], on: boolean) => void }) {
  const groups = useMemo(() => {
    const kinds: { kind: string; label: string; icon: React.ReactNode; items: FoundItem[] }[] =
      GROUPS.map((g) => ({ ...g, items: scan.items.filter((i) => i.kind === g.kind && !i.subscription) }));
    return [...kinds, { ...STEAM, items: scan.items.filter((i) => i.subscription) }].filter((g) => g.items.length);
  }, [scan]);
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
                {g.kind === "steam" && (
                  <p className="shint imp-gwhy" data-import-steam-why>{scan.autoImport
                    ? "In Steam's Workshop folder: Import new Workshop wallpapers brings these into your library by itself."
                    : "In Steam's Workshop folder: turn on Import new Workshop wallpapers in Settings to bring these in."}</p>
                )}
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
