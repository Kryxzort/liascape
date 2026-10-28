// No StrictMode — double-invoking effects would double-fire init()/fetches and skew perf.
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installRangeDragGuard } from "./hooks/rangeDrag";

// before any other key listener: keys pressed while a slider is held go nowhere (hooks/rangeDrag.ts)
installRangeDragGuard();

createRoot(document.getElementById("root")!).render(<App />);
