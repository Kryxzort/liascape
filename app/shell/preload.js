// Exposes native file/folder pickers to the renderer (Settings "Browse" buttons). contextIsolation
// stays on; only these two narrow methods cross the bridge. In a plain browser window.liascape is undefined
// and Settings falls back to manual text entry.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liascape", {
  pickFolder: () => ipcRenderer.invoke("liascape:pick", { folder: true }),
  pickFile: () => ipcRenderer.invoke("liascape:pick", { folder: false }),
  // FREEZE FIX: main-process WM focus signal → renderer pauses gif decoding when backgrounded.
  onActiveChange: (cb) => { ipcRenderer.on("liascape:active", (_e, v) => cb(!!v)); },
});
