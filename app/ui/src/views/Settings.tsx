import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, RotateCcw, SlidersHorizontal, Repeat, VolumeX, Cpu, Palette, AlertTriangle,
  Layers, MonitorSmartphone, Download, Terminal, Keyboard, Library as LibraryIcon, Wrench, Sparkles, Gauge, Volume2,
} from "lucide-react";
import { useStore, SETTINGS_DEFAULTS } from "../store";
import { api, type FeatureHealth, type ClipQuality } from "../api/client";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { Select } from "../components/Select";
import { Segmented } from "../components/Segmented";
import { CardPreview } from "../components/CardPreview";
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
import { useMotion } from "../components/motion";
import { type Level, LEVEL_LABEL, LEVEL_OF_KEY, levelOf, rank } from "../settingsLevel";

// Electron preload (app/shell/preload.js) exposes native dialogs; null in a browser → text entry only.
const bridge = (window as unknown as { liascape?: { pickFolder?: () => Promise<string | null>; pickFile?: () => Promise<string | null> } }).liascape;

// reads/writes go through the store's settings object (camelCase, mirrors AppSettings).
function useS() {
  const settings = useStore((s) => s.settings) ?? {};
  const setSetting = useStore((s) => s.setSetting);
  const g = <T,>(k: string, d: T): T => (settings[k] as T) ?? d;
  return { g, set: setSetting, settings };
}

// Settings → Playback (under "Normalize audio", liascape-player only): a scene's loudness can be ESTIMATED from its
// files before it ever plays (`liascape-player scene-loudness`, a background queue in the backend — one nice'd child at
// a time; also run on import). Estimate = every scene without an estimate for its current properties; Recalculate all
// = every scene again; Cancel stops the queue (what's done stays). Progress from WS scene-loudness-progress (the store).
function SceneLoudnessRow() {
  const prog = useStore((s) => s.sceneLoudness);
  const [failed, setFailed] = useState<{ path: string; error: string }[]>([]);
  const [note, setNote] = useState("");
  const running = prog != null;
  useEffect(() => {
    if (running) return;
    let alive = true;
    api.sceneLoudnessStatus().then((st) => {
      if (!alive) return;
      setFailed(st.failed);
      if (st.running) useStore.getState().setSceneLoudness({ done: st.done, total: st.total, currentId: st.current?.split("/").pop() ?? "" });
    }).catch(() => {});
    return () => { alive = false; };
  }, [running]);
  const start = (force: boolean) => {
    setNote("");
    api.sceneLoudnessEstimate(force).then((r) => { if (r.queued === 0) setNote("Every scene is already measured."); }).catch((e) => setNote(String(e)));
  };
  const hint = "measures a scene's loudness before it ever plays, so it's evened out from the first second. New scenes get measured when they're added."
    + (running ? ` Measuring ${prog!.done} of ${prog!.total}${prog!.currentId ? ` (${prog!.currentId})` : ""}…`
      : note ? ` ${note}` : failed.length ? ` ${failed.length} couldn't be measured (not a scene, or incomplete).` : "");
  return (
    <Row label="Pre-measure scenes" hint={hint} wk="normalizeAudio" lv="standard">
      {running
        ? <button className="btn ghost" data-scene-loudness="cancel" onClick={() => api.sceneLoudnessCancel().catch(() => {})}>Cancel</button>
        : <>
          <button className="btn ghost" data-scene-loudness="estimate" title="measure every scene not measured yet" onClick={() => start(false)}>Measure new</button>
          <button className="btn ghost" data-scene-loudness="recalculate" title="measure every scene again" onClick={() => start(true)}>Measure all again</button>
        </>}
    </Row>
  );
}

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

// `rk` (+ optional `def`) ties a row to a settings key: a reset icon appears ONLY when the current
// value deviates from its default (SETTINGS_DEFAULTS), and resets that one setting. `onReset`/`deviated`
// cover non-settings-backed rows (e.g. Theme, applied via applyTheme not setSetting). `wk` = the key whose
// feature warnings (WarnIcon) the row shows, when it has no `rk`. `lv` = the Settings level the row shows from
// (default: its key's in LEVEL_OF_KEY, else Basic); above the current level it renders nothing (its value is untouched).
function Row({ label, hint, disabled, rk, wk, def, deviated, deviatedTitle, onReset, lv, children }: {
  label: string; hint?: string; disabled?: boolean;
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
    <Tag className={`srow${disabled ? " disabled" : ""}${toggle ? " toggle" : ""}`} data-level={own} data-expert={own === "expert" ? "" : undefined}
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
// a whole section can sit at a level too (`lv`); a section's rows still filter themselves
function Section({ title, icon, lv, children }: { title: string; icon?: React.ReactNode; lv?: Level; children: React.ReactNode }) {
  const level = useStore((s) => levelOf(s.settings?.settingsLevel));
  if (lv && rank(lv) > rank(level)) return null;
  return (
    <div className="ssection">
      <h3>{icon && <span className="ssection-ico">{icon}</span>}{title}</h3>
      {children}
    </div>
  );
}
// settings changed from their defaults whose rows the current level hides (they keep working) — the note at the top
const hiddenChanged = (settings: Record<string, unknown>, level: Level) =>
  Object.entries(LEVEL_OF_KEY).filter(([k, lv]) => rank(lv) > rank(level)
    && settings[k] !== undefined && JSON.stringify(settings[k]) !== JSON.stringify(SETTINGS_DEFAULTS[k])).map(([k, lv]) => ({ k, lv }));
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
  const steamcmdSignin = useStore((s) => s.steamcmdSignin);
  const themes = useStore((s) => s.themes);
  const themeName = useStore((s) => s.theme?.name ?? "");
  const applyTheme = useStore((s) => s.applyTheme);
  const scrollRef = useRef<HTMLDivElement>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  // the Look & feel rows that change how a library card looks: the card preview shows beside them while they're on screen
  const cardRowsRef = useRef<HTMLDivElement>(null);
  const [mpv, setMpv] = useState("");
  const [lwe, setLwe] = useState("");
  const [clearArm, setClearArm] = useState(-1); // -1 idle, >0 counting, 0 ready-to-confirm
  const [wipeArm, setWipeArm] = useState(-1);   // same arming pattern for "Clear settings"
  // auto-detected outputs (hyprctl/sway): name + current refresh rate + which is focused/primary
  const [detected, setDetected] = useState<{ name: string; refreshHz: number; primary: boolean }[]>([]);
  // liascape-player availability for the "Player engine" row (binary found? last start error?)
  const [engine, setEngine] = useState<{ active: string; available: boolean; reason: string | null;
    scenes?: { available: boolean; reason: string | null; assets_dir: string | null };
    vram?: { low_active: boolean | null; mode: string } | null } | null>(null);
  // liascape-player draws the wallpaper: one scene worker shared by every output (no per-monitor primary),
  // no scene-load lead (it switches when the scene's first frame is in), the fps applies live
  const liascapeActive = engine?.active === "liascape-player";
  // legacy-only rows wait for the engine status (they'd show, then vanish, under liascape-player)
  const legacyActive = engine?.active === "legacy";

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.mpvPreview().then((x) => alive && setMpv(x));
      api.lwePreview().then((x) => alive && setLwe(x));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [g("noAudio", false), g("disableCache", false), g("volume", 100), g("speed", 1), g("hwDec", "auto"), g("videoScale", "fill"), g("demuxerMaxMib", 20), g("demuxerMaxBackMib", 5), JSON.stringify(g("sceneMonitors", []))]); // eslint-disable-line

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
  // read at once on mount, then again after an engine change (the backend switches live and may
  // report a start failure). Unreachable → not available, with the reason.
  useEffect(() => {
    const t = setTimeout(() => api.playerEngine().then(setEngine)
      .catch(() => setEngine({ active: "legacy", available: false, reason: "couldn't read the engine status from the backend" })),
      engine === null ? 0 : 600);
    return () => clearTimeout(t);
  }, [g("playerEngine", "legacy"), g("allowScenes", false)]); // eslint-disable-line
  // under liascape-player: the low-VRAM status (GPU / VRAM section) follows the player while Settings is open
  useEffect(() => {
    if (!liascapeActive) return;
    const t = setInterval(() => api.playerEngine().then(setEngine).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [liascapeActive]);
  // missing build pieces / tools (API: /health/features) → warning icons on the rows they break + the summary;
  // re-read after a change that can move them (engine, scenes, steamcmd) and every 15 s while open (a player that
  // started meanwhile reports its GPU interop / VRAM probe)
  const [features, setFeatures] = useState<FeatureHealth[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => api.featureHealth().then((r) => alive && setFeatures(r.features ?? [])).catch(() => {});
    const t0 = setTimeout(read, 300), t = setInterval(read, 15000);
    return () => { alive = false; clearTimeout(t0); clearInterval(t); };
  }, [g("playerEngine", "legacy"), g("allowScenes", false), g("steamCmdPath", ""), g("workshopDownloadMode", "subscribe")]); // eslint-disable-line
  const warnings = useMemo(() => healthWarnings(features), [features]);
  // the summary: what breaks something switched on / selected now (the row icons show regardless)
  const broken = features.filter((f) => f.ok === false && f.inUse !== false);

  // the rotation: "Switch when video ends" off → the interval is "Switch every" (a plain timer); on → the SAME field
  // is "Minimum play time", with "Maximum play time" right below, then "Separate timing for scenes" (+ "Switch scenes
  // after" while it's on) — player-adapter.md § Rotation. Every limit: 0 = off.
  const aoe = g("globalSwitchWhenVideoEnds", true);
  const sepScenes = g("globalSeparateSceneTiming", true);

  const settingsAll = useStore((s) => s.settings) ?? {};
  const level = levelOf(settingsAll.settingsLevel);
  const atLeast = (l: Level) => rank(level) >= rank(l);
  const hidden = hiddenChanged(settingsAll, level);
  // a playlist is playing now → the start-mode hint says a change waits for its next start
  const playlistPlaying = useStore((s) => s.playlist.length > 1 && !!s.playingPath && s.playlist.includes(s.playingPath));
  const plStart = g<string>("globalPlaylistStart", "start_over");
  type Mon = { name: string; fps: number; isPrimary: boolean };
  // Wallpaper Engine's own default FPS limit (its exe writes 15 when unset; the first-run preset is
  // "medium" = 15). Like WE's, the scene runs at this rate even above the monitor's refresh.
  const WE_DEFAULT_FPS = 15;
  const monitors = g<Mon[]>("sceneMonitors", []);
  const setMonitors = (m: Mon[]) => set("sceneMonitors", m);
  // Auto-populate the scene monitor list from detected outputs the first time scenes are enabled
  // (empty list). First detected output = primary. Won't clobber a list the user already configured.
  useEffect(() => {
    if (!g("allowScenes", false) || !detected.length || monitors.length) return;
    setMonitors(detected.map((d) => ({ name: d.name, fps: WE_DEFAULT_FPS, isPrimary: d.primary })));
  }, [detected, g("allowScenes", false)]); // eslint-disable-line

  const mode = g<string>("workshopDownloadMode", "subscribe");
  const mute = g("noAudio", false);          // disables the volume row (parity: muted = no volume)
  const am = g("autoMute", false);           // gates the auto-mute children

  // (live wallpaper bg is now rendered at App level via <WallpaperBg> — Settings always shows it, and
  // the "Live wallpaper behind all tabs" advanced toggle extends it to Browse/Library)
  const pickInto = async (key: string, kind: "folder" | "file") => {
    const p = await (kind === "folder" ? bridge?.pickFolder?.() : bridge?.pickFile?.());
    if (p) set(key, p);
  };

  const actions = ["toggle-mute", "toggle-pause", "stop", "play", "toggle-play",
    "next", "previous", "random", "volume-up", "volume-down", "loop-current"];
  // what a shortcut does, where the name doesn't say it
  const actionHint: Record<string, string> = {
    "loop-current": "keeps playing the current wallpaper and stops the playlist rotating. Run it again to rotate on (liascape-player).",
  };

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
        <Row label="Volume" hint={mute ? "muted" : `${g("volume", 100)}%`} disabled={mute} rk="volume">
          <input type="range" min={0} max={100} value={g("volume", 100)} disabled={mute} onChange={(e) => { set("volume", +e.target.value); previewGlobal({ volume: +e.target.value }); }} /></Row>
        <Row label="Mute wallpapers" rk="noAudio"><input type="checkbox" checked={mute} onChange={(e) => set("noAudio", e.target.checked)} /></Row>
        <Row label="Even out loudness" hint={"keeps every wallpaper at about the same loudness, so switching never blasts your ears. Your volume still applies on top." + (liascapeActive ? " Scenes fine-tune their level over their first minute." : "")} disabled={mute} rk="normalizeAudio">
          <input type="checkbox" checked={g("normalizeAudio", false)} disabled={mute} onChange={(e) => set("normalizeAudio", e.target.checked)} /></Row>
        {!mute && g("normalizeAudio", false) && <Row label="Loudness target" hint="how loud the evened-out level is. −14 is what Spotify and YouTube aim for, lower is quieter." rk="normalizeTargetLufs">
          <Combo value={g("normalizeTargetLufs", -14) as number} min={-70} max={0} step={1}
            onChange={(v) => set("normalizeTargetLufs", v)}
            options={[{ value: -11, label: "Loud (−11)" }, { value: -14, label: "Streaming (−14)" }, { value: -19, label: "Quiet (−19)" }, { value: -23, label: "Broadcast (−23)" }]} /><span>LUFS</span></Row>}
        {liascapeActive && !mute && g("normalizeAudio", false) && atLeast("standard") && <SceneLoudnessRow />}
      </Section>

      <Section title="Auto-mute" icon={<VolumeX size={15} />}>
        <Row label="Mute when other audio plays" hint="the wallpaper goes quiet while music, videos or calls play, then comes back" rk="autoMute"><input type="checkbox" checked={am} onChange={(e) => set("autoMute", e.target.checked)} /></Row>
        <Row label="Only for media players" hint="ignores notification blips and game sounds, and only reacts to media players (MPRIS)" disabled={!am} rk="autoMuteOnlyIfMprisActive"><input type="checkbox" disabled={!am} checked={g("autoMuteOnlyIfMprisActive", false)} onChange={(e) => set("autoMuteOnlyIfMprisActive", e.target.checked)} /></Row>
        <Row label="Fade out after (ms)" hint="how long other audio has to play before the wallpaper goes quiet" disabled={!am} rk="autoMuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoMuteDelayMs", 500)} onChange={(v) => set("autoMuteDelayMs", v)} /></Row>
        <Row label="Come back after (ms)" hint="how long things must stay quiet before the wallpaper's sound returns. A couple of seconds stops it flickering between songs." disabled={!am} rk="autoUnmuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoUnmuteDelayMs", 2000)} onChange={(v) => set("autoUnmuteDelayMs", v)} /></Row>
        <Row label="Ignore sounds below (dB)" disabled={!am} rk="autoMuteMinLevelDb"><NumInput disabled={!am} min={-80} max={0} value={g("autoMuteMinLevelDb", -70)} onChange={(v) => set("autoMuteMinLevelDb", v)} /></Row>
      </Section>

      <Section title="Playback" icon={<SlidersHorizontal size={15} />}>
        {liascapeActive && <Row label="Pause behind windows" hint={ROT_HINT.cover} rk="pauseWhenCovered">
          <Select value={g("pauseWhenCovered", "maximized")} onChange={(v) => set("pauseWhenCovered", v)}
            options={[{ value: "off", label: "Off" }, { value: "fullscreen", label: "A fullscreen window" }, { value: "maximized", label: "A fullscreen or maximized window" }]} /></Row>}
        <Row label="Playback speed" hint={`${g("speed", 1)}×`} rk="speed"><input type="range" min={0.1} max={4} step={0.1} value={g("speed", 1)} onChange={(e) => { set("speed", +e.target.value); previewGlobal({ speed: +e.target.value }); }} /></Row>
        <Row label="Stay paused when switching" hint="next, previous or random while paused. On, it stays paused and cuts straight to the new wallpaper. Off, it plays again with its transition." rk="stayPausedWhenSwitching">
          <input type="checkbox" checked={g("stayPausedWhenSwitching", false)} onChange={(e) => set("stayPausedWhenSwitching", e.target.checked)} /></Row>
        <Row label="Disable video cache" hint="reads videos straight from disk instead of buffering ahead" rk="disableCache"><input type="checkbox" checked={g("disableCache", false)} onChange={(e) => set("disableCache", e.target.checked)} /></Row>
        <Row label="Restart legacy player every (s)" hint="the legacy player (mpvpaper) leaks memory over time, and restarting it now and then keeps that in check. 0 means never." rk="restartMpvpaperEverySeconds"><NumInput min={0} max={3600} value={g("restartMpvpaperEverySeconds", 600)} onChange={(v) => set("restartMpvpaperEverySeconds", v)} /></Row>
        <Row label="Only restart between wallpapers" hint="waits for the next switch instead of restarting mid-video, so there's no flash. A lone video still restarts." rk="restartOnlyAtPlaylistChangeover"><input type="checkbox" checked={g("restartOnlyAtPlaylistChangeover", false)} onChange={(e) => set("restartOnlyAtPlaylistChangeover", e.target.checked)} /></Row>
      </Section>

      <Section title="Playlist & rotation" icon={<Repeat size={15} />}>
        <Row label="Switch when video ends" rk="globalSwitchWhenVideoEnds"><input type="checkbox" checked={aoe} onChange={(e) => set("globalSwitchWhenVideoEnds", e.target.checked)} /></Row>
        {aoe ? <>
          <Row label="Minimum play time" hint={ROT_HINT.min + (sepScenes ? "" : ROT_HINT.minScenes)} rk="globalIntervalSeconds">
            <PlayTimeInput label="Minimum play time" zeroText="off" value={g("globalIntervalSeconds", 0)} onChange={(v) => set("globalIntervalSeconds", v)} /></Row>
          <Row label="Maximum play time" hint={ROT_HINT.max + (sepScenes ? "" : ROT_HINT.maxScenes)} rk="globalMaxPlaySeconds">
            <PlayTimeInput label="Maximum play time" zeroText="off" value={g("globalMaxPlaySeconds", 0)} onChange={(v) => set("globalMaxPlaySeconds", v)} /></Row>
          <Row label="Separate timing for scenes" hint={sepScenes ? ROT_HINT.separate : `${ROT_HINT.sceneRule} ${ROT_HINT.separateOff}`} rk="globalSeparateSceneTiming">
            <input type="checkbox" checked={sepScenes} onChange={(e) => set("globalSeparateSceneTiming", e.target.checked)} /></Row>
          {sepScenes && <Row label="Switch scenes after" hint={ROT_HINT.scenesAfter} rk="globalSwitchScenesAfterSeconds">
            <PlayTimeInput label="Switch scenes after" zeroText="off" value={g("globalSwitchScenesAfterSeconds", 1800)} onChange={(v) => set("globalSwitchScenesAfterSeconds", v)} /></Row>}
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

      <Section title="Video" icon={<Cpu size={15} />} lv="standard">
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

      {/* liascape-player only (the player owns the GPU budget + both VRAM rules); every row applies live
          (API: /settings → player.scene_throttle / scene_vram_limit_mib / vram_low_mode) */}
      {liascapeActive && (
        <Section title="GPU & memory" icon={<Gauge size={15} />} lv="standard">
          <Row label="Ease off heavy scenes" hint="if a scene makes your GPU stutter, it runs at a lower frame rate until things calm down. Off, every scene keeps its set frame rate." rk="autoThrottleScenes">
            <input type="checkbox" checked={g("autoThrottleScenes", true)} onChange={(e) => set("autoThrottleScenes", e.target.checked)} /></Row>
          <Row label="When video memory runs low" hint="when a game grabs the GPU's memory. Stop frees the wallpaper's memory and shows its last frame, Pause only pauses. Both pick up again once there's room." rk="vramLowMode">
            <Select value={g("vramLowMode", "stop")} onChange={(v) => set("vramLowMode", v)}
              options={[{ value: "stop", label: "Stop (free memory)" }, { value: "pause", label: "Pause" }, { value: "off", label: "Off" }]} /></Row>
          <Row label="Cap each scene's video memory" hint="stops a scene that uses more video memory than the cap. A playlist moves on, a single wallpaper keeps its last frame. It doesn't count as a crash." rk="limitVramPerScene">
            <input type="checkbox" checked={g("limitVramPerScene", false)} onChange={(e) => set("limitVramPerScene", e.target.checked)} /></Row>
          {g("limitVramPerScene", false) && <Row label="Video memory cap (MiB)" hint="per scene. About 1536 suits most scenes." rk="sceneVramLimitMib">
            <NumInput min={64} max={1048576} step={64} value={g("sceneVramLimitMib", 1536)} onChange={(v) => set("sceneVramLimitMib", v)} /><span>MiB</span></Row>}
          {engine?.vram?.low_active && <Help>Video memory is low right now — the wallpaper is {engine.vram.mode === "stop" ? "stopped (its memory freed)" : "paused"} until it frees up.</Help>}
        </Section>
      )}

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
        <Row label="Glow effects" hint="the soft accent glow on hovered, active and playing things. Off keeps everything readable, just without the glow." rk="glows"><input type="checkbox" checked={g("glows", true)} onChange={(e) => set("glows", e.target.checked)} /></Row>
        <Row label="Text shadow" hint="a shadow under every letter, like film subtitles, so text stays readable over a bright wallpaper" rk="textShadow"><input type="checkbox" checked={g("textShadow", false)} onChange={(e) => set("textShadow", e.target.checked)} /></Row>
        <Row label="Smooth window animations" hint="the slides, zooms and morphs all over the app. Off, nothing moves and things fade in and out instead." rk="morphs"><input type="checkbox" checked={g("morphs", true)} onChange={(e) => set("morphs", e.target.checked)} /></Row>
        <Row label="Animate GIF previews" rk="autoPlayGifs"><input type="checkbox" checked={g("autoPlayGifs", false)} onChange={(e) => set("autoPlayGifs", e.target.checked)} /></Row>
        <Row label="Animate wallpapers without a GIF" hint="wallpapers with no GIF preview play a silent clip of their own video, without hovering" rk="autoPlayVideoThumbs"><input type="checkbox" checked={g("autoPlayVideoThumbs", false)} onChange={(e) => set("autoPlayVideoThumbs", e.target.checked)} /></Row>
        <Row label="Use the video instead of the GIF" hint="a wallpaper with a GIF preview shows a short clip of its own video instead, on hover (always while the setting above is on)" rk="preferVideoThumbs"><input type="checkbox" checked={g("preferVideoThumbs", false)} onChange={(e) => set("preferVideoThumbs", e.target.checked)} /></Row>
        <Row label="Video preview quality" hint="sharper, smoother clips use more disk space and CPU" rk="videoPreviewQuality">
          <Segmented<ClipQuality> label="Video preview quality" value={g<ClipQuality>("videoPreviewQuality", "mid")} onChange={(v) => set("videoPreviewQuality", v)}
            options={(["low", "mid", "high"] as const).map((v) => ({ value: v, label: QUALITY_LABEL[v] }))} /></Row>
        </div>
        <Row label="Wallpaper behind every tab" hint="shows the live wallpaper behind Browse and Library too, peeking through between the cards" rk="liveWallpaperBehindAllTabs"><input type="checkbox" checked={g("liveWallpaperBehindAllTabs", false)} onChange={(e) => set("liveWallpaperBehindAllTabs", e.target.checked)} /></Row>
      </Section>
      </CardPreview>

      <Section title="Wallpaper Engine" icon={<Layers size={15} />}>
        <Row label="Workshop folder" hint="where Steam keeps your Wallpaper Engine downloads">
          <input className="text" value={g("workshopFolder", "")} onChange={(e) => set("workshopFolder", e.target.value)} />
          <button className="btn ghost ico" onClick={() => pickInto("workshopFolder", "folder")}><FolderFlap size={14} /> Browse</button>
        </Row>
        <Row label="Play scenes" hint="Wallpaper Engine's interactive scene wallpapers. They need Wallpaper Engine installed for its assets." rk="allowScenes"><input type="checkbox" checked={g("allowScenes", false)} onChange={(e) => set("allowScenes", e.target.checked)} /></Row>
        <Row label="Import new Workshop wallpapers" hint="anything new in the Workshop folder lands in your library by itself" rk="autoAddWeWallpapersToLibrary"><input type="checkbox" checked={g("autoAddWeWallpapersToLibrary", false)} onChange={(e) => set("autoAddWeWallpapersToLibrary", e.target.checked)} /></Row>
        <Row label="Copy files instead of linking" hint="copies Workshop files into the library instead of linking to them (uses more disk)" rk="copyFilesInsteadOfSymlinking"><input type="checkbox" checked={g("copyFilesInsteadOfSymlinking", false)} onChange={(e) => set("copyFilesInsteadOfSymlinking", e.target.checked)} /></Row>
        <Row label="Replace direct downloads with Workshop copies" hint="when a wallpaper you downloaded directly shows up in the Workshop folder, it switches to that one and frees the duplicate's disk space" rk="replaceDirectWithWorkshop"><input type="checkbox" checked={g("replaceDirectWithWorkshop", false)} onChange={(e) => set("replaceDirectWithWorkshop", e.target.checked)} /></Row>
        {!liascapeActive && <Row label="Scene transition delay (ms)" rk="sceneTransitionDelayMs"><NumInput min={0} max={5000} value={g("sceneTransitionDelayMs", 1000)} onChange={(v) => set("sceneTransitionDelayMs", v)} /></Row>}
        {liascapeActive && g("allowScenes", false) && engine?.scenes && !engine.scenes.available && engine.scenes.reason &&
          <Help>Scenes can't play right now: {engine.scenes.reason}</Help>}
      </Section>

      {g("allowScenes", false) && (
        <Section title="Scene monitors" icon={<MonitorSmartphone size={15} />} lv="standard">
          <Help>The monitors scenes play on, each with its frame rate limit (Wallpaper Engine's default is 15; like there, a scene
            runs at it even above the monitor's refresh rate).{detected.length > 0
            ? <> Found: {detected.map((d) => <code key={d.name} className="kb">{d.name} {d.refreshHz}Hz{d.primary ? " ★" : ""}</code>)} — type or pick below.</>
            : <> None found automatically; on Hyprland, <code className="kb">hyprctl monitors</code> lists their names.</>}</Help>
          <datalist id="liascape-monitors">{detected.map((d) => <option key={d.name} value={d.name} />)}</datalist>
          {monitors.map((m, i) => (
            <Row key={i} label={`Monitor ${i + 1}`} lv="standard">
              <div className="hms">
                <input className="text mon-name" list="liascape-monitors" placeholder="e.g. DP-1" value={m.name}
                  onChange={(e) => setMonitors(monitors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <NumInput min={1} max={480} value={m.fps}
                  onChange={(v) => setMonitors(monitors.map((x, j) => j === i ? { ...x, fps: v } : x))} /><span>{liascapeActive ? "fps (live)" : "fps"}</span>
                {/* primary is one-of-N (exactly one monitor) → radio, like the Workshop download mode section;
                    legacy only (LWE's audio-owning instance) — liascape-player runs one worker for every output */}
                {!liascapeActive && <label className="inline"><input type="radio" name="lwe-primary" checked={m.isPrimary}
                  onChange={() => setMonitors(monitors.map((x, j) => ({ ...x, isPrimary: j === i })))} /> primary</label>}
                <button className="mini ico" aria-label="Remove monitor" onClick={() => setMonitors(monitors.filter((_, j) => j !== i))}><X size={14} /></button>
              </div>
            </Row>
          ))}
          <button className="btn ghost" onClick={() => {
            const used = new Set(monitors.map((m) => m.name));
            const next = detected.find((d) => !used.has(d.name));
            setMonitors([...monitors, { name: next?.name ?? `DP-${monitors.length + 1}`, fps: WE_DEFAULT_FPS, isPrimary: monitors.length === 0 }]);
          }}>+ Add monitor</button>
        </Section>
      )}

      <Section title="Getting Workshop wallpapers" icon={<Download size={15} />}>
        {/* four ways, one radio group (docs/decisions.md § "Offer four Workshop download modes, the user's choice") — each
            route its own radio, never a switch inside another or a silent fallback */}
        <Row label="Use the Steam app" hint="one click with real progress. Steam shows you as playing Wallpaper Engine for those seconds." wk="workshopDownloadMode">
          <input type="radio" data-wsmode="steamapp" checked={mode === "steamapp"} onChange={() => set("workshopDownloadMode", "steamapp")} /></Row>
        <Row label="Open in the Steam app" hint="opens the wallpaper's page in Steam. Click Subscribe there and it downloads.">
          <input type="radio" data-wsmode="steampage" checked={mode === "steampage"} onChange={() => set("workshopDownloadMode", "steampage")} /></Row>
        <Row label="Subscribe with your Steam sign-in" hint="subscribes from here. Sign in once with a QR code or a password.">
          <input type="radio" data-wsmode="subscribe" checked={mode === "subscribe"} onChange={() => set("workshopDownloadMode", "subscribe")} /></Row>
        <Row label="Download via steamcmd" hint="a one-off copy, no syncing" wk="workshopDownloadMode">
          <input type="radio" data-wsmode="steamcmd" checked={mode === "steamcmd"} onChange={() => set("workshopDownloadMode", "steamcmd")} /></Row>
        {mode === "steamapp" && (
          <Help>Needs Steam running and Wallpaper Engine in your Steam account. Steam subscribes, downloads and keeps it updated —
            nothing to sign in to here. If Steam can't be reached, it says so — it never switches to another way by itself.</Help>
        )}
        {mode === "subscribe"
          /* Signing in is optional: without a usable
             sign-in a Download opens the item in the Steam app, where the user clicks Subscribe (WorkshopDownloader) — so the
             row says what happens either way. Sign in with QR (the Steam mobile app) or with a password (SteamPasswordModal). */
          ? <Row label="Steam">
              {steam?.signedIn && !steam.rejected
                ? <div className="hms" data-steam-state="signed-in"><span className="shint">Signed in as <b>{steam.accountName}</b> · ~{steam.daysLeft}d left</span>
                    <button className="btn ghost" onClick={signoutSteam}>Sign out</button></div>
                : <div className="hms" data-steam-state={steam?.signedIn ? "rejected" : "signed-out"} data-steam-rejected={steam?.signedIn ? "" : undefined}>
                    {steam?.signedIn
                      /* Steam ended the saved sign-in (backend `SteamSignInRejected`, set when finalizelogin answers AccessDenied) —
                         else the row says "Signed in as …" while every download fails */
                      ? <span className="shint s-warn-text">Steam signed <b>{steam.accountName}</b> out — sign in again. Until then, downloads open in the Steam app.</span>
                      : <span className="shint">Not signed in — until you are, downloads open in the Steam app, where you click Subscribe.</span>}
                    <span className="steam-row-btns">
                      <button className="btn accent" onClick={startQr} data-steam-signin="qr">Sign in with QR</button>
                      <button className="btn ghost" onClick={openPwLogin} data-steam-signin="password">Sign in with password</button>
                    </span></div>}
            </Row>
          : mode === "steamcmd" && <>
              <Help>Downloads a one-off copy with steamcmd — no subscription. Needs steamcmd and a one-time sign-in.</Help>
              <Row label="steamcmd path" hint="leave blank to find it automatically" wk="steamCmdPath">
                <input className="text" placeholder="/usr/bin/steamcmd" value={g("steamCmdPath", "")} onChange={(e) => set("steamCmdPath", e.target.value)} />
                <button className="btn ghost ico" onClick={() => pickInto("steamCmdPath", "file")}><FolderFlap size={14} /> Browse</button>
              </Row>
              <Row label="Steam username"><input className="text" value={g("steamUsername", "")} onChange={(e) => set("steamUsername", e.target.value)} /></Row>
              <Row label="One-time sign-in" hint="opens a terminal, and steamcmd remembers you after"><button className="btn accent" onClick={steamcmdSignin}>Sign in (one-time)</button></Row>
            </>}
      </Section>

      <Section title="Under the hood" icon={<Wrench size={15} />} lv="advanced">
        {(() => {
          const wantPlayer = g<string>("playerEngine", "legacy") === "liascape-player";
          // status not read yet → disabled ("checking…"); binary missing → disabled with the reason
          // (switching back to Legacy always stays possible)
          const loading = engine === null;
          const unavailable = !loading && !engine.available;
          const off = loading || (unavailable && !wantPlayer);
          const hint = loading ? "checking liascape-player…"
            : unavailable ? engine.reason ?? "liascape-player is not available"
            : wantPlayer && engine.active !== "liascape-player" ? "liascape-player is selected but not running: " + (engine.reason ?? "starting…")
            : wantPlayer && engine.reason ? engine.reason
            : "what draws the wallpaper. liascape-player is the new all-in-one player (experimental, scenes need Wallpaper Engine installed for its assets). It switches live.";
          return <Row label="Player engine" hint={hint} disabled={off} rk="playerEngine">
            <Select value={g("playerEngine", "legacy")} disabled={off} onChange={(v) => set("playerEngine", v)}
              options={[{ value: "legacy", label: "Legacy" }, { value: "liascape-player", label: "liascape-player (experimental)" }]} />
          </Row>;
        })()}
        <Row label="Transition style" hint="how a switch animates. Reveal: the old one freezes while the new one plays (recommended). Frozen: both hold still. Full-live: both keep playing (heavy at 4K). Warp-style effects use Frozen under Reveal." rk="transitionMethod">
          <Select value={g("transitionMethod", "reveal")} onChange={(v) => set("transitionMethod", v)}
            options={[{ value: "reveal", label: "Reveal (live B)" }, { value: "frozen", label: "Frozen" }, { value: "full-live", label: "Full-live" }]} />
        </Row>
        {/* only the legacy transition helper reads it (TransitionService --lag-offset); hidden, the value stays saved.
            Guard: probe-settings nudge:engine */}
        {legacyActive && g<string>("transitionMethod", "reveal") === "full-live" && <Row label="Full-live sync nudge" hint="Full-live only. Shifts the outgoing video this many ms against the live one to cancel drift (negative is ahead). A slight rewind means raise it toward 0, a slight skip ahead means lower it. About −30 is typical." rk="fullLiveSyncOffsetMs">
          <NumInput min={-200} max={200} step={5} value={g("fullLiveSyncOffsetMs", -30)} onChange={(v) => set("fullLiveSyncOffsetMs", v)} /><span>ms</span>
        </Row>}
        <Row label="Volume keys change" hint="what the volume shortcuts change. Auto: the playing wallpaper's own volume if it has one, else the global one. This wallpaper: always its own. Global: always the global one." rk="volumeKeyTarget">
          <Select value={g("volumeKeyTarget", "auto")} onChange={(v) => set("volumeKeyTarget", v)}
            options={[{ value: "auto", label: "Auto" }, { value: "item", label: "This wallpaper" }, { value: "global", label: "Global" }]} />
        </Row>
        <Row label="Debug mode" hint="turns on the liascapeDbg bridge and performance metrics" rk="debugMode"><input type="checkbox" checked={g("debugMode", false)} onChange={(e) => set("debugMode", e.target.checked)} /></Row>
        {g("debugMode", false) && <Row label="Show debug overlay" hint="the on-screen FPS / metrics readout" rk="debugOverlay"><input type="checkbox" checked={g("debugOverlay", true)} onChange={(e) => set("debugOverlay", e.target.checked)} /></Row>}
      </Section>

      <Section title="mpv command (live)" icon={<Terminal size={15} />} lv="expert">
        <div className="cmd-block"><pre className="mpv">{mpv || "…"}</pre><CopyButton text={mpv} what="mpv command" /></div>
      </Section>

      <Section title="linux-wallpaperengine command (live)" icon={<Terminal size={15} />} lv="expert">
        <Help>The scene command, one line per monitor; each scene's Workshop ID goes on the end.</Help>
        <div className="cmd-block"><pre className="mpv">{lwe || "…"}</pre><CopyButton text={lwe} what="linux-wallpaperengine command" /></div>
      </Section>

      <Section title="Keyboard shortcuts" icon={<Keyboard size={15} />} lv="standard">
        <Help>Bind these commands to keys in your compositor's config.</Help>
        {actions.map((a) => (
          <Row key={a} label={a} hint={actionHint[a]}>
            <code className="kb">liascape {a.replace("volume-", "volume ")}</code>
            <CopyButton text={`liascape ${a.replace("volume-", "volume ")}`} what={`liascape ${a.replace("volume-", "volume ")}`} />
          </Row>
        ))}
        <Row label="Autostart"><code className="kb">liascape restore</code>
          <CopyButton text="liascape restore" what="liascape restore" /></Row>
      </Section>

      <Section title="Housekeeping" icon={<LibraryIcon size={15} />}>
        <CachePicker />
        <Row label="Reset all settings" hint="every setting back to its default" lv="standard">
          <div className="hms">
            {wipeArm < 0 && <button className="btn danger" onClick={() => setWipeArm(3)}>Reset Settings</button>}
            {wipeArm > 0 && <button className="btn danger" disabled>Reset in {wipeArm}s…</button>}
            {wipeArm === 0 && <button className="btn danger solid glow-pulse" onClick={() => { resetAllSettings(); setWipeArm(-1); }}>Confirm — reset all</button>}
            {wipeArm >= 0 && <button className="btn ghost" onClick={() => setWipeArm(-1)}>Cancel</button>}
          </div>
        </Row>
        <Row label="Forget the whole library" hint="removes every wallpaper from the library. There's no undo." lv="standard">
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
