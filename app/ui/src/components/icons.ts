import { createLucideIcon } from "lucide-react";

// Two-part icons for the motion vocabulary (docs/superpowers/specs/2026-11-12-icon-motion-design.md): lucide draws these
// as one path, so a part can't move on its own. Same 24-unit grid and stroke as lucide (they ARE lucide icons, built with
// its own `createLucideIcon` — `lucide lucide-<name>` classes, size / strokeWidth props).

// A folder whose front flap falls open while its button is hovered (index.css § icon motion: the flap skews from its bottom
// edge): at rest lucide's folder-closed (the back + the flap's top edge across it), open it reads as lucide's folder-open.
export const FolderFlap = createLucideIcon("folder-flap", [
  ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z", key: "back" }],
  ["path", { d: "M2 10h18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", key: "flap" }],
]);
