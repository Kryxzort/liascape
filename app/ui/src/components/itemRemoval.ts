import type { LibraryItem } from "../api/client";
import { useStore } from "../store";
import { confirmBaseRemoval } from "./baseConfirm";
import { unsubBlocked } from "./subscribeMode";

// The library's removals, one set for every place that removes a library item: the Library's cards and Delete key, and the
// item sidebar on both tabs (components/ItemSide.tsx), so the Library's and Browse's Unsubscribe / Delete act alike.
// `clearSel`: the tab's own selection, emptied once a removal goes ahead.
//
// With auto-import on, a subscribed Workshop item has no plain Delete (the import would bring it back): its Delete is
// Unsubscribe = Delete from source (undoable; Undo subscribes again), on the card's button, the Delete key and the sidebar
// alike; a mixed selection unsubscribes those and deletes the rest. The library's own copy of one ("Unsubscribe without
// deleting") deletes like any local item. Guard: probe-steam side:unsub:*
// When the mode can't unsubscribe (unsubOff; none today: signed out it goes to the item's Steam page) those Workshop items
// stay, nothing queued, and the status bar says why; the rest of a selection still deletes. Guard: probe-steam side:unsub:signedOut
export function useRemoval(clearSel: () => void) {
  const autoImport = useStore((s) => !!s.settings?.autoAddWeWallpapersToLibrary);
  const unsubOff = useStore((s) => unsubBlocked(s.settings, s.steam));
  const deleteFromSource = useStore((s) => s.deleteFromSource);
  const trashItems = useStore((s) => s.trashItems);
  const unsubscribeKeep = useStore((s) => s.unsubscribeKeepWorkshop);
  const setStatus = useStore((s) => s.setStatus);
  const unsubs = (i: LibraryItem) => autoImport && !!i.workshopId && !!i.subscribed;
  const lib = () => useStore.getState().libraryItems;

  // A scene that presets in the library play asks first, naming how many (components/baseConfirm.ts); `then` runs only once
  // it goes ahead (a sidebar closes after the answer, not before). Guard: probe-sidebar lib:baseDelete
  const doTrash = async (list: LibraryItem[], then?: () => void) => {
    const go = list.filter((i) => !unsubs(i) || !unsubOff);
    if (go.length && !await confirmBaseRemoval(go, lib(), go.some(unsubs) ? "unsubscribe" : "delete")) return;
    then?.();
    const ws = list.filter(unsubs);
    if (ws.length && !unsubOff) deleteFromSource(ws);
    const plain = list.filter((i) => !unsubs(i));
    const deleted = plain.length ? trashItems(plain) : Promise.resolve();
    if (ws.length && unsubOff) {
      const name = (l: LibraryItem[], other: string) => (l.length === 1 ? l[0].title : `${other}${l.length} wallpapers`);
      deleted.then(() => setStatus(plain.length ? `Deleted ${name(plain, "")}. ${unsubOff} ${name(ws, "the other ")}` : unsubOff, true, true));
    }
    clearSel();
  };
  // "Delete and unsubscribe" (auto-import off): every Workshop item of `list` leaves the library and Steam
  const doDeleteSource = async (list: LibraryItem[], then?: () => void) => {
    if (unsubOff) return;
    const ws = list.filter((i) => i.workshopId);
    if (!ws.length || !await confirmBaseRemoval(ws, lib(), "unsubscribe")) return;
    then?.(); clearSel();
    deleteFromSource(ws);
  };
  // "Unsubscribe without deleting" (the Unsubscribe tile's right-click): each subscribed Workshop item becomes the library's
  // own copy, then unsubscribes (POST /workshop/unsubscribe-keep, one at a time); the rest of a selection is left alone
  const doKeep = async (list: LibraryItem[]) => {
    const ws = [...new Map(list.filter(unsubs).map((i) => [i.workshopId!, i])).values()];
    if (!ws.length || unsubOff) return;
    clearSel();
    setStatus(`Copying ${ws.length === 1 ? ws[0].title : `${ws.length} wallpapers`} into your library…`, false);
    for (const i of ws) await unsubscribeKeep(i.workshopId!, i.title);
    if (ws.length > 1) setStatus(`Unsubscribing from ${ws.length} wallpapers. They stay in your library.`);
  };
  return { autoImport, unsubOff, unsubs, doTrash, doDeleteSource, doKeep };
}
