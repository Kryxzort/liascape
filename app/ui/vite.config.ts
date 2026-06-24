import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base relative so the built bundle loads under the C# server's origin (served from LP_UI_DIR).
export default defineConfig({
  base: "./",
  plugins: [react()],
  // dev HMR server (systemd livepaper-vite). strictPort so Electron's auto-detect URL is stable.
  server: { port: 5173, strictPort: true },
  build: {
    // PERF: split the stable, rarely-changing vendor libs into their own chunks. Electron's V8 code
    // cache is per-file, so a stable vendor chunk stays compiled across launches (only the app chunk
    // recompiles when our code changes) → faster repeat startup. framer-motion is the heaviest dep.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("framer-motion") || id.includes("motion-dom") || id.includes("motion-utils")) return "motion";
          if (id.includes("@dnd-kit")) return "dnd";
        },
      },
    },
  },
});
