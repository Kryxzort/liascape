import { useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { opLabel, opsWords, useShownOps } from "./libraryOps";

// The library's long background operations (components/libraryOps.ts) as one thin line on the top bar's bottom edge: the
// fill is every running operation's work together (the sum of done over the sum of total). What and how far is said in the
// top bar's status slot (components/TopbarStatus.tsx), naming the operation that started first. The line and the words show
// on the Library and Settings only: on Browse they read as Browse's own loading. Guard: --probe probe-libops.js (libops:*).

// the leave: the line fills to its end, then it fades (index.css .libops.closing)
const LEAVE_MS = 450;

// `show`: the tab has the line (the Library, Settings); leaving such a tab fades it out where it is, with the page
export default function LibraryOpsLine({ show }: { show: boolean }) {
  const ops = useShownOps();
  const active = useStore((s) => s.appActive);
  const motion = useMotion();
  const { value: cur, closing } = useLinger(show && ops.length ? ops : null, LEAVE_MS, motion);
  if (!cur) return null;
  // gone because the tab has no line while the work goes on: it fades, the fill stays where it was
  const away = closing && ops.length > 0;
  const done = cur.reduce((n, o) => n + o.done, 0), total = cur.reduce((n, o) => n + o.total, 0);
  const frac = closing && !away ? 1 : total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div className={`libops${closing ? " closing" : ""}${away ? " away" : ""}${active ? "" : " idle"}`} data-libops={cur.map((o) => o.id).join(" ")}
      role="progressbar" aria-label={cur.map(opLabel).join(", ")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
      aria-valuetext={opsWords(cur)}>
      <div className="libops-fill" style={{ transform: `scaleX(${frac})` }} />
    </div>
  );
}
