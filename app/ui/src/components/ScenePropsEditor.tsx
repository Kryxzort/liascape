import { useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { api, type SceneProp, type ScenePropsResp } from "../api/client";
import { Select } from "./Select";
import { SETTINGS_MORPH } from "./morph";

// "Scene properties" in the item settings modal: a WE scene's own options (project.json general.properties —
// colours, sliders, toggles, combos, text), applied live to the playing scene (liascape-player) and saved per item.
// Same drag contract as the volume/speed sliders (web-ui.md): every change → the local value at once +
// a throttled live preview (~90 ms, /library/scene-props/preview — nothing saved) + a debounced persist
// (250 ms after the last tick, /library/scene-props); a toggle / combo / reset persists at once. The persist's
// answer is the new list (overridden flags, condition visibility). Unmount flushes pending persists.

const toHex = (v: unknown) => {
  const c = String(v ?? "1 1 1").trim().split(/\s+/).map(Number);
  const b = (x: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(x) ? x : 1)) * 255).toString(16).padStart(2, "0");
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
};

function fmtNum(p: SceneProp, v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (!p.fraction) return String(Math.round(n));
  return n.toFixed(Math.min(4, p.precision ?? 2)).replace(/\.?0+$/, "") || "0";
}

export function ScenePropsEditor({ path }: { path: string }) {
  const [data, setData] = useState<ScenePropsResp | null>(null);
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const prevRef = useRef<{ pending: Record<string, unknown>; last: number; tm: number | null }>({ pending: {}, last: 0, tm: null });
  const persistRef = useRef<Record<string, { tm: number; fn: () => void }>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true; // a new item remounts (key={path} in the modal): its state starts empty
    // defer past the open-morph (its re-render mid-flight jumps the panel — like the duration row)
    const t = setTimeout(() => { api.sceneProps(path).then((r) => alive.current && setData(r)).catch(() => {}); }, SETTINGS_MORPH.open.duration + 40);
    return () => {
      alive.current = false; clearTimeout(t);
      for (const d of Object.values(persistRef.current)) { clearTimeout(d.tm); d.fn(); }
      persistRef.current = {};
    };
  }, [path]);

  if (!data || data.props.length === 0) return null;

  const landed = (r: ScenePropsResp, name?: string) => {
    if (!alive.current) return;
    setData(r);
    // a value the user is still dragging keeps its local copy; a landed one shows what was saved
    if (name != null && !persistRef.current[name]) setLocal((l) => { const n = { ...l }; delete n[name]; return n; });
    if (name == null) setLocal({});
  };
  const flushPreview = () => {
    const r = prevRef.current; r.tm = null; r.last = Date.now();
    for (const [name, value] of Object.entries(r.pending)) api.previewSceneProp(path, name, value).catch(() => {});
    r.pending = {};
  };
  const queuePreview = (name: string, value: unknown) => {
    const r = prevRef.current; r.pending[name] = value;
    const dt = Date.now() - r.last;
    if (dt >= 90) flushPreview(); else if (r.tm == null) r.tm = window.setTimeout(flushPreview, 90 - dt);
  };
  const persist = (name: string, value: unknown) => api.setSceneProp(path, name, value).then((r) => landed(r, name)).catch(() => {});
  const queuePersist = (name: string, value: unknown) => {
    const d = persistRef.current[name];
    if (d) clearTimeout(d.tm);
    const fn = () => { delete persistRef.current[name]; persist(name, value); };
    persistRef.current[name] = { tm: window.setTimeout(fn, 250), fn };
  };
  // drag-like controls: preview live, persist once it settles
  const drag = (name: string, value: unknown) => { setLocal((l) => ({ ...l, [name]: value })); queuePreview(name, value); queuePersist(name, value); };
  // discrete controls: persist (saves + applies live) at once
  const commit = (name: string, value: unknown) => { setLocal((l) => ({ ...l, [name]: value })); persist(name, value); };
  const reset = (name?: string) => {
    if (name) { const d = persistRef.current[name]; if (d) { clearTimeout(d.tm); delete persistRef.current[name]; } }
    else { for (const d of Object.values(persistRef.current)) clearTimeout(d.tm); persistRef.current = {}; }
    api.resetSceneProp(path, name).then((r) => landed(r, name)).catch(() => {});
  };

  const val = (p: SceneProp) => (p.name in local ? local[p.name] : p.value);
  const anyOverridden = data.props.some((p) => p.overridden);
  const resetBtn = (p: SceneProp) => p.overridden && (
    <button className="mini ico" title="Back to the scene's default" onClick={() => reset(p.name)}><RotateCcw size={13} /> Default</button>);

  const row = (p: SceneProp) => {
    if (!p.visible) return null;
    if (p.type === "group") return <div key={p.name} className="sp-group" data-scene-prop={p.name}>{p.label}</div>;
    if (p.type === "text") return <div key={p.name} className="sp-text shint" data-scene-prop={p.name}>{p.label}</div>;
    if (!p.editable) return (
      <div key={p.name} className="srow disabled" data-scene-prop={p.name} title={p.unsupported ?? ""}>
        <div className="slabel">{p.label}<span className="shint">{p.unsupported}</span></div></div>);
    const v = val(p);
    let ctl: ReactNode = null;
    if (p.type === "bool")
      ctl = <input type="checkbox" checked={v === true} onChange={(e) => commit(p.name, e.target.checked)} />;
    else if (p.type === "slider") {
      const min = p.min ?? 0, max = p.max ?? 1;
      const step = p.step ?? (p.fraction ? (max - min) / 100 || 0.01 : 1);
      ctl = <><span className="shint sp-num">{fmtNum(p, v)}</span>
        <input type="range" min={min} max={max} step={step} value={Number(v)} onChange={(e) => drag(p.name, +e.target.value)} /></>;
    } else if (p.type === "color")
      ctl = <input type="color" className="sp-color" value={toHex(v)} onChange={(e) => drag(p.name, e.target.value)} />;
    else if (p.type === "combo")
      ctl = <Select value={String(v)} options={(p.options ?? []).map((o) => ({ value: o.value, label: o.label }))} onChange={(x) => commit(p.name, x)} />;
    else if (p.type === "textinput")
      ctl = <input type="text" className="sp-textin" value={String(v ?? "")} maxLength={4096} onChange={(e) => { setLocal((l) => ({ ...l, [p.name]: e.target.value })); queuePersist(p.name, e.target.value); }} />;
    return (
      <div key={p.name} className="srow" data-scene-prop={p.name}>
        <div className="slabel">{p.label}</div>
        <div className="sctl">{ctl}{resetBtn(p)}</div>
      </div>);
  };

  return (
    <div className="scene-props" data-scene-props>
      <div className="sp-head">
        <span className="sp-title">Scene properties</span>
        {anyOverridden && <button className="mini ico" title="Every property back to the scene's default" onClick={() => reset()}><RotateCcw size={13} /> Reset all</button>}
      </div>
      {data.note && <div className="shint sp-note">{data.note}</div>}
      {data.props.map(row)}
    </div>
  );
}
