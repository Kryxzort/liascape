import { useCallback, useEffect, useState } from "react";

// Copy feedback, shared by the copy controls that flip to "Copied" (the sidebar's Workshop ID pill, components/CopyButton.tsx):
// `copy(text)` writes the clipboard and remembers WHAT was copied for `ms`, so a control compares it with its own text —
// a control showing another value (the sidebar switched items) never carries "Copied" over.
// Guard: probe-settings copy:feedback, copy:sidebarPill
export function useCopied(ms = 1200): [string | null, (text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied == null) return;
    const t = setTimeout(() => setCopied(null), ms);
    return () => clearTimeout(t);
  }, [copied, ms]);
  const copy = useCallback((text: string) => { navigator.clipboard?.writeText(text); setCopied(text); }, []);
  return [copied, copy];
}
