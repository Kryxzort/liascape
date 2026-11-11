// Feature health → warnings per settings key; the warning icon itself is FeatureWarn.tsx.
import { createContext, useEffect, useMemo, useState } from "react";
import { api, type FeatureHealth } from "../api/client";

export type Warn = { label: string; reason: string };
export const HealthCtx = createContext<Map<string, Warn[]>>(new Map());

export function healthWarnings(features: FeatureHealth[]): Map<string, Warn[]> {
  const m = new Map<string, Warn[]>();
  for (const f of features) if (f.ok === false)
    for (const k of f.affects) m.set(k, [...(m.get(k) ?? []), { label: f.label, reason: f.reason ?? `${f.label} can't work here` }]);
  return m;
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
