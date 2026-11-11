// No StrictMode — double-invoking effects would double-fire init()/fetches and skew perf.
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installRangeDragGuard } from "./hooks/rangeDrag";
import { installFocusRingGuard } from "./hooks/focusRing";

// before any other key listener: keys pressed while a slider is held go nowhere (hooks/rangeDrag.ts)
installRangeDragGuard();
// focus rings only while tabbing, in the accent — never the system's yellow after a click (hooks/focusRing.ts)
installFocusRingGuard();

createRoot(document.getElementById("root")!).render(<App />);
