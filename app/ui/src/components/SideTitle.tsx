import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { CopyButton } from "./CopyButton";
import { FADE_MS, FADE_EXIT_MS, useMotion } from "./motion";
import { glideFlip, glideY, snapFlip, softSpring, type FlipSnap } from "./flipGlide";

// COOL: the item sidebar's title (SidePanel's head). Two lines at most; a longer one is a disclosure: a click (Enter / Space,
// aria-expanded) unfolds it to the whole title and another folds it back. Motion on: the title's box (the h2, a clip) morphs
// on the soft spring with its words riding along unscaled (morphClip), revealed and covered by the clip; the head's line, the
// selection note and the panel's scroller glide with it (a FLIP on the same spring). Folding keeps every line until the box
// has closed over them, then the clamp's ellipsis fades back. Motion off: the old title cross-fades into the new one in
// place, nothing travels; sizes change at once (folding, once the hidden lines have faded). A title that fits in two lines
// is plain text: nothing to click. The words stay selectable (a drag that selected some isn't a click), and a Copy button
// floats over the end of the last line while the title is hovered or holds the keyboard focus. A switch to another item
// starts it folded and measures nothing.
// PERF: measured on the user's click (the FLIP's before) and in that click's commit (the after), nowhere else: no framer
// `layout` here (its projection re-measures on renders the user didn't ask for, e.g. the close); whether it's clamped comes
// from a ResizeObserver, never a mount effect's read.
// Guard: probe-sidebar side:titleFold:<on|off|reduced>, side:titlePlain, side:titleFoldKeys, side:titleCopy, probe-layout perf:sidebar
// what moves when the title's height changes: the rest of the head's text (the selection note), the floating Copy button and
// the panel's scroller (each measured against its own parent)
const BELOW = ":scope > .side-scroll, :scope > .side-head > .side-head-text > :not(.side-title), :scope > .side-head .side-title > .side-copy";

// The box morph without a stretch: the box scales from `from` px to its new height `to` while its words get the exact inverse
// in every keyframe (sampled from the soft spring, as glideFlip's curve), so they stay their size and only the clip moves.
// Transform only, both from the top edge (index.css .side-head h2).
const MORPH_STEPS = 32;
function morphClip(box: HTMLElement, words: HTMLElement, from: number, to: number) {
  if (Math.abs(from - to) < 0.5 || to <= 0) return;
  const { ease, ms } = softSpring(), outer: Keyframe[] = [], inner: Keyframe[] = [];
  for (let i = 0; i <= MORPH_STEPS; i++) {
    const s = Math.max(0.01, (from + (to - from) * ease(i / MORPH_STEPS)) / to);
    outer.push({ transform: `scaleY(${s})` }); inner.push({ transform: `scaleY(${1 / s})` });
  }
  box.animate(outer, { duration: ms, easing: "linear" });
  words.animate(inner, { duration: ms, easing: "linear" });
}

export function SideTitle({ id, title, panel }: { id: string; title: string; panel: RefObject<HTMLElement | null> }) {
  const motionOn = useMotion();
  const [openFor, setOpenFor] = useState<string | null>(null);
  // the item whose title is drawn without the clamp: unfolded, or folding until the box has closed
  const [looseFor, setLooseFor] = useState<string | null>(null);
  const [turns, setTurns] = useState(0); // the user's folds and unfolds: the commits that measure
  const [foldable, setFoldable] = useState(false);
  // the title as it was, fading out in place over the new one: motion off, every fold and unfold (unfolding, it waits for the
  // new title to fade in under it, so the lines both show never dim; folding, `hold` keeps the old height until it's gone, so
  // the hidden lines fade where they were); motion on, the ellipsis coming back as a fold lands
  const [ghost, setGhost] = useState<{ n: number; loose: boolean; title: string; late: boolean; hold: number | null } | null>(null);
  // another item starts folded (coming back to this one later too)
  const [shown, setShown] = useState(id);
  if (shown !== id) { setShown(id); setOpenFor(null); setLooseFor(null); }
  const open = openFor === id, loose = looseFor === id;
  const txt = useRef<HTMLSpanElement>(null);
  const before = useRef<{ snap: FlipSnap | null; head: number; box: number } | null>(null);

  // clamped = its words need more than two lines (the clamp hides them from view, not from layout: scrollHeight holds them)
  useEffect(() => {
    const el = txt.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 22.5;
      setFoldable(el.scrollHeight > 2 * lh + 1);
    });
    ro.observe(el); // a new observation reports at once: a new title is measured too
    return () => ro.disconnect();
  }, [title]);

  const toggle = () => {
    const p = panel.current;
    if (motionOn && p) {
      // as drawn (a morph still running included), so a quick second click turns back from where it is
      before.current = { snap: snapFlip(p, BELOW), head: p.querySelector(".side-head")?.getBoundingClientRect().height ?? 0,
        box: txt.current?.parentElement?.getBoundingClientRect().height ?? 0 };
    } else {
      before.current = { snap: null, head: 0, box: 0 };
      const hold = open ? txt.current?.parentElement?.getBoundingClientRect().height ?? null : null;
      setGhost((g) => ({ n: (g?.n ?? 0) + 1, loose, title, late: !open, hold }));
    }
    setTurns((n) => n + 1);
    setOpenFor(open ? null : id);
    setLooseFor(!open || motionOn ? id : null);
  };
  useLayoutEffect(() => {
    const b = before.current, p = panel.current; before.current = null;
    if (!b || !p) return;
    if (!motionOn) { if (open) txt.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "linear" }); return; }
    const box = txt.current?.parentElement, words = txt.current;
    if (box && words) morphClip(box, words, b.box, box.offsetHeight);
    glideFlip(b.snap, p, BELOW);
    const head = p.querySelector(".side-head");
    if (head) glideY(head, b.head - head.getBoundingClientRect().height, "::after"); // the head's accent line
  }, [turns]); // eslint-disable-line react-hooks/exhaustive-deps
  // folded: the clamp's ellipsis once the box has closed over the hidden lines
  useEffect(() => {
    if (open || !loose) return;
    const t = setTimeout(() => {
      setLooseFor(null);
      setGhost((g) => ({ n: (g?.n ?? 0) + 1, loose: true, title, late: false, hold: null }));
    }, motionOn ? softSpring().ms : 0);
    return () => clearTimeout(t);
  }, [open, loose, motionOn, title]);
  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), FADE_EXIT_MS + (ghost.late ? FADE_MS : 0));
    return () => clearTimeout(t);
  }, [ghost]);

  const onClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (!foldable || e.detail > 1) return; // a double / triple click selects words; its first click already turned it
    const sel = getSelection();
    if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return; // a drag that selected text
    toggle();
  };
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!foldable || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); // the grid's Enter (gridKeys.ts) and the page's Space scroll stay out of it
    toggle();
  };
  return (
    <div className={`side-title${open ? " open" : ""}`}>
      <h2 style={ghost?.hold ? { minHeight: ghost.hold } : undefined}>
        <span ref={txt} className={`side-title-txt${loose ? "" : " clamp"}`} data-side-title={open ? "open" : foldable ? "folded" : "plain"}
          role={foldable ? "button" : undefined} tabIndex={foldable ? 0 : undefined} aria-expanded={foldable ? open : undefined}
          onClick={onClick} onKeyDown={onKey}>{title}</span>
        {ghost && <span key={ghost.n} className={`side-title-txt side-title-ghost${ghost.loose ? "" : " clamp"}${ghost.late ? " late" : ""}`}
          aria-hidden inert>{ghost.title}</span>}
      </h2>
      <CopyButton text={title} what="title" className="side-copy" />
    </div>
  );
}
