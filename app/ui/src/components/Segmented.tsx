import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

// One segmented control for every "pick one of a few" switch (.claude/rules/ui/design.md § Controls): equal-width options
// in a grid, one accent highlight (`.seg-hl`) that glides between them on transform alone — it is 1/n of the track wide
// and translates by its own width + the gap per option (--seg-i), like the tabs' `.tab-pill`; a spring ease that settles
// with a slight overshoot; `:root.no-motion` (the toggle and prefers-reduced-motion) makes it jump. Glow on the highlight
// under the glow toggle. A radiogroup: arrows / Home / End move the choice, only the checked option is a Tab stop.
// Variants (index.css `.seg`):
//   row:   a standalone pill row (the Settings level picker, the playlist modal's switches); `fill` stretches it across
//          its container
//   strip: the flat strip fused to the top edge of the sidebar's picture (components/SidePanel.tsx `SideMedia`)
// Guard: probe-layout seg:glide, seg:jump, seg:keys; probe-sidebar look:strip.
export type SegOption<T extends string | number> = { value: T; label: ReactNode; icon?: ReactNode; attrs?: Record<`data-${string}`, string> };

export function Segmented<T extends string | number>({ options, value, onChange, label, variant = "row", fill, disabled, className, attrs }: {
  options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string;
  variant?: "row" | "strip"; fill?: boolean; disabled?: boolean; className?: string;
  attrs?: Record<`data-${string}`, string>;
}) {
  const n = options.length;
  const cur = options.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    const from = cur < 0 ? 0 : cur;
    const j = k === "ArrowRight" || k === "ArrowDown" ? (from + 1) % n : k === "ArrowLeft" || k === "ArrowUp" ? (from + n - 1) % n
      : k === "Home" ? 0 : k === "End" ? n - 1 : -1;
    if (j < 0 || disabled) return;
    // the grid's arrow keys and the app's shortcuts never see a key the switch took
    e.preventDefault(); e.stopPropagation();
    if (j !== cur) onChange(options[j].value);
    e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")[j]?.focus();
  };
  return (
    <div className={`seg ${variant}${fill ? " fill" : ""}${className ? " " + className : ""}`} role="radiogroup" aria-label={label}
      aria-disabled={disabled || undefined} data-seg={cur < 0 ? "none" : String(cur)} onKeyDown={onKey} {...attrs}
      style={{ "--seg-n": n, "--seg-i": Math.max(0, cur) } as CSSProperties}>
      {/* COOL: the highlight lies over the options and carries its own copy of their labels in the "on" colour, moved the
          other way on the same curve so it stands still: a label reads in the "on" colour exactly where the highlight
          covers it, mid-glide too (a colour switch on the label would flip it before the highlight arrives) */}
      <span className="seg-hl" aria-hidden>
        <span className="seg-hl-in">{options.map((o) => <span key={String(o.value)} className="seg-ghost">{o.icon}{o.label}</span>)}</span>
      </span>
      {options.map((o, i) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={i === cur} tabIndex={i === (cur < 0 ? 0 : cur) ? 0 : -1}
          className={`seg-opt${i === cur ? " on" : ""}`} disabled={disabled} onClick={() => { if (i !== cur) onChange(o.value); }} {...o.attrs}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
