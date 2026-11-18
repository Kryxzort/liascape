import { useStore } from "../store";

// The Electron shell's native pickers and dropped-file paths (app/shell/preload.js), read when used (never cached at load: a
// probe page without the preload sets its own). Absent (a plain browser): the import dialog asks for the folder's path.
type Bridge = {
  pickFolder?: () => Promise<string | null>;
  pickFiles?: () => Promise<string[] | null>;
  pathForFile?: (f: File) => string;
};
const bridge = () => (window as unknown as { liascape?: Bridge }).liascape;
export const hasPicker = () => !!bridge()?.pickFolder;
export const pickFolder = async () => (await bridge()?.pickFolder?.()) ?? null;

// The Library's Import (and Settings' "Add folder", `watch`): a folder from the native picker, then the import dialog on it.
// No picker: the dialog opens asking for the path.
export async function importFolder(watch = false) {
  if (!hasPicker()) { useStore.getState().openImport([], watch); return; }
  const p = await pickFolder();
  if (p) useStore.getState().openImport([p], watch);
}
// the Import's right-click: wallpaper files (several at once)
export async function importFiles() {
  const ps = await bridge()?.pickFiles?.();
  if (ps?.length) useStore.getState().openImport(ps);
}

// What a drop carries from the file manager: the shell's path of each file or folder, else (no shell) its `file://` URIs.
export const isFileDrag = (dt: DataTransfer | null) => !!dt && [...dt.types].some((t) => t === "Files" || t === "text/uri-list");
export function droppedPaths(dt: DataTransfer): string[] {
  const b = bridge();
  const paths = b?.pathForFile ? [...dt.files].map((f) => b.pathForFile!(f)).filter(Boolean) : [];
  if (paths.length) return paths;
  return dt.getData("text/uri-list").split(/\r?\n/).filter((u) => u.startsWith("file://"))
    .map((u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return ""; } }).filter(Boolean);
}
