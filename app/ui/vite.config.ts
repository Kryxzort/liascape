import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// DEV ONLY (`vite serve`): hand the page the backend's API token (.claude/rules/backend/api.md § Security). The app's shell
// passes it as ?token=, but a shell from before the token (an installed build loading this dev server — the owner's setup,
// 2026-11-11) doesn't, and every request would 401. `/__liascape/token` answers with serve.token (0600, the user's own)
// ONLY to a same-origin request (`Sec-Fetch-Site`, set by the browser — a script can't forge it): another site's fetch is
// "cross-site" → 403. The page asks it synchronously before the app module runs (index.html, injected here) unless the URL
// already brought one. Never part of a build. (A local process can forge headers — but it's this user's dev server.)
function devApiToken(): Plugin {
  const file = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "liascape", "serve.token");
  return {
    name: "liascape-dev-api-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__liascape/token", (req, res) => {
        let t = "";
        try { t = readFileSync(file(), "utf8").trim(); } catch { /* no backend yet */ }
        if (req.headers["sec-fetch-site"] !== "same-origin" || !/^[A-Za-z0-9_-]{16,128}$/.test(t)) { res.statusCode = 403; res.end(); return; }
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/plain");
        res.end(t);
      });
    },
    transformIndexHtml: () => [{ tag: "script", injectTo: "head-prepend",
      children: 'try{if(!new URLSearchParams(location.search).has("token")){var x=new XMLHttpRequest();x.open("GET","/__liascape/token",false);x.send();'
        + 'if(x.status===200&&x.responseText)sessionStorage.setItem("liascape_token",x.responseText)}}catch(e){}' }],
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), devApiToken()],
  // dev HMR server (systemd liascape-vite). strictPort so Electron's auto-detect URL is stable.
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
