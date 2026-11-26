import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useStore } from "../store";
import { BUTTONS_NARROW, useNarrow } from "../hooks/useTopbarCompact";
import { FADE_EXIT_MS, useMotion } from "./motion";
import { isSingle, opLabel, opsWords, useShownOps } from "./libraryOps";

// The top bar's status slot, one line in the room the bar leaves. A message (setStatus: "Applied: …", an error, a step to take)
// shows over everything for its life. Else, while the library's background work runs (the Library and Settings): "Making Low
// previews 4 / 6 · +1 more" — the operation that started first; narrow, below BUTTONS_NARROW, the count alone, "4 / 6 +1". One
// item's work long enough to show (libraryOps.ts isSingle) is its words alone, "Unsubscribing…", narrow too. With the
// now-playing line to tell too, the words are a toggle between the two (two dots under them say which; the choice lasts while
// the work runs, then the now-playing line comes back). Else the now-playing line, else the Library's muted hint.
// The slot is always in the bar with the same flex room, so nothing beside it moves when its words come or go; a change of
// what it says cross-fades in place (opacity only), a count steps in place. Guard: probe-libops libops:status,
// libops:toggle, libops:combined, libops:single; probe-layout resize:*.
type Line =
  | { kind: "status" | "playing" | "hint"; key: string; text: string; title?: string; hold?: string }
  | { kind: "op"; key: string; id: string; label: string; n: string; more: number; words: string; spoken: boolean };

// how long a replaced line stays to fade out (index.css .st-layer.out: .2 s)
const OUT_MS = 220;

// The low-VRAM hold's notice, leading the now-playing line as a pill in the notice look (index.css .st-hold: Settings'
// feature-health summary's edge and fill). It is three unbreakable parts, the words in two halves and the numbers, so the
// slot lays them out whole or not at all (index.css: one line, then the numbers on a second, then the words alone, then the
// glyph alone); what a narrow slot leaves out is in the line's tooltip. Guard: probe-layout look:vramHold
function HoldNotice({ hold }: { hold: string }) {
  const cut = hold.indexOf(" — ");
  const lead = cut < 0 ? hold : hold.slice(0, cut), num = cut < 0 ? "" : hold.slice(cut + 3);
  // the words' two halves, as even as the word breaks allow: the narrow form stacks them
  const words = lead.split(" ");
  let at = 1;
  while (at < words.length - 1 && words.slice(0, at + 1).join(" ").length <= lead.length / 2) at++;
  const parts = [words.slice(0, at).join(" "), words.slice(at).join(" ")].filter(Boolean);
  return (
    <span className="st-hold">
      <AlertTriangle size={13} className="st-hold-ico" aria-hidden />
      {/* a part's leading space keeps the notice whole for a reader (textContent); a line's start drops it, the row's gap spaces them */}
      <span className="st-hold-text">
        {/* the dash leads to the numbers: it goes where they do */}
        {parts.map((p, i) => <span key={i} className="st-hold-lead">{i > 0 ? ` ${p}` : p}{num && i === parts.length - 1 && <span className="st-hold-dash"> —</span>}</span>)}
        {num && <span className="st-hold-num">{` ${num}`}</span>}
      </span>
    </span>
  );
}

function LineView({ l, narrow, out }: { l: Line; narrow: boolean; out?: boolean }) {
  const cls = `st-layer${out ? " out" : ""}`;
  if (l.kind === "playing" && l.hold) {
    const rest = l.text.startsWith(l.hold) ? l.text.slice(l.hold.length).replace(/^ • /, "") : l.text;
    return (
      <span className={`${cls} st-held`} data-st="playing" title={l.title}>
        <HoldNotice hold={l.hold} />{rest && " "}{rest && <span className="st-held-rest">{rest}</span>}
      </span>
    );
  }
  if (l.kind !== "op") return <span className={`${cls}${l.kind === "hint" ? " muted-status" : ""}`} data-st={l.kind} title={l.title}>{l.text}</span>;
  // the words are the line's (LibraryOpsLine's progressbar names every operation): the slot shows, a reader needn't hear twice.
  // Only one item's work running has no line, so then the slot speaks. A tooltip gives what the short form hides
  return (
    <span className={`${cls} st-op`} data-st="op" data-op-id={l.id} aria-hidden={!l.spoken || undefined} title={narrow || l.more ? l.words : undefined}>
      {(!narrow || !l.n) && <span className="st-op-label">{l.label}</span>}
      {l.n && <span className="st-op-n">{l.n}</span>}
      {l.more > 0 && <span className="st-op-more">{narrow ? `+${l.more}` : `· +${l.more} more`}</span>}
    </span>
  );
}

export function TopbarStatus({ tab }: { tab: "browse" | "library" | "settings" }) {
  const status = useStore((s) => s.status);
  const isPlayingLine = useStore((s) => s.statusPlaying);
  const ops = useShownOps();
  const narrow = useNarrow(BUTTONS_NARROW);
  const motion = useMotion();
  const op = tab !== "browse" ? ops[0] : undefined;
  const message: Line | null = status && !isPlayingLine ? { kind: "status", key: `s:${status}`, text: status } : null;
  // the low-VRAM hold's notice leads the now-playing line (HoldNotice), under its own key so it comes and goes as a line does.
  // Below the narrowest one-row top bar even two lines can't hold it: the tooltip carries it whole
  const vramHold = useStore((s) => s.vramHold);
  const playing: Line | null = status && isPlayingLine
    ? { kind: "playing", key: vramHold ? "playing:hold" : "playing", text: status, title: vramHold ?? undefined, hold: vramHold ?? undefined } : null;
  const work: Line | null = op ? { kind: "op", key: `op:${op.id}`, id: op.id, label: isSingle(op) ? `${opLabel(op)}…` : opLabel(op), n: isSingle(op) ? "" : `${op.done} / ${op.total}`, more: ops.length - 1, words: opsWords(ops), spoken: ops.every(isSingle) } : null;
  // the user's pick between the work and the now-playing line, kept while the work runs
  const [showPlaying, setShowPlaying] = useState(false);
  if (showPlaying && !work) setShowPlaying(false);
  const toggle = !message && !!work && !!playing;
  const line: Line | null = message ?? (work && !(toggle && showPlaying) ? work : playing)
    ?? (tab === "library" ? { kind: "hint", key: "hint", text: "Your downloaded wallpapers" } : null);
  const flip = () => setShowPlaying((v) => !v);

  // the lines fading out: the last copy of each, replaced when what the slot says changed (not when a count stepped)
  const [last, setLast] = useState<Line | null>(line);
  const [gone, setGone] = useState<Line[]>([]);
  if (JSON.stringify(line) !== JSON.stringify(last)) {
    if (line?.key !== last?.key) setGone((g) => [...g.filter((x) => x.key !== line?.key && x.key !== last?.key), ...(last ? [last] : [])]);
    setLast(line);
  }
  useEffect(() => {
    if (!gone.length) return;
    const t = setTimeout(() => setGone([]), motion ? OUT_MS : FADE_EXIT_MS);
    return () => clearTimeout(t);
  }, [gone, motion]);

  return (
    <span className="status" data-status={line?.kind ?? "none"}>
      {/* the same element whether it toggles or not: a change of type would remount the lines (and replay their fade) */}
      <span className={`st-wrap${toggle ? " st-toggle" : ""}`} role={toggle ? "button" : undefined} tabIndex={toggle ? 0 : undefined}
        aria-label={toggle ? (line?.kind === "op" ? "Show what's playing" : "Show the library's progress") : undefined}
        onClick={toggle ? flip : undefined}
        onKeyDown={toggle ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } } : undefined}>
        <span className="st-lines">
          {gone.filter((g) => g.key !== line?.key).map((g) => <LineView key={`out:${g.key}`} l={g} narrow={narrow} out />)}
          {line && <LineView key={`in:${line.key}`} l={line} narrow={narrow} />}
        </span>
        <span className="st-dots" data-on={line?.kind === "op" ? 0 : 1} aria-hidden><i /><i /></span>
      </span>
    </span>
  );
}
