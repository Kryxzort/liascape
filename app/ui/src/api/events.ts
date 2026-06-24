import { useEffect } from "react";
import { API } from "./client";

export type LpEvent =
  | { type: "wallpaper-changed"; payload: { path: string | null } }
  | { type: "scene-crashed"; payload: { path: string } }
  | { type: "timed-stopped"; payload: null }
  | { type: "download-progress"; payload: { id: string; value: number; done?: boolean } }
  | { type: "unsub-progress"; payload: { done: number; total: number; currentId: string; finished?: boolean } }
  | { type: "library-synced"; payload: { count: number } }
  | { type: "steam-qr"; payload: { png: string } }
  | { type: "steam-signed-in"; payload: { signedIn: boolean; accountName: string; daysLeft: number | null; mode: string } }
  | { type: "steam-qr-error"; payload: { message: string } }
  | { type: "steam-qr-cancelled"; payload: null };

// API: subscribe to backend push events over WS /events. Auto-reconnects.
export function useEvents(onEvent: (e: LpEvent) => void) {
  useEffect(() => {
    if (!API) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (stop) return;
      ws = new WebSocket(`${API.replace("http", "ws")}/events`);
      ws.onmessage = (m) => {
        try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!stop) retry = setTimeout(connect, 1000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { stop = true; clearTimeout(retry); ws?.close(); };
  }, [onEvent]);
}
