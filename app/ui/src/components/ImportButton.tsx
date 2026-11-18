import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FileVideo, Upload } from "lucide-react";
import { useStore } from "../store";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { menuAt } from "./menuItems";
import { useFadeOff } from "./motion";
import { droppedPaths, hasPicker, importFiles, importFolder, isFileDrag } from "./importPick";

// The Library's Import: a click picks a folder, its right-click menu picks files instead (a control's own menu for a variant
// of its action, docs/decisions.md § "Left click does the tab's main action, right click opens the item sidebar"); either
// opens the import dialog (components/ImportDialog.tsx) on what was picked. Guard: --probe probe-import.js import:button
export function ImportButton({ narrow }: { narrow: boolean }) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className="btn ghost ico" aria-label="Import" aria-haspopup="menu" title={narrow ? "Import" : undefined} data-import-btn
        onClick={() => { void importFolder(); }} onContextMenu={(e) => { e.preventDefault(); setMenu(menuAt(e)); }}>
        <Upload size={14} /><span className="tb-label">Import</span>
      </button>
      <ContextMenu at={menu} onClose={() => setMenu(null)} returnTo={ref} label="Import"
        items={[{ key: "files", label: "Import files…", icon: <FileVideo size={14} />, onPick: () => { void importFiles(); }, disabled: !hasPicker() }]}
        note={hasPicker() ? null : "Picking files needs the app's window. Drop them on it instead."} />
    </>
  );
}

// Files or folders dragged over the window from a file manager: a frame says the window takes them, a drop opens the import
// dialog on them (any tab). Motion off: the frame only fades. Guard: --probe probe-import.js import:drop:*
export function ImportDrop() {
  const fadeOff = useFadeOff();
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => { if (!isFileDrag(e.dataTransfer)) return; e.preventDefault(); depth++; setOver(true); };
    const overFn = (e: DragEvent) => { if (!isFileDrag(e.dataTransfer)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!isFileDrag(e.dataTransfer)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault(); depth = 0; setOver(false);
      const paths = droppedPaths(e.dataTransfer!);
      if (paths.length) useStore.getState().openImport(paths);
      else useStore.getState().setStatus("Only files and folders on this computer can be imported", true);
    };
    addEventListener("dragenter", enter); addEventListener("dragover", overFn); addEventListener("dragleave", leave); addEventListener("drop", drop);
    return () => { removeEventListener("dragenter", enter); removeEventListener("dragover", overFn); removeEventListener("dragleave", leave); removeEventListener("drop", drop); };
  }, []);
  return createPortal(
    <AnimatePresence>
      {over && (
        <motion.div className="imp-drop" data-import-drop aria-hidden
          {...fadeOff({ initial: { opacity: 0, scale: 0.985 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.985 },
            transition: { type: "spring", stiffness: 380, damping: 30 } })}>
          <div className="imp-drop-card"><Upload size={22} /><b>Drop to import</b><span>folders, videos, GIFs and pictures</span></div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
