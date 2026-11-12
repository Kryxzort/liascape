import { useState } from "react";
import { ArrowDownWideNarrow, SlidersHorizontal } from "lucide-react";
import { type FilterPage, type FilterScope } from "../store";
import { Select, type Opt } from "./Select";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { setFiltersFromClick, useActiveTagCount, useFilterOpen } from "./workshopFilter";
import { SORT_NARROW, useNarrow } from "../hooks/useTopbarCompact";

// COOL: the top bar's split button `[⚟ N │ Newest ▾]` on the Library and Browse (docs/decisions.md § "Filter the
// Workshop in a column of three-way switches", its placement). The left half is the filter panel's toggle: the active-tag
// count beside the icon, lit in the accent while the panel is open; the right half is the sort menu (components/Select.tsx).
// A page without filters shows the sort half alone, one without a sort the filter half alone. The top bar never wraps for
// it: below SORT_NARROW the sort half folds to its icon and the chosen sort moves into a tooltip (index.css `.ss-split`).
// Guard: probe-filters split:*, panel:*, swap:*.

export function SortFilterButton({ page, scope, sort }: {
  page: FilterPage; scope: FilterScope | null; sort: { value: string; options: Opt[]; onChange: (v: string) => void } | null;
}) {
  const compact = useNarrow(SORT_NARROW);
  const label = sort?.options.find((o) => o.value === sort.value)?.label ?? "";
  if (!scope && !sort) return null;
  return (
    <div className={`ss-split${scope ? "" : " sort-only"}${sort ? "" : " filter-only"}`} data-sortsplit={page}>
      {scope && <FilterHalf page={page} scope={scope} />}
      {sort && <Select className="ss-sort" value={sort.value} options={sort.options} onChange={sort.onChange} align="right"
        icon={<ArrowDownWideNarrow size={15} className="ss-sort-ico" />} ariaLabel={`Sort: ${label}`}
        title={compact ? `Sort: ${label}` : undefined} />}
    </div>
  );
}

function FilterHalf({ page, scope }: { page: FilterPage; scope: FilterScope }) {
  const open = useFilterOpen(page, true);
  const n = useActiveTagCount(scope);
  const motion = useMotion();
  // the count pops when the user changes it (never on mount) and fades out at 0 (useLinger keeps it for its exit)
  const [seen, setSeen] = useState(n);
  const [pops, setPops] = useState(0);
  if (seen !== n) { setSeen(n); setPops((p) => p + 1); }
  const shown = useLinger(n || null, 170, motion);
  return (
    <button type="button" className={`ss-filter${open ? " on" : ""}${n ? " active" : ""}`} data-wf-toggle data-wf-page={page}
      aria-expanded={open} aria-controls={`wf-panel-${page}`} aria-label={n ? `Filters, ${n} on` : "Filters"}
      onClick={() => setFiltersFromClick(page, !open)}>
      <SlidersHorizontal size={15} />
      {shown.value != null && <span key={pops} className={`ss-n${pops ? " pop" : ""}${shown.closing ? " out" : ""}`} data-wf-count={shown.value}>{shown.value}</span>}
    </button>
  );
}
