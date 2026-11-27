import { useEffect, useRef } from "react";
import { useStore } from "../store";

// A read Steam's cooldown refused (`cooled`) asks again once the cooldown ends (store steamCoolEnds), by itself: the item
// sidebar's creator, favourite and comments, the Author field's lookup (components/SteamCooldown.tsx). Guard: probe-steam
// cool:side, cool:author
export function useAfterCooldown(cooled: boolean, again: () => void) {
  const ends = useStore((s) => s.steamCoolEnds);
  const seen = useRef(ends);
  const run = useRef(again);
  useEffect(() => { run.current = again; });
  useEffect(() => {
    if (ends === seen.current) return;
    seen.current = ends;
    if (cooled) run.current();
  }, [ends, cooled]);
}
