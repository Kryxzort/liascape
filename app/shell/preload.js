// Exposes native file/folder pickers to the renderer (Settings "Browse" buttons). contextIsolation
// stays on and the preload is sandboxed (main.js webPreferences — it may only use contextBridge / ipcRenderer);
// only these narrow methods cross the bridge, and main answers the picker only for the app's own page. In a plain browser window.liascape is undefined
// and Settings falls back to manual text entry.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liascape", {
  pickFolder: () => ipcRenderer.invoke("liascape:pick", { folder: true }),
  pickFile: () => ipcRenderer.invoke("liascape:pick", { folder: false }),
  // FREEZE FIX: main-process WM focus signal → renderer pauses gif decoding when backgrounded.
  onActiveChange: (cb) => { ipcRenderer.on("liascape:active", (_e, v) => cb(!!v)); },
});
