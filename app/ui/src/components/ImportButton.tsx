import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, FileVideo, Link2, Upload } from "lucide-react";
import { useStore } from "../store";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { FolderFlap } from "./icons";
import { menuAt } from "./menuItems";
import { useFadeOff } from "./motion";
import { droppedLink, droppedPaths, hasPicker, importFiles, importFolder, isFileDrag } from "./importPick";

// The Library's Import, a split button `[⇪ Import │ ▾]` (the top bar's `.ss-split` pair): a click on Import picks a folder; the
// chevron opens its menu (a folder, files or a link), and so do ↓ on the chevron and a right-click on either half (a control's own
// menu for its variants, components/ContextMenu.tsx; docs/decisions.md § "Left click does the tab's main action, right
// click opens the item sidebar" bars only item menus). Each opens the import dialog (components/ImportDialog.tsx) on what
// was picked (a link: its own field, components/ImportDialog.tsx). The chevron turns while the menu is open (the dropdowns' `.sel-caret`; motion off: at once).
// Guard: --probe probe-import.js import:button:*, import:files:*, import:link:*
export function ImportButton({ narrow }: { narrow: boolean }) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const chev = useRef<HTMLButtonElement>(null);
  // stable: ContextMenu's open effect (first entry focused) re-runs on a new onClose, and the top bar re-renders often
  const close = useCallback(() => setMenu(null), []);
  // from the chevron the menu hangs under the pair, flush with its edge on the window's nearer side (ContextMenu opens away
  // from that side); a right-click opens it at the pointer
  const openUnder = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left < innerWidth / 2 ? r.left : r.right, y: r.bottom + 4 });
  };
  const onChevKey = (e: KeyboardEvent) => { if (e.key === "ArrowDown") { e.preventDefault(); openUnder(); } };
  return (
    <>
      <div ref={wrap} className={`ss-split imp-split${menu ? " open" : ""}`} data-import-split
        onContextMenu={(e) => { e.preventDefault(); setMenu(menuAt(e)); }}>
        <button type="button" className="btn ghost ico imp-main" aria-label="Import" title={narrow ? "Import a folder" : undefined} data-import-btn
          onClick={() => { void importFolder(); }}>
          <Upload size={14} /><span className="tb-label">Import</span>
        </button>
        <button ref={chev} type="button" className="btn ghost imp-more" aria-label="More ways to import" aria-haspopup="menu"
          aria-expanded={!!menu} title="Import files, a folder or a link" data-import-more
          onClick={() => { if (menu) setMenu(null); else openUnder(); }} onKeyDown={onChevKey}>
          <ChevronDown size={14} className="sel-caret" />
        </button>
      </div>
      <ContextMenu at={menu} onClose={close} returnTo={chev} label="Import"
        items={[
          { key: "folder", label: "Import a folder…", icon: <FolderFlap size={14} />, onPick: () => { void importFolder(); } },
          { key: "files", label: "Import files…", icon: <FileVideo size={14} />, onPick: () => { void importFiles(); }, disabled: !hasPicker() },
          { key: "link", label: "Import from a link…", icon: <Link2 size={14} />, onPick: () => useStore.getState().openLink() },
        ]}
        note={hasPicker() ? null : "Picking files needs the app's window. Drop them on it instead."} />
    </>
  );
}

// Files or folders dragged over the window from a file manager: a frame says the window takes them, a drop opens the import
// dialog on them (any tab); a web link dragged from a browser opens the import from a link on it. Motion off: the frame only
// fades. Guard: --probe probe-import.js import:drop:*, import:link:drop
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
      const link = paths.length ? null : droppedLink(e.dataTransfer!);
      if (paths.length) useStore.getState().openImport(paths);
      else if (link) useStore.getState().openLink(link); // a link dragged from a browser: the import from a link on it
      else useStore.getState().setStatus("Only files, folders and web links can be imported", true);
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
          <div className="imp-drop-card"><Upload size={22} /><b>Drop to import</b><span>folders, videos, GIFs, pictures and links</span></div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
