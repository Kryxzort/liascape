import { memo, useEffect, useId, useRef, type KeyboardEvent as RKeyboardEvent } from "react";
import { Check, ChevronDown, Dot, X } from "lucide-react";
import { filterOf, useStore, type FilterScope, type TagState } from "../store";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { groupsFor, visibleGroups, type Group, type GroupMatch, type Tag } from "./workshopFilter";

// COOL: the filter column — Wallpaper Engine's filter column (docs/decisions.md § "Filter the Workshop in a column of
// three-way switches"), on the Workshop, on Browse's local Wallpaper Engine folder and on the Library, the same control
// everywhere (§ "Filter the Library and the local Wallpaper Engine folder in the page"). Every Steam
// tag is a row: its name + a compact three-way switch [✓ | · | ✕] = include / off / exclude. A click on a segment sets that
// state, a click on the NAME toggles include, a right-click on the row toggles exclude. The store keeps each scope's
// tags as two flat sets (`include` / `exclude`, a tag in at most one; store FilterScope). The Workshop's reload 280 ms after
// the last change (setBrowseFilter) and the backend owns what a set means; a local scope's filter the list it already holds
// with the same rules (workshopFilter.ts localMatcher): within a group any of; Genre / Features by their All / Any
// switch — genreMatch default any, featureMatch default all —; all groups at once; an excluded tag hides.
// Calm on purpose (40 switches must not look like a mixing desk): an untouched row's switch is faint (half
// opacity, no fill, muted glyphs) and only the ACTIVE segment of an include / exclude row carries colour.
// On the right, where the item sidebar docks (one of the two at a time — store setFiltersOpen): docked beside the grid from
// WF_DOCK_QUERY up (a sibling of `.scroll` in `.app` — index.css `.app[data-page]:has(> .wf-col[data-mode=dock])`), narrower a
// drawer over the grid. The top bar's split button (components/SortFilterButton.tsx) is its toggle; its head is a plain title,
// Clear all and ×.

// a name click is a checkbox label: it toggles INCLUDE (off ↔ ✓; an excluded tag → off). Hiding is always deliberate — the ✕
// segment or a right-click. (A cycle off → ✓ → ✕ skips over the middle segment, and a left-to-right wrap makes the first click
// hide.)
const NEXT: Record<string, TagState> = { off: "inc", inc: null, exc: null };
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

const TagRow = memo(function TagRow({ tag, label, st, scope }: Tag & { st: TagState; scope: FilterScope }) {
  const setTagIn = useStore((s) => s.setTagState);
  const setTag = (t: string, v: TagState) => setTagIn(t, v, scope);
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
            aria-label={s.st === "inc" ? `Include ${tag.startsWith("@") ? label : tag}` : s.st === "exc" ? `Hide ${tag.startsWith("@") ? label : tag}` : "Off"}
            onClick={() => setTag(tag, s.st)}>
            {s.st === "inc" ? <Check size={12} strokeWidth={3} /> : s.st === "exc" ? <X size={12} strokeWidth={3} /> : <Dot size={14} strokeWidth={3} />}
          </button>
        ))}
      </div>
    </div>
  );
});

// a group's All / Any switch — Features and Genre (docs/decisions.md § "AND Workshop features, OR genres, each switchable"):
// only means something with ≥ 2 of the group's tags included — shown
// muted until then
function MatchSwitch({ m, on, scope }: { m: GroupMatch; on: boolean; scope: FilterScope }) {
  const val = useStore((s) => filterOf(s, scope)[m.key]);
  const setF = useStore((s) => s.setFilterIn);
  const opts = [{ v: "all" as const, label: "All", aria: `Must have all ticked ${m.plural}` }, { v: "any" as const, label: "Any", aria: `Any ticked ${m.one}` }];
  const pick = (v: "all" | "any") => { if (v !== val) setF(scope, { [m.key]: v }); };
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

function GroupBox({ g, states, scope }: { g: Group; states: Map<string, TagState>; scope: FilterScope }) {
  const collapsed = useStore((s) => s.filterCollapsed.includes(g.id));
  const toggle = useStore((s) => s.toggleFilterGroup);
  const tags = g.subs.flatMap((s) => s.tags);
  const n = tags.filter((x) => states.get(x.tag)).length;
  const included = tags.filter((x) => states.get(x.tag) === "inc").length;
  const bodyId = useId();
  const match = useStore((s) => (g.match ? filterOf(s, scope)[g.match.key] : "any"));
  return (
    <section className={`wf-grp${n ? " has-active" : ""}`} data-wf-group={g.id} data-wf-collapsed={collapsed || undefined}
      role="group" aria-label={`${g.name} (${match === "all" ? "all of" : "any of"})`}>
      <div className="wf-head">
        <button type="button" className="wf-head-btn" data-wf-head={g.id} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(g.id)}>
          <ChevronDown size={14} className="wf-chev" /> {g.name}
        </button>
        {n > 0 && <span className="wf-n" data-wf-count={n}>{n}</span>}
        {g.match && <MatchSwitch m={g.match} on={included >= 2} scope={scope} />}
      </div>
      {!collapsed && (
        <div className="wf-body" id={bodyId}>
          {g.subs.map((s, i) => (
            <div key={s.name ?? i} className="wf-subgrp">
              {s.name && <div className="wf-sub">{s.name}</div>}
              {s.tags.map((x) => <TagRow key={x.tag} {...x} st={states.get(x.tag) ?? null} scope={scope} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// scope: whose filter (the Workshop's, the local WE folder's, the Library's — each its own); known: the tags the list's items
// know, for a local scope (workshopFilter.ts visibleGroups) — null offers every tag (the Workshop)
const SCOPE_NAME: Record<FilterScope, string> = { workshop: "Workshop", weLocal: "Wallpaper Engine", library: "Library" };
// PERF: memo'd — the Library re-renders on every selection change (a box-selection drag: one per card it crosses), and
// the column's ~40 rows must not with it. Guard: probe-select perf:drag
export const WorkshopFilterColumn = memo(function WorkshopFilterColumn({ mode, scope = "workshop", known = null, closing = false, entering = false, onClose }: {
  mode: "dock" | "drawer"; scope?: FilterScope; known?: Set<string> | null; closing?: boolean; entering?: boolean; onClose: () => void;
}) {
  const f = useStore((s) => filterOf(s, scope));
  const clearIn = useStore((s) => s.clearTags);
  const page = scope === "library" ? "library" : "browse";
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const smoothRef = useSmoothScroll(scrollRef);
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
      e.preventDefault(); e.stopImmediatePropagation(); onClose();
    };
    addEventListener("keydown", h, true);
    return () => removeEventListener("keydown", h, true);
  }, [mode, closing, onClose]);

  return (
    <>
      {mode === "drawer" && <div className={`wf-scrim${closing ? " closing" : ""}`} onClick={onClose} />}
      <aside ref={panelRef} id={`wf-panel-${page}`} className={`wf-col${closing ? " closing" : ""}${entering ? " entering" : ""}`} data-wf-col data-wf-page={page} data-wf-scope={scope}
        data-mode={mode} aria-label={`${SCOPE_NAME[scope]} filters`}
        tabIndex={mode === "drawer" ? -1 : undefined}>
        <div className="wf-top">
          <span className="wf-title" data-wf-title>Filters</span>
          <button type="button" className="wf-clear" data-wf-clear disabled={!n} onClick={() => clearIn(scope)}>Clear all</button>
          <button type="button" className="mini wf-close" data-wf-close aria-label="Close filters" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="wf-scroll" ref={smoothRef}>
          {visibleGroups(groupsFor(scope), known, states).map((g) => <GroupBox key={g.id} g={g} states={states} scope={scope} />)}
        </div>
      </aside>
    </>
  );
});

// a local filter that leaves nothing of the list: say so where the grid would be, with the way out
export function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div className="wf-none" data-wf-none>
      <span>No wallpapers match these filters.</span>
      <button type="button" className="btn ghost" onClick={onClear}>Clear filters</button>
    </div>
  );
}
