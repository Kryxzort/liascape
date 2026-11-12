// Evaluate JS in a Liascape window over CDP. By default the AGENT window (scripts/agent-window.sh up; its port is in the
// state dir's run/cdp.port); --owner targets the user's own window (LIASCAPE_DEBUG=1 → :9222), LIASCAPE_CDP_PORT any port.
// Usage: node app/shell/cdp.js [--owner] "liascapeDbg.metrics()"
// As a module: cdpPort(argv) → { port, args } picks the target the same way for the other CDP helpers (drive.js,
// scripts/bench-live-ui.mjs).
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const agentPortFile = () => path.join(process.env.LIASCAPE_AGENT_DIR
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "liascape-agent-window"), "run", "cdp.port");
function cdpPort(argv) {
  const args = argv.filter((a) => a !== "--owner");
  if (args.length !== argv.length) return { port: 9222, args };
  if (process.env.LIASCAPE_CDP_PORT) return { port: Number(process.env.LIASCAPE_CDP_PORT), args };
  let p = "";
  try { p = fs.readFileSync(agentPortFile(), "utf8").trim(); } catch { /* never up */ }
  if (!p) {
    console.error("the agent window isn't up: bash scripts/agent-window.sh up (--owner drives the user's own window)");
    process.exit(2);
  }
  return { port: Number(p), args };
}
module.exports = { cdpPort };

if (require.main === module) {
  const { port, args } = cdpPort(process.argv.slice(2));
  const expr = args.join(" ");
  // a page replaced by hot reload never answers: don't hang
  setTimeout(() => { console.error("cdp: no answer in 60 s"); process.exit(1); }, 60000).unref();
  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
      const t = JSON.parse(d).find((x) => x.type === "page");
      if (!t) { console.error("no page target"); process.exit(1); }
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.addEventListener("open", () => ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      })));
      ws.addEventListener("message", (ev) => {
        const r = JSON.parse(ev.data);
        if (r.id !== 1) return;
        const v = r.result && r.result.result;
        console.log(v && "value" in v ? JSON.stringify(v.value) : JSON.stringify(r.result));
        ws.close(); process.exit(0);
      });
      ws.addEventListener("error", (e) => { console.error("ws error", e.message || e); process.exit(1); });
    });
  }).on("error", (e) => { console.error("cdp http error", e.message); process.exit(1); });
}
