import { useContext } from "react";
import { AlertTriangle } from "lucide-react";
import { HealthCtx } from "./featureHealth";

// API: /health/features — a feature a missing build piece / tool breaks here puts a warning icon (its reason as the
// tooltip) on every row whose settings key it `affects` (docs/decisions.md § "Report a missing dependency with a warning,
// never hide the control"). The control
// itself stays visible and usable; only `ok === false` warns (null = not known yet). Shared by Settings (every row)
// and the playlist settings modal (its Transitions field).

export function WarnIcon({ k }: { k?: string }) {
  const w = useContext(HealthCtx).get(k ?? "");
  if (!k || !w?.length) return null;
  const text = w.map((x) => x.reason).join("\n");
  return <span className="s-warn" title={text} aria-label={text} data-feature-warn={k}><AlertTriangle size={13} /></span>;
}
