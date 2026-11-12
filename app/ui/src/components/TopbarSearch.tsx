import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { SEARCH_NARROW, useNarrow } from "../hooks/useTopbarCompact";
import { FADE_EXIT_MS, FADE_MS, useMotion } from "./motion";

// COOL: the top bar's search field (the Library's and Browse's). Below SEARCH_NARROW it folds to its magnifier, like the sort
// and the labelled buttons; a click opens it in place and focuses it. The fold is a morph on transforms alone: the field's frame
// stays where it ends (its right edge never moves) and a rounded window over it slides open or shut (`.ts-win` translates one
// way, `.ts-frame` the other, the same curve, so the frame stands still while its visible part grows); the magnifier and the
// text ride the window's left edge; the controls to its left glide aside by the room it takes (a FLIP: measured on the click,
// played back on `translate`). Motion off: the new state fades in over the old one fading out, nothing moves.
// It folds again when it loses focus empty, or holding a query where the bar has no room to keep it open (the status slot's
// count or the source pills would be squeezed): then the magnifier is lit (accent, a dot) while the query filters the list.
// Escape clears it and folds it. Guard: probe-filters search:fold, search:open, search:off, search:look, search:keep, search:escape
const FOLDED_W = 36;
const MORPH_MS = 340;
const MORPH_EASE = "cubic-bezier(.3, .8, .25, 1)";
// the room the bar's other flexible parts keep while the field stays open unfocused (index.css: the status slot's --keep,
// .pill-strip's min-width)
const STRIP_KEEP = 110;

// the top bar's parts that shift when the field changes width: its controls (the status slot's lines: they sit right-aligned,
// so they follow its right edge) and the source pills' strip and refresh button
const movers = (tb: Element) => [...tb.querySelectorAll(":scope > :not(.tsearch, .spacer, .status, .pills), :scope > .pills > *, :scope > .status > *")];
type Snap = { rects: Map<Element, DOMRect>; w: number; winLeft: number; value: string };

export function TopbarSearch({ value, onChange, placeholder }: { value: string; onChange: (q: string) => void; placeholder: string }) {
  const narrow = useNarrow(SEARCH_NARROW);
  const motion = useMotion();
  const [open, setOpen] = useState(false);
  const expanded = !narrow || open;
  const lit = !expanded && value !== "";
  const box = useRef<HTMLDivElement>(null), win = useRef<HTMLDivElement>(null), frame = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const snap = useRef<Snap | null>(null);
  const focusNext = useRef(false);
  const want = useRef(open);
  const anims = useRef<Animation[]>([]);
  const [ghost, setGhost] = useState<{ w: number; open: boolean; text: string; n: number } | null>(null);

  // read on the user's input (a click, a blur, a key): where everything is before the field changes
  const toggle = (to: boolean, focus = false) => {
    if (want.current === to) return;
    want.current = to;
    const b = box.current, tb = b?.closest(".topbar");
    if (b && tb && win.current && narrow)
      snap.current = { rects: new Map(movers(tb).map((e) => [e, e.getBoundingClientRect()])), w: b.getBoundingClientRect().width, winLeft: win.current.getBoundingClientRect().left, value };
    focusNext.current = focus;
    setOpen(to);
  };

  useLayoutEffect(() => {
    if (focusNext.current) { focusNext.current = false; input.current?.focus(); }
    const s = snap.current, b = box.current, tb = b?.closest(".topbar");
    snap.current = null;
    if (!s || !b || !tb || !win.current || !frame.current || !input.current) return;
    for (const a of anims.current) a.cancel();
    anims.current = [];
    b.style.removeProperty("--ow");
    if (!motion) {
      // the old look fades out where it was while the new one fades in
      setGhost((g) => ({ w: s.w, open: !expanded, text: s.value || placeholder, n: (g?.n ?? 0) + 1 }));
      anims.current.push(win.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "linear" }));
      return;
    }
    const br = b.getBoundingClientRect();
    const ow = expanded ? br.width : s.w;
    const opts: KeyframeAnimationOptions = { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" };
    for (const [el, r0] of s.rects) {
      const r1 = el.getBoundingClientRect(), dx = r0.right - r1.right, dw = r1.width - r0.width;
      // the source strip given its room back (Browse, folding): what it shows again is uncovered as the controls beside it
      // glide away, never under them
      if (dw > 0.5 && el.classList.contains("pill-strip"))
        anims.current.push(el.animate([{ clipPath: `inset(0 ${dw}px 0 0)` }, { clipPath: "inset(0 0 0 0)" }], opts));
      if (Math.abs(dx) < 0.5 || (Math.abs(dw) > 0.5 && !el.parentElement?.classList.contains("status"))) continue;
      anims.current.push(el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], opts));
    }
    // folding, the frame keeps its open width until the window has shut over it
    if (!expanded) b.style.setProperty("--ow", `${ow}px`);
    const from = s.winLeft - (br.right - ow), to = expanded ? 0 : ow - FOLDED_W;
    b.dataset.morph = "";
    const w = win.current.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], opts);
    anims.current.push(w, frame.current.animate([{ transform: `translateX(${-from}px)` }, { transform: `translateX(${-to}px)` }], opts),
      input.current.animate(expanded ? [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], opts));
    const mine = anims.current;
    w.onfinish = () => {
      if (anims.current !== mine) return;
      b.style.removeProperty("--ow");
      delete b.dataset.morph;
      for (const a of mine) a.cancel();
      anims.current = [];
    };
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps -- runs on the fold only; the rest is read from the snapshot

  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), FADE_EXIT_MS);
    return () => clearTimeout(t);
  }, [ghost]);

  // held open while unfocused: a resize may take the room it stood in — it folds, lit
  useEffect(() => {
    if (!narrow || !open) return;
    const fold = () => { if (document.activeElement !== input.current) toggle(false); };
    addEventListener("resize", fold);
    return () => removeEventListener("resize", fold);
  });

  // leaving it: empty, it folds; holding a query, it stays open only where the status slot and the source strip keep their room
  const onBlur = () => {
    if (!narrow || !open) return;
    const tb = box.current?.closest(".topbar");
    const st = tb?.querySelector<HTMLElement>(":scope > .status"), strip = tb?.querySelector<HTMLElement>(".pill-strip");
    const keep = st ? parseFloat(getComputedStyle(st).getPropertyValue("--keep")) || 0 : 0;
    const room = (!st || st.getBoundingClientRect().width >= keep - 0.5) && (!strip || strip.getBoundingClientRect().width >= STRIP_KEEP - 0.5);
    if (!value || !room) toggle(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || (!value && !(narrow && open))) return;
    e.preventDefault(); // the grid's Escape (closing the sidebar, the selection) waits for the next one
    onChange("");
    if (narrow) toggle(false);
    input.current?.blur();
  };

  return (
    <div ref={box} className="tsearch" data-folded={expanded ? undefined : ""} data-open={narrow && open ? "" : undefined} data-lit={lit ? "" : undefined}>
      <span className="ts-glow" aria-hidden />
      {ghost && (
        <span key={ghost.n} className={`ts-ghost${ghost.open ? " open" : ""}`} style={{ width: ghost.w }} aria-hidden>
          <span className="ts-frame" /><span className="ts-ghost-ico"><Search size={15} /></span>{ghost.open && <span className="ts-ghost-text">{ghost.text}</span>}
        </span>
      )}
      <div className="ts-clip">
        <div ref={win} className="ts-win">
          <span ref={frame} className="ts-frame" />
          <input ref={input} className="search" placeholder={placeholder} value={value} aria-label={placeholder.replace(/…$/, "")}
            tabIndex={expanded ? 0 : -1} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onKeyDown={onKeyDown} />
          <button type="button" className="ts-btn" aria-label={lit ? `Search: ${value}` : "Search"} aria-expanded={expanded}
            title={lit ? `Search: ${value}` : undefined} tabIndex={expanded ? -1 : 0} aria-hidden={expanded || undefined}
            onClick={() => toggle(true, true)}>
            <Search size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
