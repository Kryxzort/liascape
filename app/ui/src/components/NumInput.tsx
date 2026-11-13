import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type PointerEvent as RPointerEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { clampNum } from "./clampNum";
import { useMotion, FADE_MS } from "./motion";
import { useStableFn } from "../hooks/useStableFn";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type"> & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** what an emptied field commits on blur (default: min, else 0) */
  emptyValue?: number;
  /** whole numbers only (default true unless `step` has a fraction) */
  integer?: boolean;
};

// press-and-hold: the first repeat after HOLD_DELAY, then each gap shrinks by HOLD_DECAY down to HOLD_MIN_GAP; after
// HOLD_BIG_AFTER repeats a tick jumps HOLD_BIG steps, so a 0–1048576 field is crossable
const HOLD_DELAY = 380, HOLD_FIRST_GAP = 140, HOLD_DECAY = 0.88, HOLD_MIN_GAP = 35, HOLD_BIG_AFTER = 30, HOLD_BIG = 10;
// a wheel notch is ≥ 50 px; a touchpad's small deltas add up to one step per 50 px
const WHEEL_STEP_PX = 50;

// The value `mult` steps from `from`: the first lands on the step grid that starts at `min` (like the native spinner:
// 30 + 50 → 50), the rest add whole steps (Shift+↑ on 101 → 111).
function stepFrom(from: number, dir: 1 | -1, size: number, base: number, mult: number): number {
  const k = (from - base) / size;
  const i = (dir > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1) + dir * (mult - 1);
  const dec = (String(size).split(".")[1] ?? "").length;
  return Number((base + i * size).toFixed(dec));
}

// Every numeric settings field: a typeable `<input type=number>` between themed − / + buttons (the browser's spin arrows
// are hidden — docs/decisions.md § "Make the UI itself a work of art"). −/+ press-and-hold repeats and speeds up, the wheel
// steps only while the field is focused (otherwise the page scrolls), ↑/↓ step (Shift = ×10), each step clamped by
// `clampNum` and committed at once; a bound reached disables its button. Typing keeps docs/decisions.md § "Let numeric
// fields be emptied while focused": while focused the field shows exactly what was typed, only a complete in-range
// number commits, blur / Enter clamps. Guard: probe-expert "stepper: …" cells, probe-matrix num:*.
export function NumInput({ value, onChange, min, max, emptyValue, integer, step, className = "num", disabled, style, onBlur, onFocus, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null); // non-null while focused
  const motion = useMotion();
  const input = useRef<HTMLInputElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const size = Number(step) > 0 ? Number(step) : 1;
  const whole = integer ?? Number.isInteger(size);
  const inRange = (n: number) => (min == null || n >= min) && (max == null || n <= max);
  const commit = (raw: string) => {
    const v = clampNum(raw, min, max, emptyValue ?? min ?? 0, whole);
    if (v !== value) onChange(v);
    return v;
  };
  // the number the field shows (null: a typed draft that isn't one yet) — a bound it sits on disables that button
  const typed = draft != null && draft.trim() !== "" && Number.isFinite(Number(draft)) ? Number(draft) : null;
  const shownN = draft != null ? typed : value;
  const atMin = min != null && shownN != null && shownN <= min;
  const atMax = max != null && shownN != null && shownN >= max;

  // COOL: the digits roll — the old value slides out and the new one in from the side it came from (up = bigger),
  // transform + opacity only, inside the field's clip; a fast hold shortens the roll to its own pace. Motion off: the old
  // value cross-fades into the new in place (opacity only, at most FADE_MS). Guard: probe-expert "stepper: …roll…"
  const lastStep = useRef(0);
  const roll = (old: string, dir: 1 | -1) => {
    const el = input.current, g = ghost.current;
    if (!el || !g) return;
    const now = performance.now(), ms = Math.max(70, Math.min(motion ? 200 : FADE_MS, now - lastStep.current));
    lastStep.current = now;
    g.textContent = old;
    for (const a of [...el.getAnimations(), ...g.getAnimations()]) a.cancel();
    if (!motion) {
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear", fill: "forwards" });
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "linear" });
      return;
    }
    const out = dir > 0 ? "-0.9em" : "0.9em", inn = dir > 0 ? "0.9em" : "-0.9em";
    g.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${out})`, opacity: 0 }], { duration: ms, easing: "cubic-bezier(.4, 0, .6, 1)", fill: "forwards" });
    el.animate([{ transform: `translateY(${inn})`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: ms * 1.25, easing: "cubic-bezier(.34, 1.4, .64, 1)" });
  };

  // one step (× mult) from what the field shows: the typed draft when it's a number, else the value
  const stepBy = useStableFn((dir: 1 | -1, mult: number): boolean => {
    const shown = draft ?? String(value);
    const from = typed ?? value;
    const v = clampNum(String(stepFrom(from, dir, size, min ?? 0, mult)), min, max, value, whole);
    if (draft != null) setDraft(String(v));
    if (v !== value) onChange(v);
    if (String(v) === shown) return false;
    roll(shown, dir);
    return true;
  });

  // press-and-hold on − / +; ends on any release, a cancel, leaving the button, or a bound (its button disables)
  const hold = useRef<{ t: number; stop: () => void } | null>(null);
  const endHold = () => { hold.current?.stop(); hold.current = null; };
  const startHold = (e: RPointerEvent<HTMLButtonElement>, dir: 1 | -1) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the focus (and a typed draft) in the field
    endHold();
    if (!stepBy(dir, 1)) return;
    let n = 0, gap = HOLD_FIRST_GAP;
    const btn = e.currentTarget;
    btn.classList.add("held");
    const h = { t: 0, stop: () => { btn.classList.remove("held"); clearTimeout(h.t); removeEventListener("pointerup", endHold); removeEventListener("pointercancel", endHold); removeEventListener("blur", endHold); } };
    const tick = () => {
      n++;
      if (!stepBy(dir, n > HOLD_BIG_AFTER ? HOLD_BIG : 1)) { endHold(); return; }
      gap = Math.max(HOLD_MIN_GAP, gap * HOLD_DECAY);
      h.t = window.setTimeout(tick, gap);
    };
    h.t = window.setTimeout(tick, HOLD_DELAY);
    addEventListener("pointerup", endHold); addEventListener("pointercancel", endHold); addEventListener("blur", endHold);
    hold.current = h;
  };
  useEffect(() => endHold, []);
  useEffect(() => { if (disabled) endHold(); }, [disabled]);

  // the wheel steps only a focused field: over an unfocused one the page scrolls on (hooks/useSmoothScroll.ts). Native
  // listener: React's wheel handlers are passive and can't keep the page still.
  const wheelAcc = useRef(0);
  const wheelStep = useStableFn((e: WheelEvent) => {
    if (disabled || document.activeElement !== input.current || e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1);
    if (!d) return;
    const acc = wheelAcc.current = Math.abs(d) >= WHEEL_STEP_PX ? d : (Math.sign(wheelAcc.current) === Math.sign(d) ? wheelAcc.current : 0) + d;
    if (Math.abs(acc) < WHEEL_STEP_PX) return;
    wheelAcc.current = 0;
    stepBy(acc < 0 ? 1 : -1, e.shiftKey ? 10 : 1);
  });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    el.addEventListener("wheel", wheelStep, { passive: false });
    return () => el.removeEventListener("wheel", wheelStep);
  }, [wheelStep]);

  const name = rest["aria-label"];
  // the field is as wide as its longest value (tabular digits), so stepping never reflows the row
  const dec = whole ? 0 : (String(size).split(".")[1] ?? "").length + 1;
  const chars = Math.min(9, Math.max(2, String(min ?? 0).length, String(max ?? 99999).length) + dec);
  return (
    <span ref={wrap} className={`num-step${disabled ? " dis" : ""}`} data-num-step="">
      <button type="button" className="ns-btn" data-step="-1" tabIndex={-1} disabled={disabled || atMin}
        aria-label={name ? `Decrease ${name}` : "Decrease"}
        onPointerDown={(e) => startHold(e, -1)} onPointerLeave={endHold} onMouseDown={(e) => e.preventDefault()}>
        <Minus size={14} strokeWidth={2.4} /></button>
      <span className="ns-field">
        <input ref={input} {...rest} className={className} type="number" min={min} max={max} step={step} disabled={disabled}
          style={{ ...style, "--ns-ch": chars } as CSSProperties}
          value={draft ?? String(value)}
          onFocus={(e) => { setDraft(String(value)); onFocus?.(e); }}
          onChange={(e) => {
            const raw = e.target.value;
            // set without focus (a script, a test driver): nothing to wait for — commit it clamped now
            if (document.activeElement !== e.target) { commit(raw); return; }
            setDraft(raw);
            const n = raw.trim() === "" ? NaN : Number(raw);
            // a complete in-range number applies at once (settings apply live); anything else waits for the blur
            if (Number.isFinite(n) && inRange(n) && (!whole || Number.isInteger(n)) && n !== value) onChange(n);
          }}
          onBlur={(e) => { if (draft != null) commit(draft); setDraft(null); onBlur?.(e); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft != null) setDraft(String(commit(draft)));
            // the native ↑/↓ steps by one and can't roll: ours steps the same grid, Shift = ×10
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey ? 10 : 1);
            }
            onKeyDown?.(e);
          }} />
        <span ref={ghost} className="ns-ghost" aria-hidden="true" />
      </span>
      <button type="button" className="ns-btn" data-step="1" tabIndex={-1} disabled={disabled || atMax}
        aria-label={name ? `Increase ${name}` : "Increase"}
        onPointerDown={(e) => startHold(e, 1)} onPointerLeave={endHold} onMouseDown={(e) => e.preventDefault()}>
        <Plus size={14} strokeWidth={2.4} /></button>
    </span>
  );
}
