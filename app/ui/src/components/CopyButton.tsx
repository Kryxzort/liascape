import { Check, Copy } from "lucide-react";
import { useCopied } from "../hooks/useCopied";

// A small Copy button for a command (Settings → Keyboard shortcuts, the Expert command blocks). Clicked, it turns into a
// green "Copied" for a moment, like the sidebar's Workshop ID pill (the same hooks/useCopied.ts). Both faces share one grid
// cell (`.xfade`), so the button keeps its width and nothing beside it moves when the words change. The item sidebars' title
// and creator name float one beside their text, shown on hover / keyboard focus (`className` "side-copy", index.css).
// Guard: probe-settings copy:feedback, copy:commands, copy:look, probe-sidebar side:titleCopy, probe-steam ws:creatorCopy
export function CopyButton({ text, what, className }: { text: string; what: string; className?: string }) {
  const [copied, copy] = useCopied();
  const done = copied === text;
  return (
    <button className={`mini copy-btn${done ? " done" : ""}${className ? ` ${className}` : ""}`} data-copy={what} data-copied={done ? "" : undefined}
      aria-label={done ? "Copied" : `Copy ${what}`} disabled={!text} onClick={() => copy(text)}>
      <span className="xfade">
        <span data-off={done ? "" : undefined} aria-hidden={done}><Copy size={13} /> Copy</span>
        <span data-off={done ? undefined : ""} aria-hidden={!done}><Check size={13} className={done ? "ico-pop" : undefined} /> Copied</span>
      </span>
    </button>
  );
}
