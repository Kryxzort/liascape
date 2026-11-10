import type { ScenePropsResp } from "../api/client";

// The last answer per scene for this app session (ScenePropsEditor): a revisit shows at once — the Library sidebar's body
// waits for it, so nothing pops in — and the fresh read replaces it. Every answer that lands refreshes it.
export const scenePropsCache = new Map<string, ScenePropsResp>();
