import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderOpen, X, RotateCcw, SlidersHorizontal, Repeat, VolumeX, Cpu, Palette, AlertTriangle,
  Layers, MonitorSmartphone, Download, Terminal, Keyboard, Library as LibraryIcon, Wrench, Sparkles, Gauge, Volume2,
} from "lucide-react";
import { useStore, SETTINGS_DEFAULTS } from "../store";
import { api, type FeatureHealth } from "../api/client";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { Select } from "../components/Select";
import { Combo } from "../components/Combo";
import { NumInput } from "../components/NumInput";
import { TransitionPicker, type TransitionValue } from "../components/TransitionPicker";
import { PlayTimeInput, ROT_HINT } from "../components/PlayTimeInput";
import { HealthCtx, WarnIcon, healthWarnings } from "../components/FeatureWarn";
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
    api.sceneLoudnessEstimate(force).then((r) => { if (r.queued === 0) setNote("every scene is already estimated"); }).catch((e) => setNote(String(e)));
  };
  const hint = "works out a scene's loudness from its sound files before it ever plays, so it's evened out from the first second. New scenes get this when they're added; changing a property that affects a scene's sound gets its own estimate."
    + (running ? ` — ${prog!.done} / ${prog!.total}${prog!.currentId ? ` (${prog!.currentId})` : ""}…`
      : note ? ` — ${note}` : failed.length ? ` — ${failed.length} not estimated (not a scene / incomplete)` : "");
  return (
    <Row label="Pre-measure scenes" hint={hint} wk="normalizeAudio" lv="standard">
      {running
        ? <button className="btn ghost" data-scene-loudness="cancel" onClick={() => api.sceneLoudnessCancel().catch(() => {})}>Cancel</button>
        : <>
          <button className="btn ghost" data-scene-loudness="estimate" title="estimate every scene not estimated yet for its current properties" onClick={() => start(false)}>Estimate</button>
          <button className="btn ghost" data-scene-loudness="recalculate" title="estimate every scene again" onClick={() => start(true)}>Recalculate all</button>
        </>}
    </Row>
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
  // between) ticks it (owner 2026-11-11: "do you think clicking on name or the entire box of a specific setting should
  // tick/untick it?" — yes, like the filter column's names). The reset button inside still only resets (a click on
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
  const clearCache = useStore((s) => s.clearCache);
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
  useSmoothScroll(scrollRef);
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

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.mpvPreview().then((x) => alive && setMpv(x));
      api.lwePreview().then((x) => alive && setLwe(x));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [g("loop", true), g("noAudio", false), g("disableCache", false), g("volume", 100), g("speed", 1), g("hwDec", "auto"), g("videoScale", "fill"), g("demuxerMaxMib", 20), g("demuxerMaxBackMib", 5), JSON.stringify(g("sceneMonitors", []))]); // eslint-disable-line

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
    "loop-current": "keep playing the current wallpaper — the playlist stops rotating and it loops; run it again to rotate on (liascape-player)",
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
    <div className="scroll settings" ref={scrollRef}>
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
        <Row label="Mute wallpapers" hint="silence every wallpaper — your other apps are untouched" rk="noAudio"><input type="checkbox" checked={mute} onChange={(e) => set("noAudio", e.target.checked)} /></Row>
        <Row label="Even out loudness" hint={"keeps every wallpaper at about the same loudness, so switching never blasts your ears. Each video gets measured once in the background the first time it plays; your volume still applies on top." + (liascapeActive ? " Scenes start from an estimate and fine-tune themselves over their first minute." : "")} disabled={mute} rk="normalizeAudio">
          <input type="checkbox" checked={g("normalizeAudio", false)} disabled={mute} onChange={(e) => set("normalizeAudio", e.target.checked)} /></Row>
        {!mute && g("normalizeAudio", false) && <Row label="Loudness target" hint="how loud the evened-out level is. −14 is what Spotify and YouTube aim for; lower is quieter. Anything from −70 to −5." rk="normalizeTargetLufs">
          <Combo value={g("normalizeTargetLufs", -14) as number} min={-70} max={-5} step={1}
            onChange={(v) => set("normalizeTargetLufs", v)}
            options={[{ value: -11, label: "Loud (−11)" }, { value: -14, label: "Streaming (−14)" }, { value: -19, label: "Quiet (−19)" }, { value: -23, label: "Broadcast (−23)" }]} /><span>LUFS</span></Row>}
        {liascapeActive && !mute && g("normalizeAudio", false) && atLeast("standard") && <SceneLoudnessRow />}
      </Section>

      <Section title="Auto-mute" icon={<VolumeX size={15} />}>
        <Row label="Hush when other audio plays" hint="the wallpaper goes quiet while music, videos or calls play, and comes back after" rk="autoMute"><input type="checkbox" checked={am} onChange={(e) => set("autoMute", e.target.checked)} /></Row>
        <Row label="Only for media players" hint="ignore notification blips and game sounds — only react to apps that show up as media players (MPRIS)" disabled={!am} rk="autoMuteOnlyIfMprisActive"><input type="checkbox" disabled={!am} checked={g("autoMuteOnlyIfMprisActive", false)} onChange={(e) => set("autoMuteOnlyIfMprisActive", e.target.checked)} /></Row>
        <Row label="Fade out after (ms)" hint="how long other audio has to play before the wallpaper steps aside" disabled={!am} rk="autoMuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoMuteDelayMs", 500)} onChange={(v) => set("autoMuteDelayMs", v)} /></Row>
        <Row label="Come back after (ms)" hint="how long things must stay quiet before the wallpaper's sound returns — a couple of seconds stops it flickering between songs" disabled={!am} rk="autoUnmuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoUnmuteDelayMs", 2000)} onChange={(v) => set("autoUnmuteDelayMs", v)} /></Row>
        <Row label="Ignore sounds below (dB)" hint="anything quieter than this doesn't count as other audio" disabled={!am} rk="autoMuteMinLevelDb"><NumInput disabled={!am} min={-80} max={0} value={g("autoMuteMinLevelDb", -70)} onChange={(v) => set("autoMuteMinLevelDb", v)} /></Row>
      </Section>

      <Section title="Playback" icon={<SlidersHorizontal size={15} />}>
        {liascapeActive && <Row label="Pause behind windows" hint={ROT_HINT.cover} rk="pauseWhenCovered">
          <Select value={g("pauseWhenCovered", "maximized")} onChange={(v) => set("pauseWhenCovered", v)}
            options={[{ value: "off", label: "Off" }, { value: "fullscreen", label: "A fullscreen window" }, { value: "maximized", label: "A fullscreen or maximized window" }]} /></Row>}
        <Row label="Loop videos" hint="a lone video starts over when it ends" rk="loop"><input type="checkbox" checked={g("loop", true)} onChange={(e) => set("loop", e.target.checked)} /></Row>
        <Row label="Playback speed" hint={`${g("speed", 1)}×`} rk="speed"><input type="range" min={0.1} max={4} step={0.1} value={g("speed", 1)} onChange={(e) => { set("speed", +e.target.value); previewGlobal({ speed: +e.target.value }); }} /></Row>
        <Row label="Stay paused when switching" hint="next / previous / random while paused — off: it plays again and the switch gets its transition; on: it stays paused and cuts straight to the new wallpaper's first frame" rk="stayPausedWhenSwitching">
          <input type="checkbox" checked={g("stayPausedWhenSwitching", false)} onChange={(e) => set("stayPausedWhenSwitching", e.target.checked)} /></Row>
        <Row label="Disable video cache" hint="read videos straight from disk instead of buffering ahead" rk="disableCache"><input type="checkbox" checked={g("disableCache", false)} onChange={(e) => set("disableCache", e.target.checked)} /></Row>
        <Row label="Restart legacy player every (s)" hint="the legacy player (mpvpaper) leaks memory over time; restarting it now and then keeps that in check · 0 = never" rk="restartMpvpaperEverySeconds"><NumInput min={0} max={3600} value={g("restartMpvpaperEverySeconds", 600)} onChange={(v) => set("restartMpvpaperEverySeconds", v)} /></Row>
        <Row label="Only restart between wallpapers" hint="wait for the next switch instead of restarting mid-video (no flash); a lone video still restarts" rk="restartOnlyAtPlaylistChangeover"><input type="checkbox" checked={g("restartOnlyAtPlaylistChangeover", false)} onChange={(e) => set("restartOnlyAtPlaylistChangeover", e.target.checked)} /></Row>
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
        <Row label="Transitions" hint="a little animation between wallpapers" rk="globalTransitionEnabled">
          <button className="btn ghost ico" onClick={() => setTrPicker(true)}><Sparkles size={14} />
            {trVal.transitionEnabled ? `On · ${trVal.transitionEffectIds.length}` : "Off"}</button>
        </Row>
        <Row label="When the playlist starts again" hint={(plStart === "resume" ? ROT_HINT.startResume : ROT_HINT.startOver) + (playlistPlaying ? ` · ${ROT_HINT.startLive}` : "")} rk="globalPlaylistStart">
          <Select value={plStart} onChange={(v) => set("globalPlaylistStart", v)}
            options={[{ value: "start_over", label: "Start over" }, { value: "resume", label: "Resume where it left off" }]} /></Row>
        <Row label="Add new wallpapers to the playlist" hint="anything you add to the library joins the playlist too" rk="autoAddLibraryToPlaylist"><input type="checkbox" checked={g("autoAddLibraryToPlaylist", false)} onChange={(e) => set("autoAddLibraryToPlaylist", e.target.checked)} /></Row>
        <Row label="When no monitor shows the wallpaper" hint={ROT_HINT.parked} rk="rotateWhileParked">
          <Select value={g("rotateWhileParked", true) ? "rotate" : "hold"} onChange={(v) => set("rotateWhileParked", v === "rotate")}
            options={[{ value: "rotate", label: "Keep rotating" }, { value: "hold", label: "Hold until a monitor returns" }]} /></Row>
      </Section>
      <TransitionPicker open={trPicker} value={trVal} onChange={trChange} onClose={() => setTrPicker(false)} title="Global Transitions" />

      <Section title="Video" icon={<Cpu size={15} />} lv="standard">
        <Row label="Fit to screen" hint="Fill covers the whole screen (trims the edges if the shape differs); Fit shows the whole video (bars if it differs)" rk="videoScale">
          <Select value={g("videoScale", "fill")} onChange={(v) => set("videoScale", v)}
            options={[{ value: "fill", label: "Fill" }, { value: "fit", label: "Fit" }]} />
        </Row>
        <Row label="Video frame rate cap" hint="0 = no cap · videos only — scenes have their own, per monitor" rk="videoFpsCap"><NumInput min={0} max={480} value={g("videoFpsCap", 0)} onChange={(v) => set("videoFpsCap", v)} /></Row>
        <Row label="Hardware decoding" hint="let the GPU decode video (auto picks what works)" rk="hwDec">
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
          <Row label="Ease off heavy scenes" hint="if a scene makes your GPU stutter, it runs at a lower frame rate until things calm down — off: every scene keeps its set frame rate" rk="autoThrottleScenes">
            <input type="checkbox" checked={g("autoThrottleScenes", true)} onChange={(e) => set("autoThrottleScenes", e.target.checked)} /></Row>
          <Row label="When video memory runs low" hint="when a game grabs the GPU's memory: Stop frees the wallpaper's memory and shows its last frame, Pause only pauses — both pick up again once there's room" rk="vramLowMode">
            <Select value={g("vramLowMode", "stop")} onChange={(v) => set("vramLowMode", v)}
              options={[{ value: "stop", label: "Stop (free memory)" }, { value: "pause", label: "Pause" }, { value: "off", label: "Off" }]} /></Row>
          <Row label="Cap each scene's video memory" hint="stop a scene that uses more video memory than the cap (a playlist moves on; a single wallpaper keeps its last frame) — it isn't counted as a crash" rk="limitVramPerScene">
            <input type="checkbox" checked={g("limitVramPerScene", false)} onChange={(e) => set("limitVramPerScene", e.target.checked)} /></Row>
          {g("limitVramPerScene", false) && <Row label="Video memory cap (MiB)" hint="per scene · about 1536 suits most scenes" rk="sceneVramLimitMib">
            <NumInput min={64} max={1048576} step={64} value={g("sceneVramLimitMib", 1536)} onChange={(v) => set("sceneVramLimitMib", v)} /><span>MiB</span></Row>}
          {engine?.vram?.low_active && <Help>Video memory is low right now — the wallpaper is {engine.vram.mode === "stop" ? "stopped (its memory freed)" : "paused"} until it frees up.</Help>}
        </Section>
      )}

      <Section title="Look & feel" icon={<Palette size={15} />}>
        <Row label="Theme" onReset={() => applyTheme(SETTINGS_DEFAULTS.theme as string)} deviated={themeName !== SETTINGS_DEFAULTS.theme}>
          <Select value={themeName} onChange={(v) => applyTheme(v)}
            options={themes.map((t) => ({ value: t.name, label: t.name }))} />
        </Row>
        <Row label="Card size" rk="cardSize">
          <Select value={g("cardSize", "Medium")} onChange={(v) => set("cardSize", v)}
            options={["Small", "Medium", "Large"].map((x) => ({ value: x, label: x }))} />
        </Row>
        <Row label="Card shape" rk="thumbnailAspect">
          <Select value={g("thumbnailAspect", "1:1")} onChange={(v) => set("thumbnailAspect", v)}
            options={[{ value: "1:1", label: "Square" }, { value: "16:9", label: "Widescreen" }]} />
        </Row>
        <Row label="Glow effects" hint="the soft accent glow on hovered, active and playing things — off keeps everything readable, just without the glow" rk="glows"><input type="checkbox" checked={g("glows", true)} onChange={(e) => set("glows", e.target.checked)} /></Row>
        <Row label="Smooth window animations" hint="cards morph into their settings window — off simply fades it in" rk="morphs"><input type="checkbox" checked={g("morphs", true)} onChange={(e) => set("morphs", e.target.checked)} /></Row>
        <Row label="Animate GIF previews" rk="autoPlayGifs"><input type="checkbox" checked={g("autoPlayGifs", false)} onChange={(e) => set("autoPlayGifs", e.target.checked)} /></Row>
        <Row label="Play video previews" hint="wallpapers with only a still thumbnail play a little preview without hovering — just the ones on screen, at most 4 at a time" rk="autoPlayVideoThumbs"><input type="checkbox" checked={g("autoPlayVideoThumbs", false)} onChange={(e) => set("autoPlayVideoThumbs", e.target.checked)} /></Row>
        <Row label="Wallpaper behind every tab" hint="show the live wallpaper behind Browse and Library too (it peeks through between the cards)" rk="liveWallpaperBehindAllTabs"><input type="checkbox" checked={g("liveWallpaperBehindAllTabs", false)} onChange={(e) => set("liveWallpaperBehindAllTabs", e.target.checked)} /></Row>
      </Section>

      <Section title="Wallpaper Engine" icon={<Layers size={15} />}>
        <Row label="Workshop folder" hint="where Steam keeps your Wallpaper Engine downloads">
          <input className="text" value={g("workshopFolder", "")} onChange={(e) => set("workshopFolder", e.target.value)} />
          <button className="btn ghost ico" onClick={() => pickInto("workshopFolder", "folder")}><FolderOpen size={14} /> Browse</button>
        </Row>
        <Row label="Play scenes" hint="Wallpaper Engine's interactive scene wallpapers — needs Wallpaper Engine installed for its assets" rk="allowScenes"><input type="checkbox" checked={g("allowScenes", false)} onChange={(e) => set("allowScenes", e.target.checked)} /></Row>
        <Row label="Import new Workshop wallpapers" hint="anything new in the Workshop folder lands in your library by itself" rk="autoAddWeWallpapersToLibrary"><input type="checkbox" checked={g("autoAddWeWallpapersToLibrary", false)} onChange={(e) => set("autoAddWeWallpapersToLibrary", e.target.checked)} /></Row>
        <Row label="Copy files instead of linking" hint="copy Workshop files into the library instead of linking to them (uses more disk)" rk="copyFilesInsteadOfSymlinking"><input type="checkbox" checked={g("copyFilesInsteadOfSymlinking", false)} onChange={(e) => set("copyFilesInsteadOfSymlinking", e.target.checked)} /></Row>
        <Row label="Replace direct downloads with Workshop copies" hint="when a wallpaper you downloaded directly shows up in the Workshop folder, switch to that one and free the duplicate's disk space" rk="replaceDirectWithWorkshop"><input type="checkbox" checked={g("replaceDirectWithWorkshop", false)} onChange={(e) => set("replaceDirectWithWorkshop", e.target.checked)} /></Row>
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
        {/* four ways, one radio group (owner 2026-11-11 "why is this a checkbox" — the Steam app route had been a switch inside
            Subscribe via Steam; then "should have 4 options not 3, the 4th being the one which opens the wallpaper in your app" —
            opening the page had only been Subscribe's silent fallback) */}
        <Row label="Use the Steam app" hint="one click, real progress — Steam shows you as playing Wallpaper Engine for those seconds" wk="workshopDownloadMode">
          <input type="radio" data-wsmode="steamapp" checked={mode === "steamapp"} onChange={() => set("workshopDownloadMode", "steamapp")} /></Row>
        <Row label="Open in the Steam app" hint="the wallpaper's page opens in Steam — click Subscribe there and it downloads">
          <input type="radio" data-wsmode="steampage" checked={mode === "steampage"} onChange={() => set("workshopDownloadMode", "steampage")} /></Row>
        <Row label="Subscribe with your Steam sign-in" hint="subscribes from here — sign in once with QR or a password">
          <input type="radio" data-wsmode="subscribe" checked={mode === "subscribe"} onChange={() => set("workshopDownloadMode", "subscribe")} /></Row>
        <Row label="Download via steamcmd" hint="a one-off copy, no syncing" wk="workshopDownloadMode">
          <input type="radio" data-wsmode="steamcmd" checked={mode === "steamcmd"} onChange={() => set("workshopDownloadMode", "steamcmd")} /></Row>
        {mode === "steamapp" && (
          <Help>Needs Steam running and Wallpaper Engine in your Steam account. Steam subscribes, downloads and keeps it updated —
            nothing to sign in to here. If Steam can't be reached, it says so — it never switches to another way by itself.</Help>
        )}
        {mode === "subscribe"
          /* Signing in is optional (owner 2026-11-11: "is it a dead end for users without mobile guard?"): without a usable
             sign-in a Download opens the item in the Steam app, where the user clicks Subscribe (WorkshopDownloader) — so the
             row says what happens either way. Sign in with QR (the Steam mobile app) or with a password (SteamPasswordModal). */
          ? <Row label="Steam">
              {steam?.signedIn && !steam.rejected
                ? <div className="hms" data-steam-state="signed-in"><span className="shint">Signed in as <b>{steam.accountName}</b> · ~{steam.daysLeft}d left</span>
                    <button className="btn ghost" onClick={signoutSteam}>Sign out</button></div>
                : <div className="hms" data-steam-state={steam?.signedIn ? "rejected" : "signed-out"} data-steam-rejected={steam?.signedIn ? "" : undefined}>
                    {steam?.signedIn
                      /* Steam ended the saved sign-in (backend `SteamSignInRejected`, set when finalizelogin answers AccessDenied) —
                         it used to keep saying "Signed in as …" while every download failed (owner 2026-11-11) */
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
                <button className="btn ghost ico" onClick={() => pickInto("steamCmdPath", "file")}><FolderOpen size={14} /> Browse</button>
              </Row>
              <Row label="Steam username"><input className="text" value={g("steamUsername", "")} onChange={(e) => set("steamUsername", e.target.value)} /></Row>
              <Row label="One-time sign-in" hint="opens a terminal; steamcmd remembers you after"><button className="btn accent" onClick={steamcmdSignin}>Sign in (one-time)</button></Row>
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
            : wantPlayer && engine.active !== "liascape-player" ? "liascape-player selected but not running — " + (engine.reason ?? "starting…")
            : wantPlayer && engine.reason ? engine.reason
            : "what draws the wallpaper. liascape-player is the new all-in-one player (experimental — scenes need Wallpaper Engine installed for its assets). Switches live.";
          return <Row label="Player engine" hint={hint} disabled={off} rk="playerEngine">
            <Select value={g("playerEngine", "legacy")} disabled={off} onChange={(v) => set("playerEngine", v)}
              options={[{ value: "legacy", label: "Legacy" }, { value: "liascape-player", label: "liascape-player (experimental)" }]} />
          </Row>;
        })()}
        <Row label="Transition style" hint="how a switch animates — Reveal: the old one freezes while the new one plays (recommended); Frozen: both hold still; Full-live: both keep playing (heavy at 4K). Warp-style effects fall back to Frozen in Reveal." rk="transitionMethod">
          <Select value={g("transitionMethod", "reveal")} onChange={(v) => set("transitionMethod", v)}
            options={[{ value: "reveal", label: "Reveal (live B)" }, { value: "frozen", label: "Frozen" }, { value: "full-live", label: "Full-live" }]} />
        </Row>
        {g<string>("transitionMethod", "reveal") === "full-live" && <Row label="Full-live sync nudge" hint="Full-live only: shifts the outgoing video this many ms against the live one to cancel drift on your machine (negative = ahead). A slight rewind → raise it toward 0; a slight skip ahead → lower it. About −30 is typical." rk="fullLiveSyncOffsetMs">
          <NumInput min={-200} max={200} step={5} value={g("fullLiveSyncOffsetMs", -30)} onChange={(v) => set("fullLiveSyncOffsetMs", v)} /><span>ms</span>
        </Row>}
        <Row label="Volume keys change" hint="what the volume up / down shortcuts move — Auto: the playing wallpaper's own volume if it has one, else the global one; This wallpaper: always its own (gives it one); Global: always the global one (a wallpaper with its own volume stays put)" rk="volumeKeyTarget">
          <Select value={g("volumeKeyTarget", "auto")} onChange={(v) => set("volumeKeyTarget", v)}
            options={[{ value: "auto", label: "Auto" }, { value: "item", label: "This wallpaper" }, { value: "global", label: "Global" }]} />
        </Row>
        <Row label="Debug mode" hint="turns on the liascapeDbg bridge and performance metrics" rk="debugMode"><input type="checkbox" checked={g("debugMode", false)} onChange={(e) => set("debugMode", e.target.checked)} /></Row>
        {g("debugMode", false) && <Row label="Show debug overlay" hint="the on-screen FPS / metrics readout" rk="debugOverlay"><input type="checkbox" checked={g("debugOverlay", true)} onChange={(e) => set("debugOverlay", e.target.checked)} /></Row>}
      </Section>

      <Section title="mpv command (live)" icon={<Terminal size={15} />} lv="expert">
        <pre className="mpv">{mpv || "…"}</pre>
      </Section>

      <Section title="linux-wallpaperengine command (live)" icon={<Terminal size={15} />} lv="expert">
        <Help>The scene command, one line per monitor; each scene's Workshop ID goes on the end.</Help>
        <pre className="mpv">{lwe || "…"}</pre>
      </Section>

      <Section title="Keyboard shortcuts" icon={<Keyboard size={15} />} lv="standard">
        <Help>Bind these commands to keys in your compositor's config.</Help>
        {actions.map((a) => (
          <Row key={a} label={a} hint={actionHint[a]}>
            <code className="kb">liascape {a.replace("volume-", "volume ")}</code>
            <button className="mini" onClick={() => navigator.clipboard?.writeText(`liascape ${a.replace("volume-", "volume ")}`)}>copy</button>
          </Row>
        ))}
        <Row label="Autostart"><code className="kb">liascape restore</code>
          <button className="mini" onClick={() => navigator.clipboard?.writeText("liascape restore")}>copy</button></Row>
      </Section>

      <Section title="Housekeeping" icon={<LibraryIcon size={15} />}>
        <Row label="Clear thumbnail cache" hint="thumbnails and previews download again as needed">
          <button className="btn ghost" onClick={() => clearCache()}>Clear Cache</button>
        </Row>
        <Row label="Reset all settings" hint="every setting back to its default" lv="standard">
          <div className="hms">
            {wipeArm < 0 && <button className="btn danger" onClick={() => setWipeArm(3)}>Reset Settings</button>}
            {wipeArm > 0 && <button className="btn danger" disabled>Reset in {wipeArm}s…</button>}
            {wipeArm === 0 && <button className="btn danger solid glow-pulse" onClick={() => { resetAllSettings(); setWipeArm(-1); }}>Confirm — reset all</button>}
            {wipeArm >= 0 && <button className="btn ghost" onClick={() => setWipeArm(-1)}>Cancel</button>}
          </div>
        </Row>
        <Row label="Forget the whole library" hint="removes every wallpaper from the library — no undo" lv="standard">
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
