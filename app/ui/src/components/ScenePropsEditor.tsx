import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, RotateCcw, Wand2 } from "lucide-react";
import { api, type SceneProp, type ScenePropsResp } from "../api/client";
import { useStore } from "../store";
import { Select } from "./Select";
import { scenePropsCache as cache } from "./scenePropsCache";
import { rangeFill } from "./sidePreview";
import { FADE, useMotion } from "./motion";
import { glideFlip, snapFlip, softSpring, type FlipSnap } from "./flipGlide";

// "Scene properties" in the item sidebar (LibrarySide): a WE scene's own options (project.json general.properties —
// colours, sliders, toggles, combos, text), applied live to the playing scene (liascape-player) and saved per item.
// Same drag contract as the volume/speed sliders (.claude/rules/ui/design.md): every change → the local value at once +
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

// what the header counts: the rows the user sees (a group's heading and a label aren't properties; a condition-hidden one
// isn't shown) — from the same answer the rows render from, so it follows a condition whenever they do
const shownCount = (props: SceneProp[]) => props.filter((p) => p.visible && p.type !== "group" && p.type !== "text").length;
// what sits after the section in the sidebar's body: it glides into / out of the room the fold makes
const BELOW = ":scope > *";
// how long the folded rows stay mounted: past the morph (index.css --spring-soft-dur, 0.5 s). Guard: probe-sidebar lib:propsFold:on
const ROWS_GONE_S = 0.6;
// the morph's timing, read at the first fold (a :root style read: never at a sidebar's mount)
let morphT: { layout: { type: "tween"; duration: number; ease: (t: number) => number } } | undefined;

// `onReady` fires once the first answer is in (or the read failed): the sidebar holds its body until then
export function ScenePropsEditor({ path, onReady }: { path: string; onReady?: () => void }) {
  const [data, setDataRaw] = useState<ScenePropsResp | null>(() => cache.get(path) ?? null);
  const setData = (r: ScenePropsResp) => { cache.set(path, r); setDataRaw(r); };
  const [local, setLocal] = useState<Record<string, unknown>>({});
  // live preview of a drag, at most every 90 ms; one throttle per scene (a pending value goes to the scene it was set on)
  const queuePreview = useMemo(() => throttleByName(90, (name, value) => { api.previewSceneProp(path, name, value).catch(() => {}); }), [path]);
  const persistRef = useRef<Record<string, { tm: number; fn: () => void }>>({});
  const alive = useRef(true);
  const readyRef = useRef(onReady);
  useEffect(() => { readyRef.current = onReady; });

  // COOL: the fold. One remembered choice for every scene (store scenePropsFolded, localStorage), open until the user folds
  // it. Motion on: the card's box morphs (framer `layout`, on the soft spring), its head rides along unscaled, the rows fade
  // in as the box opens / out as it closes (popped out of flow at once, so the box shrinks from the first frame), what sits
  // below glides with it (a FLIP on the same spring). Motion off: the rows fade where they are; the box takes its new size
  // at once (after the fade out when folding), nothing travels. The chevron turns (index.css .sp-chev).
  // PERF: everything is measured on the user's click (the FLIP's before) or in that click's commit (framer's snapshot, the
  // FLIP's after); `layoutDependency` keeps framer from measuring on any other render (a slider's drag re-renders every
  // tick), and a mount measures nothing. Guard: probe-sidebar lib:propsFold:<on|off>, lib:propsFoldKeep, probe-layout perf:sidebar
  const folded = useStore((s) => s.scenePropsFolded);
  const setFolded = useStore((s) => s.setScenePropsFolded);
  const motionOn = useMotion();
  const bodyId = useId();
  const secRef = useRef<HTMLElement>(null);
  const below = useRef<FlipSnap | null>(null);
  const toggle = () => {
    const box = secRef.current?.parentElement;
    if (motionOn && box) below.current = snapFlip(box, BELOW);
    if (!morphT) { const { ease, ms } = softSpring(); morphT = { layout: { type: "tween", duration: ms / 1000, ease } }; }
    setFolded(!folded);
  };
  useLayoutEffect(() => {
    if (!below.current) return;
    glideFlip(below.current, secRef.current?.parentElement ?? null, BELOW); below.current = null;
  }, [folded]);

  useEffect(() => {
    alive.current = true; // a new item remounts (key={path} in the sidebar): its state starts from the cache
    if (cache.has(path)) readyRef.current?.();
    api.sceneProps(path).then((r) => { if (alive.current) setData(r); }).catch(() => {}).finally(() => { if (alive.current) readyRef.current?.(); });
    return () => {
      alive.current = false;
      for (const d of Object.values(persistRef.current)) { clearTimeout(d.tm); d.fn(); }
      persistRef.current = {};
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || data.props.length === 0) return null;

  const landed = (r: ScenePropsResp, name?: string) => {
    if (!alive.current) return;
    setData(r);
    // a value the user is still dragging keeps its local copy; a landed one shows what was saved
    if (name != null && !persistRef.current[name]) setLocal((l) => { const n = { ...l }; delete n[name]; return n; });
    if (name == null) setLocal({});
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
        <input type="range" min={min} max={max} step={step} value={Number(v)} style={rangeFill(Number(v), min, max)} onChange={(e) => drag(p.name, +e.target.value)} /></>;
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

  const n = shownCount(data.props);
  const morph = morphT;
  // the rows: in once the box has opened a little, out quickly (the box closes over them) and then held, unseen, until the
  // morph has landed: their unmount re-measures the head, and mid-morph that replays a few px of its position
  const fade = motionOn
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.22, delay: 0.06 } },
      exit: { opacity: [1, 0, 0], transition: { duration: ROWS_GONE_S, times: [0, 0.12 / ROWS_GONE_S, 1], ease: "linear" as const } } }
    : FADE;
  return (
    // the corner radius as a style: framer keeps it round while it scales the box (index.css .side-sec has the same 13 px)
    <motion.section ref={secRef} className="scene-props side-sec" data-scene-props data-folded={folded || undefined}
      layout={motionOn} layoutDependency={folded} transition={morph} style={{ borderRadius: 13 }}>
      <motion.div className="sp-head" layout={motionOn ? "position" : false} layoutDependency={folded} transition={morph}>
        {/* the heading holds the toggle (a real button: Enter / Space, aria-expanded); the count sits after the words, so
            neither its arrival nor a new number moves the title, and Reset all appearing moves nothing in the head */}
        <h3 className="side-sec-title sp-title">
          <button type="button" className="sp-fold" data-scene-props-head aria-expanded={!folded} aria-controls={folded ? undefined : bodyId}
            onClick={toggle}>
            <span className="side-sec-ico"><Wand2 size={15} /></span>Scene properties{" "}
            <span className="sp-count" data-scene-props-count={n}>· {n}</span>
            <ChevronDown size={15} className="sp-chev" aria-hidden="true" />
          </button>
        </h3>
        {anyOverridden && <button className="mini ico" onClick={() => reset()}><RotateCcw size={13} /> Reset all</button>}
      </motion.div>
      <AnimatePresence initial={false} mode={motionOn ? "popLayout" : "sync"}>
        {!folded && (
          <motion.div key="body" id={bodyId} className="sp-body" data-scene-props-body layout={motionOn} layoutDependency={folded}
            transition={morph} {...fade}>
            {data.note && <div className="shint sp-note">{data.note}</div>}
            {data.props.map(row)}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// Coalesce per-name values and send them at most every `ms` (leading edge, then one trailing send with the latest values).
// Module-level on purpose: it reads the clock, which a component body must not (react-hooks/purity).
function throttleByName(ms: number, send: (name: string, value: unknown) => void) {
  let pending: Record<string, unknown> = {}, last = 0, tm: number | null = null;
  const flush = () => {
    tm = null; last = Date.now();
    const out = pending; pending = {};
    for (const [name, value] of Object.entries(out)) send(name, value);
  };
  return (name: string, value: unknown) => {
    pending[name] = value;
    const dt = Date.now() - last;
    if (dt >= ms) flush(); else if (tm == null) tm = window.setTimeout(flush, ms - dt);
  };
}
