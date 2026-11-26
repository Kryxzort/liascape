import { useEffect, useRef, useState } from "react";
import { api, type WorkshopSubState } from "../api/client";
import { useStore } from "../store";

// A Workshop item's subscription as the item sidebar needs it for one the library doesn't hold (components/ItemSide.tsx: a
// Workshop result or a local Wallpaper Engine item that Steam keeps subscribed gets Download and Unsubscribe, not Subscribe).
// State = POST /workshop/state (disk + the unsubscribe queue + the Steam to-do, never the Steam client), re-read on every
// event that can change it (the store's wsStateTick) and every 4 s while something is still moving (pending, or an
// unsubscribed local folder Steam hasn't deleted yet). A local item whose folder Steam deleted → the Browse list reloads
// (it leaves). `id` null = nothing asked. Guard: probe-steam steam:sub:workshop, steam:sub:weLocal
export function useWsSubState(id: string | null, weLocal: boolean): WorkshopSubState | null {
  const tick = useStore((s) => s.wsStateTick);
  const [st, setSt] = useState<{ id: string; v: WorkshopSubState | null } | null>(null);
  const [readTick, setReadTick] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.workshopState([id]).then((r) => { if (alive) setSt({ id, v: r[id] ?? null }); }).catch(() => {});
    return () => { alive = false; };
  }, [id, tick, readTick]);
  const cur = id && st?.id === id ? st.v : null;
  const moving = !!cur && (!!cur.pending || (!cur.subscribed && cur.onDisk && weLocal));
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setReadTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [moving]);
  const reloaded = useRef(false);
  useEffect(() => {
    if (weLocal && cur && !cur.onDisk && !cur.pending && !reloaded.current) { reloaded.current = true; useStore.getState().reload(); }
  }, [weLocal, cur]);
  return cur;
}
