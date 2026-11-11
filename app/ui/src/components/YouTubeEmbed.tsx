import { X } from "lucide-react";

// Shared between the Browse and the Library item sidebars (1:1 — the only fully-duplicate
// bit). Overlays the thumbnail stage with a 16:9 YouTube player (the video's own aspect), centered. The picture's preview
// switch shows it (SidePanel.tsx SideMedia): it autoplays MUTED — the desktop's wallpaper owns the sound; the player's own
// button unmutes it. Unmounting it (a switch, the item changing, the sidebar closing) stops it.
const ytId = (u: string) => u.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null;

export function YouTubeEmbed({ url, onClose }: { url: string; onClose: () => void }) {
  const id = ytId(url);
  if (!id) return null;
  return (
    <div className="yt-stage" data-preview-layer="youtube" onClick={(e) => e.stopPropagation()}>
      <iframe className="yt-frame" src={`https://www.youtube.com/embed/${id}?autoplay=1&mute=1&rel=0`}
        title="YouTube trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      <button className="yt-close" title="Close the trailer" aria-label="Close the trailer" onClick={onClose}><X size={16} /></button>
    </div>
  );
}
