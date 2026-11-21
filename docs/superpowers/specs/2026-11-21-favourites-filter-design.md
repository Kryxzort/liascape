# Favourites as a filter, and "In my library" that shows the set directly

## Why

Browse's Workshop has a "Favourites" pill beside the Workshop pill that swaps Browse to a separate list. The owner's view:
a separate tab for favourites is strange. Favourites are a subset of the Workshop, so they belong in the filter column with
the other ways of narrowing it, beside "In my library". The owner also wants search and every sort to keep working on
them, with the list cached so that's fast.

Looking at the column surfaced a second problem: "In my library ✓" filters the Workshop's own pages client-side, so with
no search term it scans page after page looking for owned items. The two rows would sit side by side, so they must behave
alike.

## Goals

- The filter column's first group (today "Library") holds two three-way rows, **In my library** and **Favourites**, with
  one meaning for both:
  - **✓**: show that set directly.
  - **✕**: browse as usual and hide that set.
  - **–**: no effect.
- Search, every sort that can be computed from the data (below), and every other switch (Age, Type, Resolution, Genre,
  features, presets) work while a ✓ is on.
- The favourites list is cached, so turning Favourites ✓ on is instant after the first load, and it notices a
  change within about a minute, or within seconds of a star set through Steam from Liascape.
- Rows combine. With both ✓ you see favourites you own. Favourites ✓ with Library ✕ shows favourites you haven't
  downloaded yet. Both ✕ shows the Workshop minus everything you own or starred.
- The Library tab's filter column gets a Favourites row too (owner: yes): ✓ shows only the library items starred on
  Steam, ✕ only the unstarred ones. It is served from the same cache.
- The Favourites pill goes away. The creator and presets pills stay: they're temporary lists opened from a sidebar and
  closed with ×, not standing tabs.

## Non-goals

- No change to how a favourite is set: the sidebar's star tile stays as it is.
- No favourites for sources other than the Workshop.
- No offline Browse: images and details for items not cached still load from Steam.

## Anti-goals (failure even if it "works")

- A first Favourites ✓ that sits blank with no sign of progress on a big or private list.
- A star toggled in the sidebar that doesn't show in the filtered view until a restart.
- The ✓ rows scanning Workshop pages. That is the behaviour being removed.
- A three-way switch with a dead position, or a sort shown that silently does nothing.

## Constraints

- **Steam serves a user's favourites only as a plain list.** It can't be searched, and it sorts only by last updated or
  score. Today: `SteamWorkshopService.ListAsync`, the client protocol's `UserFilesAsync` (anonymous), and the community
  page `SteamCommunity.MyFavoritesPageAsync` for a private profile (30 a page, signed in, SteamGate-paced).
- **Signed out** there are no favourites. The row shows disabled with "Sign in to Steam", like the sidebar's star.
- **"Most Popular · period"** is Steam's trend ranking from activity Liascape can't see, so it can't be computed locally.
- **The repo is public:** the cache holds the user's Steam data, so it lives in the user's cache dir and never in logs.
- **CLAUDE.md:** features compose, settings apply live, every new UI element follows `.claude/rules/ui/design.md`'s
  checklist, and probes are hermetic.

## Approaches

- **A. A switch that swaps to Steam's favourites list.** Smallest change, but search hides and the sorts narrow to two.
  Rejected: the owner needs search and sorts.
- **B. Cache the whole favourites list and work on it locally.** Chosen by the owner. Search, sorts and switches all work.
  It costs a backend cache and a one-time load, which is slow for a large private list.
- **C. A star toggle in the top bar.** Rejected: it puts a filter outside the filter column, which is the oddness being
  fixed.

## The design

### The set rows

- The group is renamed **Yours**. It holds "In my library" and "Favourites", both UI-only pseudo-tags in the include /
  exclude sets like today's `@library` (`workshopFilter.ts`), plus `@favorites`.
- **✓ on either row** switches Browse from the Workshop's paged query to the **local set**:
  - with both ✓: the intersection of the two sets;
  - with one ✓ and the other ✕: that set minus the other;
  - then the other switches, the search and the sort apply locally.

  There is no paging against Steam; the grid shows the whole result, virtualised as today.
- **✕ only** (no ✓): the Workshop's paged query as today, with the set's IDs removed client-side. This is today's "In my
  library ✕".
- **Library set:** the library's Workshop items, from the library index, with each item's Workshop details (tags,
  counts, dates) from the same details cache as favourites. A library item with no cached details is fetched with the
  rest in one batch.

### Inside a creator's or a scene's presets list (builder's question; my call)

The rows compose with those lists rather than leaving them. ✓ shows the user's own favourites (or library items)
that are in that list: by that creator (the details' creator ID), or presets of that scene (the details' base
dependency). ✕ hides the set from the list's pages
client-side, as ✕ does on the whole Workshop.

### Two sorts (builder's question; my call)

A local set keeps its own persisted sort, separate from the Workshop's `browseFilter.sort`. Turning the last ✓ off
brings back the Workshop's own sort untouched, its trend period included. The local menu never offers "Most Popular ·
period"; the local sort defaults to Most Subscribed.

### Signed out (builder's question; my call)

A saved Favourites ✓ / ✕ is kept, so it returns at sign-in. While signed out it has no effect, and its row shows the
state dimmed with "Sign in to Steam". The row can still be cleared to – but not set, so it's never a switch you can't
turn off. If Favourites ✓ was the only ✓, Browse shows the Workshop as if it were –.

### Library items Steam has nothing on (builder's question; my call)

An item removed or hidden on Steam, or not yet fetched, still shows under Library ✓. Its card is built from the
library's own data (title, preview, the library's tags). It sorts after items that have the field a sort needs, and
tag switches use the library's tags.

### The favourites cache (backend)

- **Contents:** an ID list plus per-ID details: title, preview, tags, author, time created, time updated, subscriptions,
  favourites, vote score. Stored atomically under the user's cache dir (`.claude/rules/backend/state-files.md`
  conventions), keyed by SteamID.
- **First load:** pages through the whole list (client protocol, or the community page for a private profile), then
  fetches details in batches. Results stream to the UI as they arrive: the grid fills, and a quiet line shows
  "Loading your favourites — 120 of 450".
- **Staying current (no timed refresh):**
  - **Browse opened, or a Favourites ✓ / ✕ turned on:** the cache shows at once. In the background Liascape fetches the
    favourites' IDs only (Steam's user-files call with its IDs-only option), diffs them with the cache, fetches
    details only for new IDs, and drops removed ones.
  - **While Browse is open and visible:** a count-only check (the same call's total-only option) about once a minute.
    A changed count runs the ID diff.
  - **A star set through Steam** (the Steam-mode "Favourite on Steam", a separate TODO item, opens the item's page
    in the Steam app): Liascape watches that one item's favourite state every few seconds for a few minutes and
    updates the cache when it flips.
  - **A star set in Liascape:** applied to the cache at once. A diff that started before it never overwrites it.
  - **Details** (titles, counts) come with an item's first fetch and refresh when its sidebar opens (which reads live
    details already). Sorts use the cached counts and accept that they age.
  - **The builder verifies first** that the IDs-only and total-only options work over Liascape's anonymous client
    connection. If they don't, re-read page 1 of the list instead. For a private profile (the community page, 30 a
    page, paced), the quick check reads page 1 only; check how Steam orders that page before relying on it.
- **Sign-out** clears the favourites set from view; the cache of another account is never shown.

### Search and sorts on a local set

- **Search:** case-insensitive match on title, author and tags.
- **Sort menu while a ✓ is on:**
  - Most Recent (time created)
  - Recently Updated
  - Most Subscribed
  - Top Rated (vote score)
  - Most Favourited
  - Title A–Z
  - Date Added, for the library set only
- **"Most Popular · period" is left out of that menu** rather than shown and ignored. If it was the active sort when a ✓
  turned on, the sort becomes Most Subscribed, and the menu shows that.

### UI

- Remove the Favourites pill (`SourcePills.tsx`). The Workshop pill is plain "Workshop" again.
- The two rows look and animate like today's "In my library" row. The signed-out Favourites row is disabled with its
  reason.
- The load line follows the app's existing progress-line pattern, with theme, glow, motion and translucency toggles.

## Left to the builder

- The refresh age, the batch sizes and the cache file's format.
- Whether the details cache is shared with Browse's existing per-item details (preferred, if one exists).
- How the library set gets Workshop details for items downloaded before details were cached.
- Probe cells: both rows' ✓ / ✕ / – states and their combinations, search and sort on a local set, the signed-out
  row, star / unstar updating the view live, and the trend sort's fallback.
