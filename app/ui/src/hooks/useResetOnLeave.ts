import { useLayoutEffect } from "react";
import { useStableFn } from "./useStableFn";

// App.tsx keeps a page mounted while another tab shows (hidden by React's <Activity>), so its state outlives a switch.
// Leaving it runs `reset`, clearing what a page built anew starts without (a selection). Its grid's scroll offset stays:
// the browser keeps a hidden element's offset and brings it back with the page, and the rows above it hold their real
// height while skipped (index.css `.card`), so it comes back on the same row. A layout effect's cleanup: React runs it on
// hiding. Guard: probe-layout tabs:keep
export function useResetOnLeave(reset: () => void) {
  const onLeave = useStableFn(reset);
  useLayoutEffect(() => () => onLeave(), [onLeave]);
}
