// Is Liascape's own Vite dev server answering at `base`? Any other server on the port (another project's Vite, anything
// answering 200 on `/`) must not count: dev mode starts no backend and waits for a dev backend's serve.port, so a foreign
// server left the app quitting with no window. Only app/ui/vite.config.ts's `/__liascape/token` sends VITE_MARKER (on its
// 403 too, which is what a request from here gets). Guard: scripts/test-vite-detect.sh.
const http = require("http");

const VITE_MARKER = "x-liascape-vite";

function liascapeViteUp(base, cb, timeoutMs = 400) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  let req;
  try {
    req = http.get(new URL("/__liascape/token", base), (res) => { res.destroy(); finish(res.headers[VITE_MARKER] === "1"); });
  } catch { return finish(false); }
  req.on("error", () => finish(false));
  req.setTimeout(timeoutMs, () => { req.destroy(); finish(false); });
}

module.exports = { liascapeViteUp, VITE_MARKER };
