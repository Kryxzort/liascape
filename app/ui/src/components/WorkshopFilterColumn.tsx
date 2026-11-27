import { memo, useEffect, useId, useRef, type KeyboardEvent as RKeyboardEvent } from "react";
import { Check, ChevronDown, Dot, Layers, Monitor, Palette, Shield, Sparkles, Tags, UserRound, X, type LucideIcon } from "lucide-react";
import { favoritesSignedOut, filterOf, hiddenOnSource, nextListGen, useStore, type FilterScope, type TagState } from "../store";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { groupsFor, usePresetsOn, visibleGroups, type Group, type GroupMatch, type Tag } from "./workshopFilter";
import { FAVORITES_TAG } from "../views/localSet";
import { WorkshopListFields } from "./WorkshopListFields";

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

// why: a row that can't take effect now (Favourites signed out: "Sign in to Steam") — dimmed, the reason shown under its
// name (it's what the user can't see otherwise, so text, never a tooltip), ✓ and ✕ aria-disabled; its saved state stays
// and – clears it, as do a name click and a right-click. The reason fades in, and out through its exit (useLinger).
// Guard: probe-filters wf:yours:signedOut
const TagRow = memo(function TagRow({ tag, label, st, scope, why = null }: Tag & { st: TagState; scope: FilterScope; why?: string | null }) {
  const setTagIn = useStore((s) => s.setTagState);
  const setTag = (t: string, v: TagState) => { if (!why || v === null) setTagIn(t, v, scope); };
  const id = useId();
  const key = st ?? "off";
  const reason = useLinger(why, 160, useMotion());
  return (
    <div className={`wf-row ${key}`} data-wf-tag={tag} data-state={key} data-wf-off={why ? "" : undefined}
      onContextMenu={(e) => { e.preventDefault(); setTag(tag, st === "exc" || why ? null : "exc"); }}>
      {reason.value ? (
        <span className="wf-txt">
          <span className="wf-name" id={id} onClick={() => setTag(tag, NEXT[key])}>{label}</span>
          <span className={`wf-why${reason.closing ? " closing" : ""}`} data-wf-why>{reason.value}</span>
        </span>
      ) : <span className="wf-name" id={id} onClick={() => setTag(tag, NEXT[key])}>{label}</span>}
      <div className="wf-sw" role="radiogroup" aria-labelledby={id}
        onKeyDown={(e) => radioKeys(e, 3, SEGS.findIndex((s) => s.st === st), (i) => setTag(tag, SEGS[i].st))}>
        {SEGS.map((s) => (
          <button key={s.cls} type="button" role="radio" className={`wf-seg ${s.cls}`} data-seg={s.st ?? "off"}
            aria-checked={s.st === st} tabIndex={s.st === st ? 0 : -1} aria-disabled={why && s.st ? true : undefined}
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

// each group's emblem, in the head like a Settings section's (index.css .wf-gico): one per group, never one per tag — a
// glyph on some rows and not others reads as a difference between the tags. Resolution and Age take the sidebar's pills'
// glyphs (ItemSide.tsx), so a fact wears one icon everywhere.
const GROUP_ICON: Record<string, LucideIcon> = { yours: UserRound, age: Shield, type: Layers, resolution: Monitor, genre: Palette, features: Sparkles };
// PERF: memo'd — a group re-renders on every tag change, its emblem never needs to. Guard: probe-filters lib:interplay
const GroupEmblem = memo(function GroupEmblem({ id }: { id: string }) {
  const Icon = GROUP_ICON[id] ?? Tags;
  return <span className="wf-gico" data-wf-gico={id} aria-hidden="true"><Icon size={14} /></span>;
});

function GroupBox({ g, states, scope }: { g: Group; states: Map<string, TagState>; scope: FilterScope }) {
  const collapsed = useStore((s) => s.filterCollapsed.includes(g.id));
  const toggle = useStore((s) => s.toggleFilterGroup);
  const tags = g.subs.flatMap((s) => s.tags);
  const n = tags.filter((x) => states.get(x.tag)).length;
  const included = tags.filter((x) => states.get(x.tag) === "inc").length;
  const bodyId = useId();
  const match = useStore((s) => (g.match ? filterOf(s, scope)[g.match.key] : "any"));
  const favOff = useStore((s) => favoritesSignedOut(s.steam));
  return (
    <section className={`wf-grp${n ? " has-active" : ""}`} data-wf-group={g.id} data-wf-collapsed={collapsed || undefined}
      role="group" aria-label={`${g.name} (${match === "all" ? "all of" : "any of"})`}>
      <div className="wf-head">
        <button type="button" className="wf-head-btn" data-wf-head={g.id} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(g.id)}>
          <ChevronDown size={14} className="wf-chev" />
          <GroupEmblem id={g.id} />{g.name}
        </button>
        {n > 0 && <span className="wf-n" data-wf-count={n}>{n}</span>}
        {g.match && <MatchSwitch m={g.match} on={included >= 2} scope={scope} />}
      </div>
      {!collapsed && (
        <div className="wf-body" id={bodyId}>
          {g.subs.map((s, i) => (
            <div key={s.name ?? i} className="wf-subgrp">
              {s.name && <div className="wf-sub">{s.name}</div>}
              {s.tags.map((x) => <TagRow key={x.tag} {...x} st={states.get(x.tag) ?? null} scope={scope}
                why={x.tag === FAVORITES_TAG && favOff ? "Sign in to Steam" : null} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// scope: whose filter (the Workshop's, the local WE folder's, the Library's — each its own); known: the tags the list's items
// know, for a local scope (workshopFilter.ts visibleGroups) — null offers every tag (the Workshop)
const SCOPE_NAME: Record<FilterScope, string> = { workshop: "Workshop", weLocal: "Wallpaper Engine", library: "Library", web: "Source" };
// PERF: memo'd — the Library re-renders on every selection change (a box-selection drag: one per card it crosses), and
// the column's ~40 rows must not with it. Guard: probe-select perf:drag
export const WorkshopFilterColumn = memo(function WorkshopFilterColumn({ mode, scope = "workshop", known = null, closing = false, entering = false, onClose }: {
  mode: "dock" | "drawer"; scope?: FilterScope; known?: Set<string> | null; closing?: boolean; entering?: boolean; onClose: () => void;
}) {
  const f = useStore((s) => filterOf(s, scope));
  const presets = usePresetsOn();
  const clearIn = useStore((s) => s.clearTags);
  // the Workshop's list (Author / Presets of, at the column's top) is a filter too: counted, and Clear all leaves it
  const listOn = useStore((s) => scope === "workshop" && !!s.wsList);
  const setWsList = useStore((s) => s.setWsList);
  // the Hidden row is offered while this grid has a hidden card: the Library's, or one of the shown Browse source's
  const hiddenAny = useStore((s) => scope === "library" ? Object.keys(s.hidden.library).length > 0
    : Object.keys(hiddenOnSource(s.hidden, s.sources[s.activeSource]?.name)).length > 0);
  const page = scope === "library" ? "library" : "browse";
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  const states = new Map<string, TagState>();
  for (const x of f.include) states.set(x, "inc");
  for (const x of f.exclude) states.set(x, "exc");
  const n = f.include.length + f.exclude.length + (listOn ? 1 : 0);

  // the drawer: Escape closes it (before the grid's Escape closes the item sidebar); focus moves into it on open
  useEffect(() => {
    if (mode !== "drawer" || closing) return;
    panelRef.current?.focus({ preventScroll: true });
    const h = (e: KeyboardEvent) => {
      // a list field with something typed takes its Escape back first (WorkshopListFields.tsx)
      if (e.key !== "Escape" || document.querySelector(".sel-pop, .modal-backdrop") || (e.target as Element | null)?.closest?.("[data-wf-dirty]")) return;
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
          <button type="button" className="wf-clear" data-wf-clear disabled={!n} onClick={() => { clearIn(scope); if (scope === "workshop") nextListGen(); if (listOn) setWsList(null); }}>Clear all</button>
          <button type="button" className="mini wf-close" data-wf-close aria-label="Close filters" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="wf-scroll" ref={smoothRef}>
          {scope === "workshop" && <WorkshopListFields />}
          {visibleGroups(groupsFor(scope, presets), known, states, hiddenAny).map((g) => <GroupBox key={g.id} g={g} states={states} scope={scope} />)}
        </div>
      </aside>
    </>
  );
});

// a local filter that leaves nothing of the list: say so where the grid would be, with the way out (`clear` its words; null =
// nothing to clear, no button). `kind` tells the cases apart: "" a local folder's filter, "set" a Yours row's set (Browse)
export function NoMatch({ onClear, text = "No wallpapers match these filters.", clear = "Clear filters", kind = "" }:
  { onClear: () => void; text?: string; clear?: string | null; kind?: string }) {
  return (
    <div className="wf-none" data-wf-none={kind}>
      <span>{text}</span>
      {clear && <button type="button" className="btn ghost" onClick={onClear}>{clear}</button>}
    </div>
  );
}
