// No StrictMode — double-invoking effects would double-fire init()/fetches and skew perf.
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installRangeDragGuard } from "./hooks/rangeDrag";
import { installFocusRingGuard } from "./hooks/focusRing";
import { installIconMotion } from "./components/iconMotion";

// before any other key listener: keys pressed while a slider is held go nowhere (hooks/rangeDrag.ts)
installRangeDragGuard();
// focus rings only while tabbing, in the accent — never the system's yellow after a click (hooks/focusRing.ts)
installFocusRingGuard();
// icons act out their meaning once as the pointer enters their button (components/iconMotion.ts)
installIconMotion();

createRoot(document.getElementById("root")!).render(<App />);
