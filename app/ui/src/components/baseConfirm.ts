import { create } from "zustand";
import type { LibraryItem } from "../api/client";

// Deleting, trashing or unsubscribing a scene that presets in the library play asks first (BaseSceneConfirm.tsx), naming how
// many: those presets stay in the library, greyed out until the scene is back (their sidebar downloads it again). A preset's
// own delete never asks and never touches its base. Guard: probe-sidebar lib:baseDelete, lib:baseDeleteOff

// title: the one item's, else null (`items` of them); n: the presets that play them; bases: how many of them those presets play
export type BaseAsk = { title: string | null; items: number; n: number; bases: number; verb: "delete" | "unsubscribe" };
type Ask = BaseAsk & { answer: (yes: boolean) => void };
export const useBaseConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }));

const norm = (p: string) => p.replace(/\/+$/, "");

// the library's presets that play one of `items` now (their base folder is that item's), leaving out presets that go too
// API: a preset's basePath is the folder it plays (Helpers/Presets.cs BaseDirOf), the same path as its base item's videoPath
export function presetsUsing(items: LibraryItem[], library: LibraryItem[]): LibraryItem[] {
  const gone = new Set(items.map((i) => norm(i.videoPath)));
  const bases = new Set(items.filter((i) => i.isScene && !i.isPreset).map((i) => norm(i.videoPath)));
  if (!bases.size) return [];
  return library.filter((p) => p.isPreset && p.basePath && bases.has(norm(p.basePath)) && !gone.has(norm(p.videoPath)));
}

// true at once when no library preset plays any of them; else the dialog, true = go ahead. A second ask while one is open
// answers the first no.
export function confirmBaseRemoval(items: LibraryItem[], library: LibraryItem[], verb: BaseAsk["verb"] = "delete"): Promise<boolean> {
  const users = presetsUsing(items, library);
  if (!users.length) return Promise.resolve(true);
  const bases = new Set(users.map((p) => norm(p.basePath!)));
  return new Promise((resolve) => {
    useBaseConfirm.getState().ask?.answer(false);
    useBaseConfirm.setState({ ask: { title: items.length === 1 ? items[0].title : null, items: items.length, n: users.length, bases: bases.size, verb, answer: (yes) => { useBaseConfirm.setState({ ask: null }); resolve(yes); } } });
  });
}
