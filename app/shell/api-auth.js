// The backend's API token (web-backend.md § Local API security): `liascape serve` writes it to serve.token beside
// serve.port (0600). main.js hands it to the page as ?token= (the page keeps it, sends X-Liascape-Token); the probes use
// the same helpers for the pages they load and their own requests. Read fresh each call: a backend may have written a
// new one (a first start, an app launch) since.
const fs = require("fs");
const os = require("os");
const path = require("path");

// the backend's ~/.config (.NET's ApplicationData = $XDG_CONFIG_HOME, else ~/.config)
const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "liascape");
const tokenFile = () => path.join(configDir(), "serve.token");
function token() {
  try { return fs.readFileSync(tokenFile(), "utf8").trim(); } catch { return ""; }
}
// a page URL (the backend's own, Vite's ?api=, or the built UI's file://) with ?token= added
function withToken(url) {
  const t = token();
  if (!t) return url;
  const u = new URL(url);
  u.searchParams.set("token", t);
  return u.toString();
}
// headers for a request of this process (Node's fetch) to the backend
const authHeaders = (h = {}) => { const t = token(); return t ? { ...h, "X-Liascape-Token": t } : h; };

module.exports = { configDir, tokenFile, token, withToken, authHeaders };
