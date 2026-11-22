// Exposes native file/folder pickers to the renderer (Settings "Browse" buttons). contextIsolation
// stays on and the preload is sandboxed (main.js webPreferences — it may only use contextBridge / ipcRenderer);
// only these narrow methods cross the bridge, and main answers the picker only for the app's own page. In a plain browser window.liascape is undefined
// and Settings falls back to manual text entry.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("liascape", {
  pickFolder: () => ipcRenderer.invoke("liascape:pick"),
  // the Library's Import, right-click: wallpaper files (several at once) → their paths, or null
  pickFiles: () => ipcRenderer.invoke("liascape:pick", "files"),
  // a file or folder dropped on the window → its path ("" for one that isn't on disk): the page can't see paths itself
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ""; } },
  // FREEZE FIX: main-process WM focus signal → renderer pauses gif decoding when backgrounded.
  onActiveChange: (cb) => { ipcRenderer.on("liascape:active", (_e, v) => cb(!!v)); },
  // the window shown (true) or hidden / minimized (false), whatever has focus
  onShownChange: (cb) => { ipcRenderer.on("liascape:shown", (_e, v) => cb(!!v)); },
});
