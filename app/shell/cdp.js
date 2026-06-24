// Evaluate JS in the LIVE debug window via CDP (needs LP_DEBUG → remote-debugging-port 9222).
// Usage: node app/shell/cdp.js "lpdbg.metrics()"
const http = require("http");
const expr = process.argv.slice(2).join(" ");
http.get("http://localhost:9222/json", (res) => {
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
