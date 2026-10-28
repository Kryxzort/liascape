import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderOpen, X, RotateCcw, SlidersHorizontal, Repeat, VolumeX, Cpu, Palette, AlertTriangle,
  Layers, MonitorSmartphone, Download, Terminal, Keyboard, Library as LibraryIcon, Wrench, Sparkles, Gauge,
} from "lucide-react";
import { useStore, SETTINGS_DEFAULTS } from "../store";
import { api, type FeatureHealth } from "../api/client";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { Select } from "../components/Select";
import { Combo } from "../components/Combo";
import { NumInput } from "../components/NumInput";
import { TransitionPicker, type TransitionValue } from "../components/TransitionPicker";
import { PlayTimeInput, ROT_HINT } from "../components/PlayTimeInput";

// Electron preload (app/shell/preload.js) exposes native dialogs; null in a browser → text entry only.
const lp = (window as unknown as { lp?: { pickFolder?: () => Promise<string | null>; pickFile?: () => Promise<string | null> } }).lp;

// reads/writes go through the store's settings object (camelCase, mirrors AppSettings).
function useS() {
  const settings = useStore((s) => s.settings) ?? {};
  const setSetting = useStore((s) => s.setSetting);
  const g = <T,>(k: string, d: T): T => (settings[k] as T) ?? d;
  return { g, set: setSetting, settings };
}

// API: /health/features — a feature a missing build piece / tool breaks here puts a warning icon (its reason as the
// tooltip) on every row whose settings key it `affects` (owner: "make missing libraries fail loudly"). The control
// itself stays visible and usable; only `ok === false` warns (null = not known yet).
type Warn = { label: string; reason: string };
const HealthCtx = createContext<Map<string, Warn[]>>(new Map());
function healthWarnings(features: FeatureHealth[]): Map<string, Warn[]> {
  const m = new Map<string, Warn[]>();
  for (const f of features) if (f.ok === false)
    for (const k of f.affects) m.set(k, [...(m.get(k) ?? []), { label: f.label, reason: f.reason ?? `${f.label} can't work here` }]);
  return m;
}
function WarnIcon({ k }: { k?: string }) {
  const w = useContext(HealthCtx).get(k ?? "");
  if (!k || !w?.length) return null;
  const text = w.map((x) => x.reason).join("\n");
  return <span className="s-warn" title={text} aria-label={text} data-feature-warn={k}><AlertTriangle size={13} /></span>;
}

// `rk` (+ optional `def`) ties a row to a settings key: a reset icon appears ONLY when the current
// value deviates from its default (SETTINGS_DEFAULTS), and resets that one setting. `onReset`/`deviated`
// cover non-settings-backed rows (e.g. Theme, applied via applyTheme not setSetting). `wk` = the key whose
// feature warnings (WarnIcon) the row shows, when it has no `rk`.
function Row({ label, hint, disabled, rk, wk, def, deviated, onReset, children }: {
  label: string; hint?: string; disabled?: boolean;
  rk?: string; wk?: string; def?: unknown; deviated?: boolean; onReset?: () => void; children: React.ReactNode;
}) {
  const cur = useStore((s) => (rk ? s.settings?.[rk] : undefined));
  const set = useStore((s) => s.setSetting);
  const d = rk !== undefined ? (def ?? SETTINGS_DEFAULTS[rk]) : undefined;
  const show = onReset
    ? !!deviated
    : (rk !== undefined && cur !== undefined && JSON.stringify(cur) !== JSON.stringify(d));
  const reset = onReset ?? (() => { if (rk !== undefined) set(rk, d); });
  return (
    <div className={`srow${disabled ? " disabled" : ""}`}>
      <div className="slabel">
        <span className="slabel-row">{label}
          <WarnIcon k={wk ?? rk} />
          {show &&<button className="s-reset" title="Reset to default" onClick={reset}><RotateCcw size={12} /></button>}
        </span>
        {hint && <span className="shint">{hint}</span>}
      </div>
      <div className="sctl">{children}</div>
    </div>
  );
}
const Section = ({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) => (
  <div className="ssection">
    <h3>{icon && <span className="ssection-ico">{icon}</span>}{title}</h3>
    {children}
  </div>
);
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
  // lp-player availability for the "Player engine" row (binary found? last start error?)
  const [engine, setEngine] = useState<{ active: string; available: boolean; reason: string | null;
    scenes?: { available: boolean; reason: string | null; assets_dir: string | null };
    vram?: { low_active: boolean | null; mode: string } | null } | null>(null);
  // lp-player draws the wallpaper: one scene worker shared by every output (no per-monitor primary),
  // no scene-load lead (it switches when the scene's first frame is in), the fps applies live
  const lpActive = engine?.active === "lp-player";

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.mpvPreview().then((x) => alive && setMpv(x));
      api.lwePreview().then((x) => alive && setLwe(x));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [g("loop", true), g("noAudio", false), g("disableCache", false), g("volume", 100), g("speed", 1), g("hwDec", "auto"), g("videoScale", "fill"), g("demuxerMaxBytes", 20), g("demuxerMaxBackBytes", 5), JSON.stringify(g("lweMonitors", []))]); // eslint-disable-line

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
  // under lp-player: the low-VRAM status (GPU / VRAM section) follows the player while Settings is open
  useEffect(() => {
    if (!lpActive) return;
    const t = setInterval(() => api.playerEngine().then(setEngine).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [lpActive]);
  // missing build pieces / tools (API: /health/features) → warning icons on the rows they break + the summary;
  // re-read after a change that can move them (engine, scenes, steamcmd) and every 15 s while open (a player that
  // started meanwhile reports its GPU interop / VRAM probe)
  const [features, setFeatures] = useState<FeatureHealth[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => api.featureHealth().then((r) => alive && setFeatures(r.features ?? [])).catch(() => {});
    const t0 = setTimeout(read, 300), t = setInterval(read, 15000);
    return () => { alive = false; clearTimeout(t0); clearInterval(t); };
  }, [g("playerEngine", "legacy"), g("allowScenes", false), g("steamCmdPath", ""), g("workshopAcquireMode", "subscribe")]); // eslint-disable-line
  const warnings = useMemo(() => healthWarnings(features), [features]);
  // the summary: what breaks something switched on / selected now (the row icons show regardless)
  const broken = features.filter((f) => f.ok === false && f.inUse !== false);

  // the rotation: "Switch when video ends" off → the interval is "Switch every" (a plain timer); on → the SAME field
  // is "Minimum play time", with "Maximum play time" right below (player-adapter.md § Rotation)
  const aoe = g("globalAdvanceOnVideoEnd", true);

  const adv = g("advancedSettings", false); // gates demuxer / hw-decode / cache / copy-files / live previews
  type Mon = { name: string; fps: number; isPrimary: boolean };
  const monitors = g<Mon[]>("lweMonitors", []);
  const setMonitors = (m: Mon[]) => set("lweMonitors", m);
  // Auto-populate the scene monitor list from detected outputs the first time scenes are enabled
  // (empty list). First detected output = primary. Won't clobber a list the user already configured.
  useEffect(() => {
    if (!g("allowScenes", false) || !detected.length || monitors.length) return;
    setMonitors(detected.map((d) => ({ name: d.name, fps: d.refreshHz, isPrimary: d.primary })));
  }, [detected, g("allowScenes", false)]); // eslint-disable-line

  const mode = g<string>("workshopAcquireMode", "subscribe");
  const mute = g("noAudio", false);          // disables the volume row (parity: muted = no volume)
  const am = g("autoMute", false);           // gates the auto-mute children

  // (live wallpaper bg is now rendered at App level via <WallpaperBg> — Settings always shows it, and
  // the "Live wallpaper behind all tabs" advanced toggle extends it to Browse/Library)
  const pickInto = async (key: string, kind: "folder" | "file") => {
    const p = await (kind === "folder" ? lp?.pickFolder?.() : lp?.pickFile?.());
    if (p) set(key, p);
  };

  const actions = ["toggle-mute", "toggle-pause", "stop", "play", "toggle-play",
    "next-wallpaper", "previous-wallpaper", "random", "volume-up", "volume-down"];

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
      <Section title="Playback" icon={<SlidersHorizontal size={15} />}>
        <Row label="Loop" rk="loop"><input type="checkbox" checked={g("loop", true)} onChange={(e) => set("loop", e.target.checked)} /></Row>
        <Row label="Mute audio" rk="noAudio"><input type="checkbox" checked={mute} onChange={(e) => set("noAudio", e.target.checked)} /></Row>
        {adv && <Row label="Disable cache" rk="disableCache"><input type="checkbox" checked={g("disableCache", false)} onChange={(e) => set("disableCache", e.target.checked)} /></Row>}
        <Row label="Volume" hint={mute ? "muted" : `${g("volume", 100)}`} disabled={mute} rk="volume">
          <input type="range" min={0} max={100} value={g("volume", 100)} disabled={mute} onChange={(e) => { set("volume", +e.target.value); previewGlobal({ volume: +e.target.value }); }} /></Row>
        <Row label="Normalize audio" hint={"match perceived loudness across wallpapers (EBU R128) so switching wallpapers doesn't jump in volume — per-video & global volume still apply on top. Each video is measured once (in the background) the first time it plays." + (lpActive ? " A scene learns its loudness over its first minute of play, then is matched from that moment on." : "")} disabled={mute} rk="normalizeAudio">
          <input type="checkbox" checked={g("normalizeAudio", false)} disabled={mute} onChange={(e) => set("normalizeAudio", e.target.checked)} /></Row>
        {!mute && g("normalizeAudio", false) && <Row label="Target loudness" hint="LUFS (dB-referenced loudness); −14 = streaming standard, lower = quieter. Pick a preset or type your own. Every video is matched to this level." rk="normalizeTargetLufs">
          <Combo value={g("normalizeTargetLufs", -14) as number} min={-100} max={0} step={1}
            onChange={(v) => set("normalizeTargetLufs", v)}
            options={[{ value: -11, label: "Loud (−11)" }, { value: -14, label: "Streaming (−14)" }, { value: -19, label: "Quiet (−19)" }, { value: -23, label: "Broadcast (−23)" }]} /><span>LUFS</span></Row>}
        <Row label="Speed" hint={`${g("speed", 1)}×`} rk="speed"><input type="range" min={0.1} max={4} step={0.1} value={g("speed", 1)} onChange={(e) => { set("speed", +e.target.value); previewGlobal({ speed: +e.target.value }); }} /></Row>
        {adv && <Row label="Stay paused when switching" hint="next / previous / random while paused — off: playback resumes and the switch plays its transition; on: it stays paused, the switch is a cut to the new wallpaper's first frame" rk="keepPauseOnSwitch">
          <input type="checkbox" checked={g("keepPauseOnSwitch", false)} onChange={(e) => set("keepPauseOnSwitch", e.target.checked)} /></Row>}
        <Row label="Restart mpvpaper every (s)" hint="0 = off" rk="restartIntervalSeconds"><NumInput min={0} max={3600} value={g("restartIntervalSeconds", 600)} onChange={(v) => set("restartIntervalSeconds", v)} /></Row>
        {adv && <Row label="Restart only at playlist changeover" hint="defer the restart to the next video change (no mid-video flash); lone videos still restart" rk="restartOnSwitchOnly"><input type="checkbox" checked={g("restartOnSwitchOnly", false)} onChange={(e) => set("restartOnSwitchOnly", e.target.checked)} /></Row>}
        <Help>Kills and relaunches mpvpaper periodically to prevent memory leaks.</Help>
      </Section>

      <Section title="Rotation (global)" icon={<Repeat size={15} />}>
        <Row label="Switch when video ends" rk="globalAdvanceOnVideoEnd"><input type="checkbox" checked={aoe} onChange={(e) => set("globalAdvanceOnVideoEnd", e.target.checked)} /></Row>
        {aoe ? <>
          <Row label="Minimum play time" hint={ROT_HINT.min} rk="globalIntervalSeconds">
            <PlayTimeInput label="Minimum play time" zeroText="none" value={g("globalIntervalSeconds", 0)} onChange={(v) => set("globalIntervalSeconds", v)} /></Row>
          <Row label="Maximum play time" hint={ROT_HINT.max} rk="globalMaxPlaySeconds">
            <PlayTimeInput label="Maximum play time" zeroText="off" value={g("globalMaxPlaySeconds", 1800)} onChange={(v) => set("globalMaxPlaySeconds", v)} /></Row>
        </> : <Row label="Switch every" hint={ROT_HINT.every} rk="globalIntervalSeconds">
          <PlayTimeInput label="Switch every" value={g("globalIntervalSeconds", 0)} onChange={(v) => set("globalIntervalSeconds", v)} /></Row>}
        <Row label="Auto-add new library items to playlist" rk="autoAddLibraryToPlaylist"><input type="checkbox" checked={g("autoAddLibraryToPlaylist", false)} onChange={(e) => set("autoAddLibraryToPlaylist", e.target.checked)} /></Row>
        <Row label="Transitions" hint="animated effect between wallpaper switches" rk="globalTransitionEnabled">
          <button className="btn ghost ico" onClick={() => setTrPicker(true)}><Sparkles size={14} />
            {trVal.transitionEnabled ? `On · ${trVal.transitionEffectIds.length}` : "Off"}</button>
        </Row>
      </Section>
      <TransitionPicker open={trPicker} value={trVal} onChange={trChange} onClose={() => setTrPicker(false)} title="Global Transitions" />

      <Section title="Auto-Mute" icon={<VolumeX size={15} />}>
        <Row label="Mute when system audio plays" rk="autoMute"><input type="checkbox" checked={am} onChange={(e) => set("autoMute", e.target.checked)} /></Row>
        <Row label="Only if MPRIS player active" disabled={!am} rk="autoMuteOnlyIfMprisActive"><input type="checkbox" disabled={!am} checked={g("autoMuteOnlyIfMprisActive", false)} onChange={(e) => set("autoMuteOnlyIfMprisActive", e.target.checked)} /></Row>
        <Row label="Mute after (ms)" disabled={!am} rk="autoMuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoMuteDelayMs", 200)} onChange={(v) => set("autoMuteDelayMs", v)} /></Row>
        <Row label="Unmute after (ms)" disabled={!am} rk="autoUnmuteDelayMs"><NumInput disabled={!am} min={0} max={30000} value={g("autoUnmuteDelayMs", 2000)} onChange={(v) => set("autoUnmuteDelayMs", v)} /></Row>
        <Row label="Min level (dB)" disabled={!am} rk="autoMuteThresholdDb"><NumInput disabled={!am} min={-80} max={0} value={g("autoMuteThresholdDb", -70)} onChange={(v) => set("autoMuteThresholdDb", v)} /></Row>
      </Section>

      <Section title="Rendering & Memory" icon={<Cpu size={15} />}>
        {adv && (
          <Row label="Hardware decoding" rk="hwDec">
            <Select value={g("hwDec", "auto")} onChange={(v) => set("hwDec", v)}
              options={["auto", "nvdec", "vaapi", "no"].map((x) => ({ value: x, label: x }))} />
          </Row>
        )}
        <Row label="Video scale" rk="videoScale">
          <Select value={g("videoScale", "fill")} onChange={(v) => set("videoScale", v)}
            options={[{ value: "fill", label: "fill" }, { value: "fit", label: "fit" }]} />
        </Row>
        <Row label="Video FPS cap" hint="0 = native · applies to videos, not scenes" rk="videoFps"><NumInput min={0} max={480} value={g("videoFps", 0)} onChange={(v) => set("videoFps", v)} /></Row>
        {adv && <Row label="Demuxer max (MiB)" rk="demuxerMaxBytes"><NumInput min={1} max={10000} value={g("demuxerMaxBytes", 20)} onChange={(v) => set("demuxerMaxBytes", v)} /></Row>}
        {adv && <Row label="Demuxer max back (MiB)" rk="demuxerMaxBackBytes"><NumInput min={1} max={10000} value={g("demuxerMaxBackBytes", 5)} onChange={(v) => set("demuxerMaxBackBytes", v)} /></Row>}
      </Section>

      {/* lp-player only (the player owns the GPU budget + both VRAM rules); every row applies live
          (API: /settings → player.scene_throttle / scene_vram_limit_mib / vram_low_mode) */}
      {lpActive && (
        <Section title="GPU / VRAM" icon={<Gauge size={15} />}>
          <Row label="Auto-throttle scenes" hint="lower a scene's frame rate while it makes the GPU miss frames, and restore it when it recovers — off: every scene renders at its fixed fps" rk="sceneThrottle">
            <input type="checkbox" checked={g("sceneThrottle", true)} onChange={(e) => set("sceneThrottle", e.target.checked)} /></Row>
          <Row label="Limit VRAM per scene" hint="stop a scene that uses more video memory than the limit (a playlist moves on; a single wallpaper keeps its last frame) — it isn't marked crashed" rk="sceneVramLimitEnabled">
            <input type="checkbox" checked={g("sceneVramLimitEnabled", false)} onChange={(e) => set("sceneVramLimitEnabled", e.target.checked)} /></Row>
          {g("sceneVramLimitEnabled", false) && <Row label="VRAM limit (MiB)" hint="per scene · ~1536 suits most scenes" rk="sceneVramLimitMib">
            <NumInput min={64} max={1048576} step={64} value={g("sceneVramLimitMib", 1536)} onChange={(v) => set("sceneVramLimitMib", v)} /><span>MiB</span></Row>}
          <Row label="When VRAM runs low" hint="when the GPU's free video memory runs out (a game took it): Stop frees the wallpaper's GPU memory and shows its last frame, Pause only pauses — either resumes once memory is free again" rk="vramLowMode">
            <Select value={g("vramLowMode", "stop")} onChange={(v) => set("vramLowMode", v)}
              options={[{ value: "stop", label: "Stop (free memory)" }, { value: "pause", label: "Pause" }, { value: "off", label: "Off" }]} /></Row>
          {engine?.vram?.low_active && <Help>VRAM is low right now — the wallpaper is {engine.vram.mode === "stop" ? "stopped (its memory freed)" : "paused"} until it frees up.</Help>}
        </Section>
      )}

      <Section title="Appearance" icon={<Palette size={15} />}>
        <Row label="Theme" onReset={() => applyTheme(SETTINGS_DEFAULTS.theme as string)} deviated={themeName !== SETTINGS_DEFAULTS.theme}>
          <Select value={themeName} onChange={(v) => applyTheme(v)}
            options={themes.map((t) => ({ value: t.name, label: t.name }))} />
        </Row>
        <Row label="Thumbnail aspect" rk="thumbnailAspect">
          <Select value={g("thumbnailAspect", "1:1")} onChange={(v) => set("thumbnailAspect", v)}
            options={["1:1", "16:9"].map((x) => ({ value: x, label: x }))} />
        </Row>
        <Row label="Card size" rk="cardSize">
          <Select value={g("cardSize", "Medium")} onChange={(v) => set("cardSize", v)}
            options={["Small", "Medium", "Large"].map((x) => ({ value: x, label: x }))} />
        </Row>
        <Row label="Autoplay GIF thumbnails" rk="autoPlayGifs"><input type="checkbox" checked={g("autoPlayGifs", false)} onChange={(e) => set("autoPlayGifs", e.target.checked)} /></Row>
      </Section>

      <Section title="Wallpaper Engine" icon={<Layers size={15} />}>
        <Row label="Workshop folder">
          <input className="text" value={g("wallpaperEnginePath", "")} onChange={(e) => set("wallpaperEnginePath", e.target.value)} />
          <button className="btn ghost ico" title="Choose folder" onClick={() => pickInto("wallpaperEnginePath", "folder")}><FolderOpen size={14} /> Browse</button>
        </Row>
        {adv && <Row label="Copy files instead of symlinking" rk="weCopyFiles"><input type="checkbox" checked={g("weCopyFiles", false)} onChange={(e) => set("weCopyFiles", e.target.checked)} /></Row>}
        {adv && <Row label="Replace direct downloads with Workshop copies" hint="when a directly-downloaded wallpaper appears in the WE folder, swap to the WE symlink/copy & reclaim the duplicate's disk" rk="replaceDirectWithWorkshop"><input type="checkbox" checked={g("replaceDirectWithWorkshop", false)} onChange={(e) => set("replaceDirectWithWorkshop", e.target.checked)} /></Row>}
        <Row label="Allow scene support" rk="allowScenes"><input type="checkbox" checked={g("allowScenes", false)} onChange={(e) => set("allowScenes", e.target.checked)} /></Row>
        <Row label="Auto-add new WE wallpapers to library" rk="autoImportWallpaperEngine"><input type="checkbox" checked={g("autoImportWallpaperEngine", false)} onChange={(e) => set("autoImportWallpaperEngine", e.target.checked)} /></Row>
        {!lpActive && <Row label="Scene transition delay (ms)" rk="sceneTransitionDelayMs"><NumInput min={0} max={5000} value={g("sceneTransitionDelayMs", 1000)} onChange={(v) => set("sceneTransitionDelayMs", v)} /></Row>}
        {lpActive && g("allowScenes", false) && engine?.scenes && !engine.scenes.available && engine.scenes.reason &&
          <Help>Scenes can't play right now: {engine.scenes.reason}</Help>}
      </Section>

      {g("allowScenes", false) && (
        <Section title="Monitors (scenes)" icon={<MonitorSmartphone size={15} />}>
          <Help>Names of the monitors to play scenes on.{detected.length > 0
            ? <> Detected: {detected.map((d) => <code key={d.name} className="kb">{d.name} {d.refreshHz}Hz{d.primary ? " ★" : ""}</code>)} — type or pick below.</>
            : <> Auto-detect found none; on Hyprland run <code className="kb">hyprctl monitors</code> to list names (use the equivalent for your compositor).</>}</Help>
          <datalist id="lp-monitors">{detected.map((d) => <option key={d.name} value={d.name} />)}</datalist>
          {monitors.map((m, i) => (
            <Row key={i} label={`Monitor ${i + 1}`}>
              <div className="hms">
                <input className="text mon-name" list="lp-monitors" placeholder="e.g. DP-1" value={m.name}
                  onChange={(e) => setMonitors(monitors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <NumInput min={1} max={480} value={m.fps}
                  onChange={(v) => setMonitors(monitors.map((x, j) => j === i ? { ...x, fps: v } : x))} /><span>{lpActive ? "fps (live)" : "fps"}</span>
                {/* primary is one-of-N (exactly one monitor) → radio, like the Workshop download mode section;
                    legacy only (LWE's audio-owning instance) — lp-player runs one worker for every output */}
                {!lpActive && <label className="inline"><input type="radio" name="lwe-primary" checked={m.isPrimary}
                  onChange={() => setMonitors(monitors.map((x, j) => ({ ...x, isPrimary: j === i })))} /> primary</label>}
                <button className="mini ico" title="Remove monitor" onClick={() => setMonitors(monitors.filter((_, j) => j !== i))}><X size={14} /></button>
              </div>
            </Row>
          ))}
          <button className="btn ghost" onClick={() => {
            const used = new Set(monitors.map((m) => m.name));
            const next = detected.find((d) => !used.has(d.name));
            setMonitors([...monitors, { name: next?.name ?? `DP-${monitors.length + 1}`, fps: next?.refreshHz ?? 60, isPrimary: monitors.length === 0 }]);
          }}>+ Add monitor</button>
        </Section>
      )}

      <Section title="Workshop download mode" icon={<Download size={15} />}>
        <Row label="Subscribe via Steam" hint="keeps synced + auto-updates">
          <input type="radio" checked={mode === "subscribe"} onChange={() => set("workshopAcquireMode", "subscribe")} /></Row>
        <Row label="Download via steamcmd" hint="snapshot, no sync" wk="workshopAcquireMode">
          <input type="radio" checked={mode === "steamcmd"} onChange={() => set("workshopAcquireMode", "steamcmd")} /></Row>
        {mode === "subscribe"
          ? <Row label="Steam">
              {steam?.signedIn
                ? <div className="hms"><span className="shint">Signed in as <b>{steam.accountName}</b> · ~{steam.daysLeft}d left</span>
                    <button className="btn ghost" onClick={signoutSteam}>Sign out</button></div>
                : <button className="btn accent" onClick={startQr}>Sign in with QR</button>}
            </Row>
          : <>
              <Help>Downloads a one-time snapshot via steamcmd. No online subscription. Requires steamcmd + one-time sign-in.</Help>
              <Row label="steamcmd path" hint="blank = auto-detect" wk="steamCmdPath">
                <input className="text" placeholder="/usr/bin/steamcmd" value={g("steamCmdPath", "")} onChange={(e) => set("steamCmdPath", e.target.value)} />
                <button className="btn ghost ico" title="Choose steamcmd binary" onClick={() => pickInto("steamCmdPath", "file")}><FolderOpen size={14} /> Browse</button>
              </Row>
              <Row label="Steam username"><input className="text" value={g("steamUsername", "")} onChange={(e) => set("steamUsername", e.target.value)} /></Row>
              <Row label="One-time sign-in" hint="caches sentry; opens a terminal"><button className="btn accent" onClick={steamcmdSignin}>Sign in (one-time)</button></Row>
            </>}
      </Section>

      <Section title="Advanced" icon={<Wrench size={15} />}>
        <Row label="Advanced settings" hint="show disable-cache, hardware decoding, demuxer, copy-files & the live command previews" rk="advancedSettings"><input type="checkbox" checked={adv} onChange={(e) => set("advancedSettings", e.target.checked)} /></Row>
        {adv && (() => {
          const wantLp = g<string>("playerEngine", "legacy") === "lp-player";
          // status not read yet → disabled ("checking…"); binary missing → disabled with the reason
          // (switching back to Legacy always stays possible)
          const loading = engine === null;
          const unavailable = !loading && !engine.available;
          const off = loading || (unavailable && !wantLp);
          const hint = loading ? "checking lp-player…"
            : unavailable ? engine.reason ?? "lp-player is not available"
            : wantLp && engine.active !== "lp-player" ? "lp-player selected but not running — " + (engine.reason ?? "starting…")
            : wantLp && engine.reason ? engine.reason
            : "which player draws the wallpaper. lp-player is the new all-in-one player (experimental — scenes need Wallpaper Engine installed for its assets). Switches live.";
          return <Row label="Player engine" hint={hint} disabled={off} rk="playerEngine">
            <Select value={g("playerEngine", "legacy")} disabled={off} onChange={(v) => set("playerEngine", v)}
              options={[{ value: "legacy", label: "Legacy" }, { value: "lp-player", label: "lp-player (experimental)" }]} />
          </Row>;
        })()}
        {adv && <Row label="Transition method" hint="how a wallpaper switch animates — Reveal: freeze the old, keep the new playing (recommended); Frozen: both sides still; Full-live: both play (heavy on 4K). Warp-style effects fall back to Frozen in Reveal." rk="transitionMethod">
          <Select value={g("transitionMethod", "reveal")} onChange={(v) => set("transitionMethod", v)}
            options={[{ value: "reveal", label: "Reveal (live B)" }, { value: "frozen", label: "Frozen" }, { value: "full-live", label: "Full-live" }]} />
        </Row>}
        {adv && g<string>("transitionMethod", "reveal") === "full-live" && <Row label="Full-live A-sync offset" hint="Full-live only: aim the outgoing video this many ms vs the live wallpaper at the cover, to cancel per-machine sync drift (negative = aim ahead). If you see a slight rewind raise it toward 0; a slight skip-ahead lower it. ~-30 here." rk="transitionLagOffsetMs">
          <NumInput min={-200} max={200} step={5} value={g("transitionLagOffsetMs", -30)} onChange={(v) => set("transitionLagOffsetMs", v)} /><span>ms</span>
        </Row>}
        {adv && <Row label="Volume keys adjust" hint="what the volume-up / volume-down keybinds change — Auto: the playing wallpaper's own volume if it has one, else the global; This wallpaper: always the playing wallpaper's own volume (gives it one); Global: always the global (a wallpaper with its own volume doesn't change)" rk="volumeKeyTarget">
          <Select value={g("volumeKeyTarget", "auto")} onChange={(v) => set("volumeKeyTarget", v)}
            options={[{ value: "auto", label: "Auto" }, { value: "item", label: "This wallpaper" }, { value: "global", label: "Global" }]} />
        </Row>}
        {adv && <Row label="Live wallpaper behind all tabs" hint="show the live wallpaper behind the grid on Browse & Library (visible in the gaps between cards)" rk="wallpaperBgAllTabs"><input type="checkbox" checked={g("wallpaperBgAllTabs", false)} onChange={(e) => set("wallpaperBgAllTabs", e.target.checked)} /></Row>}
        {adv && <Row label="Debug mode" hint="enable the lpdbg bridge + perf metrics" rk="debugMode"><input type="checkbox" checked={g("debugMode", false)} onChange={(e) => set("debugMode", e.target.checked)} /></Row>}
        {adv && g("debugMode", false) && <Row label="Show debug overlay" hint="the on-screen FPS / metrics HUD" rk="debugOverlay"><input type="checkbox" checked={g("debugOverlay", true)} onChange={(e) => set("debugOverlay", e.target.checked)} /></Row>}
      </Section>

      {adv && (
        <Section title="mpv options (live)" icon={<Terminal size={15} />}>
          <pre className="mpv">{mpv || "…"}</pre>
        </Section>
      )}

      {adv && (
        <Section title="linux-wallpaperengine options (live)" icon={<Terminal size={15} />}>
          <Help>Scene command (one line per configured monitor); the workshop ID is appended per scene.</Help>
          <pre className="mpv">{lwe || "…"}</pre>
        </Section>
      )}

      <Section title="Keybind reference" icon={<Keyboard size={15} />}>
        {actions.map((a) => (
          <Row key={a} label={a}>
            <code className="kb">livepaper --action={a}</code>
            <button className="mini" onClick={() => navigator.clipboard?.writeText(`livepaper --action=${a}`)}>copy</button>
          </Row>
        ))}
        <Row label="Autostart"><code className="kb">livepaper --restore</code>
          <button className="mini" onClick={() => navigator.clipboard?.writeText("livepaper --restore")}>copy</button></Row>
      </Section>

      <Section title="Library" icon={<LibraryIcon size={15} />}>
        <Row label="Resume from last on launch" rk="resumeFromLast"><input type="checkbox" checked={g("resumeFromLast", true)} onChange={(e) => set("resumeFromLast", e.target.checked)} /></Row>
        <Row label="Clear cache" hint="thumbnail/preview cache (re-downloads as needed)">
          <button className="btn ghost" onClick={() => clearCache()}>Clear Cache</button>
        </Row>
        <Row label="Clear settings" hint="reset all to defaults">
          <div className="hms">
            {wipeArm < 0 && <button className="btn danger" onClick={() => setWipeArm(3)}>Clear Settings</button>}
            {wipeArm > 0 && <button className="btn danger" disabled>Clear in {wipeArm}s…</button>}
            {wipeArm === 0 && <button className="btn danger solid glow-pulse" onClick={() => { resetAllSettings(); setWipeArm(-1); }}>Confirm — reset all</button>}
            {wipeArm >= 0 && <button className="btn ghost" onClick={() => setWipeArm(-1)}>Cancel</button>}
          </div>
        </Row>
        <Row label="Danger zone" hint="permanent">
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
