import type { ReactNode } from "react";
import { HardDrive, Star, Users } from "lucide-react";
import { fmtCount, fmtSize } from "./sideFormat";

// The item sidebars' number pills (.side-pill), one look on both tabs: Steam's counts and a size.

// Steam's current counts (the backend reads `subscriptions` / `favorited`, never the lifetime ones — Guard:
// test-workshop-social.sh); the star is the favourite's everywhere (the Favourite tile), the people the subscribers'. No view
// count. `fav`: the favourites pill as a Workshop item's toggle (WorkshopSocial.tsx FavoritePill), in the plain one's place.
// Guard: probe-steam ws:counts, lib:ws:counts
export function StatPills({ subscriptions, favorites, fav }: { subscriptions: number | null | undefined; favorites: number | null | undefined; fav?: ReactNode }) {
  const subs = fmtCount(subscriptions), favs = fmtCount(favorites);
  return (
    <>
      {subs && <span className="side-pill" title="Subscribers" data-side-stat="subscribers"><Users size={13} /> {subs}</span>}
      {fav ?? (favs && <span className="side-pill" title="Favourites" data-side-stat="favorites"><Star size={13} /> {favs}</span>)}
    </>
  );
}

// a size: Browse's is Steam's download size, the Library's the item's files on this disk (`title` says which)
export function SizePill({ bytes, title }: { bytes: number | null | undefined; title: string }) {
  const s = fmtSize(bytes);
  return s ? <span className="side-pill" title={title} data-side-row="size"><HardDrive size={13} /> {s}</span> : null;
}
