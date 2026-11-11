import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type FeatureHealth } from "../api/client";

// API: /health/features — a feature a missing build piece / tool breaks here puts a warning icon (its reason as the
// tooltip) on every row whose settings key it `affects` (docs/decisions.md § "Report a missing dependency with a warning,
// never hide the control"). The control
// itself stays visible and usable; only `ok === false` warns (null = not known yet). Shared by Settings (every row)
// and the playlist settings modal (its Transitions field).
type Warn = { label: string; reason: string };
export const HealthCtx = createContext<Map<string, Warn[]>>(new Map());

export function healthWarnings(features: FeatureHealth[]): Map<string, Warn[]> {
  const m = new Map<string, Warn[]>();
  for (const f of features) if (f.ok === false)
    for (const k of f.affects) m.set(k, [...(m.get(k) ?? []), { label: f.label, reason: f.reason ?? `${f.label} can't work here` }]);
  return m;
}

export function WarnIcon({ k }: { k?: string }) {
  const w = useContext(HealthCtx).get(k ?? "");
  if (!k || !w?.length) return null;
  const text = w.map((x) => x.reason).join("\n");
  return <span className="s-warn" title={text} aria-label={text} data-feature-warn={k}><AlertTriangle size={13} /></span>;
}

// The warnings for a surface that isn't the Settings page: read /health/features when `active` turns on (a modal
// opening) and every 15 s while it is. Wrap the surface in <HealthCtx.Provider value={useFeatureWarnings(open)}>.
export function useFeatureWarnings(active: boolean): Map<string, Warn[]> {
  const [features, setFeatures] = useState<FeatureHealth[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = () => api.featureHealth().then((r) => alive && setFeatures(r.features ?? [])).catch(() => {});
    read();
    const t = setInterval(read, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [active]);
  return useMemo(() => healthWarnings(features), [features]);
}
