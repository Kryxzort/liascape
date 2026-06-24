// Exposes native file/folder pickers to the renderer (Settings "Browse" buttons). contextIsolation
// stays on; only these two narrow methods cross the bridge. In a plain browser window.lp is undefined
// and Settings falls back to manual text entry.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lp", {
  pickFolder: () => ipcRenderer.invoke("lp:pick", { folder: true }),
  pickFile: () => ipcRenderer.invoke("lp:pick", { folder: false }),
  // FREEZE FIX: main-process WM focus signal → renderer pauses gif decoding when backgrounded.
  onActiveChange: (cb) => { ipcRenderer.on("lp:active", (_e, v) => cb(!!v)); },
});
