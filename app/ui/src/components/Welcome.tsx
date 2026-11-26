import { useEffect, useState } from "react";
import { AlertTriangle, Check, Compass, Layers } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api/client";
import { Segmented } from "./Segmented";
import { FolderFlap } from "./icons";
import { importFolder } from "./importPick";

// The Library's welcome: what shows in the grid's place while the library is empty (views/Library.tsx), with the three ways
// in. No step-by-step tour: each choice is one card that says what it is and does it. Steam's Workshop: whether Steam is on
// this PC (GET /steam/status `found`), the download mode (the setting itself, `workshopDownloadMode`, as Settings' radio
// rows set it; its hint is the chosen mode's), then Browse's Workshop or Settings' Steam section. A folder: the Library's
// Import (the import dialog). Browse: the Browse tab. Settings → Getting started → "Show the welcome" brings it back over a
// library with wallpapers (store `welcomeOpen`), with a way back to the grid. The cards are Settings' section cards
// (`.ssection`); their cascade plays only when it comes in by a change (`entering`), never when <Activity> shows the page
// again. Guard: --probe probe-firstrun.js welcome:*
const MODE_HINT: Record<string, string> = {
  steamapp: "The Steam app downloads them and keeps them updated, like Wallpaper Engine does. Steam has to be running.",
  subscribe: "Liascape subscribes with your Steam login, which you sign in to in Settings.",
};

type Found = { client: boolean; workshopFolder: boolean } | null;
// every answer the Steam line can give, laid in one cell (index.css `.welcome-stack`): the line is as tall as the longest
// from the first frame, so the answer landing moves nothing below it; the answers cross-fade
const FOUND_TEXT = {
  unknown: "Looking for Steam…",
  error: "Couldn't look for Steam.",
  yes: "Steam and its Wallpaper Engine folder are on this PC.",
  noFolder: "Steam is on this PC, but its Wallpaper Engine folder isn't where Settings says. Install Wallpaper Engine in Steam, or point Settings at the folder.",
  noSteam: "Steam isn't on this PC, or not where it usually is. Install Steam to get Workshop wallpapers.",
} as const;

export function Welcome({ empty, entering, leaving }: { empty: boolean; entering: boolean; leaving: boolean }) {
  const mode = useStore((s) => (s.settings?.workshopDownloadMode === "subscribe" ? "subscribe" : "steamapp"));
  const folder = useStore((s) => (s.settings?.workshopFolder as string | undefined) ?? "");
  const setSetting = useStore((s) => s.setSetting);
  const navigate = useStore((s) => s.navigate);
  const showWelcome = useStore((s) => s.showWelcome);
  const ws = useStore((s) => s.sources.find((x) => x.supportsTagFilter && x.available) ?? null);
  const setSource = useStore((s) => s.setSource);
  // asked again when the folder setting changes (Settings' field): the line follows
  // a failed ask says so, with Retry (`asks` asks again)
  const [found, setFound] = useState<Found | "error">(null);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    let alive = true;
    api.steamStatus().then((r) => { if (alive) setFound(r.found ?? "error"); }).catch(() => { if (alive) setFound("error"); });
    return () => { alive = false; };
  }, [folder, asks]);
  const foundKind = found === "error" ? "error" : !found ? "unknown" : found.client && found.workshopFolder ? "yes" : found.client ? "noFolder" : "noSteam";

  return (
    <div className={`welcome${entering ? " entering" : ""}${leaving ? " leaving" : ""}`} data-welcome={empty ? "empty" : "reopened"}>
      <div className="welcome-head">
        <h2>Welcome to Liascape</h2>
        <p className="welcome-sub">{empty ? "Your library is empty. Pick a way to bring in wallpapers." : "Ways to bring in more wallpapers."}</p>
        {!empty && <button type="button" className="btn ghost welcome-back" data-welcome-close onClick={() => showWelcome(false)}>Back to your wallpapers</button>}
      </div>
      <div className="welcome-choices">
        <section className="ssection welcome-choice" data-welcome-choice="workshop">
          <h3><span className="ssection-ico"><Layers size={15} /></span>Wallpaper Engine Workshop</h3>
          <p className="welcome-what">Subscribe to wallpapers on Steam's Workshop and they come into your library by themselves. Needs Wallpaper Engine in your Steam account.</p>
          <p className="welcome-found" data-welcome-found={foundKind}>
            {foundKind === "yes" ? <Check size={14} /> : <AlertTriangle size={14} />}
            <span className="welcome-stack">
              {Object.entries(FOUND_TEXT).map(([k, t]) => <span key={k} data-off={k === foundKind ? undefined : ""} aria-hidden={k !== foundKind}>{t}</span>)}
            </span>
            {foundKind === "error" && <button type="button" className="mini" data-welcome-found-retry onClick={() => { setFound(null); setAsks((n) => n + 1); }}>Retry</button>}
          </p>
          <div className="welcome-mode">
            <span className="welcome-label">Download with</span>
            <Segmented label="Download with" value={mode} onChange={(v) => setSetting("workshopDownloadMode", v)} attrs={{ "data-welcome-mode": mode }}
              options={[{ value: "steamapp", label: "The Steam app", attrs: { "data-welcome-wsmode": "steamapp" } },
                { value: "subscribe", label: "Your Steam login", attrs: { "data-welcome-wsmode": "subscribe" } }]} />
          </div>
          {/* both hints in one cell (the taller holds the room): a switch cross-fades them and moves nothing below */}
          <p className="shint welcome-mode-hint welcome-stack" data-welcome-mode-hint={mode}>
            {Object.entries(MODE_HINT).map(([k, t]) => <span key={k} data-off={k === mode ? undefined : ""} aria-hidden={k !== mode}>{t}</span>)}
          </p>
          <div className="welcome-acts">
            <button type="button" className="btn accent" data-welcome-go="workshop" disabled={!ws}
              onClick={() => { if (!ws) return; setSource(ws.index); navigate("browse"); }}>Browse the Workshop</button>
            <button type="button" className="btn ghost" data-welcome-go="steam" onClick={() => navigate("settings", "workshop")}>Steam settings</button>
          </div>
        </section>
        <section className="ssection welcome-choice" data-welcome-choice="import">
          <h3><span className="ssection-ico"><FolderFlap size={15} /></span>Your own files</h3>
          <p className="welcome-what">Import a folder of videos, GIFs or pictures from this PC. Watch the folder and new files come in by themselves.</p>
          <div className="welcome-acts">
            <button type="button" className="btn accent" data-welcome-go="import" onClick={() => { void importFolder(); }}>Import a folder</button>
          </div>
        </section>
        <section className="ssection welcome-choice" data-welcome-choice="browse">
          <h3><span className="ssection-ico"><Compass size={15} /></span>Browse wallpapers</h3>
          <p className="welcome-what">Find live wallpapers on the web and on the Workshop, preview them, and download one with a click.</p>
          <div className="welcome-acts">
            <button type="button" className="btn accent" data-welcome-go="browse" onClick={() => navigate("browse")}>Browse</button>
          </div>
        </section>
      </div>
    </div>
  );
}
