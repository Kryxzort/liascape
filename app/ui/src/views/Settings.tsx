import { isValidElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  X, RotateCcw, SlidersHorizontal, Repeat, VolumeX, Cpu, Palette, AlertTriangle,
  Layers, MonitorSmartphone, Download, Keyboard, Library as LibraryIcon, Wrench, Sparkles, Gauge, Volume2,
  Film, ImagePlay, Image as ImageIcon, FolderSync,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore, SETTINGS_DEFAULTS } from "../store";
import { api, type FeatureHealth, type ClipQuality, type WatchedFolder } from "../api/client";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { Select } from "../components/Select";
import { Segmented } from "../components/Segmented";
import { CardPreview } from "../components/CardPreview";
import { OrderList, type OrderItem } from "../components/OrderList";
import { DEFAULT_NOT_HOVERED, DEFAULT_ON_HOVER, PREVIEW_KEYS, PREVIEW_PRESETS, presetOf, previewOrder, reach } from "../components/mediaAssets";
import { QUALITY_LABEL } from "../components/clipSource";
import { Combo } from "../components/Combo";
import { NumInput } from "../components/NumInput";
import { FolderFlap } from "../components/icons";
import { TransitionPicker, type TransitionValue } from "../components/TransitionPicker";
import { PlayTimeInput } from "../components/PlayTimeInput";
import { ROT_HINT } from "../components/rotHint";
import { WarnIcon } from "../components/FeatureWarn";
import { HealthCtx, healthWarnings } from "../components/featureHealth";
import { CopyButton } from "../components/CopyButton";
import { MuteButton } from "../components/MuteButton";
import { useMotion, useFadeOff } from "../components/motion";
import { importFolder } from "../components/importPick";
import { type Level, LEVEL_LABEL, LEVEL_OF_KEY, levelOf, rank } from "../settingsLevel";

// Electron preload (app/shell/preload.js) exposes native dialogs; null in a browser → text entry only.
const bridge = (window as unknown as { liascape?: { pickFolder?: () => Promise<string | null> } }).liascape;

// reads/writes go through the store's settings object (camelCase, mirrors AppSettings).
function useS() {
  const settings = useStore((s) => s.settings) ?? {};
  const setSetting = useStore((s) => s.setSetting);
  const g = <T,>(k: string, d: T): T => (settings[k] as T) ?? d;
  return { g, set: setSetting, settings };
}

// "Transition style": the row's hint says what the CHOSEN style does (one style at a time reads easier than all three).
// Guard: probe-settings hint:transition
const TRANSITION_STYLE: Record<string, string> = {
  reveal: "Reveal: the old one holds its last frame while the new one plays in, like Wallpaper Engine.",
  frozen: "Frozen: both hold still until it's done, the old one on its last frame and the new one on its first.",
  "full-live": "Full-live: both keep playing through it. The heaviest, noticeable at 4K.",
};

const fmtBytes = (b: number) => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB`
  : b >= 1 << 20 ? `${Math.round(b / (1 << 20))} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

// Settings → Housekeeping: the caches a user can clear, one line each (its words say what goes and what it costs to make
// again), its size and a tick, then "Clear selected". The ids and folders are the backend's (AppOps.CacheCategories); a
// line the backend doesn't list is left out. Every visit starts with the thumbnails ticked: the clips and measurements
// take a while to make again, so a remembered tick would quietly redo them on the next quick thumbnail clear.
// Guard: probe-settings cache:*
// API: /cache/size, /cache/clear {ids}
const CACHE_LINES: { id: string; label: string; hint: string }[] = [
  { id: "thumbs", label: "Card stills and GIF previews", hint: "the frames and trimmed GIFs the cards show. They're made again as cards come into view." },
  { id: "we-thumbs", label: "Workshop folder thumbnails", hint: "the Wallpaper Engine folder's pictures in Browse. They're made again on the next visit." },
  { id: "clips", label: "Video preview clips", hint: "the small clips the cards play. Making them again takes a while." },
  { id: "scene-loudness", label: "Scene sound measurements", hint: "each scene's sounds get measured again next time. The volumes already set stay." },
  { id: "media-art", label: "Album art", hint: "the cover art scenes show for what's playing. It's fetched again when needed." },
  { id: "shaders", label: "Scene shader cache", hint: "the shader work scenes save between loads. Each scene loads slower once while it's redone." },
  { id: "logs", label: "Logs", hint: "the app's debug logs, only needed when reporting a problem" },
];
const CACHE_DEFAULT_TICKS = ["thumbs", "we-thumbs"];
const SIZE_EASE_MS = 700;
const sizeText = (b: number) => (b > 0 ? fmtBytes(b) : "Empty");

// A cache's size. A new value replaces the old in place (`.xfade`: the old words roll out as the new roll in; motion off,
// they cross-fade); a size that shrank — after a clear — first counts down to its new value in the shown words.
// Guard: probe-settings cache:clear:*
type SizeFaces = { t: [string, string]; cur: -1 | 0 | 1; bytes: number | null };
// `text` into the hidden face, which then shows: the leaving one keeps its words while it fades
const swapIn = (f: SizeFaces, text: string, bytes: number | null): SizeFaces => {
  const n = f.cur === 0 ? 1 : 0;
  const t: [string, string] = [...f.t];
  t[n] = text;
  return { t, cur: n, bytes };
};
function EasedSize({ id, bytes }: { id: string; bytes: number | null }) {
  const on = useMotion();
  const active = useStore((s) => s.appActive);
  const [face, setFace] = useState<SizeFaces>({ t: ["", ""], cur: -1, bytes: null });
  const [count, setCount] = useState<{ from: number; to: number } | null>(null);
  if (bytes != null && bytes !== face.bytes) {
    const from = face.bytes;
    if (from == null || bytes > from || !on || !active) { setFace(swapIn(face, sizeText(bytes), bytes)); setCount(null); }
    else { setFace({ ...face, bytes }); setCount({ from, to: bytes }); }
  }
  useEffect(() => {
    if (!count) return;
    const shown = (text: string) => setFace((f) => {
      const i = f.cur;
      if (i < 0 || f.t[i as 0 | 1] === text) return f;
      const t: [string, string] = [...f.t];
      t[i as 0 | 1] = text;
      return { ...f, t };
    });
    // COOL: the number counts down (ease-out) to what's left; at nothing, "Empty" rolls in
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / SIZE_EASE_MS), e = 1 - (1 - k) ** 3;
      if (k < 1) { shown(fmtBytes(count.from + (count.to - count.from) * e)); raf = requestAnimationFrame(step); return; }
      if (count.to > 0) shown(fmtBytes(count.to));
      else setFace((f) => swapIn(f, "Empty", f.bytes));
      setCount(null);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [count]);
  return (
    <span className="xfade end cache-size" data-cache-size={id}>
      {face.t.map((t, i) => <span key={i} data-off={face.cur === i ? undefined : ""}>{t}</span>)}
    </span>
  );
}

function CachePicker() {
  const clearCache = useStore((s) => s.clearCache);
  const [sizes, setSizes] = useState<Record<string, number> | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(CACHE_DEFAULT_TICKS));
  // what the last clear freed: shown until the ticks change (its words stay while it fades out)
  const [freed, setFreed] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.cacheSize().then((r) => { if (alive) setSizes(Object.fromEntries(r.categories.map((c) => [c.id, c.bytes]))); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const lines = CACHE_LINES.filter((l) => sizes == null || l.id in sizes);
  const picked = lines.filter((l) => ticked.has(l.id)).map((l) => l.id);
  // nothing ticked, or every ticked cache already empty (or not read yet): nothing a click could free
  const canClear = !busy && sizes != null && picked.some((id) => (sizes[id] ?? 0) > 0);
  const tick = (id: string, on: boolean) => {
    setTicked((t) => { const n = new Set(t); if (on) n.add(id); else n.delete(id); return n; });
    setFreed((f) => ({ ...f, on: false }));
  };
  const clear = async () => {
    setBusy(true);
    const r = await clearCache(picked);
    setBusy(false);
    if (!r) return;
    setSizes((s) => ({ ...s, ...Object.fromEntries(r.categories.map((c) => [c.id, c.bytes])) }));
    setFreed({ text: r.freedBytes > 0 ? `Freed ${fmtBytes(r.freedBytes)}` : "Nothing to free", on: true });
  };
  return (
    <div className="cache-pick" data-cache-pick>
      <Row label="Clear cached files" hint="files the app can make again. Your settings and library are never touched.">{null}</Row>
      {lines.map((l) => (
        <label key={l.id} className="srow toggle cache-line" data-cache-line={l.id}>
          <div className="slabel">
            <span className="slabel-row">{l.label}</span>
            <span className="shint">{l.hint}</span>
          </div>
          <div className="sctl">
            <EasedSize id={l.id} bytes={sizes?.[l.id] ?? null} />
            <input type="checkbox" checked={ticked.has(l.id)} onChange={(e) => tick(l.id, e.target.checked)} />
          </div>
        </label>
      ))}
      <div className="cache-foot">
        <span className="cache-freed" data-cache-freed data-off={freed.on ? undefined : ""}>{freed.text}</span>
        <button className="btn ghost" data-cache-clear disabled={!canClear} onClick={clear}>Clear selected</button>
      </div>
    </div>
  );
}

// Settings → Housekeeping → "Clear crash marks": every item whose scene crashed the player (rotations skip it) playable again
// at once, through the backend's one loop (POST /library/clear-crash-all → AppOps.ClearAllCrashes: each mark as the sidebar's
// Clear lifts it, a rotation's skip flag and every page's copy following). The button names how many are marked; with none it
// is off and says "No crash marks". Its two faces share one cell (.xfade): the swap rolls, the button keeps its width, and a
// leaving face keeps the last count it showed. Guard: probe-settings crash:*
function CrashMarks() {
  const items = useStore((s) => s.libraryItems);
  const patchItem = useStore((s) => s.patchLibraryItem);
  const marked = useMemo(() => items.filter((i) => i.hasCrashed).map((i) => i.videoPath), [items]);
  const n = marked.length;
  const [shownN, setShownN] = useState(n);
  if (n > 0 && n !== shownN) setShownN(n); // follow during render: the "Clear" face rolls out with its last count
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    setBusy(true);
    for (const p of marked) patchItem(p, { hasCrashed: false });
    try { await api.libraryClearCrashAll(); }
    catch (e) {
      for (const p of marked) patchItem(p, { hasCrashed: true });
      useStore.getState().setError(`Couldn't clear the crash marks: ${(e as Error).message}`);
    }
    setBusy(false);
  };
  const none = n === 0;
  return (
    <Row label="Clear crash marks" hint="scenes that crashed the player, which rotations skip. Cleared, they play in rotations again.">
      <button className="btn ghost crash-clear-all" data-crash-clear-all data-crash-n={n} disabled={none || busy} onClick={clear}
        aria-label={none ? "No crash marks" : `Clear ${n} crash mark${n === 1 ? "" : "s"}`}>
        <span className="xfade">
          <span data-off={none ? "" : undefined} aria-hidden>Clear {shownN} mark{shownN === 1 ? "" : "s"}</span>
          <span data-off={none ? undefined : ""} aria-hidden>No crash marks</span>
        </span>
      </button>
    </Row>
  );
}

// Settings → Watched folders (AppSettings.WatchedFolders, backend-owned: edited through /library/watched, never by the settings
// save): a row per folder, its path, how many wallpapers it brought in, its own "Copy files instead of linking" (the
// Workshop folder's wording; it applies to what the folder imports from then on) and a remove that stops the watching (what it
// brought in stays). "Add folder" picks one and opens the import dialog with "Keep watching" ticked: the folder's wallpapers
// are shown before anything lands. Rows glide in and out (motion off: they fade). Guard: --probe probe-import.js import:settings*
const ROW_GLIDE = { duration: 0.2 };
// the card's height on the rows' own clock: framer's default tween curve (easeInOut) at ROW_GLIDE's duration
const CARD_GLIDE: KeyframeAnimationOptions = { duration: ROW_GLIDE.duration * 1000, easing: "cubic-bezier(0.42, 0, 0.58, 1)" };
function WatchedFolders() {
  const folders = useStore((s) => (s.settings?.watchedFolders as WatchedFolder[] | undefined) ?? []);
  const items = useStore((s) => s.libraryItems);
  const mergeSettings = useStore((s) => s.mergeSettings);
  const fadeOff = useFadeOff();
  const motionOn = useMotion();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (i.watchedFrom) m.set(i.watchedFrom, (m.get(i.watchedFrom) ?? 0) + 1);
    return m;
  }, [items]);
  // PERF: the rows and "Add folder" are framer layout nodes (they glide when the list changes) only while the section is on
  // screen. A layout node measures the page's scroll from script whenever it re-renders (forced layouts: Settings
  // re-renders as its reads land, right after the tab click), and unmounting one asks for an animation frame (the switch
  // away). Off screen there is no glide to see. The layout flag is read when framer makes a node, so the list and the
  // button remount when it flips (AnimatePresence initial={false}: nothing replays). `dep` is what moves them: a re-render
  // that keeps the same folders measures nothing. A remount would drop the keyboard focus (Tab into the section scrolls it
  // into view), so while the focus is inside the flag holds and catches up once it leaves. Guard: probe-layout perf:tabs,
  // probe-import import:settings, probe-settings watched:focus.
  const boxRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let onScreen = false, t = 0;
    const apply = () => { if (!el.contains(document.activeElement)) setSeen(onScreen); };
    const io = new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; apply(); });
    // the focus is still on the leaving element during focusout: look once it has moved
    const out = () => { clearTimeout(t); t = window.setTimeout(apply); };
    io.observe(el);
    el.addEventListener("focusout", out);
    return () => { io.disconnect(); el.removeEventListener("focusout", out); clearTimeout(t); };
  }, []);
  const layoutOn = motionOn && seen;
  const dep = folders.map((w) => w.path).join("\n");
  // COOL: a removed row leaves the flow as it starts to fade (AnimatePresence popLayout), so the rows below and "Add folder"
  // glide up into its place meanwhile: framer glides nothing once an exiting row unmounts (it isn't layout-dirty itself),
  // they would jump. All of them move on the rows' own timing. Motion off (or off screen) the row fades in place and the
  // rest then takes its place at once.
  // The card's own height glides from what was last drawn to its new height on the same clock, so its bottom edge keeps
  // pace with "Add folder" (never clipping it) and every section below slides with it instead of jumping. It is a Web
  // Animation on `height`, not a framer layout node: one would own the card's `transform` and fight `.ssection`'s hover
  // lift, and every other section would have to be one too to glide. The last drawn height comes from a ResizeObserver (no
  // layout read while nothing changes); the new one is read once, after the commit that changed the list.
  // PERF: a height animation lays the page out each frame, for 200 ms, only on a change to this list while it is on screen.
  // Guard: probe-import import:settings
  const drawnH = useRef(0), glide = useRef<Animation | null>(null), lastDep = useRef<string | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => { const b = es[es.length - 1].borderBoxSize?.[0]; if (b) drawnH.current = b.blockSize; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const was = lastDep.current;
    lastDep.current = dep;
    const el = boxRef.current, from = drawnH.current;
    if (was === null || was === dep || !layoutOn || !el || !from) return;
    glide.current?.cancel(); // its frame would be read as the new height
    const to = el.offsetHeight;
    if (Math.abs(to - from) > 0.5) glide.current = el.animate([{ height: `${from}px` }, { height: `${to}px` }], CARD_GLIDE);
  }, [dep, layoutOn]);
  // API: the backend broadcasts settings-changed {watchedFolders}; the page shows the edit at once
  const edit = (path: string, change: { copy?: boolean; remove?: boolean }) => {
    mergeSettings({ watchedFolders: change.remove ? folders.filter((w) => w.path !== path) : folders.map((w) => w.path === path ? { ...w, ...change } : w) });
    api.editWatched({ path, ...change }).catch(() => {});
  };
  return (
    <Section title="Watched folders" icon={<FolderSync size={15} />} bare boxRef={boxRef}>
      <Help>New or changed files in these folders come into your library by themselves, and removed ones leave it.</Help>
      <AnimatePresence key={`rows|${layoutOn}`} initial={false} mode={layoutOn ? "popLayout" : "sync"}>
        {folders.map((w) => {
          const c = counts.get(w.path) ?? 0;
          return (
            <motion.div key={w.path} className="srow watched-row" data-watched={w.path} layout={layoutOn ? "position" : false} layoutDependency={dep}
              {...fadeOff({ initial: { opacity: 0, y: -6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: ROW_GLIDE })}>
              <div className="slabel">
                <span className="slabel-row watched-path" title={w.path}>{w.path}</span>
                <span className="shint">{c === 1 ? "1 wallpaper" : `${c} wallpapers`}{w.skip.length ? `, ${w.skip.length} left out` : ""}</span>
              </div>
              <div className="sctl">
                <label className="inline watched-copy"><input type="checkbox" checked={w.copy} data-watched-copy
                  onChange={(e) => edit(w.path, { copy: e.target.checked })} /> Copy files instead of linking</label>
                <button className="mini ico" aria-label="Stop watching" title="Stop watching (its wallpapers stay)" data-watched-remove
                  onClick={() => edit(w.path, { remove: true })}><X size={14} /></button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
      <motion.button key={`add|${layoutOn}`} className="btn ghost ico watched-add" layout={layoutOn ? "position" : false} layoutDependency={dep} transition={ROW_GLIDE} data-watched-add
        onClick={() => { void importFolder(true); }}><FolderFlap size={14} /> Add folder</motion.button>
    </Section>
  );
}

// `rk` (+ optional `def`) ties a row to a settings key: a reset icon appears ONLY when the current
// value deviates from its default (SETTINGS_DEFAULTS), and resets that one setting. `onReset`/`deviated`
// cover non-settings-backed rows (e.g. Theme, applied via applyTheme not setSetting). `wk` = the key whose
// feature warnings (WarnIcon) the row shows, when it has no `rk`. `lv` = the Settings level the row shows from
// (default: its key's in LEVEL_OF_KEY, else Basic); above the current level it renders nothing (its value is untouched).
function Row({ label, hint, disabled, liveChip, rk, wk, def, deviated, deviatedTitle, onReset, lv, children }: {
  label: string; hint?: string; disabled?: boolean;
  // a disabled row that holds a mute chip dims its name and other controls but not the chip (the way back, index.css `.live-chip`)
  liveChip?: boolean;
  rk?: string; wk?: string; def?: unknown; deviated?: boolean; deviatedTitle?: string; onReset?: () => void; lv?: Level; children: React.ReactNode;
}) {
  const cur = useStore((s) => (rk ? s.settings?.[rk] : undefined));
  const set = useStore((s) => s.setSetting);
  const level = useStore((s) => levelOf(s.settings?.settingsLevel));
  const own = lv ?? (rk ? LEVEL_OF_KEY[rk] : undefined) ?? "basic";
  if (rank(own) > rank(level)) return null;
  const d = rk !== undefined ? (def ?? SETTINGS_DEFAULTS[rk]) : undefined;
  const show = onReset
    ? !!deviated
    : (rk !== undefined && cur !== undefined && JSON.stringify(cur) !== JSON.stringify(d));
  const reset = onReset ?? (() => { if (rk !== undefined) set(rk, d); });
  const tag = own === "advanced" || own === "expert";
  // a row whose ONLY control is a checkbox / radio is a <label>: a click anywhere on it (the name, the hint, the space
  // between) ticks it, like the filter column's names. The reset button inside still only resets (a click on
  // interactive content never activates a label). Rows with sliders, fields, selects or buttons stay plain.
  const toggle = isValidElement<{ type?: string }>(children) && children.type === "input" && (children.props.type === "checkbox" || children.props.type === "radio");
  const Tag = toggle ? "label" : "div";
  return (
    <Tag className={`srow${disabled ? " disabled" : ""}${liveChip ? " live-chip" : ""}${toggle ? " toggle" : ""}`} data-level={own} data-expert={own === "expert" ? "" : undefined}
      data-row-toggle={toggle ? "" : undefined}>
      <div className="slabel">
        <span className="slabel-row">{label}
          {tag && <span className="s-expert" data-expert-tag>{LEVEL_LABEL[own]}</span>}
          <WarnIcon k={wk ?? rk} />
          {show &&<button className="s-reset" title={(deviated && onReset && deviatedTitle) || "Reset to default"} data-deviated={deviated ? "" : undefined} onClick={reset}><RotateCcw size={12} /></button>}
        </span>
        {hint && <span className="shint">{hint}</span>}
      </div>
      <div className="sctl">{children}</div>
    </Tag>
  );
}
// a whole section can sit at a level too (`lv`); a section's rows still filter themselves, and a section none of whose
// rows the level shows hides with them (index.css `.ssection[data-rows]`), so no heading ever stands alone. `bare` = a
// section whose content isn't rows (the monitor list's add button): it always shows.
// Guard: probe-settings levels:noEmptySection.
function Section({ title, icon, lv, bare, boxRef, children }: {
  title: string; icon?: React.ReactNode; lv?: Level; bare?: boolean; boxRef?: React.Ref<HTMLDivElement>; children: React.ReactNode;
}) {
  const level = useStore((s) => levelOf(s.settings?.settingsLevel));
  if (lv && rank(lv) > rank(level)) return null;
  return (
    <div ref={boxRef} className="ssection" data-rows={bare ? undefined : ""}>
      <h3>{icon && <span className="ssection-ico">{icon}</span>}{title}</h3>
      {children}
    </div>
  );
}
// settings changed from their defaults whose rows the current level hides (they keep working) — the note at the top. The
// preview orders are tucked away only when no preset names them: a preset shows on Basic's "Card previews".
const hiddenChanged = (settings: Record<string, unknown>, level: Level) =>
  Object.entries(LEVEL_OF_KEY).filter(([k, lv]) => rank(lv) > rank(level)
    && settings[k] !== undefined && JSON.stringify(settings[k]) !== JSON.stringify(SETTINGS_DEFAULTS[k])
    && !(PREVIEW_KEYS.includes(k) && presetOf(settings))).map(([k, lv]) => ({ k, lv }));

// Look & feel → what a card shows hovered and not (components/mediaAssets.ts): Basic picks a named pair ("Card previews"),
// Advanced and up also order each list. The preset reads "Custom" when the lists match none. Guard: probe-cardpreview
// cardpv:preset, cardpv:order.
const THUMB_ITEMS: OrderItem[] = [
  { id: "video", label: "Video", icon: <Film size={14} /> },
  { id: "gif", label: "GIF", icon: <ImagePlay size={14} /> },
  { id: "image", label: "Still image", icon: <ImageIcon size={14} /> },
];
function CardPreviewRows({ level }: { level: Level }) {
  const { settings, set } = useS();
  const hover = previewOrder(settings.previewOnHover, DEFAULT_ON_HOVER), idle = previewOrder(settings.previewNotHovered, DEFAULT_NOT_HOVERED);
  const preset = presetOf(settings);
  const isDefault = reach(hover).join() === reach(DEFAULT_ON_HOVER).join() && reach(idle).join() === reach(DEFAULT_NOT_HOVERED).join();
  const pick = (v: string) => { const p = PREVIEW_PRESETS.find((x) => x.value === v); if (p) { set("previewOnHover", p.hover); set("previewNotHovered", p.idle); } };
  const custom = rank(level) < rank(LEVEL_OF_KEY.previewOnHover) ? `your own order, set at the ${LEVEL_LABEL[LEVEL_OF_KEY.previewOnHover]} level.` : "your own order, set in the two lists below.";
  return (
    <>
      {/* ffmpeg makes the clips "Not hovered" plays: its warning shows here too, where Basic sees it */}
      <Row label="Card previews" hint={preset?.hint ?? custom} wk="previewNotHovered" lv="basic" deviated={!isDefault}
        onReset={() => pick("hover")}>
        <Select value={preset?.value ?? "custom"} onChange={pick}
          options={[...PREVIEW_PRESETS.map((p) => ({ value: p.value, label: p.label })), ...(preset ? [] : [{ value: "custom", label: "Custom" }])]} />
      </Row>
      <Row label="On hover" hint="a hovered card shows the first of these it has. Every card has a still image, so nothing below it shows." rk="previewOnHover">
        <OrderList label="On hover" items={THUMB_ITEMS} order={hover} endAt="image" onChange={(o) => set("previewOnHover", o)} />
      </Row>
      <Row label="Not hovered" hint="every other card on screen shows the first of these it has. Nothing below the still image shows." rk="previewNotHovered">
        <OrderList label="Not hovered" items={THUMB_ITEMS} order={idle} endAt="image" onChange={(o) => set("previewNotHovered", o)} />
      </Row>
    </>
  );
}
const Help = ({ children }: { children: React.ReactNode }) => <p className="help">{children}</p>;

// COOL: the global Volume/Speed sliders drag-preview LIVE like the per-wallpaper modal's: a throttled
// (~90 ms, trailing) `/preview {global:true}` moves every playing wallpaper that follows the global (the
// backend leaves one with its own override alone — override ?? global); the store's debounced
// /settings save (250 ms after the last tick) persists. API: /preview global.
function useGlobalPreview() {
  const r = useRef<{ vol: number | null; spd: number | null; last: number; tm: number | null }>({ vol: null, spd: null, last: 0, tm: null });
  useEffect(() => () => { if (r.current.tm != null) clearTimeout(r.current.tm); }, []);
  return useCallback((patch: { volume?: number; speed?: number }) => {
    const s = r.current;
    if (patch.volume != null) s.vol = patch.volume;
    if (patch.speed != null) s.spd = patch.speed;
    const flush = () => {
      const body: { volume?: number; speed?: number; global: true } = { global: true };
      if (s.vol != null) { body.volume = s.vol; s.vol = null; }
      if (s.spd != null) { body.speed = s.spd; s.spd = null; }
      s.last = Date.now(); s.tm = null;
      if (body.volume != null || body.speed != null) api.preview(body).catch(() => {});
    };
    const dt = Date.now() - s.last;
    if (dt >= 90) flush();
    else if (s.tm == null) s.tm = window.setTimeout(flush, 90 - dt);
  }, []);
}

export const Settings = memo(function Settings() {
  const { g, set } = useS();
  const previewGlobal = useGlobalPreview();
  const clearLibrary = useStore((s) => s.clearLibrary);
  const steam = useStore((s) => s.steam);
  const startQr = useStore((s) => s.startQr);
  const signoutSteam = useStore((s) => s.signoutSteam);
  const openPwLogin = useStore((s) => s.openPwLogin);
  const resetAllSettings = useStore((s) => s.resetAllSettings);
  const themes = useStore((s) => s.themes);
  const themeName = useStore((s) => s.theme?.name ?? "");
  const applyTheme = useStore((s) => s.applyTheme);
  const scrollRef = useRef<HTMLDivElement>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  // the Look & feel rows that change how a library card looks: the card preview shows beside them while they're on screen
  const cardRowsRef = useRef<HTMLDivElement>(null);
  const [clearArm, setClearArm] = useState(-1); // -1 idle, >0 counting, 0 ready-to-confirm
  const [wipeArm, setWipeArm] = useState(-1);   // same arming pattern for "Clear settings"
  // auto-detected outputs (hyprctl/sway): name + current refresh rate + which is focused/primary
  const [detected, setDetected] = useState<{ name: string; refreshHz: number; primary: boolean }[]>([]);
  // liascape-player's status (binary found? last start error? scenes, low VRAM)
  const [player, setPlayer] = useState<{ available: boolean; reason: string | null;
    scenes?: { available: boolean; reason: string | null; assets_dir: string | null };
    vram?: { low_active: boolean | null; mode: string } | null } | null>(null);

  useEffect(() => {
    if (clearArm <= 0) return;
    const t = setTimeout(() => setClearArm((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [clearArm]);
  useEffect(() => {
    if (wipeArm <= 0) return;
    const t = setTimeout(() => setWipeArm((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [wipeArm]);
  // Monitor auto-detection feeds a datalist so the name fields autocomplete real outputs
  // instead of pure free-text guessing.
  useEffect(() => { api.monitors().then(setDetected).catch(() => {}); }, []);
  // read at once on mount, then again after a scene-support change (the backend may report a start failure).
  // Unreachable → not available, with the reason.
  useEffect(() => {
    const t = setTimeout(() => api.playerStatus().then(setPlayer)
      .catch(() => setPlayer({ available: false, reason: "couldn't read the player's status from the backend" })),
      player === null ? 0 : 600);
    return () => clearTimeout(t);
  }, [g("allowScenes", false)]); // eslint-disable-line
  // the low-VRAM status (GPU & memory section) follows the player while Settings is open
  useEffect(() => {
    const t = setInterval(() => api.playerStatus().then(setPlayer).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);
  // missing build pieces / tools (API: /health/features) → warning icons on the rows they break + the summary;
  // re-read after a change that can move them (scenes) and every 15 s while open (a player that
  // started meanwhile reports its GPU interop / VRAM probe)
  const [features, setFeatures] = useState<FeatureHealth[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => api.featureHealth().then((r) => alive && setFeatures(r.features ?? [])).catch(() => {});
    const t0 = setTimeout(read, 300), t = setInterval(read, 15000);
    return () => { alive = false; clearTimeout(t0); clearInterval(t); };
  }, [g("allowScenes", false)]); // eslint-disable-line
  const warnings = useMemo(() => healthWarnings(features), [features]);
  // the summary: what breaks something switched on / selected now (the row icons show regardless)
  const broken = features.filter((f) => f.ok === false && f.inUse !== false);

  // the rotation: "Switch when video ends" off → the interval is "Switch every" (a plain timer); on → the SAME field
  // is "Minimum play time", with "Maximum play time" right below, then "Separate timing for scenes" (+ "Switch scenes
  // after" while it's on) — player-adapter.md § Rotation. The minimum and maximum: 0 = off; the maximum is never under
  // the minimum (the store raises it as the minimum passes it); "Switch scenes and pictures after" is never 0.
  const aoe = g("globalSwitchWhenVideoEnds", true);
  const sepScenes = g("globalSeparateSceneTiming", true);

  const settingsAll = useStore((s) => s.settings) ?? {};
  const level = levelOf(settingsAll.settingsLevel);
  const hidden = hiddenChanged(settingsAll, level);
  // a playlist is playing now → the start-mode hint says a change waits for its next start
  const playlistPlaying = useStore((s) => s.playlist.length > 1 && !!s.playingPath && s.playlist.includes(s.playingPath));
  const plStart = g<string>("globalPlaylistStart", "start_over");
  type Mon = { name: string; fps: number };
  // Wallpaper Engine's own default FPS limit (its exe writes 15 when unset; the first-run preset is
  // "medium" = 15). Like WE's, the scene runs at this rate even above the monitor's refresh.
  const WE_DEFAULT_FPS = 15;
  const monitors = g<Mon[]>("sceneMonitors", []);
  const setMonitors = (m: Mon[]) => set("sceneMonitors", m);
  // Auto-populate the scene monitor list from detected outputs the first time scenes are enabled
  // (empty list). Won't clobber a list the user already configured.
  useEffect(() => {
    if (!g("allowScenes", false) || !detected.length || monitors.length) return;
    setMonitors(detected.map((d) => ({ name: d.name, fps: WE_DEFAULT_FPS })));
  }, [detected, g("allowScenes", false)]); // eslint-disable-line

  const mode = g<string>("workshopDownloadMode", "subscribe");
  const mute = g("noAudio", false);          // disables the volume row (parity: muted = no volume)
  const am = g("autoMute", false);           // gates the auto-mute children

  // (live wallpaper bg is now rendered at App level via <WallpaperBg> — Settings always shows it, and
  // the "Live wallpaper behind all tabs" advanced toggle extends it to Browse/Library)
  const pickInto = async (key: string) => {
    const p = await bridge?.pickFolder?.();
    if (p) set(key, p);
  };

  const actions = ["toggle-mute", "toggle-pause", "stop", "play", "toggle-play",
    "next", "previous", "random", "volume-up", "volume-down", "toggle-loop-current"];

  // Global transition config (the fallback used when a playlist doesn't override). The picker speaks
  // the per-playlist field names, so adapt to/from the global* keys.
  const [trPicker, setTrPicker] = useState(false);
  const trVal: TransitionValue = {
    transitionEnabled: g("globalTransitionEnabled", false),
    transitionEffectIds: g<string[]>("globalTransitionEffectIds", []),
    transitionDurationMs: g("globalTransitionDurationMs", 600),
    transitionDurationMaxMs: g("globalTransitionDurationMaxMs", 0),
    transitionShuffle: g("globalTransitionShuffle", true),
  };
  const trChange = (p: Partial<TransitionValue>) => {
    for (const [k, v] of Object.entries(p)) set("global" + k[0].toUpperCase() + k.slice(1), v as never);
  };

  return (
    <HealthCtx.Provider value={warnings}>
    <div className="scroll settings" ref={smoothRef}>
      {broken.length > 0 && (
        <div className="health-sum" data-health-summary>
          <div className="health-sum-head"><AlertTriangle size={14} />
            {broken.length === 1 ? "1 feature can't work here" : `${broken.length} features can't work here`} — missing from this build or system</div>
          <ul>{broken.map((f) => <li key={f.id} data-feature={f.id}><b>{f.label}:</b> {f.reason}</li>)}</ul>
        </div>
      )}
      {hidden.length > 0 && (
        <div className="help hidden-changed" data-hidden-changed={hidden.length}>
          {hidden.length === 1 ? "1 setting you changed is" : `${hidden.length} settings you changed are`} tucked away at a higher level — still working.{" "}
          <button className="mini" data-hidden-show onClick={() => set("settingsLevel", hidden.reduce<Level>((m, h) => rank(h.lv) > rank(m) ? h.lv : m, level))}>Show</button>
        </div>
      )}

      <Section title="Sound" icon={<Volume2 size={15} />}>
        {/* the mute chip is the way back from muted: the row dims around it (`liveChip`), and it follows the Volume row's level */}
        {/* the reset puts the sound back as well as the level: one click from muted or any level to sound at 100 %, so
            it shows while either is off */}
        <Row label="Volume" hint={mute ? "muted" : `${g("volume", 100)}%`} disabled={mute} liveChip rk="volume"
          deviated={mute || g("volume", 100) !== SETTINGS_DEFAULTS.volume}
          onReset={() => { set("volume", SETTINGS_DEFAULTS.volume); set("noAudio", false); }}>
          <input type="range" min={0} max={100} value={g("volume", 100)} disabled={mute} onChange={(e) => { set("volume", +e.target.value); previewGlobal({ volume: +e.target.value }); }} />
          <MuteButton muted={mute} what="wallpapers" data-wall-mute onToggle={() => set("noAudio", !mute)} /></Row>
        <Row label="Audio normalization" hint="keeps wallpapers at about the same loudness" disabled={mute} rk="normalizeAudio">
          <input type="checkbox" checked={g("normalizeAudio", false)} disabled={mute} onChange={(e) => set("normalizeAudio", e.target.checked)} /></Row>
        {!mute && g("normalizeAudio", false) && <Row label="Loudness target" hint="how loud to even the audio out. −14 is the standard, lower is quieter." rk="normalizeTargetLufs">
          <Combo value={g("normalizeTargetLufs", -14) as number} min={-70} max={0} step={1}
            onChange={(v) => set("normalizeTargetLufs", v)}
            options={[{ value: -11, label: "Loud (−11)" }, { value: -14, label: "Streaming (−14)" }, { value: -19, label: "Quiet (−19)" }, { value: -23, label: "Broadcast (−23)" }]} /><span>LUFS</span></Row>}
      </Section>

      <Section title="Auto-mute" icon={<VolumeX size={15} />}>
        <Row label="Mute when other apps play audio" rk="autoMute"><input type="checkbox" checked={am} onChange={(e) => set("autoMute", e.target.checked)} /></Row>
        <Row label="Only mute for media players" hint="only ones that support MPRIS (Spotify, Strawberry, browsers, VLC…)" disabled={!am} rk="autoMuteOnlyIfMprisActive"><input type="checkbox" disabled={!am} checked={g("autoMuteOnlyIfMprisActive", false)} onChange={(e) => set("autoMuteOnlyIfMprisActive", e.target.checked)} /></Row>
        <Row label="Fade out after (ms)" hint="how long other audio has to play before the wallpaper goes quiet" disabled={!am} rk="autoMuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoMuteDelayMs", 500)} onChange={(v) => set("autoMuteDelayMs", v)} /></Row>
        <Row label="Come back after (ms)" hint="how long things must stay quiet before the wallpaper's sound returns" disabled={!am} rk="autoUnmuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoUnmuteDelayMs", 2000)} onChange={(v) => set("autoUnmuteDelayMs", v)} /></Row>
        <Row label="Ignore sounds below (dB)" disabled={!am} rk="autoMuteMinLevelDb"><NumInput disabled={!am} min={-80} max={0} value={g("autoMuteMinLevelDb", -70)} onChange={(v) => set("autoMuteMinLevelDb", v)} /></Row>
      </Section>

      <Section title="Playback" icon={<SlidersHorizontal size={15} />}>
        <Row label="Pause behind windows" hint={ROT_HINT.cover} rk="pauseWhenCovered">
          <Select value={g("pauseWhenCovered", "maximized")} onChange={(v) => set("pauseWhenCovered", v)}
            options={[{ value: "off", label: "Off" }, { value: "fullscreen", label: "A fullscreen window" }, { value: "maximized", label: "A fullscreen or maximized window" }]} /></Row>
        <Row label="Playback speed" hint={`${g("speed", 1)}×`} rk="speed"><input type="range" min={0.1} max={4} step={0.1} value={g("speed", 1)} onChange={(e) => { set("speed", +e.target.value); previewGlobal({ speed: +e.target.value }); }} /></Row>
        <Row label="Stay paused when switching" hint="by default, a paused wallpaper unpauses when you switch with a keybind or command. This keeps it paused: the transition still plays, and the next wallpaper waits, paused, on its first frame." rk="stayPausedWhenSwitching">
          <input type="checkbox" checked={g("stayPausedWhenSwitching", false)} onChange={(e) => set("stayPausedWhenSwitching", e.target.checked)} /></Row>
        <Row label="Disable video cache" hint="reads videos straight from disk instead of buffering ahead" rk="disableCache"><input type="checkbox" checked={g("disableCache", false)} onChange={(e) => set("disableCache", e.target.checked)} /></Row>
      </Section>

      <Section title="Playlist & rotation" icon={<Repeat size={15} />}>
        <Row label="Switch when video ends" rk="globalSwitchWhenVideoEnds"><input type="checkbox" checked={aoe} onChange={(e) => set("globalSwitchWhenVideoEnds", e.target.checked)} /></Row>
        {aoe ? <>
          <Row label="Minimum play time" hint={ROT_HINT.min + (sepScenes ? "" : ROT_HINT.minScenes)} rk="globalIntervalSeconds">
            <PlayTimeInput label="Minimum play time" zeroText="off" value={g("globalIntervalSeconds", 0)} onChange={(v) => set("globalIntervalSeconds", v)} /></Row>
          <Row label="Maximum play time" hint={ROT_HINT.max + (sepScenes ? "" : ROT_HINT.maxScenes)} rk="globalMaxPlaySeconds">
            <PlayTimeInput label="Maximum play time" zeroText="off" min={g("globalIntervalSeconds", 0)} orZero value={g("globalMaxPlaySeconds", 0)} onChange={(v) => set("globalMaxPlaySeconds", v)} /></Row>
          <Row label="Separate timing for scenes and pictures" rk="globalSeparateSceneTiming">
            <input type="checkbox" checked={sepScenes} onChange={(e) => set("globalSeparateSceneTiming", e.target.checked)} /></Row>
          {sepScenes && <Row label="Switch scenes and pictures after" rk="globalSwitchScenesAfterSeconds">
            <PlayTimeInput label="Switch scenes and pictures after" min={1} value={g("globalSwitchScenesAfterSeconds", 1800)} onChange={(v) => set("globalSwitchScenesAfterSeconds", v)} /></Row>}
        </> : <Row label="Switch every" hint={ROT_HINT.every} rk="globalIntervalSeconds">
          <PlayTimeInput label="Switch every" value={g("globalIntervalSeconds", 0)} onChange={(v) => set("globalIntervalSeconds", v)} /></Row>}
        <Row label="Transitions" rk="globalTransitionEnabled">
          <button className="btn ghost ico" onClick={() => setTrPicker(true)}><Sparkles size={14} />
            {trVal.transitionEnabled ? `On · ${trVal.transitionEffectIds.length}` : "Off"}</button>
        </Row>
        <Row label="When the playlist starts again" hint={(plStart === "resume" ? ROT_HINT.startResume : ROT_HINT.startOver) + (playlistPlaying ? `. ${ROT_HINT.startLive}` : "")} rk="globalPlaylistStart">
          <Select value={plStart} onChange={(v) => set("globalPlaylistStart", v)}
            options={[{ value: "start_over", label: "Start over" }, { value: "resume", label: "Resume where it left off" }]} /></Row>
        <Row label="Add new wallpapers to the playlist" hint="anything you add to the library joins the playlist too" rk="autoAddLibraryToPlaylist"><input type="checkbox" checked={g("autoAddLibraryToPlaylist", false)} onChange={(e) => set("autoAddLibraryToPlaylist", e.target.checked)} /></Row>
        <Row label="When no monitor shows the wallpaper" hint={ROT_HINT.parked} rk="rotateWhileParked">
          <Select value={g("rotateWhileParked", true) ? "rotate" : "hold"} onChange={(v) => set("rotateWhileParked", v === "rotate")}
            options={[{ value: "rotate", label: "Keep rotating" }, { value: "hold", label: "Hold until a monitor returns" }]} /></Row>
      </Section>
      <TransitionPicker open={trPicker} value={trVal} onChange={trChange} onClose={() => setTrPicker(false)} title="Global Transitions" />

      <Section title="Video" icon={<Cpu size={15} />}>
        <Row label="Fit to screen" hint="Fill covers the whole screen and trims the edges if the shape differs. Fit shows the whole video, with bars if it differs." rk="videoScale">
          <Select value={g("videoScale", "fill")} onChange={(v) => set("videoScale", v)}
            options={[{ value: "fill", label: "Fill" }, { value: "fit", label: "Fit" }]} />
        </Row>
        <Row label="Video frame rate cap" hint="0 means no cap. Scenes have their own cap per monitor." rk="videoFpsCap"><NumInput min={0} max={480} value={g("videoFpsCap", 0)} onChange={(v) => set("videoFpsCap", v)} /></Row>
        <Row label="Hardware decoding" hint="lets the GPU decode video. Auto picks what works." rk="hwDec">
          <Select value={g("hwDec", "auto")} onChange={(v) => set("hwDec", v)}
            options={["auto", "nvdec", "vaapi", "no"].map((x) => ({ value: x, label: x }))} />
        </Row>
        <Row label="Read-ahead buffer (MiB)" hint="how much video is buffered ahead of what plays" rk="demuxerMaxMib"><NumInput min={1} max={10000} value={g("demuxerMaxMib", 20)} onChange={(v) => set("demuxerMaxMib", v)} /></Row>
        <Row label="Look-back buffer (MiB)" hint="how much already-played video is kept for seeking back" rk="demuxerMaxBackMib"><NumInput min={1} max={10000} value={g("demuxerMaxBackMib", 5)} onChange={(v) => set("demuxerMaxBackMib", v)} /></Row>
      </Section>

      {/* the player owns the GPU budget and both VRAM rules; every row applies live
          (API: /settings → player.scene_throttle / scene_vram_limit_mib / scene_vram_stop_shows / vram_low_mode / scene_spare) */}
      <Section title="GPU & memory" icon={<Gauge size={15} />} lv="standard">
        <Row label="Ease off heavy scenes" hint="if a scene makes your GPU stutter, it runs at a lower frame rate until things calm down. Off, every scene keeps its set frame rate." rk="autoThrottleScenes">
          <input type="checkbox" checked={g("autoThrottleScenes", true)} onChange={(e) => set("autoThrottleScenes", e.target.checked)} /></Row>
        <Row label="When video memory runs low" hint="when a game grabs the GPU's memory. Stop frees the wallpaper's memory and shows its last frame, Pause only pauses. Both pick up again once there's room." rk="vramLowMode">
          <Select value={g("vramLowMode", "stop")} onChange={(v) => set("vramLowMode", v)}
            options={[{ value: "stop", label: "Stop (free memory)" }, { value: "pause", label: "Pause" }, { value: "off", label: "Off" }]} /></Row>
        <Row label="Cap each scene's video memory" hint="stops a scene that uses more video memory than the cap. A playlist moves on. It doesn't count as a crash." rk="limitVramPerScene">
          <input type="checkbox" checked={g("limitVramPerScene", false)} onChange={(e) => set("limitVramPerScene", e.target.checked)} /></Row>
        {g("limitVramPerScene", false) && <Row label="Video memory cap (MiB)" hint="per scene" rk="sceneVramLimitMib">
          <NumInput min={64} max={1048576} step={64} value={g("sceneVramLimitMib", 2048)} onChange={(v) => set("sceneVramLimitMib", v)} /><span>MiB</span></Row>}
        {g("limitVramPerScene", false) && <Row label="Stopped scene shows" hint="Last frame: its picture stays, still. Nothing: the screen goes black." rk="sceneVramStopShows">
          <Segmented<string> label="Stopped scene shows" value={g<string>("sceneVramStopShows", "last_frame")} onChange={(v) => set("sceneVramStopShows", v)}
            options={[{ value: "last_frame", label: "Last frame" }, { value: "nothing", label: "Nothing" }]} /></Row>}
        <Row label="Keep a scene renderer ready" hint="while you play scenes, one renderer starts ahead and waits, so the next scene appears about a tenth of a second sooner. It holds about 60 MB of memory while it waits." rk="sceneSpareWorker">
          <input type="checkbox" checked={g("sceneSpareWorker", true)} onChange={(e) => set("sceneSpareWorker", e.target.checked)} /></Row>
        {player?.vram?.low_active && <Help>Video memory is low right now — the wallpaper is {player.vram.mode === "stop" ? "stopped (its memory freed)" : "paused"} until it frees up.</Help>}
      </Section>

      <CardPreview scrollRef={scrollRef} rowsRef={cardRowsRef}>
      <Section title="Look & feel" icon={<Palette size={15} />}>
        <Row label="Theme" onReset={() => applyTheme(SETTINGS_DEFAULTS.theme as string)} deviated={themeName !== SETTINGS_DEFAULTS.theme}>
          <Select value={themeName} onChange={(v) => applyTheme(v)}
            options={themes.map((t) => ({ value: t.name, label: t.name }))} />
        </Row>
        <div className="pv-rows" ref={cardRowsRef}>
        <Row label="Card size" rk="cardSize">
          <Select value={g("cardSize", "Medium")} onChange={(v) => set("cardSize", v)}
            options={["Small", "Medium", "Large"].map((x) => ({ value: x, label: x }))} />
        </Row>
        <Row label="Thumbnail shape" rk="thumbnailAspect">
          <Select value={g("thumbnailAspect", "1:1")} onChange={(v) => set("thumbnailAspect", v)}
            options={[{ value: "1:1", label: "Square (1:1)" }, { value: "16:9", label: "Widescreen (16:9)" }]} />
        </Row>
        <Row label="Glow effects" hint="the soft accent glow on hovered, active and playing things" rk="glows"><input type="checkbox" checked={g("glows", true)} onChange={(e) => set("glows", e.target.checked)} /></Row>
        <Row label="Text shadow" hint="a drop shadow on text, so it stays easy to read on busy backgrounds" rk="textShadow"><input type="checkbox" checked={g("textShadow", false)} onChange={(e) => set("textShadow", e.target.checked)} /></Row>
        <Row label="Smooth window animations" hint="the slides, zooms and morphs all over the app. Off, nothing moves and things fade in and out instead." rk="morphs"><input type="checkbox" checked={g("morphs", true)} onChange={(e) => set("morphs", e.target.checked)} /></Row>
        <CardPreviewRows level={level} />
        <Row label="Video preview quality" hint="scales with card size. Higher quality gives sharper, smoother clips but uses more storage and processing." rk="videoPreviewQuality">
          <Segmented<ClipQuality> label="Video preview quality" value={g<ClipQuality>("videoPreviewQuality", "mid")} onChange={(v) => set("videoPreviewQuality", v)}
            options={(["low", "mid", "high"] as const).map((v) => ({ value: v, label: QUALITY_LABEL[v] }))} /></Row>
        <Row label="Play GIF previews as videos" hint="smaller, pauses with the window. Made once per GIF." rk="gifPreviewsAsVideo">
          <input type="checkbox" checked={g("gifPreviewsAsVideo", false)} onChange={(e) => set("gifPreviewsAsVideo", e.target.checked)} /></Row>
        </div>
        <Row label="Wallpaper behind every tab" hint="shows the live wallpaper behind Browse and Library too" rk="liveWallpaperBehindAllTabs"><input type="checkbox" checked={g("liveWallpaperBehindAllTabs", false)} onChange={(e) => set("liveWallpaperBehindAllTabs", e.target.checked)} /></Row>
      </Section>
      </CardPreview>

      <Section title="Wallpaper Engine" icon={<Layers size={15} />}>
        <Row label="Workshop folder" hint="where Steam keeps your Wallpaper Engine downloads">
          <input className="text" value={g("workshopFolder", "")} onChange={(e) => set("workshopFolder", e.target.value)} />
          <button className="btn ghost ico" onClick={() => pickInto("workshopFolder")}><FolderFlap size={14} /> Browse</button>
        </Row>
        <Row label="Play scenes" hint="Wallpaper Engine's interactive scene wallpapers. They need Wallpaper Engine installed for its assets." rk="allowScenes"><input type="checkbox" checked={g("allowScenes", false)} onChange={(e) => set("allowScenes", e.target.checked)} /></Row>
        <Row label="Import new Workshop wallpapers" hint="anything new in the Workshop folder lands in your library by itself" rk="autoAddWeWallpapersToLibrary"><input type="checkbox" checked={g("autoAddWeWallpapersToLibrary", true)} onChange={(e) => set("autoAddWeWallpapersToLibrary", e.target.checked)} /></Row>
        <Row label="Copy files instead of linking" hint="copies Workshop files into the library instead of linking to them (uses more disk)" rk="copyFilesInsteadOfSymlinking"><input type="checkbox" checked={g("copyFilesInsteadOfSymlinking", false)} onChange={(e) => set("copyFilesInsteadOfSymlinking", e.target.checked)} /></Row>
        <Row label="Replace direct downloads with Workshop copies" hint="when a wallpaper you downloaded directly shows up in the Workshop folder, it switches to that one and frees the duplicate's disk space" rk="replaceDirectWithWorkshop"><input type="checkbox" checked={g("replaceDirectWithWorkshop", false)} onChange={(e) => set("replaceDirectWithWorkshop", e.target.checked)} /></Row>
        {g("allowScenes", false) && player?.scenes && !player.scenes.available && player.scenes.reason &&
          <Help>Scenes can't play right now: {player.scenes.reason}</Help>}
      </Section>

      <WatchedFolders />

      {g("allowScenes", false) && (
        <Section title="Scene monitors" icon={<MonitorSmartphone size={15} />} lv="standard" bare>
          <Help>The monitors scenes play on, each with its frame rate limit.{detected.length > 0
            ? <> Found: {detected.map((d) => <code key={d.name} className="kb">{d.name} {d.refreshHz}Hz{d.primary ? " ★" : ""}</code>)}. Type or pick below.</>
            : <> None found automatically. On Hyprland, <code className="kb">hyprctl monitors</code> lists their names.</>}</Help>
          <datalist id="liascape-monitors">{detected.map((d) => <option key={d.name} value={d.name} />)}</datalist>
          {monitors.map((m, i) => (
            <Row key={i} label={`Monitor ${i + 1}`} lv="standard">
              <div className="hms">
                <input className="text mon-name" list="liascape-monitors" placeholder="e.g. DP-1" value={m.name}
                  onChange={(e) => setMonitors(monitors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <NumInput min={1} max={480} value={m.fps}
                  onChange={(v) => setMonitors(monitors.map((x, j) => j === i ? { ...x, fps: v } : x))} /><span>fps</span>
                <button className="mini ico" aria-label="Remove monitor" onClick={() => setMonitors(monitors.filter((_, j) => j !== i))}><X size={14} /></button>
              </div>
            </Row>
          ))}
          <button className="btn ghost" onClick={() => {
            const used = new Set(monitors.map((m) => m.name));
            const next = detected.find((d) => !used.has(d.name));
            setMonitors([...monitors, { name: next?.name ?? `DP-${monitors.length + 1}`, fps: WE_DEFAULT_FPS }]);
          }}>+ Add monitor</button>
        </Section>
      )}

      <Section title="Getting Workshop wallpapers" icon={<Download size={15} />}>
        {/* three ways, one radio group (docs/decisions.md § "Offer three Workshop download modes, the user's choice") — each
            route its own radio, never a switch inside another or a silent fallback */}
        <Row label="Use the Steam app" hint="like Wallpaper Engine does it, with a live progress bar. Needs Wallpaper Engine. Steam shows you playing it from your first download until a minute after you leave the Workshop." wk="workshopDownloadMode">
          <input type="radio" data-wsmode="steamapp" checked={mode === "steamapp"} onChange={() => set("workshopDownloadMode", "steamapp")} /></Row>
        <Row label="Open in the Steam app" hint="opens the wallpaper's page in Steam. You subscribe there and it downloads here.">
          <input type="radio" data-wsmode="steampage" checked={mode === "steampage"} onChange={() => set("workshopDownloadMode", "steampage")} /></Row>
        <Row label="Subscribe with Steam login" hint="another way to subscribe from the app, but you log in to Steam here">
          <input type="radio" data-wsmode="subscribe" checked={mode === "subscribe"} onChange={() => set("workshopDownloadMode", "subscribe")} /></Row>
        {mode === "steamapp" && (
          <Help>Needs Steam running and Wallpaper Engine in your Steam account. Steam subscribes, downloads and keeps it updated.</Help>
        )}
        {mode === "subscribe" &&
          /* Signing in is optional: without a usable
             sign-in a Download opens the item in the Steam app, where the user clicks Subscribe (WorkshopDownloader) — so the
             row says what happens either way. Sign in with QR (the Steam mobile app) or with a password (SteamPasswordModal). */
          <Row label="Steam">
              {steam?.signedIn && !steam.rejected
                ? <div className="hms" data-steam-state="signed-in"><span className="shint">Signed in as <b>{steam.accountName}</b> · ~{steam.daysLeft}d left</span>
                    <button className="btn ghost" onClick={signoutSteam}>Sign out</button></div>
                : <div className="hms" data-steam-state={steam?.signedIn ? "rejected" : "signed-out"} data-steam-rejected={steam?.signedIn ? "" : undefined}>
                    {steam?.signedIn
                      /* Steam ended the saved sign-in (backend `SteamSignInRejected`, set when finalizelogin answers AccessDenied) —
                         else the row says "Signed in as …" while every download fails */
                      ? <span className="shint s-warn-text">Steam signed <b>{steam.accountName}</b> out. Sign in again.</span>
                      : <span className="shint">Not signed in.</span>}
                    <span className="steam-row-btns">
                      <button className="btn accent" onClick={startQr} data-steam-signin="qr">Sign in with QR</button>
                      <button className="btn ghost" onClick={openPwLogin} data-steam-signin="password">Sign in with password</button>
                    </span></div>}
            </Row>}
      </Section>

      <Section title="Under the hood" icon={<Wrench size={15} />} lv="advanced">
        <Row label="Transition style" hint={"how one wallpaper changes to the next. " + (TRANSITION_STYLE[g<string>("transitionMethod", "reveal")] ?? TRANSITION_STYLE.reveal)} rk="transitionMethod">
          <Select value={g("transitionMethod", "reveal")} onChange={(v) => set("transitionMethod", v)}
            options={[{ value: "reveal", label: "Reveal" }, { value: "frozen", label: "Frozen" }, { value: "full-live", label: "Full-live" }]} />
        </Row>
        <Row label="Volume keys change" hint="what the volume keybinds change. Auto: the playing wallpaper's own volume if it differs, else the global one. This wallpaper: always that wallpaper's. Global: always the global one." rk="volumeKeyTarget">
          <Select value={g("volumeKeyTarget", "auto")} onChange={(v) => set("volumeKeyTarget", v)}
            options={[{ value: "auto", label: "Auto" }, { value: "item", label: "This wallpaper" }, { value: "global", label: "Global" }]} />
        </Row>
        <Row label="Debug mode" hint="turns on the liascapeDbg bridge and performance metrics" rk="debugMode"><input type="checkbox" checked={g("debugMode", false)} onChange={(e) => set("debugMode", e.target.checked)} /></Row>
        {g("debugMode", false) && <Row label="Show debug overlay" hint="the on-screen FPS / metrics readout" rk="debugOverlay"><input type="checkbox" checked={g("debugOverlay", true)} onChange={(e) => set("debugOverlay", e.target.checked)} /></Row>}
      </Section>

      <Section title="Keyboard shortcuts" icon={<Keyboard size={15} />}>
        {/* Basic shows only Autostart: the bind-these-keys line goes with the command list */}
        {rank(level) >= rank("standard") && <Help>Bind these commands to keys in your compositor's config.</Help>}
        {actions.map((a) => (
          <Row key={a} label={a} lv="standard">
            <code className="kb">liascape {a.replace("volume-", "volume ")}</code>
            <CopyButton text={`liascape ${a.replace("volume-", "volume ")}`} what={`liascape ${a.replace("volume-", "volume ")}`} />
          </Row>
        ))}
        <Row label="Autostart" hint="run it when you log in, and your wallpapers come back"><code className="kb">liascape restore</code>
          <CopyButton text="liascape restore" what="liascape restore" /></Row>
      </Section>

      <Section title="Housekeeping" icon={<LibraryIcon size={15} />}>
        <CachePicker />
        <CrashMarks />
        <Row label="Reset all settings" hint="every setting back to its default" lv="standard">
          <div className="hms">
            {wipeArm < 0 && <button className="btn danger" onClick={() => setWipeArm(3)}>Reset Settings</button>}
            {wipeArm > 0 && <button className="btn danger" disabled>Reset in {wipeArm}s…</button>}
            {wipeArm === 0 && <button className="btn danger solid glow-pulse" onClick={() => { resetAllSettings(); setWipeArm(-1); }}>Confirm — reset all</button>}
            {wipeArm >= 0 && <button className="btn ghost" onClick={() => setWipeArm(-1)}>Cancel</button>}
          </div>
        </Row>
        <Row label="Forget the whole library" hint="removes every wallpaper from the library. There's no undo." lv="advanced">
          <div className="hms">
            {clearArm < 0 && <button className="btn danger" onClick={() => setClearArm(5)}>Clear Library</button>}
            {clearArm > 0 && <button className="btn danger" disabled>Clear in {clearArm}s…</button>}
            {clearArm === 0 && <button className="btn danger solid glow-pulse" onClick={() => { clearLibrary(); setClearArm(-1); }}>Confirm — wipe all</button>}
            {clearArm >= 0 && <button className="btn ghost" onClick={() => setClearArm(-1)}>Cancel</button>}
          </div>
        </Row>
      </Section>
    </div>
    </HealthCtx.Provider>
  );
});
