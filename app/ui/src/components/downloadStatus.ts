// The card's short words for a Workshop download's step (WS download-progress `status`, the store's downloadStatus — the
// sidebar shows the whole sentence). A bare "Downloading…" over an empty bar for a minute on a big item looks like a hang,
// so the card says whose turn it is (docs/decisions.md § "Report Workshop download phases, not a percent").
export function shortDownloadStatus(status: string | undefined): string {
  if (!status) return "Downloading…";
  // waiting for its page's turn in the Steam to-do (components/SteamTodoPanel.tsx) / for the Steam client (one helper at a time)
  if (status.includes("Steam to-do")) return "In the Steam to-do";
  if (status.startsWith("Waiting for the Steam app")) return "Waiting for the Steam app…";
  if (status.includes("click Subscribe")) return "Click Subscribe in Steam";
  if (status.startsWith("Steam is downloading")) return "Steam is downloading…";
  if (status.startsWith("Steam is finishing")) return "Steam is finishing…";
  if (status.startsWith("Subscribing")) return "Subscribing…";
  if (status.includes("waiting for Steam")) return "Waiting for Steam…";
  return "Downloading…";
}
