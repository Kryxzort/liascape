// COOL: icons act out their meaning — one delegated `pointerover` listener plays an icon's one-shot when the pointer
// enters its button (download drops into its tray, the external-link arrow leaves and comes back, refresh spins and lands…).
// The vocabulary, roles and why: docs/superpowers/specs/2026-11-12-icon-motion-design.md; the rule: .claude/rules/ui/design.md
// § Icon motion. Held states (the trash lid, the folder flap, X turning, chevrons), the object tilt and the press squeeze
// are CSS (index.css § icon motion); this file is only the one-shots, which must play to their end even when the pointer
// leaves half-way (a CSS :hover animation would snap back). WAAPI on transform / opacity only — an SVG child's transform
// repaints that icon, nothing else. Nothing starts under `:root.no-motion`. Guard: probe-icons icon:act:*, icon:act:off.

// the springs live once, as CSS custom properties on :root (index.css); read on first use
type Tokens = { S: string; SS: string; O: string; IN: string };
let tok: Tokens | null = null;
function tokens(): Tokens {
  if (tok) return tok;
  const cs = getComputedStyle(document.documentElement), v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  tok = { S: v("--spring", "ease-out"), SS: v("--spring-soft", "ease-out"), O: v("--ease-icon-out", "ease-out"), IN: "cubic-bezier(.5, 0, .9, .5)" };
  return tok;
}

// an easing name in a keyframe list: S = --spring, SS = --spring-soft, O = --ease-icon-out, IN = an accelerating throw
type E = keyof Tokens;
type K = { t?: string; o?: number; at?: number; e?: E; origin?: string };
// `sel` null = the <svg> itself (css px), else its children (viewBox units — a 16 px icon moves 2/3 of that)
type Part = { sel: string | null; k: K[]; ms: number; delay?: number };

const throughAndBack = (out: string, back: string): K[] => [
  { t: "none", o: 1, e: "IN" }, { t: out, o: 0, at: 0.3 }, { t: back, o: 0, at: 0.31, e: "S" }, { t: "none", o: 1 },
];
// a part that leaves and springs back in, starting from where it rests (a first keyframe off its rest state is a visible
// jump the moment the hover lands): it slips out fast, waits a beat, then comes in on the spring
const reIn = (out: string, origin?: string, opacity = true): K[] => [
  { t: "none", o: opacity ? 1 : undefined, e: "IN", origin }, { t: out, o: opacity ? 0 : undefined, at: 0.2, origin },
  { t: out, o: opacity ? 0 : undefined, at: 0.3, e: "S", origin }, { t: "none", o: opacity ? 1 : undefined, origin },
];
const nudge = (t: string, ms = 700): Part => ({ sel: null, ms, k: [{ t: "none", e: "O" }, { t, at: 0.28, e: "S" }, { t: "none" }] });
const dip = (sel: string, at: number, by = "translateY(1.6px)", ms = 900): Part =>
  ({ sel, ms, k: [{ t: "none", e: "O" }, { t: "none", at: Math.max(0, at - 0.08), e: "O" }, { t: by, at, e: "S" }, { t: "none" }] });

// by lucide's own class (`lucide-<name>`); parts are its SVG children (index.css sets their transform-box to the viewBox)
const RECIPES: Record<string, Part[]> = {
  // the arrow drops through into the tray, a fresh one falls in and lands; the tray dips as it does
  "lucide-download": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(3)", ms: 900, k: throughAndBack("translateY(7px)", "translateY(-9px)") },
    dip(":scope > :nth-child(2)", 0.46)],
  // the Browse card's own solid arrow + tray (components/Card.tsx)
  "dl-glyph": [{ sel: ":scope > .dl-arrow", ms: 900, k: throughAndBack("translateY(7px)", "translateY(-9px)") }, dip(":scope > .dl-tray", 0.46)],
  "lucide-cloud-download": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(2)", ms: 900, k: throughAndBack("translateY(6px)", "translateY(-8px)") },
    dip(":scope > :nth-child(3)", 0.46, "translateY(1px)")],
  "lucide-upload": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(2)", ms: 900, k: throughAndBack("translateY(-7px)", "translateY(9px)") },
    dip(":scope > :nth-child(3)", 0.12, "translateY(1.4px)")],
  // the arrow slides out to the top-right and comes back in from the bottom-left
  "lucide-external-link": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(2)", ms: 900, k: throughAndBack("translate(5px, -5px)", "translate(-6px, 6px)") }],
  // the front sheet peels off the back one
  "lucide-copy": [{ sel: ":scope > rect", ms: 800, k: [{ t: "none", o: 1, e: "IN" }, { t: "translate(-6px, -6px)", o: 0.35, at: 0.2 },
    { t: "translate(-6px, -6px)", o: 0.35, at: 0.28, e: "S" }, { t: "none", o: 1 }] },
    dip(":scope > path", 0.15, "scale(.9)", 650)],
  // a full turn: thrown, then a long springy landing
  "lucide-refresh-cw": [{ sel: null, ms: 950, k: [{ t: "rotate(0deg)", e: "SS" }, { t: "rotate(360deg)" }] }],
  "lucide-rotate-ccw": [{ sel: null, ms: 950, k: [{ t: "rotate(0deg)", e: "SS" }, { t: "rotate(-360deg)" }] }],
  "lucide-undo-2": [nudge("rotate(-35deg)", 800)],
  // a stamp: the disk presses down and springs back
  "lucide-save": [nudge("translateY(1.5px) scaleY(.86)")],
  "lucide-square": [nudge("scale(.68)")],
  "lucide-star": [{ sel: null, ms: 750, k: [{ t: "none", e: "IN" }, { t: "scale(.7) rotate(-20deg)", at: 0.22, e: "S" }, { t: "none" }] }],
  // the big star turns in, the small cross and dot pop after it (index.css: those two scale from their own centres)
  "lucide-sparkles": [{ sel: ":scope > :nth-child(1)", ms: 800, k: [{ t: "none", e: "IN" }, { t: "rotate(30deg) scale(.75)", at: 0.22, e: "S" }, { t: "none" }] },
    { sel: ":scope > :nth-child(n+2)", ms: 800, k: reIn("scale(0)") }],
  "lucide-check-check": [{ sel: ":scope > :nth-child(2)", ms: 750, k: reIn("translateX(-4px)") }],
  // the three knobs slide and spring back, one after another
  "lucide-sliders-horizontal": [
    { sel: ":scope > :nth-child(3)", ms: 700, k: [{ t: "none", e: "O" }, { t: "translateX(-3px)", at: 0.28, e: "S" }, { t: "none" }] },
    { sel: ":scope > :nth-child(8)", ms: 700, delay: 60, k: [{ t: "none", e: "O" }, { t: "translateX(3px)", at: 0.28, e: "S" }, { t: "none" }] },
    { sel: ":scope > :nth-child(4)", ms: 700, delay: 120, k: [{ t: "none", e: "O" }, { t: "translateX(-3px)", at: 0.28, e: "S" }, { t: "none" }] }],
  "lucide-volume-2": [{ sel: ":scope > :nth-child(2)", ms: 700, k: reIn("translateX(-2px)") },
    { sel: ":scope > :nth-child(3)", ms: 800, k: reIn("translateX(-2px)") }],
  "lucide-volume-x": [{ sel: ":scope > line", ms: 750, k: reIn("rotate(-90deg) scale(.6)", "19px 12px") }],
  // the slash draws across from its top-left end
  "lucide-cloud-off": [{ sel: ":scope > :nth-child(3)", ms: 750, k: reIn("scale(0)", "2px 2px", false) }],
  // the crosshair's turn is a held state (CSS); its centre dot locks on
  "lucide-locate-fixed": [dip(":scope > circle:nth-child(6)", 0.25, "scale(1.7)", 700)],
  // direction: one nudge along it
  "lucide-arrow-right": [nudge("translateX(3px)")],
  // sort (the top bar's, components/SortFilterButton.tsx): the arrow dips once down its shaft; as it lands the bars, pulled
  // in from their left ends, settle back out one after another, the widest first
  "lucide-arrow-down-wide-narrow": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(2)", ms: 700, k: [{ t: "none", e: "O" }, { t: "translateY(3px)", at: 0.28, e: "S" }, { t: "none" }] },
    ...[3, 4, 5].map((n, i): Part => ({ sel: `:scope > :nth-child(${n})`, ms: 650, delay: 140 + 50 * i,
      k: [{ t: "none", e: "O", origin: "11px 12px" }, { t: "scaleX(.7)", at: 0.25, e: "S", origin: "11px 12px" }, { t: "none", origin: "11px 12px" }] }))],
  // go: the triangle stretches and shoots off to the right, a fresh one springs in from the left (the button's ring: index.css)
  "lucide-play": [{ sel: null, ms: 820, k: throughAndBack("translateX(7px) scale(1.25, .8)", "translateX(-8px) scale(.85)") }],
  "lucide-skip-forward": [{ sel: ":scope > :nth-child(2)", ms: 700, k: [{ t: "none", e: "O" }, { t: "translateX(4px)", at: 0.28, e: "S" }, { t: "none" }] }],
  "lucide-log-in": [{ sel: ":scope > :nth-child(1), :scope > :nth-child(2)", ms: 700, k: [{ t: "none", e: "O" }, { t: "translateX(3px)", at: 0.28, e: "S" }, { t: "none" }] }],
};

// hosts whose icons are state glyphs, not actions: the segmented control (its highlight moves), the number stepper (its own
// squeeze), the filter column's tri-state switch
const SKIP = ".seg-opt, .ns-btn, .wf-seg";
// an emblem chip's glyph (a filter group's, index.css .wf-gico) is an object even inside a button: its chip tilts with its
// group, the glyph never acts on its own
const EMBLEM = ".wf-gico";

function play(svg: SVGSVGElement, parts: Part[]) {
  const T = tokens();
  for (const p of parts) {
    const els: Element[] = p.sel ? [...svg.querySelectorAll(p.sel)] : [svg];
    const kf: Keyframe[] = p.k.map((k) => {
      const f: Keyframe = {};
      if (k.t) f.transform = k.t;
      if (k.o != null) f.opacity = k.o;
      if (k.at != null) f.offset = k.at;
      if (k.e) f.easing = T[k.e];
      if (k.origin) f.transformOrigin = k.origin;
      return f;
    });
    for (const el of els) el.animate(kf, { duration: p.ms, delay: p.delay ?? 0, easing: "linear" });
  }
}

const running = new WeakSet<SVGSVGElement>();
function act(host: Element, motion: boolean) {
  for (const svg of host.querySelectorAll<SVGSVGElement>("svg.lucide, svg.dl-glyph")) {
    const parts = RECIPES[[...svg.classList].find((c) => c in RECIPES) ?? ""];
    if (!parts || svg.parentElement?.matches(EMBLEM)) continue;
    // an acting icon isn't an object: index.css's hover tilt skips [data-act] (set before the hover's first frame)
    if (!svg.hasAttribute("data-act")) svg.setAttribute("data-act", "");
    if (!motion || running.has(svg)) continue; // never restart a one-shot half-way
    running.add(svg);
    play(svg, parts);
    const end = Math.max(...parts.map((p) => p.ms + (p.delay ?? 0)));
    setTimeout(() => running.delete(svg), end);
  }
}

let installed = false;
export function installIconMotion() {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerover", (e) => {
    const host = (e.target as Element | null)?.closest?.("button, a");
    if (!host || host.matches(SKIP) || (host as HTMLButtonElement).disabled) return;
    const from = e.relatedTarget as Node | null;
    if (from && host.contains(from)) return; // moving inside the button
    act(host, !document.documentElement.classList.contains("no-motion"));
  }, { passive: true });
}
