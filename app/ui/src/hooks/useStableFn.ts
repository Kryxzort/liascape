import { useCallback, useLayoutEffect, useRef } from "react";

// A function whose identity never changes but that always calls the latest `fn` (the render's closure). PERF: what a list
// hands its memo'd cards — a fresh closure per render made every card re-render on any change of the list's parent (a
// sidebar focus re-rendered all ~170 library cards). Only for event handlers: never call it during render.
export function useStableFn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}
