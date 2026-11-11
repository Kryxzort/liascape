import { memo, useEffect, useId, useRef, type KeyboardEvent as RKeyboardEvent } from "react";
import { Check, ChevronDown, Dot, SlidersHorizontal, X } from "lucide-react";
import { useStore, type TagState } from "../store";
import { Select } from "./Select";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { PERIODS, SORTS, WF_GROUPS, useActiveTagCount, type Group, type GroupMatch, type Tag } from "./workshopFilter";

// COOL: the Workshop filter column — Wallpaper Engine's left column (owner 2026-11-11, picking from mockups: "the 2nd feels most
// natural (im probably used to wallpaper engine's design lol…)" + "3 way switch + click cycle would be good imo"). Every Steam
// tag is a row: its name + a compact three-way switch [✓ | · | ✕] = include / off / exclude. A click on a segment sets that
// state, a click on the NAME cycles off → include → exclude → off, a right-click on the row toggles exclude. The store keeps
// the tags as two flat sets (`browseFilter.include` / `.exclude`, a tag in at most one) and reloads 280 ms after the last
// change (setBrowseFilter) — the backend owns what a set means (within a group any of; Genre / Features by their All / Any
// switch — genreMatch default any, featureMatch default all —; all groups at once; an excluded tag hides).
// Calm on purpose (the owner worried 40 switches would look "like a mixing desk"): an untouched row's switch is faint (half
// opacity, no fill, muted glyphs) and only the ACTIVE segment of an include / exclude row carries colour.
// Docked left of the grid from WF_DOCK_QUERY up (a sibling of `.scroll` in `.app`, like the item sidebar on the right — index.css
// `.app:has(> .wf-col[data-mode=dock])`); narrower it's a drawer the sort row's "Filters · N" button opens over the grid.

const NEXT: Record<string, TagState> = { off: "inc", inc: "exc", exc: null };
const SEGS: { st: TagState; cls: string }[] = [{ st: "inc", cls: "i" }, { st: null, cls: "o" }, { st: "exc", cls: "e" }];

// a radiogroup's arrow keys (roving tabindex: only the checked segment is a Tab stop): ← ↑ / → ↓ step and select, Home / End
function radioKeys(e: RKeyboardEvent<HTMLDivElement>, n: number, cur: number, pick: (i: number) => void) {
  const k = e.key;
  const j = k === "ArrowRight" || k === "ArrowDown" ? (cur + 1) % n : k === "ArrowLeft" || k === "ArrowUp" ? (cur + n - 1) % n
    : k === "Home" ? 0 : k === "End" ? n - 1 : -1;
  if (j < 0) return;
  e.preventDefault(); e.stopPropagation();
  pick(j);
  (e.currentTarget.children[j] as HTMLElement | undefined)?.focus();
}

const TagRow = memo(function TagRow({ tag, label, st }: Tag & { st: TagState }) {
  const setTag = useStore((s) => s.setTagState);
  const id = useId();
  const key = st ?? "off";
  return (
    <div className={`wf-row ${key}`} data-wf-tag={tag} data-state={key}
      onContextMenu={(e) => { e.preventDefault(); setTag(tag, st === "exc" ? null : "exc"); }}>
      <span className="wf-name" id={id} onClick={() => setTag(tag, NEXT[key])}>{label}</span>
      <div className="wf-sw" role="radiogroup" aria-labelledby={id}
        onKeyDown={(e) => radioKeys(e, 3, SEGS.findIndex((s) => s.st === st), (i) => setTag(tag, SEGS[i].st))}>
        {SEGS.map((s) => (
          <button key={s.cls} type="button" role="radio" className={`wf-seg ${s.cls}`} data-seg={s.st ?? "off"}
            aria-checked={s.st === st} tabIndex={s.st === st ? 0 : -1}
            aria-label={s.st === "inc" ? `Include ${tag}` : s.st === "exc" ? `Hide ${tag}` : "Off"}
            onClick={() => setTag(tag, s.st)}>
            {s.st === "inc" ? <Check size={12} strokeWidth={3} /> : s.st === "exc" ? <X size={12} strokeWidth={3} /> : <Dot size={14} strokeWidth={3} />}
          </button>
        ))}
      </div>
    </div>
  );
});

// a group's All / Any switch — Features (owner 2026-11-11: "what if a user wants a 3D OR HDR and not 3D AND HDR") and Genre
// ("lets just have a 'all or any' option for genere too"): only means something with ≥ 2 of the group's tags included — shown
// muted until then
function MatchSwitch({ m, on }: { m: GroupMatch; on: boolean }) {
  const val = useStore((s) => s.browseFilter[m.key]);
  const setF = useStore((s) => s.setBrowseFilter);
  const opts = [{ v: "all" as const, label: "All", aria: `Must have all ticked ${m.plural}` }, { v: "any" as const, label: "Any", aria: `Any ticked ${m.one}` }];
  const pick = (v: "all" | "any") => { if (v !== val) setF({ [m.key]: v }); };
  return (
    <div className={`wf-fm${on ? "" : " idle"}`} role="radiogroup" aria-label={`${m.plural} match`} data-wf-match={val}
      onKeyDown={(e) => radioKeys(e, 2, opts.findIndex((o) => o.v === val), (i) => pick(opts[i].v))}>
      {opts.map((o) => (
        <button key={o.v} type="button" role="radio" className="wf-fm-seg" data-fm={o.v} aria-checked={val === o.v}
          tabIndex={val === o.v ? 0 : -1} aria-label={o.aria} onClick={() => pick(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

function GroupBox({ g, states }: { g: Group; states: Map<string, TagState> }) {
  const collapsed = useStore((s) => s.filterCollapsed.includes(g.id));
  const toggle = useStore((s) => s.toggleFilterGroup);
  const tags = g.subs.flatMap((s) => s.tags);
  const n = tags.filter((x) => states.get(x.tag)).length;
  const included = tags.filter((x) => states.get(x.tag) === "inc").length;
  const bodyId = useId();
  const match = useStore((s) => (g.match ? s.browseFilter[g.match.key] : "any"));
  return (
    <section className={`wf-grp${n ? " has-active" : ""}`} data-wf-group={g.id} data-wf-collapsed={collapsed || undefined}
      role="group" aria-label={`${g.name} (${match === "all" ? "all of" : "any of"})`}>
      <div className="wf-head">
        <button type="button" className="wf-head-btn" data-wf-head={g.id} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(g.id)}>
          <ChevronDown size={14} className="wf-chev" /> {g.name}
        </button>
        {n > 0 && <span className="wf-n" data-wf-count={n}>{n}</span>}
        {g.match && <MatchSwitch m={g.match} on={included >= 2} />}
      </div>
      {!collapsed && (
        <div className="wf-body" id={bodyId}>
          {g.subs.map((s, i) => (
            <div key={s.name ?? i} className="wf-subgrp">
              {s.name && <div className="wf-sub">{s.name}</div>}
              {s.tags.map((x) => <TagRow key={x.tag} {...x} st={states.get(x.tag) ?? null} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkshopFilterColumn({ mode, closing = false, onClose }: { mode: "dock" | "drawer"; closing?: boolean; onClose?: () => void }) {
  const f = useStore((s) => s.browseFilter);
  const clear = useStore((s) => s.clearTags);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useSmoothScroll(scrollRef);
  const states = new Map<string, TagState>();
  for (const x of f.include) states.set(x, "inc");
  for (const x of f.exclude) states.set(x, "exc");
  const n = f.include.length + f.exclude.length;

  // the drawer: Escape closes it (before the grid's Escape closes the item sidebar); focus moves into it on open
  useEffect(() => {
    if (mode !== "drawer" || closing) return;
    panelRef.current?.focus({ preventScroll: true });
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".sel-pop, .modal-backdrop")) return;
      e.preventDefault(); e.stopImmediatePropagation(); onClose?.();
    };
    addEventListener("keydown", h, true);
    return () => removeEventListener("keydown", h, true);
  }, [mode, closing, onClose]);

  return (
    <>
      {mode === "drawer" && <div className={`wf-scrim${closing ? " closing" : ""}`} onClick={onClose} />}
      <aside ref={panelRef} className={`wf-col${closing ? " closing" : ""}`} data-wf-col data-mode={mode} aria-label="Workshop filters"
        tabIndex={mode === "drawer" ? -1 : undefined}>
        <div className="wf-top">
          <span className="wf-title"><SlidersHorizontal size={14} /> Filters</span>
          <button type="button" className="wf-clear" data-wf-clear disabled={!n} onClick={clear}>Clear all</button>
          {mode === "drawer" && <button type="button" className="mini wf-close" aria-label="Close filters" onClick={onClose}><X size={16} /></button>}
        </div>
        <div className="wf-scroll" ref={scrollRef}>
          {WF_GROUPS.map((g) => <GroupBox key={g.id} g={g} states={states} />)}
        </div>
      </aside>
    </>
  );
}

// the row above the grid: sort + period (as before) and — while the column is a drawer — the button that opens it
export function WorkshopSortRow({ drawer, onOpenFilters }: { drawer: boolean; onOpenFilters: () => void }) {
  const f = useStore((s) => s.browseFilter);
  const setF = useStore((s) => s.setBrowseFilter);
  const n = useActiveTagCount();
  return (
    <div className="wfilter">
      {drawer && (
        <button type="button" className={`pill ico wf-open${n ? " active" : ""}`} data-wf-open onClick={onOpenFilters}>
          <SlidersHorizontal size={14} /> Filters{n ? ` · ${n}` : ""}
        </button>
      )}
      <Select value={f.sort} onChange={(v) => setF({ sort: v })} options={SORTS.map(([v, l]) => ({ value: v, label: l }))} />
      {f.sort === "trend" && (
        <Select value={f.trendDays} onChange={(v) => setF({ trendDays: +v })} options={PERIODS.map(([v, l]) => ({ value: String(v), label: l }))} />
      )}
    </div>
  );
}
