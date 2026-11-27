// Steam sign-in and the Workshop's subscribe / download controls — `scripts/test-ui-matrix.sh --probe probe-steam.js` (the
// matrix's hermetic stack). docs/decisions.md § "Offer a password sign-in beside the QR": a password sign-in
// (SteamPasswordModal) next to the QR one, and the Workshop's two download modes with the Steam page as their last resort. NOTHING here reaches
// Steam: a script injected before the page's own (CDP Page.addScriptToEvaluateOnNewDocument) answers /steam/status (the state
// a cell wants), /steam/login* and /steam/qr/* itself (recording each body), stubs POST /browse (Workshop items), the
// favourites and the library set's details (GET /workshop/my-favorites, POST /workshop/details: yours:*) and /download
// (held until the cell lets go / cancels), wraps WebSocket so a cell can push fake WS events (steam-login-code, steam-signed-in,
// steam-login-error, download-progress, workshop-favorites) through the page's own socket, and records every request body +
// console line. browse:fixture and yours:stack open a page without the stub on the stack's own backend and its fake Steam.
//   steam:row:signedOut   Settings → Getting Workshop wallpapers → Steam: "Not signed in." and what a download does then (opens
//                         the wallpaper's Steam page), Sign in with QR + Sign in with password; no tooltips
//   steam:row:rejected    a sign-in Steam turned down: the warning (in the warn colour), both sign-in buttons, no Sign out
//   steam:row:signedIn    "Signed in as …" + Sign out, no sign-in buttons
//   steam:row:steamcmd    a "steamcmd" or "steampage" download mode (dropped) saves and reads as "steamapp", the default: its
//                         radio checked, the Steam row, no steamcmd / page rows; a fresh install's default is "steamapp"
//   look:toggles          every Settings checkbox / radio is the themed control: dark when off, accent when on, the tick centred
//                         in its drawn box (pixel-centre.js); a click anywhere on a checkbox / radio row ticks it, a slider
//                         row's name doesn't
//                         (shots steam-toggles.png, steam-tick.png)
//   steam:row:steamApp    the two download-mode radios (steamapp, subscribe), no "Open in the Steam app": a click saves each,
//                         the Steam app's note (its fallbacks named), the sign-in row under both (signed out under the Steam
//                         app: the login takes over when the Steam app can't)
//   steam:modal:email     the password button → the modal (a labelled dialog: account name autocomplete=username focused,
//                         password type=password autocomplete=current-password); real typing + Enter → POST /steam/login once
//                         with both, the field emptied at once, "Signing in…"; WS email step → its text + the hint, the code field
//                         focused; a code → POST /steam/login/code; retry → "That code wasn't right"; steam-signed-in → closed,
//                         the row says signed in; the password nowhere (DOM, input values, storage, console, other requests,
//                         WS sends, status bar)
//   steam:modal:device    the authenticator step's text + label
//   steam:modal:confirm   approve-in-the-app: its text, "Waiting for your approval…", a code field too; signed-in closes it
//   steam:modal:error     steam-login-error → back to step 1, the message inline (role=alert), the account name kept, the password
//                         field empty + focused; a refused start (400 {error}: Steam's rate limit) shows its words, no retry
//   steam:modal:cancel    Escape on a code step → closed + POST /steam/login/cancel; a click outside doesn't close it; Cancel
//   steam:modal:keys      Tab order account → password → Cancel → Sign in; nothing in the modal has a title (tooltip)
//   steam:dlStatus        a Workshop download from the Browse sidebar while the backend waits on the Steam app: the sidebar and the
//                         status bar show download-progress's status ("Opened in Steam: subscribe there…"); the card the step in short
//                         words over a sweeping bar (each phase, + "In the Steam to-do" / "Waiting for the Steam app…"); Cancel
//                         aborts the request
//   steam:todo            the Steam to-do panel (components/SteamTodoPanel.tsx) for a fake WS steam-todo: "Subscribe in Steam · 2 of
//                         5", the title, the hint, Done — next / Open again / Skip / Stop + "Let the Steam app do all 4" (remaining);
//                         no tooltips, aria-label on the icon-only fold, fixed bottom-right on <body> above the item sidebar; each
//                         button → one POST /steam-todo/<action>; folds to a pill; the last entry: "Done", no Steam-app line, the
//                         message; gone after `finished`; the "Let the Steam app" note (needs WE, shows you playing). Shot
//                         steam-todo.png
//   steam:todoMotion:on|off  per frame: a playlist bar appearing → the dock's translateY passes through in-between values; fold /
//                         unfold → the panel's height too; the chevron is one icon turned 180°; a new current entry → its x off
//                         its place for ≥ 3 frames. off (Smooth window animations off): nothing moves — the lift, the fold's
//                         height and the chevron change at once; the panel, the body and the entries fade in / out (per
//                         frame: in-between opacity frames, the boxes still). Mid-animation shots
//                         steam-todo-glide.png / -fold.png / -slide.png
//   steam:sub:workshop    a Workshop result the library doesn't hold, per a stubbed /workshop/state (no subscription card):
//                         not subscribed → "Subscribe and apply" / "Subscribe", nothing else; Steam keeps it subscribed →
//                         "Download and apply" / "Download" and an Unsubscribe tile (rising in) → POST /workshop/unsubscribe →
//                         "Unsubscribing…" (disabled); Open on Steam → POST /steam/open-page, ok:false → window.open(https page)
//   steam:sub:weLocal     a WE-local item Steam keeps subscribed: Download buttons + Unsubscribe → POST; unsubscribed (folder
//                         still there): the tile fades out (per frame); no-glow (the chip's glow off) + bg-live (the tile keeps
//                         its own fill). Shots steam-sub*.png
//   side:idPill:still     the Library sidebar's Workshop ID pill (a scene, its hero row full: a stubbed resolution + age rating)
//                         keeps its box, and every hero chip keeps its own, per frame through "Copied" and back, at the window
//                         widths where the pill starts a row of its own and full screen (1920); the accessible name is the
//                         aria-label's ("— copy" / "— copied"), never the hidden face's; "Copied" rolls in (motion on) or only
//                         fades in place (motion off). Shots steam-idpill-*.png
//   side:deleteSource:names  auto-import off: a Workshop item's split reads Play | Delete, "Delete and unsubscribe" its right-click
//                         entry (the tooltip says so); its pick (stubbed POST /workshop/delete-from-source) → the status bar says
//                         "Unsubscribing from s1. Undo brings it back." (no Undo window's seconds); with auto-import on the
//                         library's own copy and a non-Workshop item's stay "Delete". Shots steam-delsource*.png
//   steam:sub:keepMenu    Browse's sidebar on a Workshop result the library holds: the Library's Unsubscribe tile; a real
//                         right-click opens a menu at the pointer ("Unsubscribe without deleting", focused; it grows in per frame;
//                         no request); Escape (focus back) and a click outside close it; picking it → ONE POST
//                         /workshop/unsubscribe-keep, the menu fades out, the status says "… It stays in your library."; the
//                         left-click posts the Library's /workshop/delete-from-source; no menu on the Unsubscribe of an item not in
//                         the library; no-glow + bg-live (its own fill, no glow). Shots steam-keepmenu*.png
//   steam:sub:keepMenuOff motion off: the menu fades in and out in place (motion-off.js)
//   steam:sub:signedOut   signed out under "Subscribe with Steam login": Browse's Unsubscribe tiles stay on (the library copy's:
//                         a click posts delete-from-source, its right-click entry on with no note; a subscribed item the library
//                         doesn't hold: /workshop/unsubscribe); "Use the Steam app" the same. Shot steam-sub-signedout.png
//   side:oneOff:menu      the item sidebar's "Subscribe" and "Subscribe and apply": a real right-click
//                         opens a menu at the pointer with that button's own entry only (Download: "Download then unsubscribe"
//                         under "Subscribe with Steam login", "… & apply" for Subscribe and apply; focused, grows
//                         in per frame, no request); picking each → ONE POST /download {oneOff: true, apply} and the menu fades
//                         out while the download shows; the left-click still posts a plain download (oneOff false); the route
//                         is asked as the pointer reaches the button; a WE-local item's Download has no menu; no-glow + bg-live
//                         (own fill, no glow). Shots steam-oneoff*.png
//   side:oneOff:missing   no route (GET /workshop/one-off {route: null, missing}): the entry shown disabled (aria-disabled,
//                         muted), the note says what's missing; a click on one posts nothing and keeps the menu open; Escape
//                         closes it. Shot steam-oneoff-missing.png
//   side:oneOff:menuOff   motion off: the menu fades in and out in place (motion-off.js)
//   side:oneOff:modes     per download mode, each button's menu holds its own entry in the mode's words ("Download then
//                         unsubscribe" under "Subscribe with Steam login", else "Download without subscribing"), and the route
//                         the stack's own backend gives (its sign-in: none): "Use the Steam app" enabled (a saved
//                         "steampage" the same: it reads as the default); "Subscribe with Steam login" disabled, "Sign in to
//                         Steam to download without subscribing" (a page can't make a one-off); a mode change (WS
//                         settings-changed) or a sign-out (WS steam-status) is asked again at the next right-click
//   side:blocked:download  no mode blocks a download (components/subscribeMode.ts actionBlocked: the Steam page is every
//                         mode's last resort): "Subscribe with Steam login" signed out keeps the sidebar's Subscribe /
//                         Subscribe and apply on, no line under them; a click posts /download; the card's button and the
//                         selection toolbar's Download N on; merged (auto-import on) and "Use the Steam app" the same; a
//                         sign-out under an open sidebar (WS steam-status) changes nothing; no-glow + bg-live: no glow.
//                         Shots steam-blocked*.png
//   side:getHint          no line under the item sidebar's Subscribe buttons in any mode, sign-in or auto-import, no second
//                         Subscribe beside them; a live mode change adds none. Shot steam-gethint.png
//   side:aboutTall        the About text of a long description: ≥ 300 px in a 900 px window, ≤ 45 % of the window, scrolls inside
//   side:blocked:subscribe  the Subscribe tile of the library's own copy stays on in every mode and sign-in (signed out it goes to
//                         the item's Steam page): a click posts /workshop/subscribe
//   side:unsub:names      auto-import on: a subscribed Workshop item's Library tiles have no Delete but "Unsubscribe" (the cloud-off
//                         icon, a tooltip naming the right-click and Undo); the card's button is named Unsubscribe; the library's
//                         own copy and a plain item keep Delete; the tile and the card's button post /workshop/delete-from-source for
//                         it alone, the status names the 5 s Undo window and the UI starts no drain (the backend waits); auto-import
//                         off: Delete + "Delete and unsubscribe". Shot steam-unsub-tile.png
//   side:unsub:mixed      a ctrl-click selection of s1 + a plain item: the tile reads "Unsubscribe 1, delete 1"; the Delete key posts
//                         delete-from-source [s1] and /library/trash [the plain one]. Shot steam-unsub-mixed.png
//   side:unsub:keep       the Unsubscribe tile's right-click menu ("Unsubscribe without deleting"): at the pointer, grows in, Escape
//                         hands focus back; picking it → ONE POST /workshop/unsubscribe-keep; the tile becomes Delete, sliding in
//                         (per frame); no-glow + bg-live. Shots steam-unsub-keepmenu*.png
//   side:unsub:keepOff    motion off: the menu fades in / out in place, the Delete tile only fades in
//   side:unsub:signedOut  signed out ("Subscribe with Steam login"): every unsubscribe control stays on (its drain opens the
//                         item's Steam page): the Unsubscribe tile (no "Sign in" tooltip), a click posts delete-from-source
//                         [s1]; its right-click entry on, no note; the card's button named Unsubscribe; auto-import off:
//                         "Delete and unsubscribe" on; "Use the Steam app" the same; a sign-out under an open sidebar (WS
//                         steam-status) changes nothing; no-glow + bg-live: the tile keeps its fill, no glow.
//                         Shot steam-unsub-signedout.png
//   steam:subMerge:labels a Workshop result's sidebar says "Subscribe and apply" / "Subscribe" (cloud-download) in every mode and
//                         auto-import, never a subscription card; "Subscribe" posts /download; the cards' button ("Subscribe &
//                         apply", the cloud glyph) and the selection toolbar ("Subscribe 2") only with auto-import on +
//                         "subscribe"; subscribed in Steam: Download + Unsubscribe; no-glow + bg-live. Shots steam-submerge*.png
//   steam:subMerge:appear the Unsubscribe tile rises in once subscribed while what follows glides down (per frame), and leaves
//                         (fade, what follows glides up) once unsubscribed, keeping its words on its way out
//   steam:subMerge:appearOff  motion off: the tile only fades in and out, nothing glides
//   side:resub[Off]       the Library sidebar of its own copy of a Workshop item: a Subscribe tile beside its Delete, none for a
//                         subscribed item or one the Workshop no longer has; Subscribe posts /workshop/subscribe ("Subscribing…");
//                         once delivered (library-synced) it fades out (Off: only a fade) and the Delete tile reads Unsubscribe.
//                         Shots steam-resub*.png
//   side:copyIdPill       the Browse sidebar's Workshop ID pill (the Library's own component, components/WorkshopIdPill.tsx; no
//                         Copy ID tile): a click copies the id and the pill reads "Copied" (its name "Workshop ID N — copied")
//                         for ≈ 1.2 s; every hero chip keeps its box per frame; the faces roll (motion on) or only fade (motion
//                         off); another item's sidebar doesn't say "Copied". Shot steam-copyid.png
//   ws:counts             the Browse stat pills: subscribers (lucide users) and favourites (the star), no views / heart pill
//   ws:creator[Off]       the creator row (avatar from the media origin + name, asked once with the item's owner); a click lists
//                         their items (/browse list creator): the sidebar closes, the filter column's Author field reads their
//                         name with their avatar and rings once (per frame; Off: a fade), no top-bar pill, the Workshop's pill
//                         lit, the search goes, the sort is the list's, the split button counts 1; the field's × back to the
//                         whole Workshop; no-glow + bg-live
//                         the whole row is the target: it ends in a bare chevron (no chip, no tooltip; the row's name "All their
//                         wallpapers, made by …"), which slides on the spring while the row is hovered and lifts (Off: still)
//   ws:creatorSelect      the creator's name is selectable text: no Copy beside it; a drag selects it and lists nothing, Ctrl+C copies it
//   side:browseTitle      the Browse sidebar's long title: folded, a click unfolds it, another folds it; no Copy: a drag selects
//                         words without unfolding, Ctrl+C copies them
//   look:browseTitles     a Browse card's long title: two lines, clamped; every card keeps its box (the grid as with short titles)
//   ws:favorite[Off]      the favourites pill is the toggle (no tile): read state, a click POSTs, the star fills and pops once
//                         (never on mount; Off: no pop), the count goes up by one, the pill keeps its box; a refusal reverts with
//                         the reason; no-glow + bg-live
//   ws:favoriteSteam[Off] no usable sign-in: the pill is "Favourite on Steam" (its name, the reason as its tooltip) once the state
//                         lands, keeping its box; a click opens the item's page in the Steam app (POST /steam/open-page
//                         {watch: "favorite"}), sends no favourite; no-glow + bg-live
//   cool:browse[Off]      Steam's cooldown refusing Browse's Workshop list: one notice over the grid ("Steam is limiting requests
//                         from this connection — back in 2 min", the warn colour, no Retry, no status line or list note), rising
//                         in (Off: a fade); the count going on (90 s, 89 s…); nothing asked meanwhile; the backend's end → it
//                         leaves (Off: a fade) and the list is asked again. Shots steam-cool-browse*.png
//   cool:end              the countdown running out by itself: Browse's notice leaves and its list, the sidebar's comments are asked
//                         again once, at the end; a 1 s cooldown still shows its notice and asks again
//   cool:more             the next page refused: the notice, the shown cards kept, page 2 asked again only at the end
//   cool:side[Off]        the item sidebar's notice (the body's notice block, before the action area) rising in as a cooldown starts
//                         (the action area gliding; Off: a fade); an item opened during it: comments and creator refused with no
//                         line of their own; the end → it leaves, both asked again. Shots steam-cool-side*.png
//   cool:author           the Author field's lookup refused: its error state in the cooldown's short words; asked again at the end.
//                         Shot steam-cool-author.png
//   cool:authorStale      a newer list lookup on its way when the cooldown ends: the refused Author lookup doesn't go over it
//   cool:stale            a status read asked before a cooldown and answered after it saying none: the notice stays; one asked
//                         during a cooldown the page never knew of, answered after its end: no notice
//   cool:local            Browse's list refused, then the In my library ✓: the notice goes with the list, the end asks nothing
//   ws:comments[Off]      the comments: read only once in view, 10 of 23 newest first, the creator's marked, the text plain (markup
//                         as typed, nothing injected), they rise in (Off: fade), Show older reads start 10; signed out no box;
//                         a failed read a quiet line, Retry; bg-live
//   ws:commentSteam[Off]  no usable sign-in: "Comment on Steam" in the box's place, rising in (Off: fading in place); a click opens
//                         the item's page in the Steam app (POST /steam/open-page), posts nothing; signed in: the box, no button;
//                         no-glow + bg-live
//   ws:commentSelect      a comment's text and its commenter's name select with a drag; an old comment's date shows its year
//                         (never 1970), one with no time shows none
//   ws:commentPost        signed in: the box posts the text as typed, the new one drops in on top, the box empties; a refusal's words
//   list:noPills          the strip: the source pills by their plain names alone (no Favourites pill, no list's pill), the
//                         Workshop's lit through a creator's list from the row and one typed in the field; its click back to the
//                         whole Workshop (the field empties). Shot steam-list-nopills.png
//   list:author:{id,url,name}  the filter column's Author field, typed + Enter: one /workshop/author with the text, the
//                         creator's list, the field showing the name (a link with no known name: the ID), the split button
//                         counting 1, no search; its blur asks nothing again. Shot steam-list-author-filled.png
//   list:author:unknown[Off]  a name never seen: the field's own error state (danger edge, aria-invalid, the words in its
//                         heading line, nothing under the box), sliding in (Off: a fade), the text kept, no list asked; typing
//                         clears it (Off: a fade out), Escape takes the text back; no-glow + bg-live. Shots
//                         steam-list-author-error*.png
//   list:author:real      the stack's own backend resolves the field: an ID, a profile link naming one, an unknown name's error
//   list:presets:{id,url,bad}  the Presets of field: an ID or its page's link → the scene's presets (exactly its two), the
//                         scene's name shown, the Author field emptied; anything else → the field's error, nothing asked
//   list:clear            the text deleted + Enter → the whole Workshop (one /browse); Clear all with a tag → one /browse with
//                         neither, the count gone
//   list:rows             a row fills its field over a typed error; narrow (the column a drawer) the row opens no drawer, the
//                         split button counts the list
//   list:race             an Author lookup overtaken by a Presets of ID (or Clear all) is dropped when it lands: the newer list
//                         stays, the Author field empty and not spinning
//   ws:presets[Off]       a scene's sidebar: a "Presets" row (the creator row's control, 12 px under it); a click lists exactly
//                         its two presets (the stack's backend + fake Steam servers): the column's Presets of field reads the
//                         scene (rings once; Off: a fade), the sidebar closes, the library's one marked in library, the list's
//                         sorts and second page; the field's × back; no-glow + bg-live
//   ws:presetsHidden      no Presets row on a video's or a preset's sidebar, nor (live) with scene support off; the filter's
//                         Type group offers Preset only alongside it
//   ws:presetsEmpty       a scene with no presets: the list says so in the grid
//   ws:presetBase         a preset's sidebar: "Uses" + its base's title (asked once); a click shows the base's Library card, else
//                         its Browse card (the list's own, else one of its own), never a Steam page
//   yours:combos         the filter's Yours rows on the Workshop (STUB __probe_yours: six favourites, the library's four Workshop
//                        items, two shared, one Steam has nothing on): every pair of row states shows its set (✓ the set, both ✓
//                        the intersection, ✓ + ✕ the difference, ✕ alone the Workshop's page minus the set). Shots steam-yours-*.png
//   yours:noScan         a ✓ on: tags, the search, a sort and a scroll to the end send no /browse, no placeholder cards; the
//                        last ✓ off → one /browse with the Workshop's own sort
//   yours:search         a local set's search: a title word, an author's name, a tag, any case
//   yours:sort           the local sort menu (Date Added only with In my library ✓); each orders by its field, the item Steam
//                        has nothing on last, none a no-op; saved apart from the Workshop's sort
//   yours:trendSort      Most Popular · Week → Favourites ✓ reads Most Subscribed (no Most Popular) → ✓ off: Week again, trend / 7
//   yours:switches       Type, an age and a genre narrow a local set; an age filter drops the untagged
//   yours:inList         inside a creator's list / a scene's presets list: ✓ its favourites only, ✕ hides them from the pages
//   yours:scenes         a favourite preset only with Type's Preset ticked; scene support off → scenes and presets leave at once
//   yours:big            2,000 favourites: all at once, a typed search sends nothing, content-visibility kept
//   yours:signFlip       a saved Favourites ✓ alone: signed out the Workshop; a signed-in steam-status → the set (sync=open, no
//                        placeholders); signed out again → one /browse, the Workshop's cards
//   yours:loadLine       a first Favourites ✓, the answer held: the load line within a frame ("Loading your favourites…", rising
//                        in), "— 120 so far" / "— 120 of 450" on workshop-favorites events (the bar eases), the grid fills, a
//                        click on the chip reaches the card under it, the line fills out and fades; opacity / transform only.
//                        Shots steam-yours-load-*.png
//   yours:loadLineOff    motion off: a fade in place, the bar at once, the error's room at once; no-glow: no glow; bg-live: its
//                        words' drop-shadow; the error covers no card. Shots steam-yours-load-error-{off,live}.png
//   yours:loadError      Steam unreachable mid-load: the error takes its own room above the grid (the cards glide down, none
//                        covered), its words + Retry, the loaded part kept; Retry asks sync=open
//   yours:starLive       the sidebar's star (stubbed POST) + workshop-favorites: the card leaves / joins, no reload, no /browse
//   yours:check          Browse open with Favourites ✕: one sync=open, then sync=check per (shortened) minute; none inactive or
//                        with no Favourites row
//   yours:oneOpen        the start and a reconnect with the favourites unread share one sync=open
//   yours:steamUnknown   /steam/status unreadable: Favourites not dimmed, ✓ refused until a signed-in status
//   yours:empty          "Nothing here matches" on an empty set (in a creator's and a scene's presets list too); its clear keeps the Yours rows,
//                        and a presets list's Type tags (ignored there) never offer a clear;
//                        motion off + bg-live
//   yours:signOut        signed out: the favourites leave at once, the row dims; another account never sees them
//   lib:yours:fav        the Library's Favourites row: ✓ the starred items, ✕ the rest (non-Workshop too), – all; signed out dimmed and no effect; the
//                        Library's sort and search apply on top; a second star arriving updates ✓ live; a star leaving a selected card empties
//                        the selection and keeps the scroll
//   lib:yours:load       Library ✓ with the first read on its way: the whole Library under the load line (counts as it comes), never a no-op
//   lib:yours:error      Library ✓ with an error and nothing read: the whole Library, the error + Retry in the flow, Retry → the set
//   yours:errorFirst     an error already read as the first line a page shows (Browse ✕, the Library ✓): its room glides the cards down
//   yours:stack          Favourites ✓ on the stack's own backend (a fake sign-in, "@userfiles" in its Steam fixture): the account's
//                        favourites, no /browse, no session to Steam, no refused network call
//   browse:fixture       a page without this probe's stub on Browse → the Workshop lists the stack's own Steam fixture
//                         ("@query"); the backend opened no session to Steam and refused no real-network call
//   browse:warm           the Browse tab hovered while it shows the Workshop, or a Workshop pill hovered: one POST /steam/warm
//                         (Steam's session connects ahead of the page), at most one per 20 s; none from the tab while another
//                         source shows there, none from another source's pill
//   browse:appPresence    "Use the Steam app": the window open, on any tab → POST /steam/app-presence at the interval the
//                         backend names (no gap across tab switches, no body, nothing on pagehide); another mode: none, and a
//                         switch to one stops them at once
//   lib:ws:order         a Workshop item's Library sidebar: its counts in the hero row, the creator under it, the tiles with the
//                         favourite, then Playback, the scene properties and the comments, last, 12 px apart; none off the
//                         Workshop, for a plain item, for a multi-selection
//   lib:ws:pillRow        a Workshop scene's and a Workshop video's counts are hero pills beside the others (same row box and
//                         line as a neighbour, before the ID and the size), the creator under the action area, both above Playback
//   lib:ws:counts[Off]    its counts: held unseen while asked (once, after the sidebar settles), they fade in (on: rising) where they
//                         stay, the creator row never moves; 4.3k people / 87 star, no views; no answer → the pills leave and the
//                         size glides into their room (Off: at once); no-glow + bg-live
//   lib:ws:size[Off]      every Library item's size on disk (the backend's measure) as the hero's last pill; a late measure fades in
//                         (on: rising) at the row's end, the Workshop ID pill never moves
//   lib:ws:creator        the creator (asked without an owner): a click lists their wallpapers on the Browse tab, its column's
//                         Author field filled
//   lib:ws:favorite       the favourite tile: a click POSTs the Library item's id
//   lib:ws:comments       the comments: read once in view, 10 of 23; signed in a post goes out with the item's id, on top
//                         Shots steam-libws*.png
// Screenshots: <LIASCAPE_OUT>/steam-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off"); // motion off: only opacity changes, nothing moves, appear / leave fade
const PXC = require("./pixel-centre"); // a glyph centred in its own drawn box, in pixels
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const PASSWORD = "Pr0be-pa55-Zq9!xK";
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
async function setSettings(patch) { await http("POST", "/settings", patch); } // a partial body merges (PATCH)

// runs in the page before its own scripts (every load)
const STUB = `(() => {
  const st = { calls: [], bodies: [], wsSent: [], dl: null };
  try { st.status = JSON.parse(localStorage.getItem("__probe_steam_status") || "null"); } catch { st.status = null; }
  st.status ??= { signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe" };
  window.__st = st;
  const OrigWS = window.WebSocket, sockets = [];
  window.WebSocket = class extends OrigWS {
    constructor(...a) { super(...a); sockets.push(this); }
    send(d) { st.wsSent.push(String(d)); return super.send(d); }
  };
  window.__fakeWs = (type, payload) => { let n = 0; for (const s of sockets) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; };
  // the page's socket dropped (the app reconnects and re-reads what it mirrors: yours:oneOpen)
  window.__wsDrop = () => { for (const s of sockets) if (s.readyState === 1) s.close(); return true; };
  // the favourites' minute check, shortened for the probe only (yours:check): __probe_fav_tick = the interval in ms
  const si = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 && localStorage.getItem("__probe_fav_tick") ? +localStorage.getItem("__probe_fav_tick") : ms, ...a);
  // GET /workshop/my-favorites held or answered by the cell (yours:load*, yours:signOut, yours:oneOpen): window.__favs =
  // { hold, answer }; a held ask waits for __favsLet(answer) (else the answer / __probe_yours' favs); __probe_favs_hold = held
  // from the page's start
  window.__favs = localStorage.getItem("__probe_favs_hold") === "1" ? { hold: true } : null;
  window.__favsLet = (b) => { const F = window.__favs ?? {}; F.hold = false; if (b) F.answer = b; for (const r of (F.pending ?? []).splice(0)) r(); return true; };
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "ws-" + (i + 1), thumbnailUrl: "", animatedThumbnailUrl: null,
    pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (930000 + i), resolution: "1920 x 1080", isScene: false,
    workshopId: String(930000 + i), addedAt: null, description: "fake", authorName: "probe", authorId: "76561190000000007", fileSizeBytes: 1000,
    subscriptions: 1234 + i, favorites: 56 + i, tags: ["Anime"], trailerKnown: true }));
  const f = window.fetch.bind(window);
  // the Yours rows' local sets (yours:*): __probe_yours (localStorage) = { favs: GET /workshop/my-favorites' answer, details:
  // POST /workshop/details' items by id, lib: the library's Workshop items (laid over the stack's k1..k4; the rest of the
  // library left out), page / creatorPage / presetsPage: the Workshop's page 1, a creator's list and a scene's presets list };
  // every favourites and details ask recorded (st.favAsks, st.detailAsks)
  let yRaw = null, yVal = null;
  const Y = () => { const r = localStorage.getItem("__probe_yours"); if (r !== yRaw) { yRaw = r; yVal = r ? JSON.parse(r) : null; } return yVal; };
  window.fetch = (u, o = {}) => {
    const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const m = (o.method || "GET").toUpperCase();
    st.bodies.push({ p, m, body: typeof o.body === "string" ? o.body : null });
    const res = (b, status = 200) => Promise.resolve(new Response(b == null ? "" : JSON.stringify(b), { status, headers: b == null ? {} : { "Content-Type": "application/json" } }));
    // __probe_steam_status_fail: the status can't be read (Steam's state stays unknown: yours:steamUnknown)
    // window.__stHold = []: a status read waits until a cell calls each held resolver (cool:stale)
    if (p === "/steam/status" && window.__stHold) return new Promise((r) => window.__stHold.push(() => r(res(st.status))));
    if (p === "/steam/status") return localStorage.getItem("__probe_steam_status_fail") === "1" ? res({ error: "the backend's status read failed" }, 500) : res(st.status);
    if (p === "/workshop/my-favorites") {
      (st.favAsks ??= []).push(new URL(String(u), location.href).searchParams.get("sync"));
      const F = window.__favs, answer = () => F?.answer ?? Y()?.favs;
      if (F?.hold) return new Promise((r) => (F.pending ??= []).push(r)).then(() => res(answer()));
      if (answer()) return res(answer());
    }
    if (p === "/workshop/details" && m === "POST" && Y()) {
      const ids = JSON.parse(o.body).ids || [], d = Y().details || {}; (st.detailAsks ??= []).push(ids);
      return res({ items: ids.filter((id) => d[id]).map((id) => d[id]) });
    }
    if (p === "/library" && m === "GET" && Y()?.lib) {
      const lib = Y().lib;
      return f(u, o).then((r) => r.json()).then((list) => { const ks = list.filter((x) => /^k\\d$/.test(x.title)).sort((a, b) => a.title.localeCompare(b.title));
        return res(lib.map((l, i) => ({ ...ks[i], ...l }))); });
    }
    // the window's heartbeat (browse:appPresence): each one's time in st.beats; __probe_beat_ms = the interval the backend names
    if (p === "/steam/app-presence") (st.beats ??= []).push(performance.now());
    if (p === "/steam/app-presence" && localStorage.getItem("__probe_beat_ms")) {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      if (o.keepalive) (st.keepalive ??= []).push(p);
      return res({ connected: false, beatMs: +localStorage.getItem("__probe_beat_ms") });
    }
    if (p.startsWith("/steam/")) {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      if (o.keepalive) (st.keepalive ??= []).push(p);
      const r = (window.__replies || {})[p];
      return r ? res(r.body, r.status) : res(null);
    }
    // "Download without subscribing"'s route (side:oneOff:*): window.__oneOff, else the Steam app's; every ask recorded. With
    // __probe_oneoff_real the stack's backend answers it (side:oneOff:modes: the route per download mode)
    if (p === "/workshop/one-off") { (st.oneOffAsks ??= []).push(performance.now());
      if (localStorage.getItem("__probe_oneoff_real") === "1") return f(u, o);
      return res(window.__oneOff ?? { route: "steamapp", missing: null }); }
    // the Steam to-do: idle at load, every button's POST recorded (steam:todo)
    if (p === "/steam-todo") return res({ finished: true });
    if (p.startsWith("/steam-todo/") && m === "POST") { st.calls.push({ p, body: null }); return res(p.endsWith("use-steam-app") ? { error: null } : null); }
    // a Workshop item's subscription (steam:sub:*): the state a cell sets in window.__wsState, every write recorded
    if (p === "/workshop/state" && m === "POST") {
      const ids = JSON.parse(o.body).ids || [], s = window.__wsState || {}, r = {};
      for (const id of ids) r[id] = s[id] ?? { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      return res(r);
    }
    // the Browse sidebar's Workshop community pieces (ws:*): the state a cell puts in window.__ws, every call recorded
    const W = (window.__ws ??= {});
    // Steam's cooldown (cool:*): a read W names answers the backend's 429 with how long is left (SteamGate's
    // SteamCooldownException.Body): W.creatorCool, W.favCool, W.comCool, W.authorCool, W.browseCool (a Workshop page read),
    // W.moreCool (its later pages only) = the ms left
    const cool = (ms) => res({ error: "Steam is limiting requests from this connection — try again in 2 min", cooldownMs: ms }, 429);
    // W.detailsDelay: Steam's details of an item held that many ms, then the stack's backend answers (cool:authorStale)
    if (p === "/workshop/details" && m === "POST" && W.detailsDelay) return new Promise((r) => setTimeout(() => r(f(u, o)), W.detailsDelay));
    if (p === "/workshop/creator") { st.calls.push({ p, q: String(u) }); if (W.creatorCool) return cool(W.creatorCool); return res(W.creator ?? { steamId: "76561190000000007", name: "Probe Creator", avatar: W.avatar ?? null }); }
    // the filter column's Author field (list:*): W.authors (by what was typed, trimmed, lower case), else the creator by their ID,
    // their profile link (its ID shown: no name) or their name, else the backend's words for a name it never saw; held
    // W.authorDelay ms. With __probe_author_real the stack's backend answers it (list:author:real)
    if (p === "/workshop/author") {
      const q = new URL(String(u), location.href).searchParams.get("q") ?? "";
      st.calls.push({ p, q });
      if (W.authorCool) return cool(W.authorCool);
      if (localStorage.getItem("__probe_author_real") === "1") return f(u, o);
      const me = { steamId: "76561190000000007", name: "Probe Creator", avatar: W.avatar ?? null };
      const A = { "76561190000000007": me, "https://steamcommunity.com/id/probecreator": { ...me, name: null }, "probe creator": me, ...(W.authors ?? {}) };
      const hit = A[q.trim().toLowerCase()];
      const out = hit ? res(hit) : res({ error: "Unknown name: paste a profile link or ID", reason: "unknown" }, 400);
      return W.authorDelay ? new Promise((r) => setTimeout(() => r(out), W.authorDelay)) : out;
    }
    // a preset's base (ws:presetBase): W.base, else Steam's "not a preset"
    if (p === "/workshop/base") { st.calls.push({ p, q: String(u) }); return W.base ? res(W.base) : res({ error: "Steam lists no base for this item: it isn't a preset" }, 404); }
    // W.favDelay: the state's answer held that many ms (ws:favoriteSteam: the words' swap as it lands)
    if (p === "/workshop/favorite" && m === "GET") { st.calls.push({ p, m }); if (W.favCool) return cool(W.favCool); const out = res(W.fav ?? { signedIn: false, favorited: null });
      return W.favDelay ? new Promise((r) => setTimeout(() => r(out), W.favDelay)) : out; }
    if (p === "/workshop/favorite" && m === "POST") {
      const b = JSON.parse(o.body); st.calls.push({ p, m, body: b });
      if (W.favFail) return res({ error: "Steam turned that down" }, 502);
      W.fav = { signedIn: true, favorited: b.favorite }; return res({ favorited: b.favorite });
    }
    if (p === "/workshop/comments") {
      const q = new URL(String(u), location.href).searchParams, s0 = +q.get("start"), n = +q.get("count");
      st.calls.push({ p, start: s0, count: n, t: performance.now() });
      if (W.comCool) return cool(W.comCool);
      if (W.comFail) return res({ error: "Couldn't reach Steam" }, 502);
      const all = W.comments ?? [];
      return res({ signedIn: !!W.signedIn, owner: "76561190000000007", total: all.length, start: s0, comments: all.slice(s0, s0 + n) });
    }
    if (p === "/workshop/comment" && m === "POST") {
      const b = JSON.parse(o.body); st.calls.push({ p, body: b });
      if (W.postFail) return res({ error: "Steam turned the comment down: you're posting too fast" }, 502);
      W.comments = [{ id: "new" + st.calls.length, author: "me", authorId: null, avatar: null, time: Math.floor(Date.now() / 1000), text: b.text }, ...(W.comments ?? [])];
      return res({ signedIn: true, owner: "76561190000000007", total: W.comments.length, start: 0, comments: W.comments.slice(0, b.count) });
    }
    // the Library sidebar's stat pills (lib:ws:*): W.counts, a failure with W.countsFail, the answer held W.countsDelay ms
    if (p === "/workshop/counts") {
      st.calls.push({ p, q: String(u) });
      const out = W.countsFail ? res({ error: "Couldn't reach Steam" }, 502) : res(W.counts ?? { subscriptions: 4321, favorites: 87 });
      return W.countsDelay ? new Promise((r) => setTimeout(() => r(out), W.countsDelay)) : out;
    }
    if ((p === "/workshop/subscribe" || p === "/workshop/unsubscribe") && m === "POST") {
      st.calls.push({ p, body: JSON.parse(o.body) });
      return res(p.endsWith("unsubscribe") ? { inLibrary: !!(window.__wsState?.[JSON.parse(o.body).workshopId]?.inLibrary), batch: null, unsubscribeInMs: 5000 }
        : { subscribed: false, inSteamTodo: true, message: "Click Subscribe in Steam, then Next…" });
    }
    // "Unsubscribe without deleting" and the Library sidebar's "Delete and unsubscribe" (side:*, steam:sub:keepMenu*):
    // recorded, answered here, never reaching the stack's backend (its library stays as it is)
    if ((p === "/workshop/unsubscribe-keep" || p === "/workshop/delete-from-source" || p === "/workshop/drain" || p === "/library/trash") && m === "POST") {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      return res(p.endsWith("keep") ? { inLibrary: true, kept: 1 } : p.endsWith("source") ? { batch: "", unsubscribeInMs: 5000 } : p.endsWith("trash") ? { batch: "" } : null);
    }
    // a scene's sidebar with a full hero row (side:*): the stack's Workshop scenes get a resolution and an age rating
    // whether a Workshop item is still subscribed (side:unsub:*, side:resub:*): __probe_lib_sub = {workshopId: subscribed}, and
    // which the Workshop no longer has: __probe_lib_off = [workshopId] (the rest it has: the stack's empty CM fixture
    // answers "no such item" for every id), read per request
    // an item whose size on disk isn't measured yet (lib:ws:size): __probe_lib_nosize = [title]
    // a plain video made a Workshop item (lib:ws:pillRow: a Workshop video's sidebar): __probe_lib_ws = {title: workshopId}
    if (p === "/library" && m === "GET" && (localStorage.getItem("__probe_lib_full") === "1" || localStorage.getItem("__probe_lib_sub") || localStorage.getItem("__probe_lib_nosize") || localStorage.getItem("__probe_lib_ws"))) {
      const full = localStorage.getItem("__probe_lib_full") === "1", sub = JSON.parse(localStorage.getItem("__probe_lib_sub") || "{}");
      const off = localStorage.getItem("__probe_lib_off") ? JSON.parse(localStorage.getItem("__probe_lib_off")) : null;
      const nosize = JSON.parse(localStorage.getItem("__probe_lib_nosize") || "[]"), wsOf = JSON.parse(localStorage.getItem("__probe_lib_ws") || "{}");
      return f(u, o).then((r) => r.json()).then((list) => res(list.map((x) => {
        let y = full && x.isScene && x.workshopId ? { ...x, resolution: "3840 x 2160", ageRating: "Everyone" } : x;
        if (x.title in wsOf) y = { ...y, workshopId: wsOf[x.title] };
        if (y.workshopId && y.workshopId in sub) y = { ...y, subscribed: sub[y.workshopId] };
        if (nosize.includes(x.title)) y = { ...y, diskBytes: null };
        return x.workshopId && off ? { ...y, offWorkshop: off.includes(x.workshopId) } : y; })));
    }
    if (p === "/browse" && m === "POST") {
      const b = JSON.parse(o.body);
      (st.browses ??= []).push({ ...b, t: performance.now() }); // every list read (ws:*), apart from the cells' own calls
      if (b.filter && (W.browseCool || (W.moreCool && b.page > 1))) return cool(W.browseCool || W.moreCool);
      const y = Y();
      // y.endless: every later Workshop page holds six more (the list never ends: its placeholders stay)
      if (y?.endless && !b.list && b.page > 1) return res(Array.from({ length: 6 }, (_, i) => ({ ...y.page[0], title: "ws-p" + b.page + "-" + i,
        workshopId: String(931000 + b.page * 10 + i), pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (931000 + b.page * 10 + i) })));
      if (y) return res(b.page > 1 ? [] : b.list?.kind === "creator" ? y.creatorPage ?? [] : b.list?.kind === "presets" ? y.presetsPage ?? [] : y.page ?? []);
      // a Workshop list (ws:*): a creator's, a few items; a scene's presets (ws:presets*): the stack's own backend answers,
      // from its fake Steam servers (scripts/test-ui-matrix.sh)
      if (b.list) { if (b.list.kind === "presets") return f(u, o);
        return res(b.page > 1 ? [] : items.slice(0, 3)); }
      // a long first title (side:browseTitle, look:browseTitles), a long first description (side:aboutTall)
      const long = localStorage.getItem("__probe_long_title"), longDesc = localStorage.getItem("__probe_long_desc");
      // __probe_presets (ws:preset*): the first item is the fixture's scene with two presets, the second a preset, the fourth a
      // scene with none (the third stays a video)
      const pre = localStorage.getItem("__probe_presets") === "1";
      const shape = (x, i) => !pre ? x : i === 0 ? { ...x, title: "Fixture Workshop Three", workshopId: "910000003", pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=910000003", isScene: true, tags: ["Scene", "Anime"] }
        : i === 1 ? { ...x, title: "ws-preset", isScene: true, isPreset: true, tags: ["Preset", "Scene", "Anime"] }
        : i === 3 ? { ...x, title: "ws-lone-scene", isScene: true, tags: ["Scene"] } : x;
      if (b.filter) return res(b.page > 1 ? [] : items.map(shape).map((x, i) => (i === 0 ? { ...x, ...(long ? { title: long } : {}), ...(longDesc ? { description: longDesc } : {}) } : x)));
      // a fake Wallpaper Engine (Local) folder (steam:sub:weLocal): local page paths + Workshop ids
      if (localStorage.getItem("__probe_we_local") === "1") return res(b.page > 1 ? [] : items.map((x, i) => ({ ...x, title: "we-" + (i + 1),
        pageUrl: "/tmp/probe-we/" + (931000 + i), workshopId: String(931000 + i), description: null, subscriptions: null, favorites: null, views: null })));
    }
    if (p === "/detail" && m === "POST") return res({ title: "x", previewUrl: "", downloadUrl: "" });
    if (p === "/download" && m === "POST") {
      return new Promise((resolve, reject) => {
        st.dl = { body: JSON.parse(o.body), aborted: false, resolve };
        o.signal?.addEventListener("abort", () => { st.dl.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      });
    }
    return f(u, o);
  };
})();`;

let win;
const consoleLines = [];
const js = (code) => win.webContents.executeJavaScript(code);
const page = (code) => js(`(async () => { ${code} })()`);
const send = (e) => win.webContents.sendInputEvent(e);
async function key(k, mods = []) { send({ type: "keyDown", keyCode: k, modifiers: mods }); if (k === "Enter") send({ type: "char", keyCode: "\r" }); send({ type: "keyUp", keyCode: k, modifiers: mods }); await sleep(60); }
async function type(text) { await win.webContents.insertText(text); await sleep(60); }
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `steam-${name}.png`), img.toPNG()); }

async function load(status) {
  await js(`localStorage.setItem("__probe_steam_status", ${J(J(status ?? null))}); true`).catch(() => {});
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
  for (let i = 0; i < 50; i++) { if (await js(`window.__fakeWs ? window.__fakeWs("noop", null) : 0`) > 0) break; await sleep(100); } // the page's socket is open
  await sleep(300);
}
async function tab(name) { await page(`[...document.querySelectorAll(".tab")].find((e) => e.textContent.trim() === ${J(name)})?.click();`); await sleep(500); }
const ev = (type, payload) => js(`window.__fakeWs(${J(type)}, ${J(payload)})`);
const steamRow = () => page(`const r = document.querySelector("[data-steam-state]"); if (!r) return null;
  const btn = (k) => r.querySelector('[data-steam-signin="' + k + '"]');
  const warn = r.querySelector(".s-warn-text");
  return { state: r.dataset.steamState, text: r.textContent, qr: !!btn("qr"), pw: !!btn("password"),
    signOut: [...r.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign out"),
    titles: [...r.querySelectorAll("[title]")].length, warnColor: warn ? getComputedStyle(warn).color : null,
    mutedColor: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() };`);
const modal = () => page(`const m = document.querySelector("[data-steam-pw-modal]"); if (!m) return null;
  const a = document.activeElement;
  return { step: m.dataset.step, text: m.textContent, role: m.getAttribute("role"), aria: m.getAttribute("aria-modal"),
    labelled: !!document.getElementById(m.getAttribute("aria-labelledby") || "-"),
    focus: a ? (a.dataset.steamPw !== undefined ? "password" : a.dataset.steamPwCode !== undefined ? "code" : a.name || a.tagName) : null,
    pwVal: m.querySelector("[data-steam-pw]")?.value ?? null, user: m.querySelector('input[name="username"]')?.value ?? null,
    err: m.querySelector("[data-steam-pw-error]")?.textContent ?? null, errRole: m.querySelector("[data-steam-pw-error]")?.getAttribute("role") ?? null,
    submit: m.querySelector("[data-steam-pw-submit]")?.textContent.trim() ?? null, titles: m.querySelectorAll("[title]").length };`);
const calls = () => js(`window.__st.calls`);
async function waitFor(fn, ms = 3000) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(60); } return v; }

// the password must be nowhere but the one /steam/login body
async function leakCheck(v, logins = 1) { // logins = how many sign-ins the cell submitted (each one /steam/login body)
  const r = await page(`const pw = ${J(PASSWORD)}; const st = window.__st;
    const inputs = [...document.querySelectorAll("input")].filter((i) => i.value.includes(pw)).length;
    const storage = [localStorage, sessionStorage].some((s) => Object.keys(s).some((k) => k.includes(pw) || (s.getItem(k) || "").includes(pw)));
    const bodies = st.bodies.filter((b) => (b.body || "").includes(pw)).map((b) => b.p);
    return { dom: document.documentElement.outerHTML.includes(pw) || document.body.innerText.includes(pw), inputs, storage, bodies,
      ws: st.wsSent.some((s) => s.includes(pw)), status: (document.querySelector(".status")?.textContent || "").includes(pw) };`);
  if (r.dom) v.push("the password is in the DOM");
  if (r.inputs) v.push(`the password is still in ${r.inputs} input value(s)`);
  if (r.storage) v.push("the password is in local/session storage");
  if (r.bodies.some((p) => p !== "/steam/login") || r.bodies.length !== logins) v.push(`the password went in ${r.bodies.length} request bodies (${logins} sign-in(s)): ${r.bodies.join(", ")}`);
  if (r.ws) v.push("the password went over the WebSocket");
  if (r.status) v.push("the password is in the status bar");
  if (consoleLines.some((l) => l.includes(PASSWORD))) v.push("the password is in the console");
}

async function openPw() {
  await tab("Settings");
  await page(`document.querySelector('[data-steam-signin="password"]').click();`);
  return (await waitFor(async () => { const m = await modal(); return m && m.focus === "username" ? m : null; }, 2000)) || modal();
}
async function credentials(user = "probe-user") { await type(user); await key("Tab"); await type(PASSWORD); await key("Enter"); await sleep(250); }

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (...a) => { const m = a[0]?.message ?? a[2]; consoleLines.push(String(m)); });
  // the debugger needs a renderer: a window that never loaded anything has none (CDP commands then never answer)
  await win.loadURL("about:blank");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  console.log("== stub installed");
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await Promise.race([fn(), sleep(90000).then(() => ["ERROR the cell took over 90 s"])]); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const SIGNED_OUT = { signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe" };
  // an Unsubscribe needs a usable sign-in under "Subscribe with Steam login" (the default mode): the cells that unsubscribe sign in
  const SIGNED_IN = { ...SIGNED_OUT, signedIn: true, accountName: "probe-acct", daysLeft: 200 };
  try {
    await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false, morphs: true, glows: true });
    await win.loadURL(withToken(U + "/")); await sleep(500);

    await cell("steam:row:signedOut", async () => {
      const v = []; await load(SIGNED_OUT); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "signed-out") v.push(`state ${r.state}`);
      if (!/^Not signed in\./.test(r.text)) v.push(`the row doesn't say it's not signed in: "${r.text}"`);
      if (!/Downloads open the wallpaper's Steam page for you to subscribe\./.test(r.text)) v.push(`the row doesn't say a download opens the wallpaper's Steam page: "${r.text}"`);
      if (!r.qr || !r.pw) v.push(`sign-in buttons: qr ${r.qr}, password ${r.pw}`);
      if (r.titles) v.push(`${r.titles} tooltip(s) in the row`);
      await page(`const el = document.querySelector("[data-steam-state]"), sc = el.closest(".scroll"); sc.scrollTop += el.getBoundingClientRect().top - innerHeight / 2;`); await sleep(900); await shot("row-signed-out");
      return v;
    });
    await cell("steam:row:rejected", async () => {
      const v = []; await load({ signedIn: true, rejected: true, accountName: "acct1", daysLeft: 120, mode: "subscribe" }); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "rejected") v.push(`state ${r.state}`);
      if (!/signed acct1 out\. Sign in again/.test(r.text) || /Steam app/.test(r.text)) v.push(`text: "${r.text}"`);
      if (!r.qr || !r.pw) v.push(`sign-in buttons: qr ${r.qr}, password ${r.pw}`);
      if (r.signOut) v.push("a Sign out button on a rejected sign-in");
      if (!r.warnColor) v.push("no warning text");
      await page(`const el = document.querySelector("[data-steam-state]"), sc = el.closest(".scroll"); sc.scrollTop += el.getBoundingClientRect().top - innerHeight / 2;`); await sleep(900); await shot("row-rejected");
      return v;
    });
    await cell("steam:row:signedIn", async () => {
      const v = []; await load({ signedIn: true, rejected: false, accountName: "acct2", daysLeft: 150, mode: "subscribe" }); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "signed-in" || !/Signed in as acct2/.test(r.text)) v.push(`state ${r.state}: "${r.text}"`);
      if (!r.signOut) v.push("no Sign out");
      if (r.qr || r.pw) v.push("sign-in buttons while signed in");
      return v;
    });
    await cell("steam:row:steamcmd", async () => {
      const v = [];
      for (const dropped of ["steamcmd", "steampage"]) {
        await setSettings({ workshopDownloadMode: dropped }); await load(SIGNED_OUT); await tab("Settings");
        const saved = (await http("GET", "/settings")).json?.workshopDownloadMode;
        if (saved !== "steamapp") v.push(`"${dropped}" reads as ${J(saved)}, not the default "steamapp"`);
        if (!(await page(`return !!document.querySelector('[data-wsmode="steamapp"]')?.checked;`))) v.push(`"${dropped}": Use the Steam app isn't the checked radio`);
        if (!(await steamRow())) v.push(`"${dropped}": no Steam sign-in row under the default mode`);
        if (await page(`return !!document.querySelector('[data-wsmode="steamcmd"], [data-wsmode="steampage"], [placeholder="/usr/bin/steamcmd"]');`)) v.push(`"${dropped}": a steamcmd / page radio or row shows`);
      }
      // the page's own fallback before the settings come in: the default too
      const def = await page(`return [...document.querySelectorAll("[data-wsmode]")].map((r) => r.dataset.wsmode).join();`);
      if (def !== "steamapp,subscribe") v.push(`the modes: ${def}`);
      await setSettings({ workshopDownloadMode: "subscribe" });
      return v;
    });

    // "Use the Steam app" (docs/decisions.md § "Offer two Workshop download modes, the Steam page the last resort") is the
    // FIRST of the two download-mode radios; picking it saves workshopDownloadMode "steamapp" and shows its note (naming its
    // fallbacks); the Steam sign-in row shows under both, saying what a sign-in does in each
    await cell("steam:row:steamApp", async () => {
      const v = []; await setSettings({ workshopDownloadMode: "subscribe" }); await load(SIGNED_OUT); await tab("Settings");
      const radios = await page(`return [...document.querySelectorAll("[data-wsmode]")].map((r) => ({ m: r.dataset.wsmode, type: r.type, name: r.closest(".srow")?.textContent.slice(0, 40) }));`);
      console.log(`        ${J(radios)}`);
      if (radios.map((r) => r.m).join() !== "steamapp,subscribe" || radios.some((r) => r.type !== "radio"))
        v.push(`the modes: ${J(radios)} (expected two radios steamapp, subscribe)`);
      if (await page(`return [...document.querySelectorAll(".settings .srow")].some((r) => /Open in the Steam app/.test(r.textContent));`)) v.push("an \"Open in the Steam app\" row still shows");
      await page(`document.querySelector('[data-wsmode="steamapp"]').click();`); await sleep(900); // the debounced save
      const saved = (await http("GET", "/settings")).json?.workshopDownloadMode;
      if (saved !== "steamapp") v.push(`a click saved workshopDownloadMode = ${saved}`);
      const after = await page(`return { checked: document.querySelector('[data-wsmode="steamapp"]').checked,
        note: (document.querySelector(".settings")?.textContent ?? "").includes("When it can't, your Steam login (if you signed in) or the wallpaper's Steam page takes over."),
        steamRow: document.querySelector("[data-steam-state]")?.closest(".srow")?.textContent ?? null };`);
      if (!after.checked) v.push("the radio isn't checked after the click");
      if (!after.note) v.push("no note under Use the Steam app naming its fallbacks");
      if (!/Not signed in\. Signed in, your Steam login takes over when the Steam app can't\./.test(after.steamRow ?? "")) v.push(`the Steam row under Use the Steam app, signed out: ${J(after.steamRow)}`);
      // back to "Subscribe with Steam login": saved, the sign-in row back
      await page(`document.querySelector('[data-wsmode="subscribe"]').click();`); await sleep(900);
      const saved2 = (await http("GET", "/settings")).json?.workshopDownloadMode;
      if (saved2 !== "subscribe") v.push(`the Subscribe with Steam login click saved ${saved2}`);
      const row2 = await page(`return document.querySelector("[data-steam-state]")?.closest(".srow")?.textContent ?? null;`);
      if (!/Downloads open the wallpaper's Steam page for you to subscribe\./.test(row2 ?? "")) v.push(`the Steam row under Subscribe with Steam login, signed out: ${J(row2)}`);
      await setSettings({ workshopDownloadMode: "subscribe" });
      return v;
    });

    // every Settings checkbox + radio is the app's themed control — dark when off (never the browser's white), the accent when on
    await cell("look:toggles", async () => {
      const v = []; await setSettings({ workshopDownloadMode: "subscribe" }); await load(SIGNED_OUT); await tab("Settings");
      const r = await page(`const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const k = c.startsWith("color(") ? 1 : 255; /* color(srgb …) is 0–1, rgb() 0–255 */ return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / k; };
        const all = [...document.querySelectorAll('.settings input[type=checkbox], .settings input[type=radio]')];
        const info = (e) => { const cs = getComputedStyle(e); return { type: e.type, checked: e.checked, appearance: cs.appearance, bg: cs.backgroundColor, lum: +lum(cs.backgroundColor).toFixed(2), border: cs.borderColor }; };
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        return { n: all.length, accent, off: all.filter((e) => !e.checked).slice(0, 40).map(info), onBox: all.filter((e) => e.checked && e.type === "checkbox").slice(0, 3).map(info),
          onRadio: all.filter((e) => e.checked && e.type === "radio").slice(0, 3).map(info) };`);
      console.log(`        ${r.n} controls; off e.g. ${J(r.off[0])}; on box ${J(r.onBox[0])}; on radio ${J(r.onRadio[0])}`);
      if (r.n < 10) v.push(`only ${r.n} checkboxes / radios in Settings`);
      const native = [...r.off, ...r.onBox, ...r.onRadio].filter((c) => c.appearance !== "none");
      if (native.length) v.push(`${native.length} still the browser's own control (appearance ${native[0].appearance})`);
      const white = r.off.filter((c) => c.lum > 0.5);
      if (white.length) v.push(`${white.length} unchecked controls are light (e.g. ${white[0].bg})`);
      if (r.onBox[0] && r.onBox[0].lum < 0.05) v.push(`a ticked checkbox isn't filled (${r.onBox[0].bg})`);
      // the tick's own pixels, centred in its box as drawn (pixel-centre.js: the tick = what hiding it changes, the box = what
      // hiding the whole checkbox changes, both in one capture's device pixels). Never against the layout box mapped into the
      // capture: the matrix window's ratio isn't whole (~1.05), so the capture's origin and the box's edges round to device
      // pixels on their own, and a centred tick reads about half a css px off, either side of a ½ px limit by chance.
      // The tolerance is the ratio's resolution: ½ css px at a whole ratio, a device pixel at a fractional one.
      const box = await page(`const e = [...document.querySelectorAll('.settings input[type=checkbox]')].find((x) => x.checked);
        if (!e) return null; e.setAttribute("data-tick-probe", ""); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      if (!box) v.push("no ticked checkbox in Settings to measure");
      else {
        // the box as drawn: Settings' sections cascade in (index.css ssection-in, up to ~1.4 s from the tab opening, later
        // sections last), so a capture taken on a timer can catch the box at opacity 0. Wait for every animation on it and
        // its ancestors to finish, then for a frame drawn after that.
        const b2 = await page(`const e = document.querySelector("[data-tick-probe]");
          for (let n = 0; n < 5; n++) {
            const run = [...e.getAnimations({ subtree: true })]; for (let x = e.parentElement; x; x = x.parentElement) run.push(...x.getAnimations());
            const fin = run.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState !== "finished");
            if (!fin.length) break;
            await Promise.race([Promise.all(fin.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
          }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
          return { op, dpr: devicePixelRatio };`);
        // against the box itself: its glow off (soft, and a transition would still run between the captures)
        const r = await PXC.measure(win, { chip: "[data-tick-probe]", glyph: "[data-tick-probe]::after", png: path.join(OUT, "steam-tick.png"),
          css: "[data-tick-probe], [data-tick-probe]::after { box-shadow: none !important; transition: none !important; }" });
        // one device pixel at a fractional ratio, without PXC's allowance for a square chip drawn a row short: the tick's box
        // is a checkbox's fill, and a row short moves its centre half a device pixel, well inside one
        const tol = PXC.tolerance(null, b2.dpr);
        console.log(`        the tick off its drawn box's centre by ${r.error ?? `(${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}) css px (tick ${J(r.glyph)}, box ${J(r.box)} device px, ratio ${+b2.dpr.toFixed(3)}, ±${tol.toFixed(2)}, drawn at opacity ${b2.op})`}`);
        v.push(...PXC.judge("the tick", r, tol));
        await page(`document.querySelector("[data-tick-probe]")?.removeAttribute("data-tick-probe");`);
      }
      // a click anywhere on a checkbox / radio row ticks it: a real click on a
      // radio row's HINT text picks it, on a checkbox row's NAME flips it (twice: back); a slider row's name changes nothing
      const rowPt = (sel, part) => page(`const row = ${sel}; if (!row) return null; row.scrollIntoView({ block: "center" });
        const t = row.querySelector(${J(part)}); const r = t.getBoundingClientRect(); return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 };`);
      const click = async (p) => { win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 });
        win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 }); await sleep(900); };
      const appRow = `document.querySelector('[data-wsmode="steamapp"]')?.closest(".srow")`;
      let pt = await rowPt(appRow, ".shint"); await sleep(300); pt = await rowPt(appRow, ".shint");
      if (!pt) v.push("no Use the Steam app row");
      else { await click(pt); const m = (await http("GET", "/settings")).json?.workshopDownloadMode;
        if (m !== "steamapp") v.push(`a click on the radio row's hint saved ${m} (expected steamapp)`); }
      const ckRow = `[...document.querySelectorAll(".srow[data-row-toggle]")].find((r) => r.querySelector('input[type=checkbox]:not(:disabled)'))`;
      const before = await page(`return ${ckRow}?.querySelector("input").checked ?? null;`);
      pt = await rowPt(ckRow, ".slabel-row"); await sleep(300); pt = await rowPt(ckRow, ".slabel-row");
      if (before === null || !pt) v.push("no checkbox row to click");
      else {
        await click(pt); const mid = await page(`return ${ckRow}.querySelector("input").checked;`);
        await click(pt); const end = await page(`return ${ckRow}.querySelector("input").checked;`);
        if (mid === before || end !== before) v.push(`a click on a checkbox row's name: ${before} → ${mid} → ${end} (expected a flip and back)`);
      }
      const rangeRow = `[...document.querySelectorAll(".srow")].find((r) => r.querySelector("input[type=range]"))`;
      const rv0 = await page(`return ${rangeRow}?.querySelector("input[type=range]").value ?? null;`);
      const rowIsLabel = await page(`return ${rangeRow}?.tagName ?? null;`);
      pt = await rowPt(rangeRow, ".slabel-row");
      if (pt) { await click(pt); const rv1 = await page(`return ${rangeRow}.querySelector("input[type=range]").value;`);
        if (rv1 !== rv0 || rowIsLabel === "LABEL") v.push(`a slider row reacted to a click on its name (${rv0} → ${rv1}, ${rowIsLabel})`); }
      const nToggle = await page(`return document.querySelectorAll(".srow[data-row-toggle]").length;`);
      console.log(`        ${nToggle} rows click anywhere to tick`);
      await setSettings({ workshopDownloadMode: "subscribe" });
      await page(`[...document.querySelectorAll(".ssection")].find((x) => /Getting Workshop wallpapers/i.test(x.textContent))?.scrollIntoView({ block: "center" });`);
      await sleep(400); await shot("toggles");
      return v;
    });

    await cell("steam:modal:email", async () => {
      const v = []; await load(SIGNED_OUT);
      let m = await openPw(); console.log(`        open ${J(m)}`);
      if (!m) return ["the password button opened no modal"];
      if (m.step !== "credentials" || m.role !== "dialog" || m.aria !== "true" || !m.labelled) v.push(`dialog semantics: ${J({ step: m.step, role: m.role, aria: m.aria, labelled: m.labelled })}`);
      const f = await page(`const m = document.querySelector("[data-steam-pw-modal]"); const pw = m.querySelector("[data-steam-pw]"), u = m.querySelector('input[name="username"]');
        const lab = (i) => !!m.querySelector('label[for="' + i.id + '"]');
        return { pwType: pw.type, pwAc: pw.autocomplete, uAc: u.autocomplete, labels: lab(pw) && lab(u) };`);
      if (f.pwType !== "password" || f.pwAc !== "current-password" || f.uAc !== "username" || !f.labels) v.push(`fields: ${J(f)}`);
      if (m.focus !== "username") v.push(`focus on open: ${m.focus}`);
      await shot("modal-credentials");
      await credentials();
      m = await modal();
      const c = (await calls()).filter((x) => x.p === "/steam/login");
      if (c.length !== 1 || c[0].body?.username !== "probe-user" || c[0].body?.password !== PASSWORD) v.push(`POST /steam/login: ${J(c.map((x) => ({ ...x.body, password: x.body?.password === PASSWORD ? "<the password>" : x.body?.password })))}`);
      if (m?.pwVal !== "") v.push("the password field still holds the password after Sign in");
      if (!/Signing in/.test(m?.submit ?? "")) v.push(`while Steam answers: "${m?.submit}"`);
      await ev("steam-login-code", { kind: "email", hint: "example.com", retry: false });
      m = await waitFor(async () => { const x = await modal(); return x?.step === "email" ? x : null; });
      console.log(`        email ${J(m && { step: m.step, focus: m.focus, text: m.text.slice(0, 120) })}`);
      if (m?.step !== "email" || !/emailed|email/.test(m.text) || !/example\.com/.test(m.text)) v.push(`email step: ${J(m && { step: m.step, text: m.text })}`);
      await sleep(150);
      if ((await modal())?.focus !== "code") v.push(`focus on the code step: ${(await modal())?.focus}`);
      await shot("modal-email");
      await type("WRONG"); await key("Enter"); await sleep(200);
      const cc = (await calls()).filter((x) => x.p === "/steam/login/code");
      if (cc.length !== 1 || cc[0].body?.code !== "WRONG") v.push(`POST /steam/login/code: ${J(cc)}`);
      await ev("steam-login-code", { kind: "email", hint: "example.com", retry: true }); await sleep(200);
      m = await modal();
      if (!/wasn't right/.test(m?.err ?? "") || m?.errRole !== "alert") v.push(`a wrong code: ${J({ err: m?.err, role: m?.errRole })}`);
      await shot("modal-email-retry");
      await type("ABCDE"); await key("Enter"); await sleep(200);
      await page(`window.__st.status = { signedIn: true, rejected: false, accountName: "probe-acct", daysLeft: 200, mode: "subscribe" };`);
      await ev("steam-signed-in", { signedIn: true, rejected: false, accountName: "probe-acct", daysLeft: 200, mode: "subscribe" });
      const gone = await waitFor(async () => !(await modal()), 2000);
      if (!gone) v.push("steam-signed-in didn't close the modal");
      const r = await waitFor(async () => { const x = await steamRow(); return x?.state === "signed-in" ? x : null; }, 2000);
      if (!r || !/probe-acct/.test(r.text)) v.push(`the row after signing in: ${J(r)}`);
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:device", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials();
      await ev("steam-login-code", { kind: "device", hint: null, retry: false });
      const m = await waitFor(async () => { const x = await modal(); return x?.step === "device" ? x : null; });
      if (!m || !/authenticator/i.test(m.text) || !/STEAM GUARD CODE/.test(m.text)) v.push(`device step: ${J(m && m.text)}`);
      await shot("modal-device");
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(400);
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("Cancel didn't close it");
      if (!(await calls()).some((x) => x.p === "/steam/login/cancel")) v.push("Cancel on a code step sent no /steam/login/cancel");
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:confirm", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials();
      await ev("steam-login-code", { kind: "confirm", hint: null, retry: false });
      const m = await waitFor(async () => { const x = await modal(); return x?.step === "confirm" ? x : null; });
      if (!m || !/Approve/.test(m.text) || !/Waiting for your approval/.test(m.text)) v.push(`confirm step: ${J(m && m.text)}`);
      if (!(await page(`return !!document.querySelector("[data-steam-pw-code]");`))) v.push("no code field on the confirm step");
      await shot("modal-confirm");
      await ev("steam-signed-in", { signedIn: true, rejected: false, accountName: "c", daysLeft: 200, mode: "subscribe" });
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("signed-in didn't close it");
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:error", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials("err-user");
      await ev("steam-login-error", { message: "Wrong account name or password.", rateLimited: false }); await sleep(300);
      let m = await modal(); console.log(`        ${J(m && { step: m.step, err: m.err, user: m.user, focus: m.focus })}`);
      if (m?.step !== "credentials" || m.err !== "Wrong account name or password." || m.errRole !== "alert") v.push(`after the error: ${J(m)}`);
      if (m?.user !== "err-user") v.push(`the account name wasn't kept (${m?.user})`);
      if (m?.pwVal !== "") v.push("the password field isn't empty after the error");
      if (m?.focus !== "password") v.push(`focus after the error: ${m?.focus}`);
      await shot("modal-error");
      // a refused start (Steam's rate limit hold): its words inline, and nothing retries
      await js(`window.__replies = { "/steam/login": { status: 400, body: { error: "Steam is limiting sign-in attempts from this connection — try again after 17:05." } } }; true`);
      const n0 = (await calls()).filter((x) => x.p === "/steam/login").length;
      await type(PASSWORD); await key("Enter"); await sleep(400);
      m = await modal();
      if (!/limiting/.test(m?.err ?? "")) v.push(`the refused start: ${m?.err}`);
      if (/Signing in/.test(m?.submit ?? "")) v.push("still 'Signing in…' after the refusal");
      await sleep(1500);
      const n1 = (await calls()).filter((x) => x.p === "/steam/login").length;
      if (n1 !== n0 + 1) v.push(`/steam/login sent ${n1 - n0} times for one click`);
      await js(`window.__replies = {}; true`);
      await shot("modal-ratelimit");
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(300);
      await leakCheck(v, 2); // the first try + the refused one
      return v;
    });
    await cell("steam:modal:cancel", async () => {
      const v = []; await load(SIGNED_OUT); await openPw();
      // a click outside the dialog keeps it (it'd throw away what was typed)
      await type("cancel-user");
      send({ type: "mouseDown", x: 20, y: 880, button: "left", clickCount: 1 }); send({ type: "mouseUp", x: 20, y: 880, button: "left", clickCount: 1 }); await sleep(300);
      if (!(await modal())) v.push("a click outside closed the modal");
      await page(`document.querySelector('[data-steam-pw-modal] input[name="username"]').focus();`);
      await key("Tab"); await type(PASSWORD); await key("Enter"); await sleep(200);
      await ev("steam-login-code", { kind: "email", hint: null, retry: false }); await sleep(250);
      await key("Escape"); await sleep(400);
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("Escape didn't close it");
      if (!(await calls()).some((x) => x.p === "/steam/login/cancel")) v.push("Escape sent no /steam/login/cancel");
      // reopened: fresh, empty
      const m = await openPw();
      if (m?.step !== "credentials" || m?.pwVal !== "" || m?.err) v.push(`reopened: ${J(m)}`);
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(300);
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:keys", async () => {
      const v = []; await load(SIGNED_OUT); await openPw();
      const order = [];
      await key("Shift"); // the first key event only gives the page keyboard focus
      for (let i = 0; i < 4; i++) {
        order.push(await page(`const a = document.activeElement; return a?.name || a?.textContent.trim() || a?.tagName;`));
        await key("Tab");
      }
      if (J(order) !== J(["username", "password", "Cancel", "Sign in"])) v.push(`Tab order: ${J(order)}`);
      const m = await modal();
      if (m?.titles) v.push(`${m.titles} element(s) with a title (tooltip) in the modal`);
      await key("Escape"); await sleep(300);
      return v;
    });

    // the download button is a bare glyph, like the Library card's buttons: at rest (the card hovered, the button not) and
    // on the button (its one-shot drop held where it lands) it draws nothing but its arrow (the capture with the arrow
    // hidden equals the one with the whole button hidden: no chip), and the arrow sits in its box's centre.
    await cell("look:dlCentre", async () => {
      const v = []; await load(SIGNED_IN); // signed out the button is off (side:blocked:download)
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((x) => x.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      const tw = await page(`const t = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]):not(:has([data-in-library])) .thumb-wrap") ?? document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap");
        t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      await sleep(300);
      const mv = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      // the FIRST card's button (re-found each time — a resize moves it)
      const btnSel = `document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .dl-btn")`;
      const measure = async (label, css) => {
        await page(`let st = document.getElementById("__dlc"); if (!st) { st = document.createElement("style"); st.id = "__dlc"; document.head.append(st); } st.textContent = ${J(css)};`);
        await sleep(450);
        const b = await page(`const b = ${btnSel}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        if (!b) return null;
        const rect = { x: Math.floor(b.x) - 2, y: Math.floor(b.y) - 2, width: Math.ceil(b.w) + 5, height: Math.ceil(b.h) + 5 };
        const withArrow = await win.webContents.capturePage(rect);
        await page(`document.getElementById("__dlc").textContent += " .dl-glyph { visibility: hidden !important; }";`); await sleep(120);
        const noArrow = await win.webContents.capturePage(rect);
        const A = withArrow.toBitmap(), B = noArrow.toBitmap(), { width: W, height: H } = withArrow.getSize();
        const sc = W / rect.width;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4, d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
          if (d > 90) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        const cx = (b.x - rect.x + b.w / 2) * sc, cy = (b.y - rect.y + b.h / 2) * sc;
        // no chip: with the glyph hidden the button draws nothing — the same pixels as with the whole button hidden
        await page(`document.getElementById("__dlc").textContent += " .dl-btn { visibility: hidden !important; }";`); await sleep(120);
        const C = (await win.webContents.capturePage(rect)).toBitmap();
        let chip = 0;
        for (let k = 0; k < W * H * 4; k += 4) if (Math.abs(B[k] - C[k]) + Math.abs(B[k + 1] - C[k + 1]) + Math.abs(B[k + 2] - C[k + 2]) > 30) chip++;
        // the glyph in its box: a pixel's grid snap either way (no ring to read it against any more)
        const lx = ((x0 + x1 + 1) / 2 - cx) / sc, ly = ((y0 + y1 + 1) / 2 - cy) / sc;
        fs.writeFileSync(path.join(OUT, `dlc-${label}.png`), withArrow.resize({ width: W * 8, quality: "good" }).toPNG());
        console.log(`        ${label}: ${n} arrow px, ${chip} chip px, arrow off its box's centre by (${lx.toFixed(2)}, ${ly.toFixed(2)}) css px`);
        return { lx, ly, n, chip };
      };
      // several window sizes (cards, and so the button's position, land on fractional pixels at some sizes; a small window
      // can hide it)
      const sizes = (E.LIASCAPE_DLC_SIZES || "1000x800,1920x1080,1600x900").split(",").map((x) => x.split("x").map(Number));
      for (const [W0, H0] of sizes) {
        win.setContentSize(W0, H0); await sleep(900);
        const t2 = await page(`const t = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap"); t.scrollIntoView({ block: "center" });
          const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        Object.assign(tw, t2); await sleep(300);
        mv(tw.x + 12, tw.y + 12); // on the card, off the button: the button shows (opacity 1), not hovered
        const rest = await measure(`${W0}x${H0}-rest`, "");
        const b0 = await page(`const e = ${btnSel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
        if (!b0) { v.push(`${W0}x${H0}: no download button`); continue; }
        mv(b0.x, b0.y);
        await sleep(100); await page(`for (const e of document.querySelectorAll(".dl-glyph *")) for (const a of e.getAnimations()) a.finish();`); // its drop, landed
        const hov = await measure(`${W0}x${H0}-hover0`, ".dl-btn::before { display: none !important; }"); // the bloom is meant to show
        if (hov?.chip > 3) v.push(`${W0}x${H0}: hovered, the button draws ${hov.chip} px of its own (a chip): want the bare glyph`);
        await page(`document.getElementById("__dlc")?.remove();`);
        mv(5, 5); await sleep(300);
        if (!rest || !rest.n) { v.push(`${W0}x${H0}: no arrow pixels at rest — proved nothing`); continue; }
        if (rest.chip > 3) v.push(`${W0}x${H0}: at rest the button draws ${rest.chip} px of its own (a chip): want the bare glyph`);
        if (Math.abs(rest.lx) > 1 || Math.abs(rest.ly) > 1) v.push(`${W0}x${H0}: at rest the arrow is off its box's centre by (${rest.lx.toFixed(2)}, ${rest.ly.toFixed(2)}) css px`);
      }
      win.setContentSize(1000, 800); await sleep(400);
      return v;
    });

    await cell("steam:dlStatus", async () => {
      const v = []; await load(SIGNED_IN);
      const srcs = (await http("GET", "/sources")).json;
      const ws = srcs.find((s) => s.supportsTagFilter)?.name;
      if (!ws) return ["no Workshop source"];
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(ws)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      await page(`document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap").click();`); await sleep(700);
      const btn = await page(`const b = [...document.querySelectorAll(".side-go")].find((x) => x.textContent.trim() === "Subscribe"); if (!b) return false; b.click(); return true;`);
      if (!btn) return ["no Subscribe button in the Browse sidebar"];
      const dl = await waitFor(() => js(`window.__st.dl && window.__st.dl.body`), 2000);
      if (!dl) return ["no POST /download"];
      // the fallback order's last step: its page waits in the Steam app (WorkshopDownloader.OpenedInSteam)
      const STATUS = "Opened in Steam: subscribe there and it downloads here";
      await ev("download-progress", { id: dl.result.pageUrl, value: 0, status: STATUS }); await sleep(300);
      const r = await page(`return { side: document.querySelector("[data-side-download-status]")?.textContent ?? null, bar: document.querySelector(".status")?.textContent ?? null };`);
      console.log(`        ${J(r)}`);
      if (r.side !== STATUS) v.push(`the sidebar says "${r.side}"`);
      if (!(r.bar ?? "").includes(STATUS)) v.push(`the status bar says "${r.bar}"`);
      // a bare "Downloading…" over an empty bar for a minute looks like a hang: the CARD says the step in
      // short words, over a sweeping (indeterminate) bar — each phase the backend reports, in order
      const card = (sel) => page(`const c = [...document.querySelectorAll("[data-morph-id]")].find((e) => e.getAttribute("data-morph-id") === ${J("br-" + dl.result.pageUrl)});
        const l = c?.querySelector("[data-dl-label]"), bar = c?.querySelector(".dl-bar"), f = bar?.querySelector(".dl-fill");
        return { label: l?.textContent ?? null, indet: !!bar?.classList.contains("indet"), anim: f ? getComputedStyle(f).animationName : null };`);
      // + the Steam to-do: waiting its page's turn, then (steamapp) its turn with the Steam client
      for (const [status, want] of [["In the Steam to-do — its page opens in Steam when it's its turn…", "In the Steam to-do"], ["Waiting for the Steam app…", "Waiting for the Steam app…"],
        [STATUS, "Click Subscribe in Steam"], ["Steam is downloading it…", "Steam is downloading…"], ["Steam is finishing…", "Steam is finishing…"]]) {
        await ev("download-progress", { id: dl.result.pageUrl, value: 0, status }); await sleep(250);
        const c = await card();
        console.log(`        card: ${J(c)}`);
        if (c.label !== want) v.push(`for "${status}" the card says "${c.label}" (expected "${want}")`);
        if (!c.indet || c.anim !== "dl-indet") v.push(`for "${status}" the card's bar isn't sweeping (indet ${c.indet}, animation ${c.anim})`);
      }
      // with a short label ("1%") the bar still spans ~72 % of the card
      await ev("download-progress", { id: dl.result.pageUrl, value: 0.01, status: "Steam is downloading it…" }); await sleep(250);
      const bw = await page(`const c = [...document.querySelectorAll("[data-morph-id]")].find((e) => e.getAttribute("data-morph-id") === ${J("br-" + dl.result.pageUrl)});
        const b = c?.querySelector(".dl-bar"); return b ? { bar: b.getBoundingClientRect().width, card: c.getBoundingClientRect().width, label: c.querySelector("[data-dl-label]")?.textContent } : null;`);
      console.log(`        bar ${J(bw)}`);
      if (!bw || bw.bar < bw.card * 0.6) v.push(`the progress bar is ${bw?.bar.toFixed(0)} px on a ${bw?.card.toFixed(0)} px card (label "${bw?.label}")`);
      await shot("dl-status");
      await page(`[...document.querySelectorAll("[data-side-download] button")].find((b) => /Cancel/.test(b.textContent))?.click();`); await sleep(400);
      if (!(await js(`window.__st.dl.aborted`))) v.push("Cancel didn't abort the download request");
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("the progress row stayed after Cancel");
      // a late status for the cancelled download doesn't bring it back
      await ev("download-progress", { id: dl.result.pageUrl, value: 0, status: STATUS }); await sleep(300);
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("a late download-progress brought the progress row back");
      return v;
    });

    // docs/decisions.md § "Queue the Steam pages the user must click, one at a time, advanced by Next": the Steam to-do panel, driven by
    // fake WS steam-todo events; every button POSTs its /steam-todo/<action> (stubbed — nothing reaches the backend)
    await cell("steam:todo", async () => {
      const v = []; await load(SIGNED_OUT);
      const TITLE = "Re:Zero Rem – Edit";
      const panel = () => page(`const p = document.querySelector("[data-steam-todo]"); if (!p) return null;
        const btn = (k) => p.querySelector('[data-st="' + k + '"]');
        const dock = p.closest("[data-steam-todo-dock]"), cs = getComputedStyle(dock || p), side = document.querySelector(".side-panel");
        return { step: p.querySelector("[data-st-step]")?.textContent ?? null, title: p.querySelector("[data-st-title]")?.textContent ?? null,
          hint: p.querySelector("[data-st-hint]")?.textContent ?? null, next: btn("next")?.textContent.trim() ?? null,
          reopen: btn("reopen")?.textContent.trim() ?? null, skip: btn("skip")?.textContent.trim() ?? null, stop: btn("stop")?.textContent.trim() ?? null,
          use: btn("use-steam-app")?.textContent.trim() ?? null, titles: p.querySelectorAll("[title]").length,
          iconOnlyNoLabel: [...p.querySelectorAll("button")].filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).length,
          fixed: cs.position, z: +cs.zIndex, sideZ: side ? +getComputedStyle(side).zIndex : 40, inBody: !!dock && dock.parentElement === document.body,
          useNote: p.querySelector("[data-st-use-note]")?.textContent ?? null,
          rect: (() => { const r = p.getBoundingClientRect(); const bar = document.querySelector(".playlist-bar"); return { r: innerWidth - r.right, b: innerHeight - r.bottom, w: r.width, barLift: bar ? innerHeight - bar.getBoundingClientRect().top : 0 }; })(),
          emoji: /\\p{Extended_Pictographic}/u.test(p.textContent), icons: p.querySelectorAll("svg.lucide").length };`);
      if (await panel()) v.push("a panel showed before any steam-todo event");
      const STEP = { action: "subscribe", index: 2, total: 5, remaining: 4, current: { id: "930001", title: TITLE }, delivered: false, message: null, busy: false };
      await ev("steam-todo", STEP); await sleep(700);
      const p = await panel();
      console.log(`        ${J(p)}`);
      if (!p) return ["no panel for a steam-todo event"];
      if (p.step !== "Subscribe in Steam · 2 of 5") v.push(`the step reads "${p.step}"`);
      if (p.title !== TITLE) v.push(`the title reads "${p.title}"`);
      if (!/Click Subscribe on the page Steam opened, then Done — next/.test(p.hint ?? "")) v.push(`the hint reads "${p.hint}"`);
      if (p.next !== "Done — next" || p.reopen !== "Open again" || p.skip !== "Skip" || p.stop !== "Stop") v.push(`the buttons read ${J([p.next, p.reopen, p.skip, p.stop])}`);
      if (p.use !== "Let the Steam app do all 4") v.push(`the Steam-app line reads "${p.use}" (4 remaining)`);
      // "Let the Steam app do all N" says it needs WE, Steam running, and shows the user as playing
      if (!/Wallpaper Engine/.test(p.useNote ?? "") || !/playing/.test(p.useNote ?? "") || !/Steam running/.test(p.useNote ?? "")) v.push(`the Steam-app note reads "${p.useNote}"`);
      if (p.titles) v.push(`${p.titles} element(s) with a title (tooltip) in the panel`);
      if (p.iconOnlyNoLabel) v.push(`${p.iconOnlyNoLabel} icon-only button(s) without an aria-label`);
      // bottom-right: 16 px from the edge, lifted over the playlist bar when it shows (Library)
      if (p.fixed !== "fixed" || !p.inBody || !(p.z > p.sideZ) || p.rect.r > 40 || Math.abs(p.rect.b - (p.rect.barLift + 16)) > 4) v.push(`placement: ${J({ fixed: p.fixed, inBody: p.inBody, z: p.z, sideZ: p.sideZ, rect: p.rect })}`);
      if (p.emoji || p.icons < 4) v.push(`icons: emoji ${p.emoji}, ${p.icons} lucide icons`);
      await shot("todo");
      // each button → its endpoint, once
      for (const k of ["next", "reopen", "skip", "stop", "use-steam-app"]) {
        const n0 = (await calls()).length;
        await page(`document.querySelector('[data-steam-todo] [data-st="${k}"]').click();`); await sleep(250);
        const got = (await calls()).slice(n0).map((c) => c.p);
        if (J(got) !== J([`/steam-todo/${k}`])) v.push(`${k} → ${J(got)} (expected one POST /steam-todo/${k})`);
      }
      // the fold: a pill with the step, back again
      await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(300);
      const folded = await page(`const p = document.querySelector("[data-steam-todo]"); return { folded: p.classList.contains("folded"), step: p.querySelector("[data-st-step]")?.textContent, btns: p.querySelectorAll("[data-st]").length };`);
      if (!folded.folded || folded.step !== "Subscribe in Steam · 2 of 5" || folded.btns) v.push(`folded: ${J(folded)}`);
      await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(300);
      // the last one: "Done", no Steam-app line; an unsubscribe entry says so; a message shows
      await ev("steam-todo", { ...STEP, action: "unsubscribe", index: 5, total: 5, remaining: 1, message: "The Steam app couldn't be reached — Steam isn't running." }); await sleep(400);
      const last = await page(`const p = document.querySelector("[data-steam-todo]"); return { step: p?.querySelector("[data-st-step]")?.textContent,
        next: p?.querySelector('[data-st="next"]')?.textContent.trim(), use: !!p?.querySelector('[data-st="use-steam-app"]'), msg: p?.querySelector("[data-st-msg]")?.textContent ?? null };`);
      console.log(`        last: ${J(last)}`);
      if (last.step !== "Unsubscribe in Steam · 5 of 5" || last.next !== "Done" || last.use || !/couldn't be reached/.test(last.msg ?? "")) v.push(`at 1 remaining: ${J(last)}`);
      // finished → gone (after its exit)
      await ev("steam-todo", { finished: true }); await sleep(600);
      if (await panel()) v.push("the panel stayed after a finished event");
      return v;
    });

    // ---- per-frame sampling: run `act` (page statements), then read `expr` every animation frame for `ms` ----
    const frames = (act, expr, ms = 600) => page(`const out = []; const t0 = performance.now(); try { out.push(${expr}); } catch { out.push(null); }
      ${act}
      await new Promise((res) => { const f = () => { try { out.push(${expr}); } catch { out.push(null); } if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      return out;`);
    // how many samples lie strictly between the first and the last value (an animation passes through them; a jump doesn't)
    const between = (xs, eps = 1.5) => { const ys = xs.filter((x) => x != null); if (ys.length < 2) return 0; const a = ys[0], b = ys.at(-1);
      const lo = Math.min(a, b) + eps, hi = Math.max(a, b) - eps; return ys.filter((y) => y > lo && y < hi).length; };
    const shotDuring = async (name, run, at = 110) => { const p = run(); await sleep(at); await shot(name); return p; };
    const STEP2 = { action: "subscribe", index: 2, total: 5, remaining: 4, current: { id: "930001", title: "Rem – Edit" }, delivered: false, message: null, busy: false, autoNext: true };
    const DOCK_Y = `new DOMMatrix(getComputedStyle(document.querySelector("[data-steam-todo-dock]")).transform).m42`;
    const PANEL_W = `document.querySelector("[data-steam-todo]")?.getBoundingClientRect().height ?? null`;
    // the newest entry block's x offset (the carousel slide): the live one is the last [data-st-entry] with the new id
    const ENTRY_X = (id) => `(() => { const e = [...document.querySelectorAll('[data-st-entry="${id}"]')].at(-1); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 : null; })()`;
    // (a bar that shows: the Library's stays in the document, hidden, while another tab shows — App.tsx)
    const fakeBar = `if (![...document.querySelectorAll(".playlist-bar")].some((e) => e.getClientRects().length)) { const b = document.createElement("div"); b.className = "playlist-bar"; b.id = "__fakebar";
      b.style.cssText = "position:fixed;left:0;bottom:0;width:40px;height:130px;pointer-events:none"; document.body.append(b); }`;

    // the to-do panel moves smoothly — the lift
    // GLIDES (a playlist bar appearing), fold ⇄ unfold MORPHS (widths in between), a new current entry SLIDES (the carousel);
    // under no-motion nothing moves (the lift and the fold change at once) and what appears or leaves fades (components/motion.ts
    // FADE). Mid-animation shots: steam-todo-glide.png, steam-todo-fold.png, steam-todo-slide.png
    for (const motion of [true, false]) {
      await cell(`steam:todoMotion:${motion ? "on" : "off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion });
        await load(SIGNED_OUT); await tab("Browse");
        await page(`document.getElementById("__fakebar")?.remove(); [...document.querySelectorAll(".playlist-bar")].some((e) => e.getClientRects().length) && (window.__realBar = true);`);
        // motion off: what appears / leaves is sampled per frame (MO.judge)
        // (wrapped: an async function returning the bare promise would wait for the whole sample)
        const smp = async (sels, ms) => { if (motion) return { p: null }; const p = js(MO.SAMPLE(sels, ms)); await sleep(50); return { p }; };
        const pIn = await smp({ panel: "[data-steam-todo]" }, 500);
        await ev("steam-todo", { ...STEP2, current: { id: "930001", title: "Rem – Edit" } }); await sleep(900);
        const panelIn = await pIn.p;
        if (await js(`!!window.__realBar`)) console.log("        (a playlist bar already shows on Browse — the glide is measured against the fake one anyway)");
        // (a) the lift: a bar appears → the dock glides up to it (re-measured every 150 ms)
        const lift = await (motion ? shotDuring("todo-glide", () => frames(fakeBar, DOCK_Y, 900), 260) : frames(fakeBar, DOCK_Y, 900));
        const liftEnd = lift.filter((x) => x != null).at(-1);
        const nLift = between(lift);
        console.log(`        lift: ${lift[0]} → ${liftEnd}, ${nLift} frame(s) in between`);
        if (!(Math.abs(liftEnd - lift[0]) > 50)) v.push(`the dock didn't lift over the bar (${lift[0]} → ${liftEnd})`);
        if (motion && nLift < 4) v.push(`the lift jumped (${nLift} in-between frames)`);
        if (!motion && nLift > 1) v.push(`no-motion: the lift animated (${nLift} in-between frames)`);
        await page(`document.getElementById("__fakebar")?.remove();`); await sleep(700);
        // (b) fold ⇄ unfold: the box's width passes through sizes in between
        // heights: the folded pill keeps about the open width (its head), the height is what folds
        const bFold = await smp({ body: "[data-steam-todo] .st-body" }, 600);
        const fold = await (motion ? shotDuring("todo-fold", () => frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700), 90)
          : frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700));
        const bodyOut = await bFold.p, bUnfold = await smp({ body: "[data-steam-todo] .st-body" }, 600);
        const unfold = await frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700);
        const bodyIn = await bUnfold.p;
        const nF = between(fold), nU = between(unfold);
        console.log(`        fold: ${fold[0]?.toFixed(0)} → ${fold.at(-1)?.toFixed(0)} (${nF} between); unfold → ${unfold.at(-1)?.toFixed(0)} (${nU} between)`);
        if (!(fold.at(-1) < fold[0] - 40) || Math.abs(unfold.at(-1) - fold[0]) > 2) v.push(`fold heights ${fold[0]} → ${fold.at(-1)} → ${unfold.at(-1)}`);
        if (motion && (nF < 3 || nU < 3)) v.push(`the fold popped (${nF} / ${nU} in-between frames)`);
        if (!motion && (nF > 1 || nU > 1)) v.push(`no-motion: the fold animated (${nF} / ${nU})`);
        // the chevron turns (one icon, rotated) — 180° folded
        await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(motion ? 600 : 100);
        const chev = await page(`const c = document.querySelector("[data-steam-todo] .st-chev"); return { n: document.querySelectorAll("[data-steam-todo] .st-fold svg").length, a: new DOMMatrix(getComputedStyle(c).transform).a, tr: getComputedStyle(c).transitionDuration };`);
        if (chev.n !== 1 || !(chev.a < -0.99)) v.push(`the folded chevron: ${J(chev)} (one icon turned 180°)`);
        if (motion && chev.tr === "0s") v.push("the chevron has no transition");
        await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(700);
        // (c) a new current entry: the content slides in (transform)
        const sEntry = await smp({ old: '[data-st-entry="930001"]', now: '[data-st-entry="930002"]' }, 600);
        const slide = await (motion
          ? shotDuring("todo-slide", () => frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600), 90)
          : shotDuring("todo-slide-off", () => frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600), 55));
        const moved = slide.filter((x) => x != null && Math.abs(x) > 1.5).length;
        console.log(`        slide x: [${slide.slice(0, 10).map((x) => x == null ? "–" : x.toFixed(1))}…] ${moved} offset frame(s)`);
        if (motion && moved < 3) v.push(`the new entry didn't slide in (${moved} frames off its place)`);
        if (!motion && moved > 0) v.push(`no-motion: the new entry slid (${moved} frames)`);
        if (slide.at(-1) == null || Math.abs(slide.at(-1)) > 0.5) v.push(`the new entry didn't land (x ${slide.at(-1)})`);
        const entries = await sEntry.p, pOut = await smp({ panel: "[data-steam-todo]" }, 500);
        await ev("steam-todo", { finished: true }); await sleep(500);
        if (!motion) {
          const panelOut = await pOut.p;
          console.log(`        no-motion: panel in ${MO.brief(panelIn.panel)}, body out ${MO.brief(bodyOut.body)} / in ${MO.brief(bodyIn.body)}, entry old ${MO.brief(entries.old)} / new ${MO.brief(entries.now)}, panel out ${MO.brief(panelOut.panel)}`);
          v.push(...MO.judge("no-motion: the panel coming in", panelIn.panel, { appear: true, size: false }),
            ...MO.judge("no-motion: the body folding away", bodyOut.body, { leave: true }), ...MO.judge("no-motion: the body unfolding", bodyIn.body, { appear: true }),
            ...MO.judge("no-motion: the old entry", entries.old, { leave: true }), ...MO.judge("no-motion: the new entry", entries.now, { appear: true, size: false }),
            ...MO.judge("no-motion: the panel leaving", panelOut.panel, { leave: true, size: false }));
        }
        return v;
      });
    }
    await setSettings({ morphs: true });

    // The item sidebar's subscription for a Workshop result and a WE-local item the library doesn't hold (components/ItemSide.tsx:
    // no subscription card): the buttons and the Unsubscribe tile per the stubbed /workshop/state (components/wsSubState.ts);
    // their POSTs; Open on Steam → POST /steam/open-page (ok:false → the https page through window.open). Shots steam-sub*.png
    const openSide = async (n = 0) => { await page(`document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap")[${n}].click();`); await sleep(800); };
    const sub = () => page(`const b = document.querySelector(".side-panel:not(.closing) .side-body"); if (!b) return null;
      const t = b.querySelector("[data-unsubscribe-steam]");
      return { cta: [...b.querySelectorAll(".side-cta .side-go:not([data-unsubscribe-steam])")].map((e) => e.textContent.trim()), tile: t ? t.textContent.trim() : null, off: t?.getAttribute("aria-disabled") ?? null,
        card: !!b.querySelector("[data-side-sub]"), row: t ? t.className : null, bg: t ? getComputedStyle(t).backgroundColor : null, icoShadow: t ? getComputedStyle(t).boxShadow : null };`);
    const setWs = (id, st) => js(`window.__wsState = { ...(window.__wsState || {}), ${J(id)}: ${J(st)} }; true`);
    const bump = () => ev("steam-todo", { finished: true }); // any event that can change a subscription → the state is read again
    // steam:sub:workshop — a Workshop result: not subscribed → "Subscribe and apply" / "Subscribe" and no subscription action;
    // Steam keeps it subscribed (not imported) → "Download and apply" / "Download" and an Unsubscribe tile (POST /workshop/unsubscribe),
    // "Unsubscribing…" (disabled) while pending; never a subscription card
    await cell("steam:sub:workshop", async () => {
      const v = []; await load(SIGNED_IN);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((s) => s.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0); await sleep(300);
      let s = await sub();
      console.log(`        not subscribed: ${J(s)}`);
      if (!s || J(s.cta) !== J(["Subscribe and apply", "Subscribe"]) || s.tile || s.row || s.card) v.push(`not subscribed: ${J(s)}`);
      // subscribed in Steam, not imported: Download + Unsubscribe, arriving with the state (rising in)
      await setWs("930000", { subscribed: true, pending: null, inLibrary: false, onDisk: true }); await bump(); await sleep(600);
      s = await sub();
      console.log(`        subscribed: ${J(s)}`);
      if (!s || J(s.cta) !== J(["Download and apply", "Download"]) || s.tile !== "Unsubscribe" || s.off || s.card || !/arrive/.test(s.row ?? "")) v.push(`subscribed: ${J(s)}`);
      await shot("sub-workshop");
      let n0 = (await calls()).length;
      await page(`document.querySelector("[data-unsubscribe-steam]").click();`); await sleep(300);
      let got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe" || got[0].body?.workshopId !== "930000") v.push(`Unsubscribe posted ${J(got)}`);
      await setWs("930000", { subscribed: false, pending: "unsubscribe", inLibrary: false, onDisk: true }); await bump(); await sleep(500);
      s = await sub();
      if (s?.tile !== "Unsubscribing…" || s.off !== "true") v.push(`pending unsubscribe: ${J(s)}`);
      // Open on Steam → POST /steam/open-page; the browser only when the Steam app couldn't be opened
      await page(`window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.__replies = { ...(window.__replies || {}), "/steam/open-page": { body: { ok: true } } };`);
      n0 = (await calls()).length;
      await page(`document.querySelector("[data-open-steam]").click();`); await sleep(400);
      got = (await calls()).slice(n0);
      let opened = await js(`window.__opened`);
      if (got.length !== 1 || got[0].p !== "/steam/open-page" || got[0].body?.workshopId !== "930000" || opened.length) v.push(`Open on Steam (ok): ${J(got)}, browser ${J(opened)}`);
      await page(`window.__replies["/steam/open-page"] = { body: { ok: false } };`);
      await page(`document.querySelector("[data-open-steam]").click();`); await sleep(400);
      opened = await js(`window.__opened`);
      if (J(opened) !== J(["https://steamcommunity.com/sharedfiles/filedetails/?id=930000"])) v.push(`Open on Steam (ok:false) → the browser got ${J(opened)}`);
      if (await page(`return !!document.querySelector('.side-panel a[href*="steamcommunity.com"]');`)) v.push("a plain steamcommunity.com link is still in the sidebar");
      return v;
    });
    // steam:sub:weLocal — a WE-local item Steam keeps subscribed: "Download and apply" / "Download" (it imports) and Unsubscribe →
    // POST /workshop/unsubscribe; unsubscribed with its folder still there: the tile fades out (per frame) and what follows
    // glides up; no-glow: the tile's chip has no glow; bg-live: the tile keeps its own dark fill
    await cell("steam:sub:weLocal", async () => {
      const v = [];
      await js(`localStorage.setItem("__probe_we_local", "1"); true`);
      await load(SIGNED_IN);
      const srcs = (await http("GET", "/sources")).json;
      const local = srcs.find((s) => /Local/i.test(s.name) && !s.supportsTagFilter)?.name;
      if (!local) return ["no Wallpaper Engine (Local) source"];
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(local)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      await setWs("931000", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
      await openSide(0);
      let s = await waitFor(() => sub().then((x) => x && x.tile ? x : null), 3000);
      console.log(`        WE local: ${J(s)}`);
      if (s?.tile !== "Unsubscribe" || J(s?.cta) !== J(["Download and apply", "Download"])) v.push(`a WE-local subscription: ${J(s)}`);
      const n0 = (await calls()).length;
      // the tile leaves: its opacity per frame passes through in-between values
      const ops = await frames(`document.querySelector("[data-unsubscribe-steam]").click(); window.__wsState["931000"] = { subscribed: false, pending: null, inLibrary: false, onDisk: true };`,
        `(() => { const t = document.querySelector("[data-unsubscribe-steam]"); return t ? +getComputedStyle(t).opacity : null; })()`, 900);
      const got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe" || got[0].body?.workshopId !== "931000") v.push(`Unsubscribe posted ${J(got)}`);
      s = await sub();
      if (s?.tile || s?.row) v.push(`after the unsubscribe (folder still there): ${J(s)}`);
      const mid = ops.filter((x) => x != null && x > 0.05 && x < 0.95).length;
      console.log(`        leave opacity: [${ops.filter((x) => x != null).slice(0, 10).map((x) => x.toFixed(2))}] ${mid} in-between frame(s)`);
      if (mid < 2) v.push(`the tile didn't fade out (${mid} frames)`);
      await shot("sub-welocal");
      // no-glow: the tile's chip has no glow; bg-live: the tile keeps its own dark fill
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await load(SIGNED_IN); await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(local)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      await js(`window.__wsState = { "931000": { subscribed: true, pending: null, inLibrary: false, onDisk: true } }; true`);
      await openSide(0);
      s = await waitFor(() => sub().then((x) => x && x.tile ? x : null), 3000);
      const html = await js(`document.documentElement.className`);
      console.log(`        no-glow + bg-live: ${J({ html, bg: s?.bg, ico: s?.icoShadow })}`);
      if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
      if (s && (s.icoShadow ?? "").split(/,(?![^(]*\))/).some((x) => !/inset|none/.test(x) && !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the button glows (${s.icoShadow})`);
      if (!s || /rgba\(0, 0, 0, 0\)|transparent/.test(s.bg)) v.push(`bg-live: the Unsubscribe has no dark base of its own (${s?.bg})`);
      await shot("sub-live");
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      await js(`localStorage.removeItem("__probe_we_local"); true`);
      return v;
    });
    // ---- the Library sidebar's Workshop ID pill and its "Delete and unsubscribe"; the Browse sidebar's "Unsubscribe without
    // deleting" (the Unsubscribe button's right-click menu, components/ContextMenu.tsx). Shots steam-idpill-*.png,
    // steam-delsource*.png, steam-keepmenu*.png
    const mvTo = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
    const clickAt = async (x, y, button = "left") => {
      await mvTo(x, y, 60);
      send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button, clickCount: 1 }); await sleep(40);
      send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
    };
    const SIDE = ".side-panel:not(.closing)";
    const PILL = `${SIDE} [data-side-row=workshop-id]`;
    const openLib = async (t) => {
      await tab("Library");
      return page(`const c = [...document.querySelectorAll(".card.lib:not([data-leaving])")].find((x) => x.querySelector('[data-title="${t}"]'));
        if (!c) return false;
        c.querySelector(".thumb-wrap").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        for (let i = 0; i < 30 && document.querySelector("${SIDE} .side-title, ${SIDE} h2")?.textContent.trim() !== "${t}"; i++) await new Promise((r) => setTimeout(r, 100));
        return !!document.querySelector("${SIDE} .side-hero");`);
    };
    // every hero chip's layout box [name, x, y, w, h] (offset*: the click's press squeeze, a transform, isn't a re-wrap) and the
    // viewport box of the pill's own, for aiming
    const HERO = `(() => { const h = document.querySelector("${SIDE} .side-hero"); if (!h) return null;
      return [...h.children].map((e) => [e.dataset.sideRow ?? e.textContent.trim().slice(0, 14), e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]); })()`;
    const pillAim = () => js(`(() => { const r = document.querySelector("${PILL}")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    // the pill's accessible name, as the accessibility tree has it (the hidden face must not be in it)
    const axName = async (sel) => {
      const d = win.webContents.debugger;
      const { root } = await d.sendCommand("DOM.getDocument", { depth: 0 });
      const { nodeId } = await d.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (!nodeId) return null;
      const { nodes } = await d.sendCommand("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      return nodes.find((n) => !n.ignored)?.name?.value ?? null;
    };
    const restoreLib = async () => { await js(`localStorage.removeItem("__probe_lib_full"); true`); win.setContentSize(1400, 900); await sleep(300); };

    // The Workshop ID pill keeps its box (and every other hero chip keeps its own) through "Copied" and back, at the window
    // widths where the hero row wraps (the sidebar is clamp(300px, 26vw, 400px) wide) and full screen; the accessible name is
    // the aria-label's (never the hidden face's words); motion on the faces roll, motion off they only cross-fade
    await cell("side:idPill:still", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, settingsLevel: "standard" });
      await js(`localStorage.setItem("__probe_lib_full", "1"); true`);
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) { await restoreLib(); return ["no sidebar for the scene s1 — proved nothing"]; }
      await sleep(700);
      const seen = [];
      for (const w of [1160, 1200, 1240, 1280, 1320, 1360, 1400, 1440, 1480, 1520, 1560, 1920]) {
        win.setContentSize(w, w >= 1920 ? 1080 : 900); await sleep(350);
        const b = await js(HERO), i = b ? b.findIndex((x) => x[0] === "workshop-id") : -1;
        if (i < 0) { v.push(`${w} px: no Workshop ID pill in the hero row (${J(b)})`); continue; }
        const wrapped = b[i][2] > b[0][2] + 2, startsRow = wrapped && (i === 0 || b[i - 1][2] < b[i][2] - 2);
        seen.push({ w, wrapped, startsRow, n: b.length });
      }
      console.log(`        rows: ${seen.map((s) => `${s.w}:${s.startsRow ? "starts a row" : s.wrapped ? "wrapped" : "first row"}`).join(" ")}`);
      const rowStarts = seen.filter((s) => s.startsRow).map((s) => s.w);
      if (!rowStarts.length) v.push("at no width does the ID pill start a row of its own — proved nothing about the re-wrap");
      const test = [...new Set([...rowStarts.slice(0, 3), rowStarts.at(-1), seen.find((s) => !s.startsRow)?.w, 1920].filter(Boolean))];
      for (const w of test) {
        win.setContentSize(w, w >= 1920 ? 1080 : 900); await sleep(400);
        await mvTo(3, 3, 200);
        const before = await js(HERO), p0 = await pillAim();
        const name0 = await axName(PILL);
        if (!/^Workshop ID \d+ — copy$/.test(name0 ?? "")) v.push(`${w} px: the pill's name before is ${J(name0)}`);
        const fr = js(`new Promise((res) => { const out = []; const t0 = performance.now();
          const f = () => { out.push({ t: Math.round(performance.now() - t0), b: ${HERO}, on: !!document.querySelector("${PILL}.done"),
            y: (() => { const e = document.querySelector("${PILL} .xfade > :last-child"); return e ? +new DOMMatrix(getComputedStyle(e).transform).m42.toFixed(2) : null; })() });
            if (performance.now() - t0 < 700) requestAnimationFrame(f); else res(out); };
          requestAnimationFrame(f); })`);
        await sleep(30);
        await clickAt(p0.x, p0.y);
        if (w === test[0]) { await sleep(90); await shot("idpill-roll"); }
        const frames = await fr;
        if (!frames.some((f) => f.on)) { v.push(`${w} px: the pill never turned into "Copied" — proved nothing`); continue; }
        const name1 = await axName(PILL);
        if (!/^Workshop ID \d+ — copied$/.test(name1 ?? "") || /Copied/.test(name1 ?? "")) v.push(`${w} px: the pill's name while copied is ${J(name1)}`);
        let moved = null;
        for (const f of frames) for (const [k, x, y, ww, h] of f.b ?? []) {
          const o = before.find((q) => q[0] === k);
          if (!o || Math.max(Math.abs(o[1] - x), Math.abs(o[2] - y), Math.abs(o[3] - ww), Math.abs(o[4] - h)) > 0.75) { moved ??= { t: f.t, k, was: o, now: [x, y, ww, h] }; }
        }
        if (moved) v.push(`${w} px: a hero chip moved or resized when the pill turned into "Copied": ${J(moved)}`);
        const ys = frames.filter((f) => f.on && f.y != null).map((f) => f.y);
        if (between(ys, 0.5) < 2) v.push(`${w} px: "Copied" didn't roll in (its y per frame ${J(ys.slice(0, 10))})`);
        if (w === 1920) await shot("idpill-copied-full");
        // back to its ID after ≈ 1.2 s: the same boxes
        await waitFor(() => js(`!document.querySelector("${PILL}.done")`), 2500); await sleep(400);
        const after = await js(HERO);
        if (J(after) !== J(before)) v.push(`${w} px: the hero row after "Copied" differs: ${J(before)} → ${J(after)}`);
      }
      // motion off: the faces only cross-fade in place (in-between opacity, no transform), the pill's box still
      await setSettings({ morphs: false });
      win.setContentSize(test[0] ?? 1400, 900); await load(SIGNED_OUT);
      if (!(await openLib("s1"))) v.push("motion off: no sidebar for s1");
      await sleep(700); await mvTo(3, 3, 150);
      if (!(await js(`document.documentElement.classList.contains("no-motion")`))) v.push("motion off: the page isn't in no-motion — proved nothing");
      const p1 = await pillAim();
      if (p1) {
        const smp = js(MO.SAMPLE({ face: `${PILL} .xfade > :last-child`, pill: PILL }, 500)); await sleep(40);
        await clickAt(p1.x, p1.y);
        const s = await smp;
        console.log(`        motion off: "Copied" ${MO.brief(s.face)}`);
        v.push(...MO.judge("motion off: \"Copied\"", s.face.map((f) => (f[1] === 0 ? [f[0], null] : f)), { appear: true }), ...MO.judge("motion off: the pill", s.pill));
        await waitFor(() => js(`!document.querySelector("${PILL}.done")`), 2500);
      }
      await setSettings({ morphs: true });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await restoreLib();
      return v;
    });

    // "Delete from source" names the unsubscribe: the tile reads "Delete and unsubscribe" with a tooltip saying Steam is told too,
    // and the status bar after it says "Unsubscribing …"; with auto-import on, the Delete tile of a Workshop item (it also
    // unsubscribes: the import would bring it back) says so the same way, a non-Workshop item's stays a plain "Delete"
    await cell("side:deleteSource:names", async () => {
      const v = [];
      // (this cell runs before the shared menu helpers further down are defined: its own)
      const boxOf = (sel) => js(`(() => { const e = document.querySelector("${SIDE} ${sel}"); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const menuNow = () => js(`(() => { const m = document.querySelector("[data-ctx-menu]"); return m ? { items: [...m.querySelectorAll("[role=menuitem]")].map((b) => ({ key: b.dataset.ctxItem, text: b.textContent.trim() })) } : null; })()`);
      const itemAt = (key) => js(`(() => { const r = document.querySelector("[data-ctx-item=${key}]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      const acts = () => page(`return [...document.querySelectorAll("${SIDE} .side-cta .side-go, ${SIDE} .side-tiles > *")].map((t) => ({ text: t.textContent.trim(), title: t.getAttribute("title"),
        danger: t.classList.contains("danger"), name: t.getAttribute("aria-label") }));`);
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await js(`localStorage.setItem("__probe_lib_full", "1"); true`);
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) { await restoreLib(); return ["no sidebar for the scene s1 — proved nothing"]; }
      await sleep(600);
      let t = await acts(); console.log(`        auto-import off: ${J(t)}`);
      const del = t.find((x) => x.danger);
      if (!del || del.text !== "Delete" || !/unsubscribes on Steam/i.test(del.title ?? "")) v.push(`the Delete half: ${J(del)} (want "Delete", its tooltip naming the right-click's unsubscribe)`);
      if (t.some((x) => /from source/i.test(x.text + (x.title ?? "")))) v.push(`"Delete from source" is still there: ${J(t)}`);
      const db = await boxOf("[data-delete]");
      if (db) { await clickAt(db.x, db.y, "right"); await sleep(350); }
      const m = await menuNow();
      console.log(`        Delete's right-click: ${J(m?.items)}`);
      if (!m || J(m.items.map((x) => x.text)) !== J(["Delete and unsubscribe"])) v.push(`Delete's right-click menu: ${J(m)}`);
      await shot("delsource");
      const n0 = (await calls()).length;
      const pk = await itemAt("delete-source");
      if (pk) { await clickAt(pk.x, pk.y); await sleep(700); }
      const got = (await calls()).slice(n0);
      const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
      console.log(`        picked: ${J(got.map((c) => c.p))} | status "${status}"`);
      if (!got.some((c) => c.p === "/workshop/delete-from-source" && c.body?.items?.[0]?.workshopId === "900000001")) v.push(`the pick posted ${J(got)}`);
      if (!/^Unsubscribing from s1\. Undo brings it back\.$/.test(status)) v.push(`the status bar says "${status}"`);
      // auto-import on: a Workshop item Steam doesn't have subscribed (the library's own copy) deletes plainly — no unsubscribe
      // (a subscribed one's Delete is Unsubscribe: side:unsub:names); a plain item's stays "Delete"
      await setSettings({ autoAddWeWallpapersToLibrary: true });
      await js(`localStorage.setItem("__probe_lib_sub", ${J(J({ "900000001": false }))}); true`);
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) v.push("auto-import on: no sidebar for s1");
      else {
        await sleep(600); t = await acts(); console.log(`        auto-import on, s1 (its own copy): ${J(t)}`);
        const d = t.filter((x) => x.danger);
        if (d.length !== 1 || d[0].text !== "Delete" || d[0].title) v.push(`auto-import on, the library's own copy of a Workshop item: ${J(t)}`);
        await shot("delsource-autoimport");
      }
      await js(`localStorage.removeItem("__probe_lib_sub"); true`);
      const plain = await page(`return [...document.querySelectorAll(".card.lib:not([data-leaving]) [data-title]")].map((e) => e.dataset.title).find((x) => !/^s\\d$/.test(x)) ?? null;`);
      if (!plain) v.push("no non-Workshop library item — proved nothing about the plain Delete");
      else if (!(await openLib(plain))) v.push(`auto-import on: no sidebar for ${plain}`);
      else {
        await sleep(600); t = await acts(); console.log(`        auto-import on, ${plain}: ${J(t)}`);
        if (!t.some((x) => x.text === "Delete" && !x.title) || t.some((x) => /unsubscribe/i.test(x.text))) v.push(`auto-import on, a non-Workshop item: ${J(t)}`);
      }
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await restoreLib();
      return v;
    });

    // Browse's sidebar on a Workshop result the library holds: the Library's own Unsubscribe tile (components/ItemSide.tsx, one
    // sidebar on both tabs). A right-click opens "Unsubscribe without deleting" at the pointer (no request, the plain click
    // untouched); picking it → ONE POST /workshop/unsubscribe-keep; Escape and a click outside close it without one; the plain
    // click is the Library's Delete from source; an item not in the library has no menu. The menu grows in (per frame) and
    // shrinks out; no-glow and bg-live keep its fill. The library's k1 stands in as ws-1's copy (__probe_lib_ws)
    const MENU = "[data-ctx-menu]";
    const browseWs = async (status = SIGNED_IN) => {
      await load(status);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((s) => s.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
    };
    // ws-1 (930000) in the library as k1's copy, subscribed, auto-import on: its Browse sidebar has the Library's Unsubscribe
    const libCopy = async (status = SIGNED_IN) => {
      await setSettings({ autoAddWeWallpapersToLibrary: true });
      await js(`localStorage.setItem("__probe_lib_ws", ${J(J({ k1: "930000" }))}); localStorage.setItem("__probe_lib_sub", ${J(J({ "930000": true }))}); true`);
      await browseWs(status);
      await openSide(0);
      return waitFor(() => js(`!!document.querySelector("${SIDE} [data-unsubscribe]")`), 3000);
    };
    const libCopyDone = async () => {
      await js(`localStorage.removeItem("__probe_lib_ws"); localStorage.removeItem("__probe_lib_sub"); true`);
      await setSettings({ autoAddWeWallpapersToLibrary: false });
    };
    const btnBox = (sel = "[data-unsubscribe]") => js(`(() => { const e = document.querySelector("${SIDE} ${sel}"); if (!e) return null; e.scrollIntoView({ block: "center" });
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const menuState = () => page(`const m = document.querySelector(${J(MENU)}); if (!m) return null; const r = m.getBoundingClientRect(), cs = getComputedStyle(m);
      return { items: [...m.querySelectorAll("[role=menuitem]")].map((b) => b.textContent.trim()), focus: document.activeElement?.dataset?.ctxItem ?? null,
        x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, closing: m.classList.contains("closing"), bg: cs.backgroundColor, shadow: cs.boxShadow,
        role: m.getAttribute("role"), titles: m.querySelectorAll("[title]").length };`);
    await cell("steam:sub:keepMenu", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      try {
        if (!(await libCopy())) return [`no Unsubscribe tile on ws-1's Browse sidebar (its library copy) — proved nothing`];
        await sleep(400);
        const tip = await js(`document.querySelector("${SIDE} [data-unsubscribe]")?.getAttribute("title") ?? ""`);
        if (!/right-click keeps it/.test(tip)) v.push(`the tile doesn't tell about the menu: "${tip}"`);
        const title0 = await js(`document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null`);
        let b = await btnBox(); await sleep(250); b = await btnBox();
        // a real right-click: the menu grows in at the pointer (per frame: its width passes through in-between values)
        let n0 = (await calls()).length;
        const grow = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { out.push(document.querySelector(${J(MENU)})?.getBoundingClientRect().width ?? null);
          if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
        await sleep(20);
        await clickAt(b.x, b.y, "right");
        await sleep(70); await shot("keepmenu-opening");
        const ws = await grow;
        let m = await menuState();
        console.log(`        menu: ${J(m)} | widths ${J(ws.filter((x) => x != null).slice(0, 8).map((x) => +x.toFixed(1)))}`);
        if (!m) return [...v, "no menu after a right-click on Unsubscribe"];
        if (J(m.items) !== J(["Unsubscribe without deleting"])) v.push(`menu items ${J(m.items)}`);
        if (m.role !== "menu" || m.titles) v.push(`role ${m.role}, ${m.titles} tooltip(s)`);
        if (m.focus !== "keep") v.push(`the first entry isn't focused (${m.focus})`);
        if (Math.min(Math.abs(m.x - b.x), Math.abs(m.r - b.x)) > 2 || Math.min(Math.abs(m.y - b.y), Math.abs(m.b - b.y)) > 2) v.push(`the menu isn't at the pointer (${J({ b, m })})`);
        if (m.x < 0 || m.y < 0 || m.r > 1400 || m.b > 900) v.push(`the menu leaves the window ${J(m)}`);
        if (between(ws, 1) < 2) v.push(`the menu didn't grow in (widths ${J(ws.slice(0, 10))})`);
        if ((await calls()).slice(n0).some((c) => c.p !== "/workshop/state")) v.push(`the right-click sent ${J((await calls()).slice(n0))}`);
        if (/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`the menu has no fill (${m.bg})`);
        await sleep(250); await shot("keepmenu");
        if ((await js(`document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null`)) !== title0) v.push("the right-click changed the sidebar");
        // Escape closes it, no request; focus back on the tile
        await key("Escape"); await sleep(300);
        if (await menuState()) v.push("Escape didn't close the menu");
        if (!(await js(`document.activeElement?.dataset?.unsubscribe !== undefined`))) v.push("after Escape the focus isn't back on Unsubscribe");
        if (!(await js(`!!document.querySelector("${SIDE}")`))) v.push("Escape in the menu closed the sidebar too");
        // a click outside closes it, no request
        n0 = (await calls()).length;
        await clickAt(b.x, b.y, "right"); await sleep(300);
        await clickAt(40, 450); await sleep(300);
        if (await menuState()) v.push("a click outside didn't close the menu");
        if ((await calls()).slice(n0).some((c) => c.p !== "/workshop/state")) v.push(`closing sent ${J((await calls()).slice(n0))}`);
        // pick it: ONE POST /workshop/unsubscribe-keep; the menu shrinks out; the status says kept
        await openSide(0); await sleep(300); b = await btnBox();
        await clickAt(b.x, b.y, "right"); await sleep(300);
        const it = await js(`(() => { const r = document.querySelector("[data-ctx-item=keep]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
        if (!it) return [...v, "no menu entry to pick"];
        const shrink = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(${J(MENU)}); out.push(e ? +getComputedStyle(e).opacity : null);
          if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
        await sleep(20);
        n0 = (await calls()).length;
        await clickAt(it.x, it.y); await sleep(500);
        const ops = await shrink;
        const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/state" && c.p !== "/workshop/drain");
        if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe-keep" || got[0].body?.workshopId !== "930000") v.push(`picking it posted ${J(got)}`);
        if (between(ops, 0.05) < 1 || ops.at(-1) != null) v.push(`the menu didn't fade / shrink out (opacity per frame ${J(ops.slice(0, 12))})`);
        const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
        if (!/^Unsubscribing from \S+\. It stays in your library\.$/.test(status)) v.push(`the status bar says "${status}"`);
        // the plain left-click: the Library's Delete from source
        await libCopy(); await sleep(400);
        b = await btnBox(); n0 = (await calls()).length;
        await clickAt(b.x, b.y); await sleep(600);
        const plain = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/state" && c.p !== "/workshop/drain");
        if (plain.length !== 1 || plain[0].p !== "/workshop/delete-from-source") v.push(`a left-click posted ${J(plain)}`);
        // not in the library (ws-2, subscribed in Steam): its Unsubscribe has nothing to keep, no menu
        await setWs("930001", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
        await openSide(1);
        await waitFor(() => js(`!!document.querySelector("${SIDE} [data-unsubscribe-steam]")`), 3000);
        b = await btnBox("[data-unsubscribe-steam]");
        if (!b) v.push("ws-2 (subscribed, not in the library): no Unsubscribe — proved nothing");
        else { await clickAt(b.x, b.y, "right"); await sleep(300); if (await menuState()) v.push("a menu on an item that isn't in the library"); }
        // no-glow + bg-live: the menu keeps its own fill and loses its glow
        await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
        await libCopy(); await sleep(400);
        b = await btnBox(); await clickAt(b.x, b.y, "right"); await sleep(350);
        m = await menuState();
        const html = await js(`document.documentElement.className`);
        console.log(`        no-glow + bg-live: ${J({ html, bg: m?.bg, shadow: m?.shadow })}`);
        if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
        if (!m || /rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`bg-live: the menu has no fill of its own (${m?.bg})`);
        if (m && (m.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((c) => !/rgba\(0, 0, 0/.test(c))) v.push(`no-glow: the menu still glows (${m.shadow})`);
        await shot("keepmenu-live");
        await key("Escape"); await sleep(250);
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false }); await libCopyDone(); }
      return v;
    });
    // motion off (Smooth window animations off): the menu fades in and out in place, nothing moves
    await cell("steam:sub:keepMenuOff", async () => {
      const v = [];
      await setSettings({ morphs: false });
      try {
        if (!(await libCopy())) return ["no Unsubscribe tile on ws-1's Browse sidebar — proved nothing"];
        await sleep(400);
        let b = await btnBox(); await sleep(250); b = await btnBox();
        await mvTo(b.x, b.y, 300);
        let smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
        await clickAt(b.x, b.y, "right");
        const sIn = await smp;
        smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
        await key("Escape");
        const sOut = await smp;
        console.log(`        motion off: in ${MO.brief(sIn.menu)} / out ${MO.brief(sOut.menu)}`);
        v.push(...MO.judge("motion off: the menu appearing", sIn.menu, { appear: true }), ...MO.judge("motion off: the menu leaving", sOut.menu, { leave: true }));
      } finally { await setSettings({ morphs: true }); await libCopyDone(); }
      return v;
    });
    // ---- "Download without subscribing": the Browse sidebar's download / subscribe buttons' right-click menu
    // (components/ItemSide.tsx, menuItems.tsx oneOffMenuItem). /download is held by the stub; /workshop/one-off answers
    // window.__oneOff
    const getBox = (k) => js(`(() => { const r = document.querySelector("${SIDE} [data-side-get=${k}]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    const ctxItems = () => page(`const m = document.querySelector(${J(MENU)}); if (!m) return null;
      return { items: [...m.querySelectorAll("[role=menuitem]")].map((b) => ({ key: b.dataset.ctxItem, text: b.textContent.trim(), off: b.getAttribute("aria-disabled") === "true",
        color: getComputedStyle(b).color })), note: m.querySelector("[data-ctx-note]")?.textContent ?? null, described: m.getAttribute("aria-describedby"),
        focus: document.activeElement?.dataset?.ctxItem ?? null, label: m.getAttribute("aria-label"), titles: m.querySelectorAll("[title]").length,
        bg: getComputedStyle(m).backgroundColor, shadow: getComputedStyle(m).boxShadow, closing: m.classList.contains("closing") };`);
    const pickAt = (key) => js(`(() => { const r = document.querySelector("[data-ctx-item=${key}]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    const heldDl = () => js(`window.__st.dl ? { body: window.__st.dl.body, aborted: window.__st.dl.aborted } : null`);
    const cancelDl = async () => { await page(`document.querySelector("${SIDE} [data-side-download] button")?.click();`); await sleep(400); };
    // a button's menu: its own one-off variant only (menuItems.tsx oneOffMenuItem), "Download then unsubscribe" under
    // "Subscribe with Steam login" (the copy comes through a subscription the download takes back)
    const oneOffFor = (btn, mode) => { const base = mode === "subscribe" ? "Download then unsubscribe" : "Download without subscribing";
      return btn === "apply" ? [["oneoff-apply", `${base} & apply`]] : [["oneoff", base]]; };
    await cell("side:oneOff:menu", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, workshopDownloadMode: "subscribe" });
      await browseWs();
      await openSide(0);
      for (const [btn, apply] of [["only", false], ["apply", true]]) {
        const b = await getBox(btn);
        if (!b) return [...v, `no [data-side-get=${btn}] button in the Browse sidebar`];
        const asks0 = (await js(`window.__st.oneOffAsks?.length ?? 0`));
        await mvTo(b.x, b.y, 250);
        if ((await js(`window.__st.oneOffAsks?.length ?? 0`)) === asks0 && btn === "only") v.push("the route wasn't asked as the pointer reached the button");
        await js(`window.__st.dl = null; true`);
        const grow = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { out.push(document.querySelector(${J(MENU)})?.getBoundingClientRect().width ?? null);
          if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
        await sleep(20);
        await clickAt(b.x, b.y, "right");
        if (btn === "only") { await sleep(70); await shot("oneoff-opening"); }
        const ws = await grow;
        const m = await ctxItems();
        console.log(`        ${btn}: ${J(m)}`);
        if (!m) { v.push(`no menu after a right-click on [data-side-get=${btn}]`); continue; }
        if (J(m.items.map((x) => [x.key, x.text])) !== J(oneOffFor(btn, "subscribe"))) v.push(`${btn}: menu items ${J(m.items.map((x) => [x.key, x.text]))} (want only ${J(oneOffFor(btn, "subscribe"))})`);
        if (m.items.some((x) => x.off) || m.note) v.push(`${btn}: with a route, an entry is disabled or a note shows (${J(m)})`);
        if (m.focus !== oneOffFor(btn, "subscribe")[0][0]) v.push(`${btn}: its entry isn't focused (${m.focus})`);
        if (m.titles) v.push(`${btn}: ${m.titles} tooltip(s) in the menu`);
        if (between(ws, 1) < 2) v.push(`${btn}: the menu didn't grow in (widths ${J(ws.slice(0, 10))})`);
        if (await heldDl()) v.push(`${btn}: the right-click itself posted /download`);
        if (btn === "only") { await sleep(250); await shot("oneoff"); }
        // pick the entry that matches the button: ONE /download {oneOff: true, apply}; the menu fades out over the download
        const key = apply ? "oneoff-apply" : "oneoff";
        const it = await pickAt(key);
        const fade = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(${J(MENU)}); out.push(e ? +getComputedStyle(e).opacity : null);
          if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
        await sleep(20);
        await clickAt(it.x, it.y);
        const ops = await fade;
        const dl = await waitFor(heldDl, 2000);
        if (!dl || dl.body.oneOff !== true || dl.body.apply !== apply || dl.body.result?.workshopId !== "930000") v.push(`${btn}: picking "${key}" posted ${J(dl?.body ?? null)}`);
        if (between(ops, 0.05) < 1 || ops.at(-1) != null) v.push(`${btn}: the menu didn't fade out (opacity per frame ${J(ops.slice(0, 12))})`);
        if (!(await js(`!!document.querySelector("${SIDE} [data-side-download]")`))) v.push(`${btn}: the sidebar doesn't show the download`);
        await cancelDl();
      }
      // the left-click is still the plain download / subscription
      await js(`window.__st.dl = null; true`);
      await page(`document.querySelector("${SIDE} [data-side-get=only]")?.click();`);
      const plain = await waitFor(heldDl, 2000);
      if (!plain || plain.body.oneOff !== false || plain.body.apply !== false) v.push(`a left-click on Download posted ${J(plain?.body ?? null)}`);
      await cancelDl();
      // merged (auto-import on + "subscribe"): "Subscribe" has the same menu
      await setSettings({ autoAddWeWallpapersToLibrary: true });
      await browseWs(); await openSide(0);
      let b = await getBox("only");
      const label = await js(`document.querySelector("${SIDE} [data-side-get=only]")?.textContent.trim() ?? null`);
      await clickAt(b.x, b.y, "right"); await sleep(350);
      let m = await ctxItems();
      if (label !== "Subscribe" || !m || J(m.items.map((x) => [x.key, x.text])) !== J(oneOffFor("only", "subscribe"))) v.push(`merged: "${label}" right-click menu ${J(m)}`);
      await key("Escape"); await sleep(300);
      if (!(await js(`document.activeElement?.dataset?.sideGet === "only"`))) v.push("after Escape the focus isn't back on the button");
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      // no-glow + bg-live: the menu keeps its own fill and loses its glow
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await browseWs(); await openSide(0);
      b = await getBox("only"); await mvTo(b.x, b.y, 200); await clickAt(b.x, b.y, "right"); await sleep(350);
      m = await ctxItems();
      const html = await js(`document.documentElement.className`);
      console.log(`        no-glow + bg-live: ${J({ html, bg: m?.bg, shadow: m?.shadow })}`);
      if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
      if (!m || /rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`bg-live: the menu has no fill of its own (${m?.bg})`);
      if (m && (m.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((c) => !/rgba\(0, 0, 0/.test(c))) v.push(`no-glow: the menu still glows (${m.shadow})`);
      await shot("oneoff-live");
      await key("Escape"); await sleep(250);
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      // a WE-local item (on disk already: its Download imports it) has no menu
      await js(`localStorage.setItem("__probe_we_local", "1"); true`);
      await load(SIGNED_OUT);
      const local = (await http("GET", "/sources")).json.find((x) => /Local/i.test(x.name) && !x.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(local)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0;`), 4000);
      await openSide(0);
      b = await getBox("only");
      if (!b) v.push("a WE-local item's sidebar has no Download — proved nothing");
      else { await clickAt(b.x, b.y, "right"); await sleep(350); if (await ctxItems()) { v.push("a WE-local item's Download has the menu"); await key("Escape"); } }
      await js(`localStorage.removeItem("__probe_we_local"); true`);
      return v;
    });
    await cell("side:oneOff:missing", async () => {
      const v = [];
      const MISSING = "Couldn't check how to download it here. Try again.";
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
      await browseWs();
      await js(`window.__oneOff = { route: null, missing: ${J(MISSING)} }; true`);
      await openSide(0);
      const b = await getBox("only");
      await mvTo(b.x, b.y, 200);
      await clickAt(b.x, b.y, "right"); await sleep(350);
      const m = await ctxItems();
      console.log(`        ${J(m)}`);
      if (!m) return ["no menu without a route (it should say what's missing)"];
      if (J(m.items.map((x) => [x.key, x.text])) !== J(oneOffFor("only", "subscribe")) || m.items.some((x) => !x.off)) v.push(`entries ${J(m.items)} (want Download's own, disabled)`);
      if (m.note !== MISSING) v.push(`the note says "${m.note}"`);
      if (!m.described) v.push("the menu isn't described by its note");
      const textColor = await js(`getComputedStyle(document.querySelector(".side-title, h2") ?? document.body).color`);
      if (m.items.some((x) => x.color === textColor)) v.push(`a disabled entry has the text colour (${m.items.map((x) => x.color)})`);
      if (m.focus !== "oneoff") v.push(`the first entry isn't focused (${m.focus}): the keys must reach a disabled menu`);
      await shot("oneoff-missing");
      await js(`window.__st.dl = null; true`);
      const it = await pickAt("oneoff");
      await clickAt(it.x, it.y); await sleep(400);
      if (await heldDl()) v.push("a click on a disabled entry posted /download");
      if (!(await ctxItems()) || (await ctxItems()).closing) v.push("a click on a disabled entry closed the menu");
      await key("Escape"); await sleep(300);
      if (await ctxItems()) v.push("Escape didn't close the menu");
      await js(`window.__oneOff = null; true`);
      return v;
    });
    await cell("side:oneOff:menuOff", async () => {
      const v = [];
      await setSettings({ morphs: false, autoAddWeWallpapersToLibrary: false });
      await browseWs(); await openSide(0);
      const b = await getBox("only");
      if (!b) { await setSettings({ morphs: true }); return ["no Download button"]; }
      await mvTo(b.x, b.y, 300);
      let smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      await clickAt(b.x, b.y, "right");
      const sIn = await smp;
      smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      await key("Escape");
      const sOut = await smp;
      console.log(`        motion off: in ${MO.brief(sIn.menu)} / out ${MO.brief(sOut.menu)}`);
      v.push(...MO.judge("motion off: the menu appearing", sIn.menu, { appear: true }), ...MO.judge("motion off: the menu leaving", sOut.menu, { leave: true }));
      await setSettings({ morphs: true });
      return v;
    });
    await cell("side:oneOff:modes", async () => {
      const v = [];
      const SIGN_IN = "Sign in to Steam to download without subscribing";
      await js(`localStorage.setItem("__probe_oneoff_real", "1"); true`);
      const menuFor = async (shotName, btn = "only") => {
        const b = await getBox(btn);
        if (!b) return null;
        await mvTo(b.x, b.y, 150); await sleep(150);
        await clickAt(b.x, b.y, "right");
        const m = await waitFor(async () => { const x = await ctxItems(); return x && !x.closing ? x : null; }, 2000);
        if (shotName) { await sleep(250); await shot(shotName); }
        await key("Escape"); await sleep(300);
        return m;
      };
      const judge = (label, m, want, mode, btn = "only") => {
        console.log(`        ${label} (${btn}): ${J(m && { items: m.items.map((x) => x.text), off: m.items.map((x) => x.off), note: m.note })}`);
        if (!m) return v.push(`${label}: no menu`);
        if (J(m.items.map((x) => [x.key, x.text])) !== J(oneOffFor(btn, mode))) v.push(`${label} (${btn}): entries ${J(m.items.map((x) => [x.key, x.text]))}, want ${J(oneOffFor(btn, mode))}`);
        if (want === null) { if (m.items.some((x) => x.off) || m.note) v.push(`${label}: want both entries on and no note, got ${J(m)}`); }
        else if (!m.items.every((x) => x.off) || !want.test(m.note ?? "")) v.push(`${label}: want both entries disabled with a note matching ${want}, got ${J({ off: m.items.map((x) => x.off), note: m.note })}`);
      };
      const cases = [
        ["Use the Steam app", { workshopDownloadMode: "steamapp" }, null],
        ["Subscribe with Steam login, signed out", { workshopDownloadMode: "subscribe" }, new RegExp(`^${SIGN_IN}$`)],
        // a saved "steampage" (the dropped page mode) reads as the default: the Steam client's route, from the stack's backend
        ["a saved \"steampage\" (reads as Use the Steam app)", { workshopDownloadMode: "steampage" }, null],
      ];
      try {
        await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
        for (const [label, patch, want] of cases) {
          await setSettings(patch);
          await browseWs(SIGNED_OUT); await openSide(0);
          judge(label, await menuFor(label === "Subscribe with Steam login, signed out" ? "oneoff-signin" : null), want, patch.workshopDownloadMode);
          judge(label, await menuFor(null, "apply"), want, patch.workshopDownloadMode, "apply");
        }
        // live, no reload: the mode changes (another window's save → WS settings-changed) → the next right-click asks again
        await setSettings({ workshopDownloadMode: "steamapp" });
        await browseWs(SIGNED_OUT); await openSide(0);
        judge("live: Use the Steam app", await menuFor(), null, "steamapp");
        const asks0 = await js(`window.__st.oneOffAsks?.length ?? 0`);
        await setSettings({ workshopDownloadMode: "subscribe" });
        await ev("settings-changed", { workshopDownloadMode: "subscribe" }); await sleep(200);
        judge("live: then Subscribe with Steam login (signed out), within the route's 5 s", await menuFor(), new RegExp(`^${SIGN_IN}$`), "subscribe");
        if ((await js(`window.__st.oneOffAsks?.length ?? 0`)) === asks0) v.push("live: the mode change didn't ask the route again");
      } finally {
        await js(`localStorage.removeItem("__probe_oneoff_real"); true`);
        await setSettings({ workshopDownloadMode: "subscribe" });
      }
      return v;
    });
    // ---- one rule for every Workshop action (components/subscribeMode.ts actionBlocked, the backend's WorkshopDownloader.Blocked)
    const sideGet = () => page(`const b = [...document.querySelectorAll("${SIDE} [data-side-get]")]; const w = document.querySelector("${SIDE} [data-side-get-why]");
      return { off: b.map((x) => x.getAttribute("aria-disabled") === "true"), why: w?.textContent ?? null, whyFilter: w ? getComputedStyle(w).filter : null,
        shadow: b.map((x) => getComputedStyle(x).boxShadow), tf: b.map((x) => getComputedStyle(x).transform) };`);
    const cardBtn = () => page(`const b = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .dl-btn"); return b ? { off: b.getAttribute("aria-disabled") === "true", title: b.getAttribute("title") } : null;`);
    const statusText = () => js(`document.querySelector(".status")?.textContent ?? ""`);
    // no mode blocks a download: every one ends on the item's Steam page (docs/decisions.md § "Offer two Workshop download
    // modes, the Steam page the last resort"), so signed out under "Subscribe with Steam login" every Subscribe stays on, with no
    // line under them (a reason would be the disabled button's tooltip: none here)
    const noLine = () => js(`!document.querySelector("${SIDE} [data-side-get-hint], ${SIDE} [data-side-get-why], ${SIDE} .side-cta-note")`);
    await cell("side:blocked:download", async () => {
      const v = [];
      try {
        await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs(SIGNED_OUT); await openSide(0);
        let g = await sideGet(); console.log(`        signed out: ${J(g)} | no line ${await noLine()}`);
        if (J(g.off) !== J([false, false]) || g.why) v.push(`signed out, the sidebar's buttons: ${J(g)} (want both on, no "Sign in" line)`);
        if (!(await noLine())) v.push("signed out: a line under the buttons");
        await shot("blocked");
        await js(`window.__st.dl = null; true`);
        await page(`document.querySelector("${SIDE} [data-side-get=only]")?.click();`); await sleep(400);
        if (!(await heldDl())) v.push("signed out, a click on Subscribe posted no /download");
        // the card's button: on
        await browseWs(SIGNED_OUT); await sleep(300);
        const cb = await cardBtn();
        if (!cb || cb.off) v.push(`the card's download button: ${J(cb)} (want on)`);
        // the selection toolbar's Download N: on
        await page(`for (const i of [2, 3]) document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap")[i]?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));`); await sleep(400);
        const tb = await page(`const b = document.querySelector(".sel-toolbar .btn.accent"); return b ? { off: b.getAttribute("aria-disabled"), title: b.getAttribute("title"), text: b.textContent } : null;`);
        if (!tb || tb.off === "true" || /Sign in/.test(tb.title ?? "")) v.push(`the selection toolbar: ${J(tb)} (want on)`);
        await key("Escape"); await sleep(200);
        // merged: the same
        await setSettings({ autoAddWeWallpapersToLibrary: true });
        await browseWs(SIGNED_OUT); await openSide(0);
        g = await sideGet();
        if (J(g.off) !== J([false, false]) || g.why || !(await noLine())) v.push(`merged, signed out: ${J(g)}`);
        await setSettings({ autoAddWeWallpapersToLibrary: false });
        // "Use the Steam app" keeps them
        await setSettings({ workshopDownloadMode: "steamapp" });
        await browseWs(SIGNED_OUT); await openSide(0);
        g = await sideGet(); const c2 = await cardBtn();
        if (J(g.off) !== J([false, false]) || g.why || c2?.off) v.push(`steamapp, signed out: ${J(g)}, card ${J(c2)}`);
        // live: a sign-out under an open sidebar (WS steam-status) changes nothing: the buttons on, still no line
        await setSettings({ workshopDownloadMode: "subscribe" });
        await browseWs(SIGNED_IN); await openSide(0); await sleep(300);
        await ev("steam-status", SIGNED_OUT); await sleep(500);
        g = await sideGet();
        if (J(g.off) !== J([false, false]) || g.why || !(await noLine())) v.push(`after WS steam-status (signed out) the buttons: ${J(g)}, no line ${await noLine()}`);
        // no-glow + bg-live: the buttons don't glow
        await setSettings({ morphs: true, glows: false, liveWallpaperBehindAllTabs: true });
        await browseWs(SIGNED_OUT); await openSide(0); await sleep(300);
        g = await sideGet();
        const html = await js(`document.documentElement.className`);
        if (!/no-glow/.test(html) || !/bg-live/.test(html) || g.shadow.some((x) => /rgba?\((?!0, 0, 0)/.test(x))) v.push(`no-glow + bg-live: ${J(g)} (${html})`);
        await shot("blocked-live-bg");
      } finally {
        await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      }
      return v;
    });
    await cell("side:blocked:subscribe", async () => {
      const v = [];
      const tileOff = () => js(`(() => { const b = document.querySelector("${SIDE} [data-side-subscribe]"); return b ? b.getAttribute("aria-disabled") : "none"; })()`);
      try {
        await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        // s2 is the library's own copy of a Workshop item the Workshop still has (the empty CM fixture says none has)
        await js(`localStorage.setItem("__probe_lib_sub", ${J(J({ "900000002": false }))}); localStorage.setItem("__probe_lib_off", "[]"); true`);
        for (const [mode, status] of [["subscribe", SIGNED_OUT], ["steamapp", SIGNED_OUT], ["subscribe", SIGNED_IN]]) {
          await setSettings({ workshopDownloadMode: mode });
          await load(status);
          const label = `${mode} (${status.signedIn ? "signed in" : "signed out"})`;
          if (!(await openLib("s2"))) { v.push(`${label}: no sidebar for s2`); continue; }
          await sleep(600);
          const off = await tileOff();
          const n0 = (await calls()).length;
          await page(`document.querySelector("${SIDE} [data-side-subscribe]")?.click();`); await sleep(400);
          const sent = (await calls()).slice(n0).filter((c) => c.p === "/workshop/subscribe");
          console.log(`        ${label}: aria-disabled ${off}, posted ${sent.length}`);
          if (off !== null || sent.length !== 1) v.push(`${label}: the Subscribe tile aria-disabled ${off}, posted ${sent.length}`);
          if (mode === "subscribe" && !status.signedIn) await shot("blocked-subscribe");
        }
      } finally { await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false }); await js(`localStorage.removeItem("__probe_lib_sub"); localStorage.removeItem("__probe_lib_off"); true`); }
      return v;
    });
    // side:getHint — no line under the item sidebar's Subscribe buttons in any mode, sign-in or auto-import (the buttons say what
    // they do; a reason goes in the disabled control's tooltip or its menu), and no second Subscribe (a subscription card) beside
    // them; a live mode change adds none
    await cell("side:getHint", async () => {
      const v = [];
      const NOT = { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      try {
        for (const [mode, auto, status] of [["subscribe", false, SIGNED_IN], ["steamapp", false, SIGNED_OUT], ["subscribe", false, SIGNED_OUT],
          ["steamapp", true, SIGNED_OUT], ["subscribe", true, SIGNED_IN]]) {
          await setSettings({ workshopDownloadMode: mode, autoAddWeWallpapersToLibrary: auto, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
          await browseWs(status); await setWs("930000", NOT); await openSide(0);
          await sleep(400);
          const x = await sub();
          const label = `${mode}${auto ? " + auto-import" : ""}${status.signedIn ? "" : ", signed out"}`;
          console.log(`        ${label}: ${J({ cta: x?.cta, card: x?.card, noLine: await noLine() })}`);
          if (!(await noLine())) v.push(`${label}: a line under the buttons`);
          if (J(x?.cta) !== J(["Subscribe and apply", "Subscribe"]) || x?.card || x?.tile) v.push(`${label}: the actions ${J(x)} (want the two Subscribe buttons alone)`);
          if (mode === "subscribe" && status.signedIn && !auto) await shot("gethint");
        }
        await setSettings({ workshopDownloadMode: "steamapp", autoAddWeWallpapersToLibrary: false });
        await browseWs(SIGNED_OUT); await openSide(0); await sleep(300);
        await setSettings({ workshopDownloadMode: "subscribe" }); await ev("settings-changed", { workshopDownloadMode: "subscribe" }); await sleep(500);
        if (!(await noLine())) v.push("a live mode change put a line under the buttons");
      } finally {
        await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      }
      return v;
    });
    // side:aboutTall — the Browse sidebar's About shows a long description tall (most read whole, ≥ 300 px in a 900 px window),
    // never past 45 % of the window, scrolling inside past that. Shot steam-about-tall.png
    await cell("side:aboutTall", async () => {
      const v = [];
      const DESC = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long Workshop description.`).join("\n");
      await js(`localStorage.setItem("__probe_long_desc", ${J(DESC)}); true`);
      try {
        await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        for (const [w, hgt] of [[1400, 900], [1400, 560]]) {
          win.setContentSize(w, hgt); await sleep(300);
          await browseWs(); await openSide(0);
          const r = await js(`(() => { const d = document.querySelector("${SIDE} .side-sec .desc"); if (!d) return null;
            return { h: d.clientHeight, sh: d.scrollHeight, vh: innerHeight, ov: getComputedStyle(d).overflowY }; })()`);
          console.log(`        ${w}x${hgt}: ${J(r)}`);
          if (!r) { v.push(`${w}x${hgt}: no About text`); continue; }
          if (r.sh <= r.h) { v.push(`${w}x${hgt}: the description fits whole — proved nothing`); continue; }
          if (r.h > r.vh * 0.45 + 1) v.push(`${w}x${hgt}: the About text is ${r.h} px, past 45 % of the window (${r.vh})`);
          if (hgt === 900 && r.h < 300) v.push(`${w}x${hgt}: the About text is only ${r.h} px tall`);
          if (r.ov !== "auto") v.push(`${w}x${hgt}: the About text doesn't scroll inside (overflow ${r.ov})`);
          if (hgt === 900) { await js(`document.querySelector("${SIDE} .side-sec .desc").scrollIntoView({ block: "center" }); true`); await sleep(200); await shot("about-tall"); }
        }
      } finally { await js(`localStorage.removeItem("__probe_long_desc"); true`); win.setContentSize(1400, 900); await sleep(200); }
      return v;
    });
    // ---- auto-import on: a subscribed Workshop item's Delete is Unsubscribe (views/Library.tsx doTrash) — the sidebar's tile
    // (the Browse Unsubscribe's icon and right-click "Unsubscribe without deleting"), the card's button, the Delete key; a
    // mixed selection unsubscribes the Workshop part and deletes the rest. /library's `subscribed` comes from __probe_lib_sub.
    // Shots steam-unsub*.png
    const libSub = (m) => js(`localStorage.setItem("__probe_lib_sub", ${J(J(m))}); true`);
    const dangerTiles = () => page(`return [...document.querySelectorAll("${SIDE} .side-cta .danger")].map((t) => ({ text: t.textContent.trim(),
      title: t.getAttribute("title"), unsub: t.dataset.unsubscribe !== undefined, icon: t.querySelector("svg.lucide")?.getAttribute("class") ?? "" }));`);
    const cardDel = (t) => page(`const c = [...document.querySelectorAll(".card.lib:not([data-leaving])")].find((x) => x.querySelector('[data-title="${t}"]')); return c?.querySelector(".del")?.getAttribute("aria-label") ?? null;`);
    const cardBox = (t) => page(`const c = [...document.querySelectorAll(".card.lib:not([data-leaving])")].find((x) => x.querySelector('[data-title="${t}"]')); if (!c) return null;
      c.scrollIntoView({ block: "center" }); const r = c.querySelector(".thumb-wrap").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 };`);
    const plainTitle = () => page(`return [...document.querySelectorAll(".card.lib:not([data-leaving]) [data-title]")].map((e) => e.dataset.title).find((x) => !/^s\\d$/.test(x)) ?? null;`);
    const unsubBox = (sel = "[data-unsubscribe]") => js(`(() => { const e = document.querySelector("${SIDE} ${sel}"); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const unsubDone = async () => { await libSub({}); await js(`localStorage.removeItem("__probe_lib_sub"); true`); await setSettings({ autoAddWeWallpapersToLibrary: false }); };

    await cell("side:unsub:names", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await libSub({ "900000001": true, "900000002": false });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) { await unsubDone(); return ["no sidebar for s1 — proved nothing"]; }
      await sleep(600);
      let d = await dangerTiles(); console.log(`        s1 (subscribed): ${J(d)}`);
      if (d.length !== 1 || d[0].text !== "Unsubscribe" || !d[0].unsub || !/lucide-cloud-off/.test(d[0].icon)) v.push(`a subscribed Workshop item's tiles: ${J(d)}`);
      if (d[0] && !(/right-click keeps it/.test(d[0].title ?? "") && /Undo subscribes again/.test(d[0].title ?? ""))) v.push(`its tooltip doesn't name the right-click or Undo: ${J(d[0].title)}`);
      if (await js(`[...document.querySelectorAll("${SIDE} .side-cta .side-go, ${SIDE} .side-tiles > *")].some((t) => /^Delete/.test(t.textContent.trim()))`)) v.push("a Delete is still offered for a subscribed Workshop item");
      await page(`document.querySelector("${SIDE} [data-unsubscribe]")?.scrollIntoView({ block: "center" });`); await sleep(300);
      await shot("unsub-tile");
      const plain = await plainTitle();
      const labels = { s1: await cardDel("s1"), s2: await cardDel("s2"), [plain]: await cardDel(plain) };
      console.log(`        card buttons: ${J(labels)}`);
      if (labels.s1 !== "Unsubscribe" || labels.s2 !== "Delete" || labels[plain] !== "Delete") v.push(`the cards' buttons: ${J(labels)}`);
      // the library's own copy (no longer subscribed): a plain Delete
      if (!(await openLib("s2"))) v.push("no sidebar for s2");
      else {
        await sleep(500); d = await dangerTiles(); console.log(`        s2 (its own copy): ${J(d)}`);
        if (d.length !== 1 || d[0].text !== "Delete" || d[0].unsub || d[0].title) v.push(`the library's own copy: ${J(d)}`);
      }
      // the Unsubscribe tile's click: Delete from source for s1 alone (undoable), no plain trash
      if (!(await openLib("s1"))) v.push("no sidebar for s1 (second time)");
      await sleep(500);
      let n0 = (await calls()).length;
      await page(`document.querySelector("${SIDE} [data-unsubscribe]")?.click();`); await sleep(700);
      if ((await calls()).slice(n0).some((c) => c.p === "/workshop/drain")) v.push("the UI started the drain at once (the backend waits out the Undo window)");
      let got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain");
      const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
      console.log(`        Unsubscribe: ${J(got.map((c) => [c.p, c.body?.items?.map((i) => i.title)]))} | "${status}"`);
      if (got.length !== 1 || got[0].p !== "/workshop/delete-from-source" || J(got[0].body?.items?.map((i) => i.title)) !== J(["s1"])) v.push(`Unsubscribe posted ${J(got)}`);
      if (!/^Unsubscribing from s1\. Undo brings it back\.$/.test(status)) v.push(`the status bar says "${status}"`);
      // the card's button the same
      n0 = (await calls()).length;
      await page(`[...document.querySelectorAll(".card.lib:not([data-leaving])")].find((x) => x.querySelector('[data-title="s1"]'))?.querySelector(".del")?.click();`); await sleep(600);
      got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain");
      if (got.length !== 1 || got[0].p !== "/workshop/delete-from-source" || J(got[0].body?.items?.map((i) => i.title)) !== J(["s1"])) v.push(`the card's Unsubscribe posted ${J(got)}`);
      // auto-import off: Delete, "Delete and unsubscribe" its right-click entry; the card's plain Delete
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) v.push("auto-import off: no sidebar for s1");
      else {
        await sleep(500); d = await dangerTiles(); console.log(`        auto-import off, s1: ${J(d)}`);
        if (J(d.map((x) => x.text)) !== J(["Delete"]) || d.some((x) => x.unsub)) v.push(`auto-import off: ${J(d)}`);
        const db = await unsubBox("[data-delete]");
        if (db) { await clickAt(db.x, db.y, "right"); await sleep(350); }
        const dm = await ctxItems();
        if (!dm || J(dm.items.map((x) => [x.key, x.text])) !== J([["delete-source", "Delete and unsubscribe"]])) v.push(`auto-import off, Delete's right-click: ${J(dm?.items)}`);
        await key("Escape"); await sleep(250);
        if ((await cardDel("s1")) !== "Delete") v.push(`auto-import off: the card's button is "${await cardDel("s1")}"`);
      }
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await unsubDone();
      return v;
    });

    // a mixed selection: the sidebar's tile says what happens to each part; the Delete key unsubscribes s1 and deletes the
    // plain item, one request each
    await cell("side:unsub:mixed", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, morphs: true });
      await libSub({ "900000001": true });
      await load(SIGNED_IN); await tab("Library"); await sleep(400);
      const plain = await plainTitle();
      if (!plain) { await unsubDone(); return ["no non-Workshop library item — proved nothing"]; }
      for (const t of ["s1", plain]) {
        const b = await cardBox(t); if (!b) { v.push(`no card ${t}`); continue; }
        await mvTo(b.x, b.y, 60);
        send({ type: "mouseDown", x: Math.round(b.x), y: Math.round(b.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(40);
        send({ type: "mouseUp", x: Math.round(b.x), y: Math.round(b.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(200);
      }
      const nSel = await js(`document.querySelectorAll(".card.lib:not([data-leaving]).selected").length`);
      if (nSel !== 2) { await unsubDone(); return [`ctrl-clicks selected ${nSel} cards — proved nothing`]; }
      await openLib("s1"); await sleep(500);
      const d = await dangerTiles(); console.log(`        mixed selection: ${J(d)}`);
      if (d.length !== 1 || d[0].text !== "Unsubscribe 1, delete 1" || !d[0].unsub) v.push(`a mixed selection's tile: ${J(d)}`);
      if (d[0] && !/them|it/.test(d[0].title ?? "")) v.push(`its tooltip: ${J(d[0].title)}`);
      await shot("unsub-mixed");
      const n0 = (await calls()).length;
      await mvTo(40, 450, 60);
      await key("Delete"); await sleep(800);
      const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain").map((c) => [c.p, c.body?.items?.map((i) => i.title)]);
      console.log(`        Delete key: ${J(got)}`);
      const want = J([["/workshop/delete-from-source", ["s1"]], ["/library/trash", [plain]]].sort());
      if (J([...got].sort()) !== want) v.push(`the Delete key posted ${J(got)}, want ${want}`);
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await unsubDone();
      return v;
    });

    // "Unsubscribe without deleting" on the Library's Unsubscribe (the Browse sidebar's menu, components/ContextMenu.tsx):
    // a real right-click opens it at the pointer, growing in; Escape hands focus back; picking it → ONE POST
    // /workshop/unsubscribe-keep, nothing deleted; the item is then the library's own copy and its tile becomes Delete,
    // sliding in (per frame). No-glow + bg-live: the tile and the menu keep their fills, nothing glows
    await cell("side:unsub:keep", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await libSub({ "900000001": true });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) { await unsubDone(); return ["no sidebar for s1 — proved nothing"]; }
      await sleep(600);
      let b = await unsubBox(); await sleep(250); b = await unsubBox();
      if (!b) { await unsubDone(); return ["no Unsubscribe tile"]; }
      let n0 = (await calls()).length;
      const grow = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { out.push(document.querySelector(${J(MENU)})?.getBoundingClientRect().width ?? null);
        if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await clickAt(b.x, b.y, "right");
      await sleep(70); await shot("unsub-keepmenu-opening");
      const ws = await grow;
      let m = await menuState();
      console.log(`        menu: ${J(m)} | widths ${J(ws.filter((x) => x != null).slice(0, 8).map((x) => +x.toFixed(1)))}`);
      if (!m) { await unsubDone(); return [...v, "no menu after a right-click on Unsubscribe"]; }
      if (J(m.items) !== J(["Unsubscribe without deleting"]) || m.focus !== "keep" || m.role !== "menu") v.push(`the menu: ${J(m)}`);
      if (Math.min(Math.abs(m.x - b.x), Math.abs(m.r - b.x)) > 2 || Math.min(Math.abs(m.y - b.y), Math.abs(m.b - b.y)) > 2) v.push(`the menu isn't at the pointer (${J({ b, m })})`);
      if (between(ws, 1) < 2) v.push(`the menu didn't grow in (widths ${J(ws.slice(0, 10))})`);
      if ((await calls()).length !== n0) v.push(`the right-click sent ${J((await calls()).slice(n0))}`);
      if (!(await js(`!!document.querySelector("${SIDE} [data-unsubscribe]") && !document.querySelector(".side-panel.closing")`))) v.push("the right-click changed or closed the sidebar");
      await sleep(250); await shot("unsub-keepmenu");
      await key("Escape"); await sleep(300);
      if (await menuState()) v.push("Escape didn't close the menu");
      if (!(await js(`document.activeElement?.dataset?.unsubscribe !== undefined`))) v.push("after Escape the focus isn't back on Unsubscribe");
      // pick it: one keep request, nothing deleted; /library now says it's the library's own copy
      await clickAt(b.x, b.y, "right"); await sleep(300);
      const it = await js(`(() => { const r = document.querySelector("[data-ctx-item=keep]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      if (!it) { await unsubDone(); return [...v, "no menu entry to pick"]; }
      await libSub({ "900000001": false });
      n0 = (await calls()).length;
      const DT = `${SIDE} .side-cta .danger`;
      const swap = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(${J(DT)});
        out.push(e ? [e.textContent.trim(), +getComputedStyle(e).opacity, +new DOMMatrix(getComputedStyle(e).transform).m41.toFixed(2)] : null);
        if (performance.now() - t0 < 1200) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await clickAt(it.x, it.y);
      const sw = await swap;
      const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain");
      console.log(`        keep: ${J(got.map((c) => [c.p, c.body]))}`);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe-keep" || got[0].body?.workshopId !== "900000001" || got[0].body?.title !== "s1") v.push(`picking it posted ${J(got)}`);
      const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
      if (!/^Unsubscribing from \S+\. It stays in your library\.$/.test(status)) v.push(`the status bar says "${status}"`);
      const del = sw.filter((f) => f && f[0] === "Delete");
      console.log(`        the tile: ${sw.filter(Boolean).length} frames, Delete frames ${del.length}; op ${J(del.slice(0, 8).map((f) => f[1]))} x ${J(del.slice(0, 8).map((f) => f[2]))}`);
      if (!del.length) v.push(`the tile never became Delete: ${J(sw.filter(Boolean).at(-1))}`);
      else {
        if (between(del.map((f) => f[1]), 0.05) < 2) v.push(`the Delete tile popped in (opacity per frame ${J(del.slice(0, 10).map((f) => f[1]))})`);
        if (between(del.map((f) => f[2]), 0.5) < 2) v.push(`the Delete tile didn't slide in (x per frame ${J(del.slice(0, 10).map((f) => f[2]))})`);
      }
      if (await js(`!!document.querySelector("${SIDE} [data-unsubscribe]")`)) v.push("the Unsubscribe tile is still there");
      // no-glow + bg-live
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await libSub({ "900000001": true });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) v.push("no-glow + bg-live: no sidebar for s1");
      else {
        await sleep(600); b = await unsubBox(); await sleep(250); b = await unsubBox();
        await clickAt(b.x, b.y, "right"); await sleep(350);
        m = await menuState();
        const tl = await js(`(() => { const t = document.querySelector("${SIDE} [data-unsubscribe]"); return t ? { bg: getComputedStyle(t).backgroundColor, ico: getComputedStyle(t).boxShadow } : null; })()`);
        const html = await js(`document.documentElement.className`);
        console.log(`        no-glow + bg-live: ${J({ html, menuBg: m?.bg, tile: tl })}`);
        if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
        if (!m || /rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`bg-live: the menu has no fill (${m?.bg})`);
        if (!tl || /rgba\(0, 0, 0, 0\)|transparent/.test(tl.bg)) v.push(`bg-live: the tile has no fill (${tl?.bg})`);
        if (tl && tl.ico.split(/,(?![^(]*\))/).some((x) => !/inset|none/.test(x) && !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the Unsubscribe glows (${tl.ico})`);
        await shot("unsub-keepmenu-live");
        await key("Escape"); await sleep(250);
      }
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await unsubDone();
      return v;
    });
    // motion off: the menu fades in and out in place; the tile's swap after the keep only fades (no slide)
    await cell("side:unsub:keepOff", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, morphs: false });
      await libSub({ "900000001": true });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) { await unsubDone(); await setSettings({ morphs: true }); return ["no sidebar for s1 — proved nothing"]; }
      await sleep(600);
      let b = await unsubBox(); await sleep(250); b = await unsubBox();
      await mvTo(b.x, b.y, 300);
      let smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      await clickAt(b.x, b.y, "right");
      const sIn = await smp;
      const it = await js(`(() => { const r = document.querySelector("[data-ctx-item=keep]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      await libSub({ "900000001": false });
      const DT = `${SIDE} .side-cta .danger`;
      const swap = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(${J(DT)});
        out.push(e ? [e.textContent.trim(), +getComputedStyle(e).opacity, getComputedStyle(e).transform] : null);
        if (performance.now() - t0 < 900) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      if (it) await clickAt(it.x, it.y);
      const sOut = await smp, sw = await swap;
      console.log(`        motion off: menu in ${MO.brief(sIn.menu)} / out ${MO.brief(sOut.menu)}`);
      v.push(...MO.judge("motion off: the menu appearing", sIn.menu, { appear: true }), ...MO.judge("motion off: the menu leaving", sOut.menu, { leave: true }));
      const del = sw.filter((f) => f && f[0] === "Delete");
      console.log(`        motion off: the Delete tile op ${J(del.slice(0, 10).map((f) => f[1]))} transforms ${J([...new Set(del.map((f) => f[2]))])}`);
      if (!del.length) v.push("motion off: the tile never became Delete");
      else {
        if (!del.some((f) => f[1] > 0.02 && f[1] < 0.95)) v.push(`motion off: the Delete tile popped in (opacity ${J(del.slice(0, 10).map((f) => f[1]))})`);
        if (del.some((f) => f[2] !== "none")) v.push(`motion off: the Delete tile moved (${J([...new Set(del.map((f) => f[2]))])})`);
      }
      await setSettings({ morphs: true });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await unsubDone();
      return v;
    });

    // Signed out the app stays disconnected from Steam for unsubscribes (components/subscribeMode.ts unsubBlocked; the backend
    // refuses the same: test-steam-signin.sh § 2). The Library's Unsubscribe controls show it disabled with the reason
    const WHY = "Sign in to Steam to unsubscribe";
    const posted = async (n0) => (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain").map((c) => [c.p, c.body?.items?.map((i) => i.title) ?? c.body?.workshopId ?? null]);
    await cell("side:unsub:signedOut", async () => {
      const v = [];
      const tile = (sel = "[data-unsubscribe]") => page(`const t = document.querySelector("${SIDE} ${sel}"); if (!t) return null; const cs = getComputedStyle(t);
        return { off: t.getAttribute("aria-disabled") === "true", title: t.getAttribute("title"), text: t.textContent.trim(), color: cs.color, bg: cs.backgroundColor,
          shadow: cs.boxShadow, icoShadow: t.querySelector(".side-tile-ico") ? getComputedStyle(t.querySelector(".side-tile-ico")).boxShadow : "none" };`);
      await setSettings({ autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe", morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await libSub({ "900000001": true });
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) { await unsubDone(); return ["no sidebar for s1 — proved nothing"]; }
      await sleep(600);
      let t = await tile(); console.log(`        signed out: ${J(t)}`);
      if (!t || t.off || t.title === WHY || t.text !== "Unsubscribe") v.push(`the Unsubscribe tile: ${J(t)} (want on, no "Sign in" tooltip)`);
      const b = await unsubBox();
      if (b) {
        // its right-click menu: the entry on, no note
        await clickAt(b.x, b.y, "right"); await sleep(350);
        const m = await ctxItems(); console.log(`        its menu: ${J(m && { items: m.items, note: m.note })}`);
        if (!m || m.items.length !== 1 || m.items[0].key !== "keep" || m.items[0].off || m.note) v.push(`the right-click menu: ${J(m)}`);
        await key("Escape"); await sleep(300);
        await mvTo(b.x, b.y, 300);
        await shot("unsub-signedout");
        // the card's button: named Unsubscribe
        if ((await cardDel("s1")) !== "Unsubscribe") v.push(`the card's button: named "${await cardDel("s1")}"`);
        // no-glow + bg-live: the tile keeps its own fill over the wallpaper, no glow (the danger chip keeps only its inset ring)
        await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
        await load(SIGNED_OUT);
        if (!(await openLib("s1"))) v.push("no-glow + bg-live: no sidebar for s1");
        await sleep(600); await mvTo(40, 450, 60); await sleep(300);
        t = await tile();
        const cls = await js(`document.documentElement.className`);
        if (!/no-glow/.test(cls) || !/bg-live/.test(cls)) v.push(`no-glow + bg-live: the page's classes are "${cls}" — proved nothing`);
        if (!t || t.shadow !== "none" || t.icoShadow.split(/,(?![^(]*\))/).some((p) => p.trim() !== "none" && !/inset/.test(p)) || /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(t.bg)) v.push(`no-glow + bg-live: ${J(t)}`);
        await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
        await load(SIGNED_OUT);
        if (!(await openLib("s1"))) v.push("no sidebar for s1 after no-glow");
        await sleep(500);
        // a click posts the Delete from source (stubbed): its drain then opens the item's Steam page
        const n0 = (await calls()).length;
        const b2 = await unsubBox();
        if (b2) { await clickAt(b2.x, b2.y); await sleep(500); }
        const got = await posted(n0);
        if (!got.some((x) => x[0] === "/workshop/delete-from-source" && J(x[1]) === J(["s1"]))) v.push(`a click on the tile posted ${J(got)}, want delete-from-source [s1]`);
      } else v.push("no Unsubscribe tile");
      // auto-import off: "Delete and unsubscribe" (Delete's right-click entry) on too
      await libSub({ "900000001": true });
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) v.push("auto-import off: no sidebar for s1");
      else {
        await sleep(500);
        const db = await unsubBox("[data-delete]");
        if (db) { await clickAt(db.x, db.y, "right"); await sleep(350); }
        const dm = await ctxItems();
        if (!dm || dm.items[0]?.key !== "delete-source" || dm.items[0].off || dm.note) v.push(`auto-import off, "Delete and unsubscribe": ${J(dm)} (want on)`);
        await key("Escape"); await sleep(250);
      }
      // "Use the Steam app" the same
      await setSettings({ autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "steamapp" });
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) v.push("steamapp: no sidebar for s1");
      else {
        await sleep(500); t = await tile();
        if (!t || t.off || t.title === WHY || (await cardDel("s1")) !== "Unsubscribe") v.push(`steamapp, signed out: ${J(t)}, the card's "${await cardDel("s1")}"`);
      }
      // a sign-out under an open sidebar (WS steam-status) changes nothing
      await setSettings({ workshopDownloadMode: "subscribe" });
      await load(SIGNED_IN);
      if (!(await openLib("s1"))) v.push("no sidebar for s1 (signed in)");
      else {
        await sleep(500);
        if ((await tile())?.off !== false) v.push(`signed in, the tile: ${J(await tile())}`);
        await ev("steam-status", SIGNED_OUT); await sleep(800);
        if ((await tile())?.off !== false) v.push(`after WS steam-status (signed out) the tile: ${J(await tile())}`);
      }
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await unsubDone();
      return v;
    });
    // Browse's Unsubscribe tiles, signed out under "Subscribe with Steam login": on (its drain opens the item's Steam page),
    // no "Sign in" reason, the library copy's right-click entry on; a subscribed item the library doesn't hold the same; "Use the
    // Steam app" the same
    await cell("steam:sub:signedOut", async () => {
      const v = [];
      await setSettings({ workshopDownloadMode: "subscribe", morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      const off = (sel) => js(`document.querySelector("${SIDE} ${sel}")?.getAttribute("aria-disabled") ?? null`);
      const tip = (sel) => js(`document.querySelector("${SIDE} ${sel}")?.getAttribute("title") ?? null`);
      try {
        if (!(await libCopy(SIGNED_OUT))) return ["signed out: no Unsubscribe tile on ws-1 (its library copy) — proved nothing"];
        await sleep(400);
        console.log(`        signed out: aria-disabled ${await off("[data-unsubscribe]")}, title ${J(await tip("[data-unsubscribe]"))}`);
        if ((await off("[data-unsubscribe]")) !== null || (await tip("[data-unsubscribe]")) === WHY) v.push(`signed out, the library copy's tile: aria-disabled ${await off("[data-unsubscribe]")} (want on, no "Sign in" reason)`);
        let b = await btnBox();
        await clickAt(b.x, b.y, "right"); await sleep(350);
        const m = await ctxItems(); console.log(`        its menu: ${J(m && { items: m.items, note: m.note })}`);
        if (!m || m.items.length !== 1 || m.items[0].off || m.note) v.push(`the right-click menu: ${J(m)}`);
        await key("Escape"); await sleep(300);
        await mvTo(b.x, b.y, 300);
        await shot("sub-signedout");
        let n0 = (await calls()).length;
        await clickAt(b.x, b.y); await sleep(500);
        if (!(await posted(n0)).some((x) => x[0] === "/workshop/delete-from-source")) v.push(`a click posted ${J(await posted(n0))}, want /workshop/delete-from-source`);
        // a subscribed item the library doesn't hold (ws-2): its Unsubscribe on too
        await setWs("930001", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
        await openSide(1);
        await waitFor(() => js(`!!document.querySelector("${SIDE} [data-unsubscribe-steam]")`), 3000);
        if ((await off("[data-unsubscribe-steam]")) !== null || (await tip("[data-unsubscribe-steam]")) === WHY) v.push(`signed out, ws-2's Unsubscribe: aria-disabled ${await off("[data-unsubscribe-steam]")}`);
        b = await btnBox("[data-unsubscribe-steam]");
        n0 = (await calls()).length;
        if (b) { await clickAt(b.x, b.y); await sleep(500); }
        if (!(await posted(n0)).some((x) => x[0] === "/workshop/unsubscribe")) v.push(`ws-2's click posted ${J(await posted(n0))}, want /workshop/unsubscribe`);
        await setSettings({ workshopDownloadMode: "steamapp" });
        if (!(await libCopy(SIGNED_OUT))) v.push("Use the Steam app: no Unsubscribe tile");
        else if ((await off("[data-unsubscribe]")) !== null) v.push(`Use the Steam app, signed out: aria-disabled ${await off("[data-unsubscribe]")}`);
      } finally { await setSettings({ workshopDownloadMode: "subscribe" }); await libCopyDone(); }
      return v;
    });

    // ---- the item sidebar's buttons for a Workshop result the library doesn't hold: "Subscribe and apply" / "Subscribe" (the
    // subscribe glyph) in every download mode and auto-import, never a subscription card; Steam keeping it subscribed (not
    // imported): "Download and apply" / "Download" and an Unsubscribe tile. The card's own button and the selection toolbar still
    // say Subscribe only with auto-import on + the "subscribe" mode (components/subscribeMode.ts). Shots steam-submerge*.png
    const ctas = () => page(`return [...document.querySelectorAll("${SIDE} .side-cta .side-go")].map((b) => [b.textContent.trim(), b.querySelector("svg.lucide")?.getAttribute("class")?.match(/lucide-([a-z-]+)/g)?.at(-1) ?? null]);`);
    const hasCard = () => js(`!!document.querySelector("${SIDE} [data-side-sub]")`);
    const mergedSide = async (state) => {
      await browseWs();
      await setWs("930000", state);
      await openSide(0); await sleep(500);
    };
    const NOT_SUB = { subscribed: false, pending: null, inLibrary: false, onDisk: false };
    const SUBD = { subscribed: true, pending: null, inLibrary: false, onDisk: true };
    const SUBS = `${SIDE} [data-unsubscribe-steam]`;
    await cell("steam:subMerge:labels", async () => {
      const v = [];
      for (const [auto, mode, merged] of [[true, "subscribe", true], [true, "steamapp", false], [false, "subscribe", false]]) {
        await setSettings({ autoAddWeWallpapersToLibrary: auto, workshopDownloadMode: mode, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await mergedSide(NOT_SUB);
        const c = await ctas(), card = await hasCard();
        // the cards' own button and the selection toolbar (components/subscribeMode.ts)
        const btn = await page(`const b = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .dl-btn"); return b ? { title: b.getAttribute("title"), sub: b.dataset.dlSub ?? null, arrow: b.querySelector(".dl-arrow")?.getAttribute("d") } : null;`);
        await page(`document.querySelector("${SIDE} .side-close, .side-panel .side-close")?.click();`); await sleep(300);
        for (const i of [1, 2]) {
          const r = await page(`const t = document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap")[${i}]; t.scrollIntoView({ block: "center" }); const q = t.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 3 };`);
          send({ type: "mouseDown", x: Math.round(r.x), y: Math.round(r.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(40);
          send({ type: "mouseUp", x: Math.round(r.x), y: Math.round(r.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(150);
        }
        const bulk = await js(`document.querySelector(".sel-toolbar .btn.accent")?.textContent.trim() ?? null`);
        if (merged) {
          await shot("submerge-bulk");
          const c0 = await page(`const t = document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap")[3]; const q = t.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 3 };`);
          await mvTo(c0.x, c0.y, 500); await shot("submerge-card");
          await mvTo(5, 450, 200);
        }
        await page(`[...document.querySelectorAll(".sel-toolbar .btn")].find((b) => b.textContent.trim() === "Cancel")?.click();`); await sleep(200);
        console.log(`        auto-import ${auto}, ${mode}: ${J(c)} card ${card} | card button ${J(btn)} | toolbar "${bulk}"`);
        if (!btn || btn.title !== (merged ? "Subscribe & apply" : "Download & apply") || !!btn.sub !== merged) v.push(`auto-import ${auto}, ${mode}: the card's button ${J(btn)}`);
        if (bulk !== (merged ? "Subscribe 2" : "Download 2")) v.push(`auto-import ${auto}, ${mode}: the selection toolbar reads "${bulk}"`);
        const want = [["Subscribe and apply", "lucide-cloud-download"], ["Subscribe", "lucide-cloud-download"]];
        if (J(c) !== J(want)) v.push(`auto-import ${auto}, ${mode}: buttons ${J(c)}, want ${J(want)}`);
        if (card) v.push(`auto-import ${auto}, ${mode}: a subscription card`);
        if (merged) await shot("submerge");
      }
      // "Subscribe" is the download (POST /download, held by the stub), then Cancel
      await setSettings({ autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe" });
      await mergedSide(NOT_SUB);
      await page(`document.querySelector("${SIDE} [data-side-get=only]")?.click();`);
      const dl = await waitFor(() => js(`window.__st.dl && window.__st.dl.body`), 2000);
      if (dl?.result?.workshopId !== "930000" || dl.apply !== false) v.push(`"Subscribe" posted ${J(dl)}`);
      if (await hasCard()) v.push("a subscription card showed while subscribing (the download says it)");
      await page(`[...document.querySelectorAll("${SIDE} .side-dl button")].find((b) => /Cancel/.test(b.textContent))?.click();`); await sleep(400);
      // subscribed in Steam, not in the library: Download and an Unsubscribe (the action area's third button); no-glow + bg-live keep its fill, no glow
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await mergedSide(SUBD);
      const s = await waitFor(() => sub().then((x) => x && x.tile ? x : null), 3000);
      const c = await ctas();
      console.log(`        subscribed: ${J(s)} | ${J(c)}`);
      if (!s || s.tile !== "Unsubscribe" || s.card) v.push(`subscribed: ${J(s)}`);
      if (J(c) !== J([["Download and apply", "lucide-download"], ["Download", "lucide-download"], ["Unsubscribe", "lucide-cloud-off"]])) v.push(`subscribed, the buttons ${J(c)}`);
      if (s && (s.icoShadow ?? "").split(/,(?![^(]*\))/).some((x) => !/inset|none/.test(x) && !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the button glows (${s.icoShadow})`);
      if (!s || /rgba\(0, 0, 0, 0\)|transparent/.test(s.bg)) v.push(`bg-live: the Unsubscribe has no dark base (${s?.bg})`);
      await shot("submerge-live");
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
      return v;
    });
    // the Unsubscribe tile arrives with the state (it rises in, what follows glides down out of its room) and leaves once
    // unsubscribed (it fades out keeping its words, what follows glides up); motion off: it only fades, nothing glides
    const NEXT_Y = `(() => { const c = document.querySelector(${J(SUBS)}), n = document.querySelector("${SIDE} [data-probe-next]");
      return [c ? +(() => { let o = 1; for (let x = c; x && x.nodeType === 1; x = x.parentElement) o *= +getComputedStyle(x).opacity; return o; })().toFixed(3) : null,
        n ? +new DOMMatrix(getComputedStyle(n).transform).m42.toFixed(2) : null, c ? c.textContent.trim() : null]; })()`;
    const markNext = () => js(`(() => { const n = document.querySelector("${SIDE} .side-cta")?.nextElementSibling; if (!n) return false; n.dataset.probeNext = ""; return true; })()`);
    await cell("steam:subMerge:appear", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe", morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await mergedSide(NOT_SUB);
      if (await js(`!!document.querySelector(${J(SUBS)})`)) { await setSettings({ autoAddWeWallpapersToLibrary: false }); return ["an Unsubscribe while not subscribed — proved nothing"]; }
      if (!(await markNext())) { await setSettings({ autoAddWeWallpapersToLibrary: false }); return ["nothing follows the buttons — proved nothing"]; }
      const inP = frames(`window.__wsState["930000"] = ${J(SUBD)}; window.__fakeWs("steam-todo", { finished: true });`, NEXT_Y, 900);
      await sleep(150); await shot("submerge-appear");
      const fin = await inP;
      const ops = fin.map((f) => f?.[0] ?? null), ys = fin.map((f) => f?.[1] ?? null);
      console.log(`        appear: op ${J(ops.filter((x) => x != null).slice(0, 10))} next y ${J(ys.filter((y) => y).slice(0, 10))}`);
      if (!ops.some((o) => o != null && o >= 0.95)) v.push("the tile never appeared");
      if (between(ops.map((o) => o ?? 0), 0.05) < 2) v.push(`the tile popped in (opacity per frame ${J(ops.slice(0, 14))})`);
      if (ys.filter((y) => y != null && y < -1).length < 2) v.push(`what follows didn't glide down (y per frame ${J(ys.slice(0, 14))})`);
      await sleep(300); await shot("submerge-subscribed");
      // Unsubscribe: Steam says it's gone → the tile leaves
      const n0 = (await calls()).length;
      await page(`document.querySelector("${SIDE} [data-unsubscribe-steam]")?.click();`); await sleep(300);
      const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/state");
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe") v.push(`Unsubscribe posted ${J(got)}`);
      const outP = frames(`window.__wsState["930000"] = ${J(NOT_SUB)}; window.__fakeWs("steam-todo", { finished: true });`, NEXT_Y, 1000);
      await sleep(120); await shot("submerge-leave");
      const fout = await outP;
      const ops2 = fout.map((f) => f?.[0] ?? null), ys2 = fout.map((f) => f?.[1] ?? null), words = [...new Set(fout.map((f) => f?.[2]).filter((x) => x != null))];
      console.log(`        leave: op ${J(ops2.slice(0, 16))} next y ${J(ys2.filter((y) => y).slice(0, 10))} words ${J(words)}`);
      if (ops2.at(-1) != null) v.push("the tile didn't leave");
      if (!ops2.some((o) => o != null && o > 0.05 && o < 0.95)) v.push(`the tile popped out (opacity per frame ${J(ops2.slice(0, 16))})`);
      if (ys2.filter((y) => y != null && y > 1).length < 2) v.push(`what follows didn't glide up (y per frame ${J(ys2.slice(0, 16))})`);
      if (words.some((w) => !/^Unsubscrib/.test(w))) v.push(`the leaving tile changed its words: ${J(words)}`);
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      return v;
    });
    await cell("steam:subMerge:appearOff", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe", morphs: false });
      await mergedSide(NOT_SUB);
      if (await js(`!!document.querySelector(${J(SUBS)})`) || !(await markNext())) { await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true }); return ["no starting state — proved nothing"]; }
      const GLIDES = `${MO.OPACITY_ONLY}(document.querySelector("${SIDE} .side-body"))`;
      let smp = js(MO.SAMPLE({ card: SUBS }, 500)); await sleep(20);
      await js(`window.__wsState["930000"] = ${J(SUBD)}; window.__fakeWs("steam-todo", { finished: true }); true`);
      await sleep(60); const g1 = await js(GLIDES);
      const sIn = await smp;
      await page(`document.querySelector("${SIDE} [data-unsubscribe-steam]")?.click();`); await sleep(300);
      smp = js(MO.SAMPLE({ card: SUBS }, 500)); await sleep(20);
      await js(`window.__wsState["930000"] = ${J(NOT_SUB)}; window.__fakeWs("steam-todo", { finished: true }); true`);
      await sleep(60); const g2 = await js(GLIDES);
      const sOut = await smp;
      await sleep(250); const g3 = await js(GLIDES);
      console.log(`        motion off: in ${MO.brief(sIn.card)} / out ${MO.brief(sOut.card)} | non-opacity animations ${J([g1, g2, g3])}`);
      v.push(...MO.judge("motion off: the tile appearing", sIn.card, { appear: true, size: false }), ...MO.judge("motion off: the tile leaving", sOut.card, { leave: true, size: false }));
      if ([...g1, ...g2, ...g3].length) v.push(`motion off: something glides (${J([g1, g2, g3])})`);
      await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true });
      return v;
    });

    // ---- the item sidebar's Subscribe for a Workshop item the library holds unsubscribed (its own copy after "Unsubscribe
    // without deleting"): a Subscribe tile beside its Delete, never for a subscribed item or one the Workshop no longer has;
    // Subscribe → POST /workshop/subscribe, "Subscribing…" meanwhile; once subscribed the tile fades out and the Delete tile
    // becomes Unsubscribe. Motion off: only fades. Shots steam-resub*.png
    const subTile = () => js(`document.querySelector("${SIDE} [data-side-subscribe]")?.textContent.trim() ?? null`);
    const resubDone = async () => { await js(`localStorage.removeItem("__probe_lib_off"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`); await unsubDone(); };
    const resubFlow = async (v, motionOn) => {
      await setSettings({ autoAddWeWallpapersToLibrary: true, morphs: motionOn, glows: true, liveWallpaperBehindAllTabs: false });
      await libSub({ "900000001": true, "900000002": false, "900000003": false });
      await js(`localStorage.setItem("__probe_lib_off", ${J(J(["900000003"]))}); true`);
      await load(SIGNED_IN);
      // a subscribed item: no Subscribe; one the Workshop no longer has: none
      for (const t of ["s1", "s3"]) {
        if (!(await openLib(t))) { v.push(`no sidebar for ${t}`); continue; }
        await sleep(700);
        if (await subTile()) v.push(`${t}: a Subscribe tile (${J(await subTile())})`);
      }
      if (!(await openLib("s2"))) return false;
      await sleep(600);
      const c = await subTile();
      console.log(`        s2 (its own copy): ${J(c)} | tiles ${J(await dangerTiles())}`);
      if (c !== "Subscribe") { v.push(`s2's Subscribe: ${J(c)}`); return false; }
      if (motionOn) await shot("resub");
      const n0 = (await calls()).length;
      await page(`document.querySelector("${SIDE} [data-side-subscribe]")?.click();`); await sleep(400);
      // the sidebar's own community reads (counts, creator, favourite state, asked once it settles) may land meanwhile: they
      // read, they never act
      const got = (await calls()).slice(n0).filter((c) => !/^\/workshop\/(counts|creator|comments)$/.test(c.p) && !(c.p === "/workshop/favorite" && c.m === "GET"));
      if (got.length !== 1 || got[0].p !== "/workshop/subscribe" || got[0].body?.workshopId !== "900000002" || got[0].body?.title !== "s2") v.push(`Subscribe posted ${J(got)}`);
      if ((await subTile()) !== "Subscribing…") v.push(`while subscribing: ${J(await subTile())}`);
      // Steam delivers: subscribed, the library re-read (the backend's library-synced)
      await libSub({ "900000001": true, "900000002": true, "900000003": false });
      return true;
    };
    const RESUB = `(() => { const c = document.querySelector("${SIDE} [data-side-subscribe]"), d = document.querySelector("${SIDE} .side-cta .danger");
      return [c ? +getComputedStyle(c).opacity : null, d ? d.textContent.trim() : null]; })()`;
    const DELIVER = `window.__fakeWs("subscribe-progress", { id: "900000002", value: 1, status: "Subscribed", done: true }); window.__fakeWs("library-synced", { count: 0 });`;
    await cell("side:resub", async () => {
      const v = [];
      if (!(await resubFlow(v, true))) { await resubDone(); return v.length ? v : ["no starting state — proved nothing"]; }
      const outP = frames(DELIVER, RESUB, 1100);
      await sleep(110); await shot("resub-leave");
      const fr = await outP;
      const ops = fr.map((f) => f?.[0] ?? null), tiles = fr.map((f) => f?.[1] ?? null);
      console.log(`        delivered: Subscribe op ${J(ops.slice(0, 16))} tile ${J([...new Set(tiles)])}`);
      if (ops.at(-1) != null) v.push("the Subscribe tile didn't leave once subscribed");
      if (!ops.some((o) => o != null && o > 0.05 && o < 0.95)) v.push(`the Subscribe tile popped out (opacity ${J(ops.slice(0, 16))})`);
      if (tiles.at(-1) !== "Unsubscribe") v.push(`the Delete tile didn't become Unsubscribe: ${J([...new Set(tiles)])}`);
      await sleep(300); await shot("resub-done");
      await resubDone();
      return v;
    });
    await cell("side:resubOff", async () => {
      const v = [];
      if (!(await resubFlow(v, false))) { await resubDone(); await setSettings({ morphs: true }); return v.length ? v : ["no starting state — proved nothing"]; }
      const GLIDES = `${MO.OPACITY_ONLY}(document.querySelector("${SIDE} .side-body"))`;
      const smp = js(MO.SAMPLE({ card: `${SIDE} [data-side-subscribe]` }, 500)); await sleep(20);
      await js(`${DELIVER} true`);
      await sleep(60); const g = await js(GLIDES);
      const s = await smp;
      console.log(`        motion off: the tile ${MO.brief(s.card)} | non-opacity animations ${J(g)}`);
      v.push(...MO.judge("motion off: the Subscribe tile leaving", s.card, { leave: true, size: false }));
      if (g.length) v.push(`motion off: something glides (${J(g)})`);
      await resubDone(); await setSettings({ morphs: true });
      return v;
    });
    // The Browse sidebar's Workshop ID pill — the Library's (components/WorkshopIdPill.tsx, one component for both) — turns into
    // "Copied" (hooks/useCopied.ts) without any hero chip changing size or place
    await cell("side:copyIdPill", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true });
      await browseWs();
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0);
      const BPILL = `${SIDE} .side-hero [data-copy-id]`;
      const shownText = () => js(`document.querySelector("${BPILL} .xfade > :not([data-off])")?.textContent.trim() ?? null`);
      if (!(await waitFor(() => js(`!!document.querySelector("${BPILL}")`), 3000))) return ["no Workshop ID pill in the Browse sidebar's hero"];
      if (await js(`!!document.querySelector("${SIDE} .side-tiles [data-copy-id], ${SIDE} .copy-tile")`)) v.push("the old Copy ID tile is still there");
      if (await js(`document.querySelector("${BPILL}").dataset.sideRow !== "workshop-id"`)) v.push("the Browse pill isn't the shared one (data-side-row=workshop-id)");
      const before = await js(HERO);
      const name0 = await axName(BPILL);
      if (name0 !== "Workshop ID 930000 — copy") v.push(`its name at rest is ${J(name0)}`);
      const r = await js(`(() => { const r = document.querySelector("${BPILL}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await clipboard.writeText("");
      const tClick = Date.now();
      const fr = js(`new Promise((res) => { const out = []; const t0 = performance.now();
        const f = () => { out.push({ b: ${HERO}, on: !!document.querySelector("${BPILL}[data-copied]"),
          y: (() => { const e = document.querySelector("${BPILL} .xfade > :last-child"); return e ? +new DOMMatrix(getComputedStyle(e).transform).m42.toFixed(2) : null; })() });
          if (performance.now() - t0 < 600) requestAnimationFrame(f); else res(out); };
        requestAnimationFrame(f); })`);
      await sleep(30);
      await clickAt(r.x, r.y);
      await sleep(90); await shot("copyid-roll");
      const frs = await fr;
      if (!frs.some((f) => f.on)) return [...v, "the pill never turned into \"Copied\" — proved nothing"];
      if ((await shownText()) !== "Copied") v.push(`it reads ${J(await shownText())}, want "Copied"`);
      const name1 = await axName(BPILL);
      if (name1 !== "Workshop ID 930000 — copied") v.push(`its name while copied is ${J(name1)}`);
      const got = await clipboard.readText();
      if (got !== "930000") v.push(`the clipboard holds ${J(got)}, want "930000"`);
      const moved = frs.find((f) => f.b && before && f.b.some((x, i) => before[i] && x.slice(1).some((n, k) => Math.abs(n - before[i][k + 1]) > 0.75)));
      if (moved) v.push(`a hero chip moved or resized: ${J(before)} → ${J(moved.b)}`);
      const ys = frs.filter((f) => f.on && f.y != null).map((f) => f.y);
      if (between(ys, 0.5) < 2) v.push(`"Copied" didn't roll in (y per frame ${J(ys.slice(0, 10))})`);
      await sleep(250); await mvTo(3, 3, 100); await shot("copyid");
      if (!(await waitFor(() => shownText().then((t) => t === "930000"), 2500))) v.push("it never went back to the id");
      else if (Date.now() - tClick < 1000) v.push(`"Copied" held only ≈ ${Date.now() - tClick} ms (want ≈ 1200)`);
      await clickAt(r.x, r.y); await sleep(200);
      await openSide(1);
      if (await js(`!!document.querySelector("${BPILL}[data-copied]")`)) v.push("another item's sidebar shows \"Copied\"");
      // motion off: the faces only fade, nothing moves
      await setSettings({ morphs: false });
      await browseWs();
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0);
      await waitFor(() => js(`!!document.querySelector("${BPILL}")`), 3000);
      if (!(await js(`document.documentElement.classList.contains("no-motion")`))) v.push("motion off: the page isn't in no-motion — proved nothing");
      const r2 = await js(`(() => { const r = document.querySelector("${BPILL}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await mvTo(r2.x, r2.y, 300);
      const smp = js(MO.SAMPLE({ face: `${BPILL} .xfade > :last-child`, pill: BPILL }, 500)); await sleep(40);
      await clickAt(r2.x, r2.y);
      const s2 = await smp;
      console.log(`        motion off: "Copied" ${MO.brief(s2.face)}`);
      v.push(...MO.judge("motion off: \"Copied\"", s2.face, { appear: true }), ...MO.judge("motion off: the pill", s2.pill));
      await setSettings({ morphs: true });
      return v;
    });

    // ---- the Browse sidebar's Workshop community pieces (components/WorkshopSocial.tsx) and the Workshop's lists ----
    const W = (o) => js(`window.__ws = Object.assign(window.__ws || {}, ${J(o)}); true`);
    const wsCalls = (p) => js(`window.__st.calls.filter((c) => c.p === ${J(p)})`);
    const browses = () => js(`window.__st.browses ?? []`);
    const libThumb = ((await http("GET", "/library")).json ?? []).map((i) => i.thumbnailPath).find((t) => t) ?? null;
    const COMMENTS = Array.from({ length: 23 }, (_, i) => ({ id: String(900 + 23 - i), author: i === 3 ? "Probe Creator" : `fan ${i}`,
      authorId: i === 3 ? "76561190000000007" : String(76561190000000100 + i), avatar: libThumb, time: Math.floor(Date.now() / 1000) - i * 7200,
      text: i === 0 ? "first line\n<b>not bold</b> <img src=x onerror=window.__pwned=1>" : `comment ${23 - i}` }));
    const scrollSideTo = (sel) => page(`const e = document.querySelector(${J(sel)}), sc = e?.closest(".side-scroll"); if (!e || !sc) return false;
      sc.scrollTop += e.getBoundingClientRect().top - sc.getBoundingClientRect().top - 40; return true;`);
    const looks = (sel) => js(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, html: document.documentElement.className }; })()`);
    // the filter column's list fields (components/WorkshopListFields.tsx): Author ("creator") and Presets of ("presets")
    const LFIELD = (k) => `.wf-col:not(.closing) [data-wf-field="${k}"]`;
    const field = (k) => page(`const f = document.querySelector(${J(LFIELD(k))}); if (!f) return null;
      const i = f.querySelector("input"), box = f.querySelector(".wf-field-box").getBoundingClientRect(), e = f.querySelector("[data-wf-field-err]"), cs = getComputedStyle(i);
      const er = e?.getBoundingClientRect(), next = f.nextElementSibling ?? f.parentElement.nextElementSibling;
      return { value: i.value, state: f.dataset.wfFieldState, invalid: i.getAttribute("aria-invalid"), err: e && !e.classList.contains("closing") ? e.textContent : null,
        errAbove: er ? er.bottom <= box.top + 0.5 : null, under: [...f.children].filter((c) => c.getBoundingClientRect().top >= box.bottom - 0.5).length,
        border: cs.borderTopColor, shadow: cs.boxShadow, focused: document.activeElement === i, avatar: f.querySelector("[data-ws-avatar]")?.dataset.wsAvatar ?? null,
        clear: !!f.querySelector("[data-wf-field-clear]"), danger: getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
        errColor: e ? getComputedStyle(e).color : null, gap: next ? +(next.getBoundingClientRect().top - box.bottom).toFixed(1) : null };`);
    // open Browse's filter column (its split button) when it isn't
    const openCol = () => page(`const t = document.querySelector("[data-sortsplit=browse] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") { t?.click(); await new Promise((r) => setTimeout(r, 650)); }
      return !!document.querySelector(${J(LFIELD("creator"))});`);
    // type into a field as the user does (focus, select what's there, the text, Enter)
    const typeIn = async (k, text, enter = true) => {
      await page(`const i = document.querySelector(${J(LFIELD(k) + " input")}); i.focus(); i.select(); return true;`);
      if (text) await type(text); else await key("Backspace");
      if (enter) await key("Enter");
    };
    const clearField = (k) => page(`const b = document.querySelector(${J(LFIELD(k) + " [data-wf-field-clear]")}); if (!b) return false; b.click(); return true;`);
    const splitCount = () => js(`document.querySelector("[data-sortsplit=browse] .ss-n:not(.out)")?.dataset.wfCount ?? null`);
    const lastList = async () => (await browses()).at(-1)?.list ?? null;
    // a sidebar row's click fills its field (WorkshopSocial.tsx fillListField): the sidebar closes, the column shows where it
    // was (docked), the field reads `want` and rings once: an accent edge fading in and out through in-between frames (motion
    // off too: opacity alone, the field's box fading in where it stays)
    const fillFromRow = async (v, rowSel, k, want, motion, shotName) => {
      const RING = `${LFIELD(k)} .wf-field-ring`;
      const smp = js(MO.SAMPLE({ ring: RING, box: `${LFIELD(k)} .wf-field-box` }, 1100)); await sleep(40);
      if (!(await page(`const e = document.querySelector(${J(rowSel)}); if (!e) return false; e.click(); return true;`))) { v.push(`no row ${rowSel} to click`); return null; }
      if (shotName) { await sleep(260); await shot(shotName); }
      const s = await smp;
      const f = await field(k);
      console.log(`        ${k} filled: ${J(f)}; ring ${MO.brief(s.ring)}`);
      if (!f) { v.push(`the click didn't show the column's ${k} field`); return null; }
      if (f.value !== want || f.state !== "on") v.push(`the ${k} field reads ${J(f.value)} (${f.state}), want ${J(want)} (on)`);
      if (await js(`!!document.querySelector(${J(SIDE)})`)) v.push("the sidebar stayed open");
      const mid = s.ring.filter((x) => x[1] != null && x[1] > 0.05 && x[1] < 0.95).length;
      if (!s.ring.some((x) => x[1] != null && x[1] > 0.6)) v.push(`the ${k} field didn't ring (${MO.brief(s.ring)})`);
      else if (mid < 3) v.push(`the ${k} field's ring popped (${MO.brief(s.ring)})`);
      if (!motion) {
        if (!(await js(`document.documentElement.classList.contains("no-motion")`))) v.push("motion off: the page isn't in no-motion — proved nothing");
        v.push(...MO.judge(`motion off: the ${k} field's box`, s.box, { appear: true }));
      }
      return f;
    };

    // the stat pills: Steam's current counts, subscribers with the people icon, favourites with the star; no view count
    await cell("ws:counts", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs(); await openSide(0);
      const r = await page(`const h = document.querySelector("${SIDE} .side-hero"); if (!h) return null;
        const pill = (k) => { const e = h.querySelector('[data-side-stat="' + k + '"]'); return e ? { text: e.textContent.trim(), icon: [...(e.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-") && c !== "lucide") } : null; };
        return { subs: pill("subscribers"), favs: pill("favorites"), eye: !!h.querySelector(".lucide-eye"), heart: !!h.querySelector(".lucide-heart"),
          views: [...h.children].some((e) => /^Views$/i.test(e.title)) };`);
      console.log(`        ${J(r)}`);
      if (!r) return ["no hero row"];
      if (r.subs?.text !== "1.2k" || r.subs?.icon !== "lucide-users") v.push(`subscribers pill ${J(r.subs)} (want 1.2k with lucide-users)`);
      if (r.favs?.text !== "56" || r.favs?.icon !== "lucide-star") v.push(`favourites pill ${J(r.favs)} (want 56 with lucide-star)`);
      if (r.eye || r.heart || r.views) v.push(`a views / heart pill is still there: ${J(r)}`);
      return v;
    });

    // the creator: avatar + name (asked once the sidebar settles), a click lists their wallpapers: the filter column's Author
    // field reads their name (fillFromRow), the search goes, the sort is the list's; its × goes back to the whole Workshop
    for (const motion of [true, false]) {
      await cell(`ws:creator${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        await W({ avatar: libThumb });
        await openSide(0);
        const ROW = `${SIDE} [data-ws-creator]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return ["the creator row never showed the creator"];
        const c = await wsCalls("/workshop/creator");
        if (c.length !== 1 || !/owner=76561190000000007/.test(c[0].q)) v.push(`creator asked ${c.length}× (${J(c)}), want once with the item's owner`);
        const name = await js(`document.querySelector("${ROW} [data-ws-row-name]")?.textContent`);
        if (name !== "Probe Creator") v.push(`the row says ${J(name)}`);
        // the whole row is the target: it ends in a bare chevron (no icon chip, no tooltip, no words), the row's name says where
        // it goes
        const go = await js(`(() => { const r = document.querySelector(${J(ROW)}), g = r?.querySelector("[data-ws-go]"); if (!g) return null;
          const sv = g.querySelector("svg"), gr = g.getBoundingClientRect(), rr = r.getBoundingClientRect(), cs = getComputedStyle(g);
          return { text: g.textContent.trim(), icon: [...(sv?.classList ?? [])].find((c) => c.startsWith("lucide-") && c !== "lucide") ?? null, title: g.getAttribute("title"),
            label: r.getAttribute("aria-label"), words: r.textContent.includes("All their wallpapers"), endGap: +(rr.right - gr.right).toFixed(1), bg: cs.backgroundColor,
            icons: r.querySelectorAll("svg.lucide").length }; })()`);
        console.log(`        the row's end: ${J(go)}`);
        if (!go) v.push("the row's end has no chevron ([data-ws-go])");
        else {
          if (go.text || go.words) v.push(`"All their wallpapers" is still words in the row (${J(go)})`);
          if (go.icon !== "lucide-chevron-right" || go.title) v.push(`the row's end is ${go.icon} with tooltip ${J(go.title)} (want a bare chevron, no tooltip)`);
          if (!/rgba\(0, 0, 0, 0\)|transparent/.test(go.bg)) v.push(`the chevron sits on a chip (${go.bg})`);
          if (!/^All their wallpapers, made by Probe Creator$/.test(go.label ?? "")) v.push(`the row's name reads ${J(go.label)}`);
          if (go.endGap > 14) v.push(`the chevron isn't at the row's end (${go.endGap} px short)`);
        }
        // hovered, the row lifts and its chevron slides toward where it goes (motion on: on the spring, per frame; off: still)
        await mvTo(3, 3, 300);
        const rb = await js(`(() => { const r = document.querySelector(${J(ROW)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const slide = frames("", `(() => { const g = document.querySelector("${ROW} [data-ws-go]"), r = document.querySelector(${J(ROW)});
          return [+new DOMMatrix(getComputedStyle(g).transform).m41.toFixed(2), +new DOMMatrix(getComputedStyle(r).transform).m42.toFixed(2)]; })()`, 600);
        await sleep(30); await mvTo(rb.x, rb.y);
        if (motion) { await sleep(90); await shot("ws-creator-go"); }
        const sl = (await slide).filter((x) => x != null), xs = sl.map((x) => x[0]), lift = sl.map((x) => x[1]);
        console.log(`        the chevron's x per frame: ${J(xs.slice(0, 14))}; the row's y ${J(lift.slice(0, 8))}`);
        if (motion && (xs.at(-1) < 2 || between(xs, 0.3) < 3)) v.push(`motion on: the chevron didn't slide on the spring (${J(xs.slice(0, 14))})`);
        if (motion && !(lift.at(-1) < -0.5)) v.push(`motion on: the row didn't lift (${J(lift.slice(0, 8))})`);
        if (!motion && (xs.some((x) => Math.abs(x) > 0.01) || lift.some((y) => Math.abs(y) > 0.01))) v.push(`motion off: the row or its chevron moved (${J(sl.slice(0, 8))})`);
        await mvTo(3, 3, 200);
        if (libThumb && !(await waitFor(() => js(`document.querySelector("${ROW} [data-ws-avatar]")?.dataset.wsAvatar === "loaded"`), 3000))) v.push("the avatar never loaded");
        const src = await js(`document.querySelector("${ROW} img")?.src ?? ""`);
        const api = await js(`location.origin`);
        if (libThumb && src.startsWith(api + "/")) v.push(`the avatar loads from the API origin (${src.slice(0, 60)}), not the media one`);
        if (motion) {
          // no-glow + bg-live: the row keeps its own dark fill, its hover no glow (the page re-read with them on)
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ avatar: libThumb }); await openSide(0);
          await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000); await sleep(300);
          const rr = await js(`(() => { const r = document.querySelector(${J(ROW)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await mvTo(rr.x, rr.y, 400);
          const lk = await looks(ROW);
          console.log(`        no-glow + bg-live: ${J(lk)}`);
          if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the creator row has no fill of its own (${lk.bg})`);
          if ((lk.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((x) => !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the hovered row glows (${lk.shadow})`);
          await shot("ws-creator-live");
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
          await browseWs(); await W({ avatar: libThumb }); await openSide(0);
          await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000); await mvTo(3, 3, 100);
        }
        // the click fills the column's Author field (no pill in the top bar): the creator's name, avatar and list, the
        // Workshop's pill still lit, the search gone, the list's sort, the split button counting it
        const wsName = (await http("GET", "/sources")).json.find((s) => s.supportsTagFilter)?.name;
        const f = await fillFromRow(v, ROW, "creator", "Probe Creator", motion, motion ? "ws-creator-field-in" : null);
        const b = (await browses()).at(-1);
        if (b?.list?.kind !== "creator" || b.list.id !== "76561190000000007") v.push(`the click asked /browse ${J(b?.list)}`);
        if (libThumb && f && !(await waitFor(async () => (await field("creator"))?.avatar === "loaded", 3000))) v.push("the Author field never showed the creator's avatar");
        const st = await page(`return { pills: document.querySelectorAll("[data-ws-pill], .ws-pill, .ws-pill-pair").length, side: !!document.querySelector("${SIDE}"),
            lit: [...document.querySelectorAll(".pill-strip > .pill.active")].map((e) => e.textContent.trim()),
            search: !!document.querySelector(".topbar .tsearch"), sort: document.querySelector("[data-sortsplit=browse] .ss-sort")?.textContent.trim() ?? null };`);
        console.log(`        after the click: ${J(st)}`);
        if (st.pills) v.push(`a list pill is in the top bar (${st.pills})`);
        if (J(st.lit) !== J([wsName])) v.push(`lit: ${J(st.lit)} (want the Workshop's ${J(wsName)})`);
        if (st.search) v.push("the search shows on a creator's list (Steam can't search it)");
        if (st.sort !== "Recently Updated") v.push(`the sort reads ${J(st.sort)}, want the list's "Recently Updated"`);
        if (await splitCount() !== "1") v.push(`the split button counts ${J(await splitCount())} (want 1: the list)`);
        // its × → the whole Workshop: the field empties, the search comes back
        if (!(await clearField("creator"))) v.push("the Author field has no ×");
        await sleep(600);
        const after = await field("creator"), search = await js(`!!document.querySelector(".topbar .tsearch")`);
        if (after?.value !== "" || after?.state !== "off") v.push(`after ×: the field ${J(after)}`);
        if (!search) v.push("the search didn't come back on the whole Workshop");
        const back = (await browses()).at(-1);
        if (back?.list) v.push(`× still asked a list (${J(back.list)})`);
        if (await splitCount() != null) v.push(`after ×: the split button counts ${J(await splitCount())}`);
        return v;
      });
    }

    // ws:creatorSelect — the creator's name is selectable text, the way to copy it: no Copy beside it, at rest or with the row
    // hovered; a real drag across the (long) name selects it and lists nothing, the sidebar stays; Ctrl+C then puts the
    // selection on the clipboard; a plain click on the row still lists their wallpapers (ws:creator). Shot steam-ws-creatorselect.png
    await cell("ws:creatorSelect", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      const NM = "Probe Creator With A Rather Long Steam Name";
      await browseWs(); await W({ avatar: libThumb, creator: { steamId: "76561190000000007", name: NM, avatar: libThumb } }); await mvTo(3, 3); await openSide(0);
      const ROW = `${SIDE} [data-ws-creator]`, NAME = `${ROW} [data-ws-row-name]`;
      if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return ["the creator row never showed the creator"];
      await sleep(300);
      const copies = () => js(`document.querySelector(${J(ROW)}).parentElement.querySelectorAll(".side-copy, [data-copy], .copy-btn").length`);
      if (await copies()) v.push("a Copy sits beside the creator's name");
      const n = await js(`(() => { const e = document.querySelector(${J(NAME)}), b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, us: getComputedStyle(e).userSelect }; })()`);
      await mvTo(n.x + 20, n.y + n.h / 2, 300);
      if (await copies()) v.push("hovering the row shows a Copy");
      if (n.us !== "text") v.push(`the name isn't selectable (user-select ${n.us})`);
      const nb = (await browses()).length;
      await js(`getSelection().removeAllRanges(); true`);
      const y = n.y + n.h / 2;
      send({ type: "mouseDown", x: Math.round(n.x + 1), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
      for (let i = 1; i <= 6; i++) { send({ type: "mouseMove", x: Math.round(n.x + 1 + i * 14), y: Math.round(y), button: "left" }); await sleep(20); }
      send({ type: "mouseUp", x: Math.round(n.x + 85), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(500);
      const sel = await js(`getSelection().toString()`);
      console.log(`        dragged: ${J(sel)}`);
      await shot("ws-creatorselect");
      if (sel.trim().length < 3 || !NM.startsWith(sel.trim())) v.push(`a drag across the name selected ${J(sel)}`);
      await clipboard.writeText("");
      send({ type: "keyDown", keyCode: "C", modifiers: ["control"] }); send({ type: "keyUp", keyCode: "C", modifiers: ["control"] }); await sleep(250);
      const got = await clipboard.readText();
      if (sel.trim().length >= 3 && got !== sel) v.push(`Ctrl+C put ${J(got)} on the clipboard, want ${J(sel)}`);
      await sleep(300);
      if ((await browses()).slice(nb).some((b) => b.list)) v.push("the drag across the name listed the creator's wallpapers");
      if (!(await js(`!!document.querySelector(${J(SIDE)})`))) v.push("the drag closed the sidebar");
      await js(`getSelection().removeAllRanges(); true`); await mvTo(3, 3);
      return v;
    });

    // Browse's long titles: the first Workshop item named far past two lines (the page's stub, __probe_long_title)
    const LONG_T = "An extremely long Workshop wallpaper title that goes on well past the two lines a card and the sidebar's head show";
    const withLongBrowse = async (fn) => {
      await js(`localStorage.setItem("__probe_long_title", ${J(LONG_T)}); true`);
      try { return await fn(); } finally { await js(`localStorage.removeItem("__probe_long_title"); true`).catch(() => {}); await mvTo(3, 3); }
    };
    // side:browseTitle — the Browse sidebar's title: folded (a button, aria-expanded false, two lines), a real click unfolds it to
    // the whole title and another folds it; no Copy in the head: a drag selects its words without unfolding it and Ctrl+C
    // copies them. Shot steam-browsetitle-open.png
    await cell("side:browseTitle", async () => withLongBrowse(async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs(); await openSide(0);
      const T0 = `${SIDE} [data-side-title]`;
      const st = () => js(`(() => { const t = document.querySelector(${J(T0)}); if (!t) return null; const r = t.getBoundingClientRect(), h = t.closest("h2").getBoundingClientRect();
        return { x: r.x, y: r.y, hh: h.height, lh: parseFloat(getComputedStyle(t).lineHeight), exp: t.getAttribute("aria-expanded"), text: t.textContent,
          copies: t.closest(".side-head").querySelectorAll(".side-copy, [data-copy], .copy-btn").length }; })()`);
      const s0 = await st();
      if (!s0) return ["no Browse sidebar title"];
      if (s0.text !== LONG_T) return [`the sidebar shows ${J(s0.text)} — proved nothing`];
      if (s0.exp !== "false" || Math.abs(s0.hh - 2 * s0.lh) > 1) v.push(`folded: ${J(s0)}`);
      await clickAt(s0.x + 30, s0.y + 8); await sleep(700); await shot("browsetitle-open");
      const s1 = await st();
      if (s1.exp !== "true" || s1.hh < 3 * s1.lh) v.push(`a click didn't unfold it: ${J({ exp: s1.exp, hh: s1.hh })}`);
      await clickAt(s1.x + 30, s1.y + 8); await sleep(800);
      const s2 = await st();
      if (s2.exp !== "false" || Math.abs(s2.hh - 2 * s2.lh) > 1) v.push(`another click didn't fold it: ${J({ exp: s2.exp, hh: s2.hh })}`);
      await mvTo(s2.x + 40, s2.y + 10, 350);
      if ((await st()).copies) v.push("the Browse sidebar's head has a Copy button");
      await js(`getSelection().removeAllRanges(); true`);
      const y = s2.y + s2.lh / 2;
      send({ type: "mouseDown", x: Math.round(s2.x + 3), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
      for (let i = 1; i <= 6; i++) { send({ type: "mouseMove", x: Math.round(s2.x + 3 + i * 25), y: Math.round(y), button: "left" }); await sleep(20); }
      send({ type: "mouseUp", x: Math.round(s2.x + 153), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(500);
      const sel = await js(`getSelection().toString()`);
      if (sel.length < 4 || !LONG_T.startsWith(sel.trim().slice(0, 4))) v.push(`a drag across the title selected ${J(sel)}`);
      if ((await st()).exp !== "false") v.push("the drag that selected words unfolded the title");
      await clipboard.writeText("");
      send({ type: "keyDown", keyCode: "C", modifiers: ["control"] }); send({ type: "keyUp", keyCode: "C", modifiers: ["control"] }); await sleep(250);
      const got = await clipboard.readText();
      if (sel.length >= 4 && got !== sel) v.push(`Ctrl+C put ${J(got.slice(0, 50))} on the clipboard, want the selection`);
      await js(`getSelection().removeAllRanges(); true`);
      return v;
    }));

    // look:browseTitles — a Browse card shows its title on two lines like a Library card (clamped, the rest hidden), and a
    // long title moves nothing: every card keeps its box (its height from the thumbnail's aspect-ratio), the grid the same as
    // with short titles. Shot steam-browse-titles.png
    await cell("look:browseTitles", async () => {
      const v = [];
      const grid = () => js(`(() => { const cs = [...document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])")];
        return cs.map((c) => { const r = c.getBoundingClientRect(), s = c.querySelector(".lib-title span"); const lh = s ? parseFloat(getComputedStyle(s).lineHeight) : 0;
          return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), lines: s ? Math.round(s.clientHeight / lh) : 0,
            clamped: s ? s.scrollHeight > s.clientHeight + 1 : false, title: s?.textContent ?? null }; }); })()`);
      await setSettings({ morphs: true }); await browseWs(); await sleep(500);
      const short = await grid();
      const long = await withLongBrowse(async () => { await browseWs(); await sleep(500); await shot("browse-titles"); return grid(); });
      if (!long.length || long[0].title !== LONG_T) return [`the first card reads ${J(long[0]?.title)} — proved nothing`];
      console.log(`        long card: ${J(long[0])}; short: ${J(short[0])}`);
      if (long[0].lines !== 2 || !long[0].clamped) v.push(`the long title shows ${long[0].lines} line(s) (clamped ${long[0].clamped}), want 2, clamped`);
      if (short.length !== long.length) v.push(`${short.length} cards with short titles, ${long.length} with the long one`);
      for (let i = 0; i < Math.min(short.length, long.length); i++) {
        const a = short[i], b = long[i];
        if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5) { v.push(`card ${i} moved or resized with the long title (${J(a)} → ${J(b)})`); break; }
      }
      const hs = long.map((c) => c.h);
      if (Math.max(...hs) - Math.min(...hs) > 0.5) v.push(`the cards' heights differ (${J([...new Set(hs)])})`);
      return v;
    });

    // the favourite: the favourites count pill is the toggle (no Favourite tile) — signed in it reads the state (once the sidebar
    // settles), a click favourites (POST), the star fills and pops once (never on mount), the count goes up by one and the pill
    // keeps its box; Steam refusing puts it back with the reason. Motion off: no pop, nothing moves. Signed out: ws:favoriteSteam.
    for (const motion of [true, false]) {
      await cell(`ws:favorite${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        await W({ fav: { signedIn: true, favorited: false } });
        await openSide(0);
        const FAV = `${SIDE} [data-ws-fav]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "off"`), 3000))) return ["the favourites pill never read its state"];
        const t0 = await page(`const t = document.querySelector(${J(FAV)}); return { count: t.querySelector("[data-fav-count]")?.textContent ?? null, pressed: t.getAttribute("aria-pressed"),
          pop: !!t.querySelector(".ico-pop"), inPills: !!t.closest(".side-hero"), stat: t.dataset.sideStat, tiles: !!document.querySelector("${SIDE} .side-tiles [data-ws-fav]") };`);
        if (t0.count !== "56" || t0.pressed !== "false" || t0.pop || !t0.inPills || t0.stat !== "favorites" || t0.tiles)
          v.push(`at rest: ${J(t0)} (want the favourites pill "56", not pressed, no pop on mount, among the info pills, no tile)`);
        const box0 = await js(`(() => { const e = document.querySelector(${J(FAV)}); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
        const smp = motion ? null : js(MO.SAMPLE({ tile: FAV }, 500));
        if (!motion) await sleep(40);
        const fr = frames(`document.querySelector(${J(FAV)}).click();`, `(() => { const e = document.querySelector(${J(FAV)}); const s = e.querySelector("svg");
          return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight, +new DOMMatrix(getComputedStyle(s).transform).a.toFixed(3)]; })()`, 600);
        if (motion) { await sleep(80); await shot("ws-fav-pop"); }
        const f = await fr;
        await sleep(300);
        const post = (await wsCalls("/workshop/favorite")).filter((c) => c.m === "POST");
        if (post.length !== 1 || post[0].body.workshopId !== "930000" || post[0].body.favorite !== true) v.push(`POSTs: ${J(post)}`);
        const t1 = await page(`const t = document.querySelector(${J(FAV)}); return { count: t.querySelector("[data-fav-count]")?.textContent ?? null, pressed: t.getAttribute("aria-pressed"),
          fill: t.querySelector("svg")?.getAttribute("fill"), pop: !!t.querySelector("svg.ico-pop"), label: t.getAttribute("aria-label") };`);
        if (t1.count !== "57" || t1.pressed !== "true" || t1.fill !== "currentColor" || !t1.pop || !/^Favourited, 57 favourites$/.test(t1.label ?? "")) v.push(`after the click: ${J(t1)}`);
        if (f.some((x) => x && x.slice(0, 4).some((n, k) => Math.abs(n - box0[k]) > 0.75))) v.push(`the pill moved or resized: ${J(box0)} → ${J(f.find((x) => x && x.slice(0, 4).some((n, k) => Math.abs(n - box0[k]) > 0.75)))}`);
        if (motion) {
          const sc = f.filter((x) => x).map((x) => x[4]);
          console.log(`        star scale ${J(sc.slice(0, 8))}`);
          if (!sc.some((a) => a < 0.95)) v.push("the star didn't pop");
        } else {
          const s1 = await smp; console.log(`        motion off: the pill ${MO.brief(s1.tile)}`);
          v.push(...MO.judge("motion off: the pill", s1.tile));
          if (f.some((x) => x && x[4] < 0.99)) v.push("motion off: the star popped");
        }
        // Steam refusing: back to on (the state before), the reason as the pill's tooltip
        await W({ favFail: true });
        await page(`document.querySelector(${J(FAV)}).click();`); await sleep(500);
        const t2 = await page(`const t = document.querySelector(${J(FAV)}); return { state: t.dataset.wsFav, title: t.title, count: t.querySelector("[data-fav-count]")?.textContent ?? null };`);
        if (t2.state !== "on" || !/turned that down/.test(t2.title) || t2.count !== "57") v.push(`a refused unfavourite: ${J(t2)} (want back on, 57, with the reason)`);
        if (motion) {
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ fav: { signedIn: true, favorited: true } }); await openSide(0);
          await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "on"`), 3000); await sleep(400);
          const r = await js(`(() => { const e = document.querySelector(${J(FAV)}).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; })()`);
          await mvTo(r.x, r.y, 300);
          const lk = await looks(FAV);
          if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the pill has no fill (${lk.bg})`);
          if ((lk.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((x) => !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the hovered pill glows (${lk.shadow})`);
          await shot("ws-fav-live");
          await mvTo(3, 3, 100);
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
        }
        return v;
      });
    }

    // the page opener the signed-out controls share: a click → one POST /steam/open-page {workshopId} (`want`: the rest of its
    // body), the Steam app opening it (no browser), nothing sent to `notTo`
    const steamOpenClick = async (sel, want, notTo) => {
      const v = [];
      await page(`window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.__replies = { ...(window.__replies || {}), "/steam/open-page": { body: { ok: true } } };`);
      const nNot = (await wsCalls(notTo)).filter((c) => c.m === "POST" || c.body).length, nOpen = (await wsCalls("/steam/open-page")).length;
      await page(`document.querySelector(${J(sel)}).click();`); await sleep(400);
      const opens = (await wsCalls("/steam/open-page")).slice(nOpen);
      if (opens.length !== 1 || J(opens[0].body) !== J({ workshopId: "930000", ...want })) v.push(`the click sent ${J(opens)} (want one POST /steam/open-page ${J({ workshopId: "930000", ...want })})`);
      if ((await wsCalls(notTo)).filter((c) => c.m === "POST" || c.body).length !== nNot) v.push(`the click sent a POST ${notTo}`);
      if ((await js(`window.__opened.length`)) !== 0) v.push("the browser opened the page though the Steam app could");
      return v;
    };

    // no usable sign-in: the favourites pill says "Favourite on Steam" (its name; the reason as its tooltip) once the state lands,
    // keeping its box (motion off: nothing moves); a click opens the item's page in the Steam app (POST /steam/open-page {watch:
    // "favorite"}: the backend watches its state there) and sends no favourite; the pill stays as it was (Steam's own page takes
    // the star). Shots steam-ws-fav-steam.png, steam-ws-fav-steam-live.png
    for (const motion of [true, false]) {
      await cell(`ws:favoriteSteam${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        // the state answers 700 ms after it is asked (the sidebar settles 350 ms first): the swap lands well inside the sampling
        await W({ fav: { signedIn: false, favorited: null }, favDelay: 700 });
        const FAV = `${SIDE} [data-ws-fav]`;
        await page(`document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) .thumb-wrap")[0].click();`);
        if (!(await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "loading"`), 2000))) return ["the pill never showed while its state was asked — proved nothing"];
        await sleep(450); // the sidebar's open and its body's fade are over
        const box0 = await js(`(() => { const e = document.querySelector(${J(FAV)}); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
        const smp = motion ? null : js(MO.SAMPLE({ tile: FAV }, 1100));
        const fr = motion ? frames("", `(() => { const e = document.querySelector(${J(FAV)}); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`, 1100) : null;
        const f = motion ? await fr : null, s1 = motion ? null : await smp;
        const t = await page(`const t = document.querySelector(${J(FAV)}); return { state: t.dataset.wsFav, label: t.getAttribute("aria-label"),
          disabled: t.disabled, pressed: t.getAttribute("aria-pressed"), title: t.title };`);
        if (t.state !== "signed-out" || !/^Favourite on Steam/.test(t.label ?? "") || t.disabled || t.pressed !== null || !/Steam app/.test(t.title))
          v.push(`signed out: ${J(t)} (want "Favourite on Steam", enabled, no pressed state, the reason as its tooltip)`);
        if (motion) { if (f.some((x) => x && x.some((n, k) => Math.abs(n - box0[k]) > 0.75))) v.push(`the pill moved or resized as its state landed: ${J(box0)}`); }
        else { console.log(`        motion off: the pill ${MO.brief(s1.tile)}`); v.push(...MO.judge("motion off: the pill", s1.tile)); }
        v.push(...await steamOpenClick(FAV, { watch: "favorite" }, "/workshop/favorite"));
        const t2 = await page(`const t = document.querySelector(${J(FAV)}); return { state: t.dataset.wsFav, pop: !!t.querySelector(".ico-pop") };`);
        if (t2.state !== "signed-out" || t2.pop) v.push(`after the click: ${J(t2)} (want unchanged, no pop)`);
        if (motion) {
          await shot("ws-fav-steam");
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ favDelay: 0 }); await openSide(0);
          await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "signed-out"`), 3000); await sleep(400);
          const lk = await looks(FAV);
          if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the pill has no fill (${lk.bg})`);
          if ((lk.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((x) => !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the pill glows (${lk.shadow})`);
          await shot("ws-fav-steam-live");
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
        }
        await W({ favDelay: 0 });
        return v;
      });
    }

    // no usable sign-in: "Comment on Steam" takes the comment box's place, rising in with the comments (motion off: fading in
    // place); a click opens the item's page in the Steam app and posts nothing; signed in the box shows and no button. Shots
    // steam-ws-comment-steam.png, steam-ws-comment-steam-live.png
    for (const motion of [true, false]) {
      await cell(`ws:commentSteam${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        await W({ comments: COMMENTS.slice(0, 3), signedIn: false });
        win.setContentSize(1400, 480); await sleep(300); // the section below the fold: it reads (and its button appears) on the scroll
        await openSide(0); await sleep(500);
        const SEC = `${SIDE} [data-ws-comments]`, BTN = `${SEC} [data-ws-steam-comment]`;
        if (await js(`!!document.querySelector(${J(BTN)})`)) { win.setContentSize(1400, 900); return ["the button was there before the comments were read — proved nothing"]; }
        const scroll = `const e = document.querySelector(${J(SEC)}), sc = e.closest(".side-scroll"); sc.scrollTop += e.getBoundingClientRect().top - sc.getBoundingClientRect().top - 40;`;
        const smp = motion ? null : js(MO.SAMPLE({ btn: BTN }, 700));
        const fr = frames(scroll, `(() => { const e = document.querySelector(${J(BTN)}); if (!e) return null; const cs = getComputedStyle(e); return [+cs.opacity, new DOMMatrix(cs.transform).m42]; })()`, 700);
        if (motion) { await sleep(120); await shot("ws-comment-steam-in"); }
        const f = await fr, s1 = motion ? null : await smp;
        await sleep(300);
        const r = await page(`const b = document.querySelector(${J(BTN)}); return b && { text: b.textContent.trim(), box: !!document.querySelector("${SEC} textarea"),
          icon: !!b.querySelector("svg.lucide-external-link"), title: b.title };`);
        if (!r || r.text !== "Comment on Steam" || r.box || !r.icon || !/Steam app/.test(r.title)) v.push(`signed out: ${J(r)} (want "Comment on Steam" with its icon and reason, no box)`);
        if (motion) {
          const ops = f.filter((x) => x).map((x) => x[0]), ys = f.filter((x) => x).map((x) => x[1]);
          console.log(`        "Comment on Steam": opacity ${J(ops.slice(0, 8).map((o) => +o.toFixed(2)))} y ${J(ys.slice(0, 8).map((o) => +o.toFixed(1)))}`);
          if (between(ops, 0.05) < 2 || between(ys, 0.3) < 2) v.push("\"Comment on Steam\" popped in (no in-between frames)");
        } else {
          console.log(`        motion off: "Comment on Steam" ${MO.brief(s1.btn)}`);
          v.push(...MO.judge("motion off: \"Comment on Steam\"", s1.btn, { appear: true }));
        }
        v.push(...await steamOpenClick(BTN, {}, "/workshop/comment"));
        win.setContentSize(1400, 900); await sleep(300);
        if (motion) {
          await shot("ws-comment-steam");
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ comments: COMMENTS.slice(0, 3), signedIn: false }); await openSide(0); await scrollSideTo(SEC);
          await waitFor(() => js(`!!document.querySelector(${J(BTN)})`), 3000); await sleep(500);
          const lk = await looks(SEC);
          if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the section has no fill (${lk.bg})`);
          await shot("ws-comment-steam-live");
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
          // signed in: the box, no button
          await browseWs(); await W({ comments: COMMENTS.slice(0, 3), signedIn: true }); await openSide(0); await scrollSideTo(SEC);
          if (!(await waitFor(() => js(`!!document.querySelector("${SEC} textarea")`), 3000))) v.push("signed in: the comment box never showed");
          if (await js(`!!document.querySelector(${J(BTN)})`)) v.push("signed in: \"Comment on Steam\" shows beside the box");
        }
        return v;
      });
    }

    // the comments: read only once their section comes into view; 10 newest first, "Show older" pages, the creator's comment
    // marked, the text plain (markup shows as typed, nothing injected); they rise in (motion off: fade); signed out no box
    // (ws:commentSteam); a failed read a quiet line with Retry
    for (const motion of [true, false]) {
      await cell(`ws:comments${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        await W({ comments: COMMENTS, signedIn: false });
        win.setContentSize(1400, 480); await sleep(300); // the section below the sidebar's fold: its read waits for it
        await openSide(0); await sleep(500);
        const SEC = `${SIDE} [data-ws-comments]`;
        const inView = await page(`const e = document.querySelector(${J(SEC)}), sc = e?.closest(".side-scroll"); if (!e) return null;
          return e.getBoundingClientRect().top < sc.getBoundingClientRect().bottom + 120;`);
        if (inView === null) return ["no comments section"];
        if (inView) v.push("the comments section is in view at once — the lazy read proved nothing");
        else if ((await wsCalls("/workshop/comments")).length) v.push("the comments were read before their section came into view");
        const smp = motion ? null : js(MO.SAMPLE({ c: `${SEC} .ws-c` }, 600));
        const fr = frames(`const e = document.querySelector(${J(SEC)}), sc = e.closest(".side-scroll"); sc.scrollTop += e.getBoundingClientRect().top - sc.getBoundingClientRect().top - 40;`,
          `(() => { const e = document.querySelector("${SEC} .ws-c"); if (!e) return null; const cs = getComputedStyle(e); return [+cs.opacity, new DOMMatrix(cs.transform).m42]; })()`, 700);
        if (motion) { await sleep(120); await shot("ws-comments-in"); }
        const f = await fr;
        await sleep(400);
        const calls = await wsCalls("/workshop/comments");
        if (calls.length !== 1 || calls[0].start !== 0 || calls[0].count !== 10) v.push(`reads: ${J(calls)} (want one, start 0, count 10)`);
        const r = await page(`const s = document.querySelector(${J(SEC)}); const cs = [...s.querySelectorAll(".ws-c")];
          return { n: cs.length, count: s.querySelector("[data-ws-count]")?.textContent, first: cs[0]?.querySelector("[data-ws-text]")?.textContent,
            firstEls: cs[0]?.querySelector("[data-ws-text]")?.children.length, img: !!s.querySelector(".ws-c-text img, .ws-c-text b"), pwned: !!window.__pwned,
            op: cs.findIndex((c) => c.querySelector(".ws-c-op")), signin: !!s.querySelector("[data-ws-steam-comment]"), box: !!s.querySelector("textarea"),
            more: !!s.querySelector("[data-ws-more]"), avatars: s.querySelectorAll('[data-ws-avatar="loaded"]').length };`);
        console.log(`        ${J(r)}`);
        if (r.n !== 10 || r.count !== "23") v.push(`shown ${r.n} of ${r.count} (want 10 of 23)`);
        if (r.first !== "first line\n<b>not bold</b> <img src=x onerror=window.__pwned=1>" || r.firstEls !== 0 || r.img || r.pwned) v.push(`the text isn't plain: ${J(r)}`);
        if (r.op !== 3) v.push(`the creator's comment isn't marked (index ${r.op}, want 3)`);
        if (!r.signin || r.box) v.push(`signed out: "Comment on Steam" ${r.signin}, box ${r.box}`);
        if (!r.more) v.push("no Show older");
        if (motion) {
          const ops = f.filter((x) => x).map((x) => x[0]), ys = f.filter((x) => x).map((x) => x[1]);
          console.log(`        first comment: opacity ${J(ops.slice(0, 8).map((o) => +o.toFixed(2)))} y ${J(ys.slice(0, 8).map((o) => +o.toFixed(1)))}`);
          if (between(ops, 0.05) < 2 || between(ys, 0.3) < 2) v.push("the comments popped in (no in-between frames)");
        } else {
          const s1 = await smp; console.log(`        motion off: comment in ${MO.brief(s1.c)}`);
          v.push(...MO.judge("motion off: a comment appearing", s1.c, { appear: true, size: false }));
        }
        await page(`document.querySelector("${SEC} [data-ws-more]").click();`); await sleep(500);
        const r2 = await page(`return document.querySelectorAll("${SEC} .ws-c").length;`);
        const c2 = (await wsCalls("/workshop/comments")).at(-1);
        if (r2 !== 20 || c2?.start !== 10) v.push(`Show older: ${r2} shown, asked start ${c2?.start}`);
        win.setContentSize(1400, 900); await sleep(300);
        if (motion) {
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ comments: COMMENTS }); await openSide(0); await scrollSideTo(SEC);
          await waitFor(() => js(`document.querySelectorAll("${SEC} .ws-c").length > 0`), 3000); await sleep(400);
          const lk = await looks(SEC);
          if (!/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the section has no fill (${lk.bg})`);
          await shot("ws-comments-live");
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
          // a failed read: a quiet line with Retry, no crash
          await browseWs(); await W({ comFail: true }); await openSide(0); await scrollSideTo(SEC);
          if (!(await waitFor(() => js(`!!document.querySelector("${SEC} [data-ws-error]")`), 3000))) v.push("a failed read shows no quiet line");
          await W({ comFail: false, comments: COMMENTS });
          await page(`document.querySelector("${SEC} .ws-retry").click();`); await sleep(500);
          if ((await js(`document.querySelectorAll("${SEC} .ws-c").length`)) !== 10) v.push("Retry didn't read the comments");
        }
        return v;
      });
    }

    // ---- Steam's cooldown (components/SteamCooldown.tsx): one notice per surface, counting down to the backend's end ----
    // The reads are this page's stub: each answers the backend's 429 with how long is left (W.*Cool); its end is a
    // `steam-status` {cooldownMs: 0} (the backend's Changed) or the countdown running out on its own (cool:end).
    const COOL_WORDS = /^Steam is limiting requests from this connection — back in (\d+) (min|s)$/;
    const COOL_NOTE = `.br-scroll [data-ws-set-load="cooldown"]`;
    const SIDE_COOL = `${SIDE} [data-cool-side]`;
    const opY = (sel) => `(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const cs = getComputedStyle(e); return [+cs.opacity, new DOMMatrix(cs.transform).m42]; })()`;
    const pillClick = (n) => `[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(n)})?.click();`;
    const srcNames = async () => { const s = (await http("GET", "/sources")).json; return { ws: s.find((x) => x.supportsTagFilter)?.name, other: s.find((x) => !x.supportsTagFilter && x.available)?.name }; };
    const wsBrowses = async () => (await browses()).filter((b) => b.filter);
    const coolEnd = () => ev("steam-cooldown", { cooldownMs: 0 });

    // cool:browse[Off] — Browse's Workshop list refused for the cooldown (a source switch back to the Workshop): the notice over
    // the grid in the favourites line's look (the warn colour, no Retry), its words "… — back in 2 min", the only notice on the
    // page (no status line, no list note), rising in (Off: fading in place); the count goes on by itself (95 s: "2 min", then
    // "90 s", "89 s"); nothing more asked while it lasts; the backend's end → it leaves (Off: a fade) and the list is asked
    // again, its cards back. On: no-glow + bg-live keep its fill. Shots steam-cool-browse*.png
    for (const motion of [true, false]) {
      await cell(`cool:browse${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        if (!motion && !(await js(`document.documentElement.classList.contains("no-motion")`))) return ["motion off: the page isn't in no-motion — proved nothing"];
        const { ws, other } = await srcNames();
        if (!other) return ["no other source to switch to — proved nothing"];
        await page(pillClick(other)); await sleep(600);
        await W({ browseCool: 95_000 });
        const nb = (await wsBrowses()).length;
        const smp = motion ? null : js(MO.SAMPLE({ n: COOL_NOTE }, 700));
        if (!motion) await sleep(40);
        const fr = frames(pillClick(ws), opY(COOL_NOTE), 700);
        if (motion) { await sleep(130); await shot("cool-browse-in"); }
        const f = await fr;
        await sleep(300);
        const r = await page(`const e = document.querySelector(${J(COOL_NOTE)}); if (!e) return null; const t = e.querySelector(".wsl-text");
          return { text: t.textContent, notices: document.querySelectorAll("[data-ws-set-load], [data-ws-list-note], [data-cool-side]").length,
            status: document.querySelector(".status")?.textContent ?? "", retry: !!e.querySelector("button"), color: getComputedStyle(t).color,
            role: e.getAttribute("role") };`);
        const warn = await js(`(() => { const d = document.createElement("i"); d.style.color = "var(--warn)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
        console.log(`        ${J(r)}`);
        if (!r) return ["no cooldown notice over Browse's grid"];
        if (!/^Steam is limiting requests from this connection — back in 2 min$/.test(r.text)) v.push(`the words: ${J(r.text)} (want "… — back in 2 min")`);
        if (r.notices !== 1) v.push(`${r.notices} notices on the page (want the one)`);
        if (/limiting/.test(r.status)) v.push(`the status line says it too: ${J(r.status)}`);
        if (r.retry) v.push("the notice has a button (the list asks again by itself)");
        if (r.color !== warn) v.push(`its words are ${r.color} (want the warn colour ${warn})`);
        if (r.role !== "status") v.push(`role ${r.role} (want status)`);
        if (motion) {
          const ops = f.filter((x) => x).map((x) => x[0]), ys = f.filter((x) => x).map((x) => x[1]);
          console.log(`        in: opacity ${J(ops.slice(0, 10).map((o) => +o.toFixed(2)))} y ${J(ys.slice(0, 10).map((o) => +o.toFixed(1)))}`);
          if (between(ops, 0.05) < 2) v.push("the notice popped in (no in-between opacity frames)");
          if (between(ys, 0.3) < 1) v.push("the notice didn't rise in");
        } else {
          const s1 = await smp; console.log(`        motion off: in ${MO.brief(s1.n)}`);
          v.push(...MO.judge("motion off: the notice appearing", s1.n, { appear: true, size: false }));
        }
        // the count, live: "2 min" until 90 s are left, then the seconds, one a second
        const words = () => js(`document.querySelector(${J(COOL_NOTE)} + " .wsl-text")?.textContent ?? null`);
        const secs = await waitFor(async () => { const w = await words(); const m = COOL_WORDS.exec(w ?? ""); return m && m[2] === "s" ? +m[1] : null; }, 8000);
        await sleep(1100);
        const m2 = COOL_WORDS.exec((await words()) ?? "");
        console.log(`        the count: ${secs} s, then ${m2?.[1]} ${m2?.[2]}`);
        if (!secs || secs > 90 || secs < 85) v.push(`the count never turned to seconds at 90 s (${secs})`);
        else if (!m2 || m2[2] !== "s" || +m2[1] >= secs || +m2[1] < secs - 2) v.push(`the count didn't go on: ${secs} s, then ${J(m2?.[0])}`);
        const during = (await wsBrowses()).slice(nb);
        if (during.length !== 1) v.push(`${during.length} Workshop reads during the cooldown (want the one refused)`);
        if (motion) await shot("cool-browse");
        // the end: the notice leaves, the list is asked again and shows
        await W({ browseCool: 0 });
        const n1 = (await wsBrowses()).length;
        // a scroller's scrollbar, as thick as the page draws it
        const bar = await js(`(() => { const d = document.createElement("div"); d.className = "scroll"; d.style.cssText = "position:absolute;left:-999px;width:100px;height:50px;overflow-y:scroll";
          document.body.append(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; })()`);
        const smp2 = motion ? null : js(MO.SAMPLE({ n: COOL_NOTE }, 700));
        if (!motion) await sleep(40);
        const fo = frames(`window.__fakeWs("steam-cooldown", { cooldownMs: 0 });`, opY(COOL_NOTE), 700);
        const g = await fo;
        await sleep(500);
        const after = await page(`return { note: !!document.querySelector(${J(COOL_NOTE)}), cards: document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length };`);
        const again = (await wsBrowses()).slice(n1);
        console.log(`        after the end: ${J(after)}, asked ${J(again.map((b) => b.page))}`);
        if (after.note) v.push("the notice stayed after the cooldown ended");
        if (again.filter((b) => b.page === 1).length !== 1 || again[0]?.page !== 1) v.push(`after the end the list was asked ${J(again.map((b) => b.page))} (want page 1 once, first)`);
        if (!after.cards) v.push("no cards after the end");
        if (motion) {
          const ops = g.filter((x) => x).map((x) => x[0]);
          if (between(ops, 0.05) < 2) v.push(`the notice vanished (no in-between frames: ${J(ops.slice(0, 10))})`);
        } else {
          const s2 = await smp2; console.log(`        motion off: out ${MO.brief(s2.n)}`);
          // the list coming back (its cards, then a moment of placeholders until the next page answers) can bring the
          // scroller's scrollbar, which re-centres the line at once by half its thickness (a layout change, not a motion):
          // anything else that moves or resizes fails
          const dx = bar / 2 + 0.75;
          const shown = s2.n.filter((x) => x[1] != null), f0 = shown[0];
          const moved = shown.find((x) => Math.abs(x[3] - f0[3]) > 0.75 || Math.abs(x[4] - f0[4]) > 0.75 || Math.abs(x[5] - f0[5]) > 0.75 || Math.abs(x[2] - f0[2]) > dx);
          if (moved) v.push(`motion off: the notice moved while leaving (${J(f0)} → ${J(moved)}; a scrollbar is ${bar} px)`);
          v.push(...MO.judge("motion off: the notice leaving", s2.n, { leave: true, size: false, still: false }));
        }
        if (motion) {
          // no-glow + bg-live (a fresh page: the toggles apply on load): the notice keeps its fill
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await page(pillClick(other)); await sleep(600);
          await W({ browseCool: 95_000 }); await page(pillClick(ws));
          await waitFor(() => js(`!!document.querySelector(${J(COOL_NOTE)})`), 3000); await sleep(500);
          const lk = await looks(COOL_NOTE);
          if (!/no-glow/.test(lk?.html ?? "") || !/bg-live/.test(lk?.html ?? "")) v.push(`the toggles didn't apply: ${lk?.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk?.bg ?? "")) v.push(`bg-live: the notice has no fill (${lk?.bg})`);
          await shot("cool-browse-live");
          await W({ browseCool: 0 }); await coolEnd();
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
        }
        return v;
      });
    }

    // cool:end — the countdown running out on its own (no event): Browse's notice ("3 s") leaves at 0 and the list is asked
    // again once; the sidebar's comments refused at its open read again by themselves once it is over, not before
    await cell("cool:end", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      const { ws, other } = await srcNames();
      if (!other) return ["no other source to switch to — proved nothing"];
      await page(pillClick(other)); await sleep(600);
      await W({ browseCool: 3000 });
      const nb = (await wsBrowses()).length;
      await page(pillClick(ws));
      if (!(await waitFor(() => js(`!!document.querySelector(${J(COOL_NOTE)})`), 2000))) return ["no notice for a 3 s cooldown"];
      await W({ browseCool: 0 }); // the stub would answer now: nothing may ask before the end
      const t0 = await js(`performance.now()`);
      await sleep(1200);
      if ((await wsBrowses()).length !== nb + 1) v.push("the list was asked again before the cooldown ended");
      const gone = await waitFor(() => js(`!document.querySelector(${J(COOL_NOTE)})`), 4000);
      await sleep(400);
      const again = (await wsBrowses()).slice(nb + 1).filter((b) => b.page === 1);
      if (!gone) v.push("the notice stayed after its countdown ran out");
      if (again.length !== 1 || again[0].t - t0 < 1500) v.push(`after the countdown the list was asked ${again.length} time(s) (${J(again.map((b) => Math.round(b.t - t0)))} ms in; want once, at the end)`);
      // the sidebar: the comments refused while it opened, read again by themselves when the countdown ends
      await W({ comments: COMMENTS, signedIn: false, comCool: 3000 });
      await openSide(0);
      const SEC = `${SIDE} [data-ws-comments]`;
      await scrollSideTo(SEC);
      if (!(await waitFor(() => js(`document.querySelector(${J(SEC)})?.dataset.wsComments === "cooled"`), 3000))) return [...v, "the comments weren't refused — proved nothing"];
      await W({ comCool: 0 });
      const c0 = await wsCalls("/workshop/comments");
      if (!(await waitFor(() => js(`document.querySelectorAll("${SEC} .ws-c").length === 10`), 5000))) v.push("the comments didn't come once the countdown ran out");
      const c1 = await wsCalls("/workshop/comments");
      const dt = c1.length === c0.length + 1 ? c1.at(-1).t - c0.at(-1).t : null;
      console.log(`        comments asked ${c0.length} → ${c1.length}, again after ${Math.round(dt)} ms`);
      if (c1.length !== c0.length + 1 || dt < 2500) v.push(`the comments were asked again ${c1.length - c0.length} time(s), ${Math.round(dt)} ms after the refusal (want once, at the end)`);
      if (!(await waitFor(() => js(`!document.querySelector(${J(SIDE_COOL)})`), 1500))) v.push("the sidebar's notice stayed after the end");
      // a cooldown of a second (Steam's Retry-After: 1): still the notice, and the list asked again once it is over
      await page(`document.querySelector("${SIDE} .side-close")?.click(); return true;`); await sleep(400);
      await page(pillClick(other)); await sleep(600);
      await W({ browseCool: 1000 });
      const nc = (await wsBrowses()).length;
      await page(pillClick(ws)); await sleep(150);
      await W({ browseCool: 0 });
      const short = await js(`document.querySelector(${J(COOL_NOTE)} + " .wsl-text")?.textContent ?? null`);
      await sleep(2000);
      const asked = (await wsBrowses()).slice(nc).filter((b) => b.page === 1).length;
      const st2 = await js(`document.querySelector(".status")?.textContent ?? ""`);
      console.log(`        a 1 s cooldown: ${J(short)}, page 1 asked ${asked} time(s), status ${J(st2)}`);
      if (!/back in 1 s$/.test(short ?? "")) v.push(`a 1 s cooldown showed ${J(short)} (want "… — back in 1 s")`);
      if (asked !== 2) v.push(`a 1 s cooldown: page 1 asked ${asked} time(s) (want the refused one and once more at its end)`);
      if (/limiting/.test(st2)) v.push(`a 1 s cooldown went to the status line: ${J(st2)}`);
      return v;
    });

    // cool:stale — a Steam status read asked before a cooldown began (held while the page reconnects) and answered after it,
    // saying none: older news than the cooldown, so the notice stays and the list isn't asked early
    await cell("cool:stale", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      const { ws, other } = await srcNames();
      if (!other) return ["no other source to switch to — proved nothing"];
      await page(pillClick(other)); await sleep(600);
      await js(`window.__st.status = { ...window.__st.status, cooldownMs: 0 }; window.__stHold = []; window.__wsDrop()`);
      if (!(await waitFor(() => js(`window.__stHold.length > 0`), 5000))) return ["the reconnect asked no status — proved nothing"];
      await W({ browseCool: 95_000 });
      const nb = (await wsBrowses()).length;
      await page(pillClick(ws));
      if (!(await waitFor(() => js(`!!document.querySelector(${J(COOL_NOTE)})`), 3000))) return ["no notice for the refused list — proved nothing"];
      await js(`{ const h = window.__stHold; window.__stHold = null; h.forEach((r) => r()); } true`);
      await sleep(800);
      const still = await js(`!!document.querySelector(${J(COOL_NOTE)})`), asked = (await wsBrowses()).slice(nb).length;
      console.log(`        after the stale status: notice ${still}, Workshop reads ${asked}`);
      if (!still) v.push("a status read asked before the cooldown ended it");
      if (asked !== 1) v.push(`the list was asked ${asked} times (want the refused one only)`);
      await W({ browseCool: 0 }); await coolEnd(); await sleep(400);
      // and the other way: a read held while a cooldown was on says so after the backend said it was over (the page never
      // knew of it): older news again, no notice (the sidebar's would show it: Browse's list wasn't refused)
      await openSide(0);
      await js(`window.__st.status = { ...window.__st.status, cooldownMs: 95000 }; window.__stHold = []; window.__wsDrop()`);
      if (!(await waitFor(() => js(`window.__stHold.length > 0`), 5000))) return [...v, "the second reconnect asked no status — proved nothing"];
      await coolEnd(); await sleep(200);
      await js(`{ const h = window.__stHold; window.__stHold = null; h.forEach((r) => r()); } true`);
      await sleep(800);
      const back = await js(`!!document.querySelector(${J(COOL_NOTE)}) || !!document.querySelector("[data-cool-side]")`);
      if (back) v.push("a status read asked before the backend said the cooldown was over brought a notice back");
      await js(`window.__st.status = { ...window.__st.status, cooldownMs: 0 }; true`);
      return v;
    });

    // cool:local — Browse's list refused, then a view of the page's own (the In my library ✓): the notice is the refused list's,
    // so it goes with it, and the view stays as it is when the cooldown ends (no Workshop read)
    await cell("cool:local", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      const { ws, other } = await srcNames();
      if (!other) return ["no other source to switch to — proved nothing"];
      await page(pillClick(other)); await sleep(600);
      await W({ browseCool: 95_000 });
      await page(pillClick(ws));
      if (!(await waitFor(() => js(`!!document.querySelector(${J(COOL_NOTE)})`), 3000))) return ["no notice for the refused list — proved nothing"];
      const row = (s) => page(`const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") { t?.click(); await new Promise((r) => setTimeout(r, 450)); }
        const b = document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@library"] [data-seg=' + ${J(J(s))} + ']'); if (!b) return false; b.click(); return true;`);
      if (!(await row("inc"))) return ["no In my library row — proved nothing"];
      await sleep(900);
      const nb = (await wsBrowses()).length;
      const gone = await js(`!document.querySelector(${J(COOL_NOTE)})`);
      if (!gone) v.push("the refused list's notice stayed over the local set");
      await coolEnd(); await sleep(600);
      if ((await wsBrowses()).length !== nb) v.push("the cooldown's end asked the Workshop under the local set");
      await W({ browseCool: 0 });
      await row("off"); await sleep(600);
      return v;
    });

    // cool:more — the next page refused for the cooldown: its notice, the cards already shown kept, no more page asked while it
    // lasts (the placeholders ask nothing); at the end that page is asked once by itself
    await cell("cool:more", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      await W({ moreCool: 95_000 });
      const nb = (await wsBrowses()).length;
      await page(`const sc = document.querySelector(".br-scroll"); sc.scrollTop = sc.scrollHeight; return true;`);
      if (!(await waitFor(() => js(`!!document.querySelector(${J(COOL_NOTE)})`), 4000))) return ["no notice when the next page was refused"];
      await sleep(1500);
      const p2 = (await wsBrowses()).slice(nb).filter((b) => b.page === 2);
      const cards = await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length`);
      if (p2.length !== 1) v.push(`page 2 asked ${p2.length} times during the cooldown (want the one refused)`);
      if (cards < 6) v.push(`${cards} cards (want the first page's 6 kept)`);
      await W({ moreCool: 0 });
      await coolEnd(); await sleep(800);
      const p2b = (await wsBrowses()).slice(nb).filter((b) => b.page === 2);
      if (p2b.length !== 2) v.push(`page 2 asked ${p2b.length} times in all (want once more at the end)`);
      if (await js(`!!document.querySelector(${J(COOL_NOTE)})`)) v.push("the notice stayed after the end");
      return v;
    });

    // cool:side[Off] — the item sidebar: a cooldown starting while it shows (steam-status) → its notice among the body's notices
    // (the preset notice's block: the warn stripe, before the action area), rising in while the action area glides down (Off:
    // fading in place); an item opened during it: the comments and the creator refused, no error line, the creator row still
    // waiting ("…"); the end → the notice leaves (Off: a fade), the comments and the creator asked again by themselves.
    // On: no-glow + bg-live. Shots steam-cool-side*.png
    for (const motion of [true, false]) {
      await cell(`cool:side${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs();
        await W({ comments: COMMENTS, signedIn: false });
        await openSide(0); await sleep(700);
        if (await js(`!!document.querySelector(${J(SIDE_COOL)})`)) return ["a cooldown notice with no cooldown"];
        const CTA = `${SIDE} [data-side-part="cta"]`;
        const smp = motion ? null : js(MO.SAMPLE({ n: SIDE_COOL }, 700));
        if (!motion) await sleep(40);
        const fr = frames(`window.__fakeWs("steam-cooldown", { cooldownMs: 95000 });`,
          `(() => { const e = document.querySelector(${J(SIDE_COOL)}), c = document.querySelector(${J(CTA)}); return [e ? +getComputedStyle(e).opacity : null, c ? +c.getBoundingClientRect().top.toFixed(1) : null]; })()`, 700);
        if (motion) { await sleep(110); await shot("cool-side-in"); }
        const f = await fr;
        await sleep(300);
        const r = await page(`const n = document.querySelector(${J(SIDE_COOL)}); if (!n) return null; const cta = document.querySelector(${J(CTA)}), hero = document.querySelector("${SIDE} .side-hero");
          return { text: n.querySelector("[data-cool-words]").textContent, beforeCta: !!(n.compareDocumentPosition(cta) & 4), afterHero: !!(hero.compareDocumentPosition(n) & 4),
            body: n.parentElement.classList.contains("side-body"), block: n.classList.contains("side-crash") && n.classList.contains("side-preset"), role: n.getAttribute("role"),
            n: document.querySelectorAll("[data-cool-side], [data-ws-set-load='cooldown']").length };`);
        console.log(`        ${J(r)}`);
        if (!r) return ["no notice in the sidebar after the cooldown started"];
        if (!/^Steam is limiting requests from this connection — back in 2 min$/.test(r.text)) v.push(`the words: ${J(r.text)}`);
        if (!r.body || !r.beforeCta || !r.afterHero || !r.block) v.push(`placement / look: ${J(r)} (want the body's notice block, after the pills, before the action area)`);
        if (r.n !== 1) v.push(`${r.n} cooldown notices on the page (want the sidebar's one: Browse's list wasn't refused)`);
        if (motion) {
          const ops = f.filter((x) => x && x[0] != null).map((x) => x[0]), ctas = f.filter((x) => x).map((x) => x[1]);
          console.log(`        in: opacity ${J(ops.slice(0, 8).map((o) => +o.toFixed(2)))} cta ${J(ctas.slice(0, 8))}`);
          if (between(ops, 0.05) < 2) v.push("the notice popped in");
          if (between(ctas, 1) < 2) v.push("the action area jumped down (no glide)");
        } else {
          const s1 = await smp; console.log(`        motion off: in ${MO.brief(s1.n)}`);
          v.push(...MO.judge("motion off: the notice appearing", s1.n, { appear: true, size: false }));
        }
        if (motion) await shot("cool-side");
        // another item opened during the cooldown: its reads refused, nothing says so twice
        await W({ comCool: 95_000, creatorCool: 95_000 });
        await openSide(1); await sleep(600);
        const SEC = `${SIDE} [data-ws-comments]`;
        await scrollSideTo(SEC);
        await waitFor(() => js(`document.querySelector(${J(SEC)})?.dataset.wsComments === "cooled"`), 3000);
        const d = await page(`const s = document.querySelector(${J(SEC)}), c = document.querySelector("${SIDE} [data-ws-creator]");
          return { com: s?.dataset.wsComments, error: !!s?.querySelector("[data-ws-error]"), loading: !!s?.querySelector("[data-ws-loading]"), shown: s?.querySelectorAll(".ws-c").length,
            creator: c?.dataset.wsCreator, name: c?.querySelector("[data-ws-row-name]")?.textContent, note: !!document.querySelector(${J(SIDE_COOL)}),
            arrive: document.querySelector(${J(SIDE_COOL)})?.classList.contains("arrive") };`);
        console.log(`        during: ${J(d)}`);
        if (d.com !== "cooled" || d.error || d.loading || d.shown) v.push(`the comments during the cooldown: ${J(d)} (want refused, no line of their own)`);
        if (d.creator !== "loading" || d.name !== "…") v.push(`the creator row during the cooldown: ${J(d)} (want still "…")`);
        if (!d.note || d.arrive) v.push(`the opened item's notice: ${J(d)} (want there from the open, coming in with the body)`);
        const c0 = (await wsCalls("/workshop/comments")).length, cr0 = (await wsCalls("/workshop/creator")).length;
        if (!c0 || !cr0) v.push(`nothing was refused (comments ${c0}, creator ${cr0}) — proved nothing`);
        // the end
        await W({ comCool: 0, creatorCool: 0 });
        const smp2 = motion ? null : js(MO.SAMPLE({ n: SIDE_COOL }, 700));
        if (!motion) await sleep(40);
        const fo = frames(`window.__fakeWs("steam-cooldown", { cooldownMs: 0 });`, `(() => { const e = document.querySelector(${J(SIDE_COOL)}); return e ? +getComputedStyle(e).opacity : null; })()`, 600);
        const g = await fo;
        await waitFor(() => js(`document.querySelectorAll("${SEC} .ws-c").length === 10`), 3000); await sleep(300);
        const e = await page(`const c = document.querySelector("${SIDE} [data-ws-creator]");
          return { note: !!document.querySelector(${J(SIDE_COOL)}), shown: document.querySelectorAll("${SEC} .ws-c").length, name: c?.querySelector("[data-ws-row-name]")?.textContent };`);
        const c1 = (await wsCalls("/workshop/comments")).length, cr1 = (await wsCalls("/workshop/creator")).length;
        console.log(`        after the end: ${J(e)}, comments asked ${c0} → ${c1}, creator ${cr0} → ${cr1}`);
        if (e.note) v.push("the notice stayed after the end");
        if (e.shown !== 10 || c1 !== c0 + 1) v.push(`the comments after the end: ${e.shown} shown, asked ${c1 - c0} more (want 10, once)`);
        if (e.name !== "Probe Creator" || cr1 !== cr0 + 1) v.push(`the creator after the end: ${J(e.name)}, asked ${cr1 - cr0} more (want "Probe Creator", once)`);
        if (motion) {
          const ops = g.filter((x) => x != null);
          if (between(ops, 0.05) < 2) v.push(`the notice vanished (no in-between frames: ${J(ops.slice(0, 10))})`);
        } else {
          const s2 = await smp2; console.log(`        motion off: out ${MO.brief(s2.n)}`);
          v.push(...MO.judge("motion off: the notice leaving", s2.n, { leave: true, size: false }));
        }
        if (motion) {
          // no-glow + bg-live (a fresh page: the toggles apply on load): its own fill, the stripe without its glow
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await browseWs(); await W({ comments: COMMENTS, signedIn: false }); await openSide(0); await sleep(500);
          await ev("steam-cooldown", { cooldownMs: 95_000 });
          await waitFor(() => js(`!!document.querySelector(${J(SIDE_COOL)})`), 3000); await sleep(500);
          const lk = await looks(SIDE_COOL);
          if (!/no-glow/.test(lk?.html ?? "") || !/bg-live/.test(lk?.html ?? "")) v.push(`the toggles didn't apply: ${lk?.html}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk?.bg ?? "")) v.push(`bg-live: the notice has no fill (${lk?.bg})`);
          const stripe = await js(`getComputedStyle(document.querySelector(${J(SIDE_COOL)}), "::before").boxShadow`);
          if (stripe && stripe !== "none") v.push(`no-glow: the stripe still glows (${stripe})`);
          await shot("cool-side-live");
          await coolEnd();
          await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
        }
        return v;
      });
    }

    // cool:author — a custom profile name looked up during the cooldown: the Author field's own error state with the cooldown's
    // short words, counting; the typed text kept; at the end the field asks again by itself and opens that creator's list
    await cell("cool:author", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      if (!(await openCol())) return ["no Author field in Browse's filter column"];
      const LINK = "https://steamcommunity.com/id/someone-new";
      await W({ authorCool: 95_000, authors: { [LINK]: { steamId: "76561190000000099", name: "Someone New", avatar: null } } });
      const n0 = (await wsCalls("/workshop/author")).length;
      await typeIn("creator", LINK);
      await waitFor(async () => (await field("creator"))?.state === "error", 3000); await sleep(300);
      const f = await field("creator");
      console.log(`        during: ${J(f)}`);
      if (f?.state !== "error" || !/^Steam is limiting requests — back in 2 min$/.test(f?.err ?? "")) v.push(`the field during the cooldown: ${J(f)} (want its error state, "Steam is limiting requests — back in 2 min")`);
      if (f?.value !== LINK) v.push(`the typed text wasn't kept (${J(f?.value)})`);
      const fits = await js(`(() => { const e = document.querySelector(${J(LFIELD("creator") + " [data-wf-field-err]")}); return e ? e.scrollWidth <= e.clientWidth + 1 : null; })()`);
      if (fits === false) v.push("the field's cooldown words are cut off");
      await shot("cool-author");
      await W({ authorCool: 0 });
      await coolEnd();
      await waitFor(async () => (await field("creator"))?.state === "on", 3000); await sleep(300);
      const g = await field("creator"), asks = (await wsCalls("/workshop/author")).slice(n0), l = await lastList();
      console.log(`        after the end: ${J(g)}; asked ${J(asks.map((a) => a.q))}; list ${J(l)}`);
      if (g?.state !== "on" || g.value !== "Someone New" || g.err) v.push(`the field after the end: ${J(g)} (want "Someone New", on)`);
      if (asks.length !== 2) v.push(`/workshop/author asked ${asks.length} times (want the refused one and once more at the end)`);
      if (l?.kind !== "creator" || l.id !== "76561190000000099") v.push(`the list asked: ${J(l)}`);
      await clearField("creator"); await sleep(400);
      return v;
    });

    // cool:authorStale — a newer lookup (the Presets of field, its answer still on its way) when the cooldown ends: the
    // refused Author lookup doesn't go again over it, and the newer one's list opens
    await cell("cool:authorStale", async () => {
      const v = [];
      await setSettings({ allowScenes: true, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      try {
        await browseWs();
        if (!(await openCol())) return ["no Author field in Browse's filter column"];
        if (!(await js(`!!document.querySelector(${J(LFIELD("presets"))})`))) return ["no Presets of field — proved nothing"];
        // a 2.5 s cooldown that runs out by itself (no event: the same end on any build of the page)
        await W({ authorCool: 2500 });
        const n0 = (await wsCalls("/workshop/author")).length;
        await typeIn("creator", "https://steamcommunity.com/id/someone-new");
        if (!(await waitFor(async () => (await field("creator"))?.state === "error", 3000))) return ["the Author lookup wasn't refused — proved nothing"];
        // the Presets of field: the Author field's blur commits it again (refused again, the cooldown still on), then the
        // presets lookup, held past the cooldown's end, is the newest list operation when it ends
        await W({ detailsDelay: 5000 });
        await typeIn("presets", "910000003");
        await sleep(100);
        const n1 = (await wsCalls("/workshop/author")).length;
        await waitFor(async () => (await lastList())?.kind === "presets", 8000); await sleep(600);
        const l = await lastList(), asks = (await wsCalls("/workshop/author")).slice(n1).length;
        console.log(`        list ${J(l)}; Author asked ${asks} time(s) after the end (${n1 - n0} before)`);
        if (l?.kind !== "presets" || l.id !== "910000003") v.push(`the list opened: ${J(l)} (want the scene's presets, the newer lookup)`);
        if (asks !== 0) v.push(`the Author lookup went again ${asks} time(s) at the end, over the newer lookup (want none)`);
        await W({ detailsDelay: 0, authorCool: 0 }); await clearField("presets"); await sleep(400);
      } finally { await setSettings({ allowScenes: false }); }
      return v;
    });

    // ws:commentSelect — a comment's text and its commenter's name are selectable text (a real drag selects each); a comment's
    // date says its own year (never 1970), and one Steam gave no time for shows none. Shot steam-ws-commentselect.png
    await cell("ws:commentSelect", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      const OLD = Math.floor(new Date(2025, 2, 7, 12).getTime() / 1000);
      const LIST = [{ id: "s1", author: "Selectable Commenter Name", authorId: "76561190000000201", avatar: null, time: Math.floor(Date.now() / 1000) - 7200, text: "a comment whose words can be selected" },
        { id: "s2", author: "an old one", authorId: "76561190000000202", avatar: null, time: OLD, text: "from March 2025" },
        { id: "s3", author: "no time", authorId: "76561190000000203", avatar: null, time: 0, text: "Steam gave no time" }];
      await browseWs(); await W({ comments: LIST, signedIn: false }); await openSide(0);
      const SEC = `${SIDE} [data-ws-comments]`;
      await scrollSideTo(SEC);
      if (!(await waitFor(() => js(`document.querySelectorAll("${SEC} .ws-c").length === 3`), 3000))) return ["the three comments never showed"];
      await sleep(400);
      const times = await js(`[...document.querySelectorAll("${SEC} .ws-c")].map((c) => c.querySelector(".ws-c-time")?.textContent ?? null)`);
      console.log(`        times: ${J(times)}`);
      if (!/2025/.test(times[1] ?? "")) v.push(`the old comment's date reads ${J(times[1])} (want its year)`);
      if (times.some((t) => /1970/.test(t ?? ""))) v.push(`a date reads 1970 (${J(times)})`);
      if (times[2] != null) v.push(`a comment with no time shows ${J(times[2])}`);
      const drag = async (sel, want) => {
        const b = await js(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height, us: getComputedStyle(e).userSelect }; })()`);
        if (!b) return v.push(`no ${sel}`);
        if (b.us !== "text") v.push(`${sel}: not selectable (user-select ${b.us})`);
        await js(`getSelection().removeAllRanges(); true`);
        const y = b.y + Math.min(b.h, 16) / 2;
        send({ type: "mouseDown", x: Math.round(b.x + 1), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
        for (let i = 1; i <= 5; i++) { send({ type: "mouseMove", x: Math.round(b.x + 1 + i * 14), y: Math.round(y), button: "left" }); await sleep(20); }
        send({ type: "mouseUp", x: Math.round(b.x + 71), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(400);
        const got = await js(`getSelection().toString()`);
        console.log(`        ${sel.split(" ").at(-1)}: dragged ${J(got)}`);
        if (got.trim().length < 3 || !want.startsWith(got.trim())) v.push(`a drag across ${sel.split(" ").at(-1)} selected ${J(got)}`);
      };
      await drag(`${SEC} [data-ws-comment="s1"] [data-ws-c-name]`, "Selectable Commenter Name");
      await shot("ws-commentselect");
      await drag(`${SEC} [data-ws-comment="s1"] [data-ws-text]`, "a comment whose words can be selected");
      await js(`getSelection().removeAllRanges(); true`);
      return v;
    });

    // posting: signed in, the box posts the text as typed; the new comment drops in on top, the box empties; Steam's refusal
    // shows its words under the box
    await cell("ws:commentPost", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      await W({ comments: COMMENTS.slice(0, 4), signedIn: true });
      await openSide(0);
      const SEC = `${SIDE} [data-ws-comments]`;
      await scrollSideTo(SEC);
      if (!(await waitFor(() => js(`!!document.querySelector("${SEC} textarea")`), 3000))) return ["signed in: no comment box"];
      await page(`document.querySelector("${SEC} textarea").focus();`);
      await type("Lovely <3\nsecond line");
      await page(`document.querySelector("${SEC} [data-ws-post-btn]").click();`);
      await sleep(100); await shot("ws-comment-post");
      await sleep(500);
      const p = (await wsCalls("/workshop/comment")).at(-1);
      if (p?.body?.text !== "Lovely <3\nsecond line" || p?.body?.workshopId !== "930000" || p?.body?.owner !== "76561190000000007") v.push(`the POST: ${J(p)}`);
      const r = await page(`const s = document.querySelector(${J(SEC)}); const c = s.querySelector(".ws-c");
        return { first: c?.querySelector("[data-ws-text]")?.textContent, fresh: c?.classList.contains("fresh"), box: s.querySelector("textarea").value, count: s.querySelector("[data-ws-count]")?.textContent };`);
      if (r.first !== "Lovely <3\nsecond line" || !r.fresh || r.box !== "" || r.count !== "5") v.push(`after posting: ${J(r)}`);
      await W({ postFail: true });
      await page(`document.querySelector("${SEC} textarea").focus();`); await type("again");
      await page(`document.querySelector("${SEC} [data-ws-post-btn]").click();`); await sleep(400);
      const e = await js(`document.querySelector("${SEC} [data-ws-post-error]")?.textContent ?? null`);
      if (!/too fast/.test(e ?? "")) v.push(`a refused post shows ${J(e)}`);
      return v;
    });

    // list:noPills — the strip holds the source pills alone, each its plain name: no Favourites pill (the favourites are a
    // filter row, docs/decisions.md § "Show Favourites and In my library as sets in the filter column") and no list's pill
    // (a creator's list is the column's Author field: .claude/rules/ui/design.md § Layout discipline). The Workshop's pill
    // stays lit through a list opened from the sidebar's row and one typed in the field; its click goes back to the whole
    // Workshop (the field empties). Shot steam-list-nopills.png
    await cell("list:noPills", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      const srcs = (await http("GET", "/sources")).json, names = srcs.filter((s) => s.available).map((s) => s.name), wsName = srcs.find((s) => s.supportsTagFilter)?.name;
      if (!wsName) return ["no Workshop source in /sources — proved nothing"];
      const strip = () => page(`const s = document.querySelector(".pill-strip");
        return { kids: [...s.children].map((e) => e.matches(".pill") ? "pill:" + e.textContent.trim() : (e.dataset.wsPill ?? e.className)),
          icons: [...s.querySelectorAll(":scope > .pill svg")].length, listPills: document.querySelectorAll("[data-ws-pill], .ws-pill, .ws-pill-pair, .ws-pill-x").length,
          lit: [...s.querySelectorAll(".pill.active")].map((e) => e.textContent.trim()) };`);
      const want = J(names.map((n) => "pill:" + n));
      const s1 = await strip();
      console.log(`        the whole Workshop: ${J(s1)}`);
      if (s1.kids.length === 0) return ["no source pills — proved nothing"];
      if (J(s1.kids) !== want) v.push(`the strip holds ${J(s1.kids)} (want the source pills ${J(names)} alone)`);
      if (s1.icons) v.push(`a source pill carries an icon (${s1.icons})`);
      if (J(s1.lit) !== J([wsName])) v.push(`lit: ${J(s1.lit)} (want the Workshop's ${J(wsName)})`);
      // a creator's list from the sidebar's row: the Author field holds it, the strip doesn't change
      await openSide(0);
      const ROW = `${SIDE} [data-ws-creator]`;
      if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return [...v, "the creator row never showed the creator"];
      await page(`document.querySelector(${J(ROW)}).click();`); await sleep(800);
      if ((await lastList())?.kind !== "creator") return [...v, `the row's click asked ${J(await lastList())} — proved nothing`];
      const s2 = await strip();
      console.log(`        a creator's list (the row): ${J(s2)}`);
      if (J(s2.kids) !== want || s2.listPills) v.push(`a creator's list: the strip holds ${J(s2.kids)}, ${s2.listPills} list pill(s) (want the source pills alone)`);
      if (J(s2.lit) !== J([wsName])) v.push(`a creator's list: lit ${J(s2.lit)} (want the Workshop's pill)`);
      await shot("list-nopills");
      // one typed in the field: the same
      await clearField("creator"); await sleep(500);
      await typeIn("creator", "76561190000000007"); await sleep(800);
      const s3 = await strip();
      if ((await lastList())?.id !== "76561190000000007") v.push(`typing the ID asked ${J(await lastList())}`);
      if (J(s3.kids) !== want || s3.listPills || J(s3.lit) !== J([wsName])) v.push(`a typed creator's list: ${J(s3)}`);
      // the Workshop's lit pill → the whole Workshop, the field empty
      await page(`[...document.querySelectorAll(".pill-strip > .pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`); await sleep(700);
      const b4 = await lastList(), f4 = await field("creator");
      if (b4) v.push(`the Workshop's pill still asked a list (${J(b4)})`);
      if (f4 && f4.value !== "") v.push(`the Workshop's pill left the Author field reading ${J(f4.value)}`);
      return v;
    });

    // ---- a scene's presets and a preset's base (WorkshopSocial.tsx PresetsRow / BaseRow). The presets list is the stack's own
    // backend's, from its fake Steam servers (the scene 910000003 has two presets); __probe_lib_ws makes "Fixture Preset One"
    // the library's k1 ----
    const PRESETS = ["Fixture Preset One", "Fixture Preset Two"];
    const PROW = `${SIDE} [data-ws-presets]`, CROW = `${SIDE} [data-ws-creator]`, BROW = `${SIDE} [data-ws-base]`;
    const CARDS = ".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])";
    const brTitles = () => js(`[...document.querySelectorAll(${J(CARDS + " [data-title]")})].map((e) => e.dataset.title)`);
    const presetsOn = async ({ motion = true, glows = true, live = false } = {}) => {
      await setSettings({ allowScenes: true, morphs: motion, glows, liveWallpaperBehindAllTabs: live });
      await js(`localStorage.setItem("__probe_presets", "1"); localStorage.setItem("__probe_lib_ws", ${J(J({ k1: "910000011" }))}); true`);
      await browseWs();
    };
    const presetsDone = async () => {
      await js(`localStorage.removeItem("__probe_presets"); localStorage.removeItem("__probe_lib_ws"); localStorage.setItem("liascape.wsListSort", '"lastupdated"'); true`);
      await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await mvTo(3, 3);
    };
    const sideTitle = () => js(`document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null`);
    // a row's material and words, held against the creator row's (the same control, WsListRow)
    const rowLook = (sel) => js(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const cs = getComputedStyle(e), r = e.getBoundingClientRect(), c = e.querySelector("[data-ws-go]");
      const cb = c?.getBoundingClientRect();
      return { cls: e.classList.contains("ws-creator"), bg: cs.backgroundColor, border: cs.borderTopWidth + " " + cs.borderTopColor, radius: cs.borderRadius, pad: cs.padding,
        h: Math.round(r.height), w: Math.round(r.width), font: cs.fontSize, chip: c ? [Math.round(cb.width), Math.round(cb.height), getComputedStyle(c).backgroundColor] : null,
        by: e.querySelector(".ws-creator-by")?.textContent ?? null, name: e.querySelector("[data-ws-row-name]")?.textContent ?? null, label: e.getAttribute("aria-label") }; })()`);
    const sameLook = (v, what, a, b) => {
      if (!a || !b) { v.push(`${what}: no row to compare (${J(a)} / ${J(b)})`); return; }
      if (!a.cls) v.push(`${what} isn't the creator row's control (.ws-creator)`);
      for (const k of ["bg", "border", "radius", "pad", "h", "w", "font"]) if (a[k] !== b[k]) v.push(`${what}'s ${k} ${J(a[k])} ≠ the creator row's ${J(b[k])}`);
      if (J(a.chip) !== J(b.chip)) v.push(`${what}'s end (its chevron) ${J(a.chip)} ≠ the creator row's ${J(b.chip)}`);
    };
    const clickRow = (sel) => page(`const e = document.querySelector(${J(sel)}); if (!e) return false; e.click(); return true;`);

    // ws:presets[Off] — a scene's sidebar has a "Presets" row (the creator row's control, 12 px under it); a click lists exactly
    // its presets: the sidebar closes, the filter column's Presets of field reads the scene's name and rings once (per frame;
    // Off: fades in place), no pill in the top bar, the one in the library carries Browse's in-library mark, the list's two
    // sorts (Top Rated asks again) and its second page; the field's × goes back to the whole Workshop. On: no-glow + bg-live
    // keep the row's own fill, no glow.
    // Shots steam-ws-presets-*.png
    for (const motion of [true, false]) {
      await cell(`ws:presets${motion ? "" : "Off"}`, async () => {
        const v = [];
        try {
          await presetsOn({ motion });
          await openSide(0);
          if (await sideTitle() !== "Fixture Workshop Three") return [`the first card's sidebar shows ${J(await sideTitle())} — proved nothing`];
          if (!(await waitFor(() => js(`!!document.querySelector(${J(PROW)})`), 2000))) return ["the scene's sidebar has no Presets row"];
          await waitFor(() => js(`document.querySelector(${J(CROW)})?.dataset.wsCreator === "known"`), 3000);
          const p = await rowLook(PROW), c = await rowLook(CROW);
          console.log(`        Presets ${J(p)}\n        creator ${J(c)}`);
          sameLook(v, "the Presets row", p, c);
          if (p?.by !== "Presets") v.push(`the row's small heading reads ${J(p?.by)} (want "Presets")`);
          const gap = await js(`(() => { const a = document.querySelector(${J(CROW)}).getBoundingClientRect(), b = document.querySelector(${J(PROW)}).getBoundingClientRect(); return +(b.top - a.bottom).toFixed(1); })()`);
          if (Math.abs(gap - 12) > 0.6) v.push(`the Presets row sits ${gap} px under the creator's (want the sidebar's 12)`);
          if (motion) await shot("ws-presets-row");
          // the click fills the column's Presets of field with the scene's name (no pill in the top bar)
          await fillFromRow(v, PROW, "presets", "Fixture Workshop Three", motion, motion ? "ws-presets-field-in" : null);
          const t = (await waitFor(async () => { const x = await brTitles(); return J([...x].sort()) === J(PRESETS) ? x : null; }, 4000)) ?? await brTitles();
          const b = (await browses()).filter((x) => x.list).at(-1);
          if (b?.list?.kind !== "presets" || b.list.id !== "910000003") v.push(`the click asked /browse ${J(b?.list)} (want the presets of 910000003)`);
          if (J([...t].sort()) !== J(PRESETS)) v.push(`the list holds ${J(t)} (want exactly ${J(PRESETS)})`);
          const st = await page(`return { pills: document.querySelectorAll("[data-ws-pill], .ws-pill, .ws-pill-pair").length,
              sort: document.querySelector("[data-sortsplit=browse] .ss-sort")?.textContent.trim() ?? null,
              owned: [...document.querySelectorAll(${J(CARDS)})].filter((c) => c.querySelector("[data-in-library]")).map((c) => c.querySelector("[data-title]")?.dataset.title) };`);
          console.log(`        the list ${J(t)}; ${J(st)}`);
          if (st.pills) v.push(`a list pill is in the top bar (${st.pills})`);
          if (st.sort !== "Recently Updated") v.push(`the sort reads ${J(st.sort)} (want the list's "Recently Updated")`);
          if (J(st.owned) !== J(["Fixture Preset One"])) v.push(`cards marked in the library: ${J(st.owned)} (want "Fixture Preset One")`);
          // it pages (its placeholders ask for page 2) and sorts by a list's two sorts
          const paged = () => browses().then((xs) => xs.some((x) => x.list?.kind === "presets" && x.page === 2));
          if (!(await waitFor(paged, 3000))) v.push("the presets list never asked for its second page");
          const nb = (await browses()).length;
          const opts = await page(`document.querySelector("[data-sortsplit=browse] .ss-sort").click(); await new Promise((r) => setTimeout(r, 200));
            const o = [...document.querySelectorAll(".sel-pop .sel-opt")], labels = o.map((x) => x.textContent.trim());
            o.find((x) => x.textContent.trim() === "Top Rated")?.click(); return labels;`);
          if (J(opts) !== J(["Recently Updated", "Top Rated"])) v.push(`the sorts offered: ${J(opts)} (want the list's two)`);
          await sleep(700);
          const sb = (await browses()).slice(nb).find((x) => x.list);
          if (sb?.list?.kind !== "presets" || sb.list.sort !== "toprated") v.push(`Top Rated asked ${J(sb?.list)}`);
          const t2 = await brTitles();
          if (J([...t2].sort()) !== J(PRESETS)) v.push(`Top Rated lists ${J(t2)}`);
          // the field's × → the whole Workshop, the field empty
          if (!(await clearField("presets"))) v.push("the Presets of field has no ×");
          await sleep(500);
          const back = (await browses()).at(-1), pf = await field("presets");
          if (back?.list) v.push(`× still asked a list (${J(back.list)})`);
          if (pf?.value !== "" || pf?.state !== "off") v.push(`after ×: the field ${J(pf)}`);
          if (motion) {
            await presetsOn({ glows: false, live: true }); await openSide(0);
            await waitFor(() => js(`!!document.querySelector(${J(PROW)})`), 2000); await sleep(300);
            const rr = await js(`(() => { const r = document.querySelector(${J(PROW)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
            if (!rr) v.push("no-glow + bg-live: no Presets row");
            else {
              await mvTo(rr.x, rr.y, 400);
              const lk = await looks(PROW);
              console.log(`        no-glow + bg-live: ${J(lk)}`);
              if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
              if (/rgba\(0, 0, 0, 0\)|transparent/.test(lk.bg)) v.push(`bg-live: the Presets row has no fill of its own (${lk.bg})`);
              if ((lk.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((x) => !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the hovered row glows (${lk.shadow})`);
              await shot("ws-presets-live");
            }
          }
        } finally { await presetsDone(); }
        return v;
      });
    }

    // ---- the filter column's list fields (components/WorkshopListFields.tsx): Author and Presets of ----
    // the danger colour as the page draws it (the theme var resolved on an element)
    const dangerRgb = () => js(`(() => { const e = document.createElement("span"); e.style.color = "var(--danger)"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
    const enterIn = (k) => `document.querySelector(${J(LFIELD(k) + " input")}).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`;
    const errFrame = (k) => `(() => { const e = document.querySelector('${LFIELD(k)} [data-wf-field-err]'); if (!e) return null; const cs = getComputedStyle(e); return [+cs.opacity, +new DOMMatrix(cs.transform).m41.toFixed(2)]; })()`;

    // list:author:{id,url,name} — typed into the Author field + Enter: one GET /workshop/author with the text as typed, the
    // list asked for the account it names, the field showing its name (a profile link the backend knows no name for: its
    // ID), no error, the split button counting the list, the search gone; leaving the field after Enter asks nothing again.
    // Shot steam-list-author-filled.png
    for (const [cname, text, want] of [["id", "76561190000000007", "Probe Creator"], ["url", "https://steamcommunity.com/id/probecreator", "76561190000000007"],
      ["name", "Probe Creator", "Probe Creator"]]) {
      await cell(`list:author:${cname}`, async () => {
        const v = [];
        await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await browseWs(); await W({ avatar: libThumb });
        if (!(await openCol())) return ["no Author field in Browse's filter column"];
        if (await lastList()) return [`a list is open before typing (${J(await lastList())}) — proved nothing`];
        const n0 = (await wsCalls("/workshop/author")).length;
        await typeIn("creator", text);
        await waitFor(async () => (await lastList())?.kind === "creator", 3000); await sleep(300);
        const asks = (await wsCalls("/workshop/author")).slice(n0), l = await lastList(), f = await field("creator");
        console.log(`        asked ${J(asks)}; /browse ${J(l)}; the field ${J(f)}`);
        if (asks.length !== 1 || asks[0].q !== text) v.push(`asked /workshop/author ${J(asks)} (want once with ${J(text)})`);
        if (l?.kind !== "creator" || l.id !== "76561190000000007") v.push(`/browse asked ${J(l)} (want the creator's list)`);
        if (f?.value !== want || f.state !== "on" || f.invalid || f.err) v.push(`the field: ${J(f)} (want ${J(want)}, on, no error)`);
        if (await splitCount() !== "1") v.push(`the split button counts ${J(await splitCount())} (want 1: the list)`);
        if (await js(`!!document.querySelector(".topbar .tsearch")`)) v.push("the search shows on a creator's list");
        await page(`document.activeElement?.blur(); return true;`); await sleep(400);
        if ((await wsCalls("/workshop/author")).length !== n0 + 1) v.push("leaving the field after Enter asked again");
        if (cname === "id") { await mvTo(3, 3, 300); await shot("list-author-filled"); }
        await clearField("creator"); await sleep(400);
        return v;
      });
    }

    // list:author:unknown[Off] — a name the backend never saw: the field's own error state, not a line under it: the box in the
    // danger colour (aria-invalid), the heading line's right end says to paste a profile link or ID, sliding in (Off: a fade,
    // nothing moving), the typed text kept, no list asked; typing again takes the error away (Off: a fade out); Escape takes
    // the text back. On: no-glow (the invalid box has no glow) + bg-live (the heading line's shadow). Shots
    // steam-list-author-error*.png
    for (const motion of [true, false]) {
      await cell(`list:author:unknown${motion ? "" : "Off"}`, async () => {
        const v = [];
        const run = async (shotName) => {
          await browseWs();
          if (!(await openCol())) return v.push("no Author field in Browse's filter column");
          const nb = (await browses()).length;
          await typeIn("creator", "Somebody Unknown", false);
          const ERR = `${LFIELD("creator")} [data-wf-field-err]`;
          const smp = motion ? null : js(MO.SAMPLE({ err: ERR, box: `${LFIELD("creator")} .wf-field-box` }, 600));
          if (!motion) await sleep(40);
          const fr = motion ? frames(enterIn("creator"), errFrame("creator"), 500) : (await page(`${enterIn("creator")} return true;`), null);
          const fin = motion ? await fr : null, s1 = motion ? null : await smp;
          await sleep(300);
          const f = await field("creator"), danger = await dangerRgb();
          console.log(`        the field ${J(f)}`);
          if (f?.err !== "Unknown name: paste a profile link or ID") v.push(`the error reads ${J(f?.err)}`);
          if (f?.state !== "error" || f.invalid !== "true") v.push(`the field isn't in its error state: ${J(f)}`);
          if (f?.border !== danger) v.push(`the box's edge is ${f?.border} (want the danger colour ${danger})`);
          if (f?.errColor !== danger) v.push(`the error's words are ${f?.errColor} (want the danger colour ${danger})`);
          if (!f?.errAbove) v.push("the error isn't in the field's heading line (above its box)");
          if (f?.under) v.push(`${f.under} element(s) under the field's box (a hint line)`);
          if (f?.value !== "Somebody Unknown") v.push(`the typed text wasn't kept (${J(f?.value)})`);
          const sent = (await browses()).slice(nb).filter((b) => b.list);
          if (sent.length) v.push(`an unknown name asked /browse ${J(sent.map((b) => b.list))}`);
          if (motion && fin) {
            const ops = fin.filter((x) => x).map((x) => x[0]), xs = fin.filter((x) => x).map((x) => x[1]);
            console.log(`        error in: opacity ${J(ops.slice(0, 10))} x ${J(xs.slice(0, 10))}`);
            if (!ops.length) v.push("the error never showed");
            else if (between(ops, 0.05) < 2 || between(xs, 0.5) < 2) v.push(`the error popped in (opacity ${J(ops.slice(0, 8))}, x ${J(xs.slice(0, 8))})`);
          }
          if (s1) {
            console.log(`        motion off: error ${MO.brief(s1.err)}`);
            v.push(...MO.judge("motion off: the error appearing", s1.err, { appear: true, size: false }), ...MO.judge("motion off: the field's box", s1.box));
          }
          if (shotName) { await mvTo(3, 3, 200); await shot(shotName); }
          return f;
        };
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false });
        await run(motion ? "list-author-error" : null);
        // typing again: the error goes (Off: fades out)
        const smp2 = js(MO.SAMPLE({ err: `${LFIELD("creator")} [data-wf-field-err]` }, 500)); await sleep(40);
        await page(`document.querySelector(${J(LFIELD("creator") + " input")}).focus(); return true;`); await type("x");
        const s2 = await smp2; await sleep(200);
        const f2 = await field("creator");
        if (f2?.err || f2?.state === "error" || f2?.invalid) v.push(`typing again kept the error: ${J(f2)}`);
        if (!motion) v.push(...MO.judge("motion off: the error leaving", s2.err, { leave: true, size: false }));
        // Escape takes the text back; the column stays
        await key("Escape"); await sleep(300);
        const f3 = await field("creator");
        if (f3?.value !== "") v.push(`Escape left ${J(f3?.value)} in the field`);
        if (motion) {
          await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
          await run("list-author-error-live");
          const lk = await page(`const i = document.querySelector(${J(LFIELD("creator") + " input")}), h = document.querySelector(${J(LFIELD("creator") + " .wf-field-head")});
            return { html: document.documentElement.className, shadow: getComputedStyle(i).boxShadow, filter: getComputedStyle(h).filter };`);
          console.log(`        no-glow + bg-live: ${J(lk)}`);
          if (!/no-glow/.test(lk.html) || !/bg-live/.test(lk.html)) v.push(`the toggles didn't apply: ${lk.html}`);
          if (lk.shadow !== "none") v.push(`no-glow: the invalid box glows (${lk.shadow})`);
          if (!/drop-shadow/.test(lk.filter)) v.push(`bg-live: the field's heading line has no shadow over the wallpaper (${lk.filter})`);
          await key("Escape");
        }
        await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        return v;
      });
    }

    // list:author:real — the stack's own backend resolves the field (no stub; Helpers/SteamAuthors.cs, no network): a Steam ID →
    // its list; a profile link naming an ID → that ID's list, the field showing the ID; a name it never saw → the field's error
    await cell("list:author:real", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await js(`localStorage.setItem("__probe_author_real", "1"); true`);
      try {
        await browseWs();
        if (!(await openCol())) return ["no Author field in Browse's filter column"];
        await typeIn("creator", "76561198000000042");
        await waitFor(async () => (await lastList())?.id === "76561198000000042", 3000);
        if ((await lastList())?.id !== "76561198000000042") v.push(`a Steam ID asked ${J(await lastList())}`);
        await typeIn("creator", "https://steamcommunity.com/profiles/76561198000000043/");
        await waitFor(async () => (await lastList())?.id === "76561198000000043", 3000);
        const f = await field("creator");
        if ((await lastList())?.id !== "76561198000000043" || f?.value !== "76561198000000043") v.push(`a profile link asked ${J(await lastList())}, the field ${J(f?.value)}`);
        const nb = (await browses()).length;
        await typeIn("creator", "Nobody This Backend Saw"); await sleep(700);
        const f2 = await field("creator");
        console.log(`        unknown name: ${J(f2)}`);
        if (f2?.err !== "Unknown name: paste a profile link or ID" || f2.state !== "error") v.push(`a name the backend never saw: ${J(f2)}`);
        if ((await browses()).slice(nb).some((b) => b.list)) v.push("an unknown name asked a list");
        await key("Escape"); await clearField("creator"); await sleep(300);
      } finally { await js(`localStorage.removeItem("__probe_author_real"); true`); }
      return v;
    });

    // list:presets:{id,url,bad} — the Presets of field (presets on): a scene's Workshop ID or its page's link → the scene's
    // presets list (the stack's backend: exactly its two), the field showing the scene's name (its card is on the page), an
    // Author name showing its error emptied; a creator typed after replaces it (the field empties); anything else → the
    // field's error, saying to paste the scene's ID or link, nothing asked, the open creator's list kept
    for (const [cname, text] of [["id", "910000003"], ["url", "https://steamcommunity.com/sharedfiles/filedetails/?id=910000003"], ["bad", "the blue one"]]) {
      await cell(`list:presets:${cname}`, async () => {
        const v = [];
        try {
          await presetsOn();
          if (!(await openCol())) return ["no filter column"];
          if (!(await js(`!!document.querySelector(${J(LFIELD("presets"))})`))) return ["no Presets of field with presets on"];
          if (cname === "bad") {
            await typeIn("creator", "76561190000000007");
            await waitFor(async () => (await lastList())?.kind === "creator", 3000);
          } else {
            // an Author name it couldn't take, still showing its error: the presets list opening takes it away
            await typeIn("creator", "Somebody Unknown"); await sleep(500);
            if ((await field("creator"))?.state !== "error") v.push("the unknown Author name showed no error — proved nothing");
          }
          const nb = (await browses()).length;
          await typeIn("presets", text); await sleep(900);
          const f = await field("presets"), a = await field("creator"), sent = (await browses()).slice(nb).filter((b) => b.list);
          console.log(`        the field ${J(f)}; Author ${J(a?.value)}; asked ${J(sent.map((b) => b.list))}`);
          if (cname === "bad") {
            if (f?.err !== "Paste the scene's Workshop ID or link" || f.state !== "error" || f.invalid !== "true") v.push(`not an id or link: the field ${J(f)}`);
            if (sent.length) v.push(`not an id or link asked ${J(sent.map((b) => b.list))}`);
            if (a?.value !== "Probe Creator") v.push(`the creator's list went (${J(a?.value)})`);
            await key("Escape");
          } else {
            const t = (await waitFor(async () => { const x = await brTitles(); return J([...x].sort()) === J(PRESETS) ? x : null; }, 4000)) ?? await brTitles();
            if (sent.at(-1)?.list?.kind !== "presets" || sent.at(-1).list.id !== "910000003") v.push(`asked ${J(sent.map((b) => b.list))} (want the presets of 910000003)`);
            if (f?.value !== "Fixture Workshop Three" || f.state !== "on" || f.err) v.push(`the field: ${J(f)} (want the scene's name, on)`);
            if (J([...t].sort()) !== J(PRESETS)) v.push(`the list holds ${J(t)} (want exactly ${J(PRESETS)})`);
            if (a?.value !== "" || a?.state !== "off" || a?.err) v.push(`the Author field kept its unknown name after the presets list opened: ${J(a)}`);
            if (cname === "id") { await mvTo(3, 3, 200); await shot("list-presets-filled"); }
            await typeIn("creator", "76561190000000007");
            await waitFor(async () => (await lastList())?.kind === "creator", 3000); await sleep(300);
            const p2 = await field("presets"), a2 = await field("creator");
            if (p2?.value !== "" || p2?.state !== "off" || a2?.value !== "Probe Creator") v.push(`a creator typed after: Presets of ${J(p2?.value)}, Author ${J(a2?.value)}`);
          }
          await clearField("creator"); await sleep(300);
        } finally { await presetsDone(); }
        return v;
      });
    }

    // list:clear — leaving a list from its field: the text deleted + Enter (the whole Workshop, one first page asked), and Clear all
    // with a tag on (the tags and the list both gone in ONE first page asked, the count gone)
    await cell("list:clear", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      if (!(await openCol())) return ["no Author field in Browse's filter column"];
      await typeIn("creator", "76561190000000007");
      if (!(await waitFor(async () => (await lastList())?.kind === "creator", 3000))) return ["typing the ID opened no list — proved nothing"];
      let nb = (await browses()).length;
      await typeIn("creator", ""); await sleep(700);
      let sent = (await browses()).slice(nb).filter((b) => b.page === 1), f = await field("creator");
      if (sent.length !== 1 || sent[0].list) v.push(`the text deleted + Enter asked ${J(sent.map((b) => b.list ?? null))} (want one /browse of the whole Workshop)`);
      if (f?.value !== "" || f?.state !== "off") v.push(`the text deleted: the field ${J(f)}`);
      await typeIn("creator", "76561190000000007");
      await waitFor(async () => (await lastList())?.kind === "creator", 3000);
      await page(`document.querySelector('.wf-col:not(.closing) [data-wf-tag="Anime"] .wf-seg.i')?.click(); return true;`); await sleep(900);
      if (await splitCount() !== "2") v.push(`a list + a tag: the split button counts ${J(await splitCount())} (want 2)`);
      nb = (await browses()).length;
      await page(`document.querySelector(".wf-col:not(.closing) [data-wf-clear]").click(); return true;`); await sleep(900);
      sent = (await browses()).slice(nb).filter((b) => b.page === 1); f = await field("creator");
      console.log(`        Clear all asked ${J(sent.map((b) => [b.list ?? null, b.filter?.include]))}; the field ${J(f)}`);
      if (sent.length !== 1 || sent[0].list || sent[0].filter?.include?.length) v.push(`Clear all asked ${J(sent.map((b) => [b.list ?? null, b.filter?.include]))} (want one /browse, no list, no tag)`);
      if (f?.value !== "" || f?.state !== "off") v.push(`Clear all left the field ${J(f)}`);
      if (await splitCount() != null) v.push(`after Clear all the split button counts ${J(await splitCount())}`);
      return v;
    });

    // list:rows — a sidebar row fills its field over what was being typed (its error gone); in a narrow window (the column a
    // drawer) the row doesn't open the drawer over the grid, and the split button counts the list
    await cell("list:rows", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      try {
        await browseWs();
        if (!(await openCol())) return ["no Author field in Browse's filter column"];
        await typeIn("creator", "Somebody Unknown"); await sleep(500);
        if ((await field("creator"))?.state !== "error") return ["the unknown name showed no error — proved nothing"];
        await openSide(0);
        const ROW = `${SIDE} [data-ws-creator]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return ["the creator row never showed the creator"];
        await fillFromRow(v, ROW, "creator", "Probe Creator", true, null);
        const f = await field("creator");
        if (f?.err || f?.invalid) v.push(`the row's fill kept the error: ${J(f)}`);
        await clearField("creator"); await sleep(400);
        win.setContentSize(820, 900); await sleep(700);
        await openSide(0);
        if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return [...v, "narrow: the creator row never showed"];
        await page(`document.querySelector(${J(ROW)}).click();`); await sleep(800);
        const st = await page(`return { drawer: !!document.querySelector('.wf-col:not(.closing)[data-mode="drawer"]'), side: !!document.querySelector("${SIDE}") };`);
        console.log(`        narrow: ${J(st)}, count ${J(await splitCount())}, list ${J(await lastList())}`);
        if ((await lastList())?.kind !== "creator") v.push(`narrow: the row asked ${J(await lastList())}`);
        if (st.drawer) v.push("narrow: the row opened the filter drawer over the grid");
        if (st.side) v.push("narrow: the sidebar stayed open");
        if (await splitCount() !== "1") v.push(`narrow: the split button counts ${J(await splitCount())} (want 1: the list)`);
      } finally { win.setContentSize(1400, 900); await sleep(500); }
      return v;
    });

    // list:race — the newest input wins across both fields: an Author lookup still out (its answer held) when a Presets of ID
    // opens that scene's presets is dropped when it lands (the presets list stays, the Author field empty, not spinning); one
    // still out when Clear all runs opens nothing either
    await cell("list:race", async () => {
      const v = [];
      try {
        await presetsOn();
        if (!(await openCol())) return ["no filter column"];
        await W({ authorDelay: 900 });
        await typeIn("creator", "76561190000000007"); await sleep(100);
        if ((await field("creator"))?.state !== "busy") v.push(`the held lookup doesn't show (${J(await field("creator"))}) — proved nothing`);
        await typeIn("presets", "910000003");
        await waitFor(async () => (await lastList())?.kind === "presets", 2000);
        await sleep(1300);
        const l = await lastList(), a = await field("creator"), p = await field("presets");
        console.log(`        after the held answer: ${J(l)}; Author ${J(a)}; Presets of ${J(p?.value)}`);
        if (l?.kind !== "presets") v.push(`the older Author lookup won: /browse ${J(l)}`);
        if (a?.state !== "off" || a?.value !== "") v.push(`the Author field after its lookup was overtaken: ${J(a)} (want empty, off)`);
        if (p?.value !== "Fixture Workshop Three") v.push(`the Presets of field reads ${J(p?.value)}`);
        await clearField("presets"); await sleep(500);
        await page(`document.querySelector('.wf-col:not(.closing) [data-wf-tag="Anime"] .wf-seg.i')?.click(); return true;`); await sleep(400);
        await typeIn("creator", "76561190000000007"); await sleep(100);
        await page(`document.querySelector(".wf-col:not(.closing) [data-wf-clear]").click(); return true;`);
        await sleep(1400);
        const l2 = await lastList(), a2 = await field("creator");
        if (l2) v.push(`a lookup out when Clear all ran opened ${J(l2)}`);
        if (a2?.state !== "off") v.push(`after Clear all the Author field ${J(a2)}`);
      } finally { await W({ authorDelay: 0 }); await presetsDone(); }
      return v;
    });

    // ws:presetsHidden — no Presets row where there's nothing to list (a video's sidebar, a preset's own) nor while presets can't
    // play: scene support off (a WS settings-changed: the page's own settings, the backend's untouched) — live, under an
    // open sidebar; the filter's Type group offers Preset only alongside it
    await cell("ws:presetsHidden", async () => {
      const v = [];
      try {
        await presetsOn();
        const at = async (n) => { await openSide(n); await sleep(500); return { title: await sideTitle(), row: await js(`!!document.querySelector(${J(PROW)})`) }; };
        const scene = await at(0);
        if (!scene.row) return [`the scene's sidebar (${scene.title}) has no Presets row — proved nothing`];
        const preset = await at(1), video = await at(2);
        console.log(`        ${J({ scene, preset, video })}`);
        if (preset.title !== "ws-preset" || preset.row) v.push(`the preset's sidebar: ${J(preset)} (want no Presets row)`);
        if (video.title !== "ws-3" || video.row) v.push(`the video's sidebar: ${J(video)} (want no Presets row)`);
        const typeRows = () => page(`const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") { t?.click(); await new Promise((r) => setTimeout(r, 450)); }
          return [...(document.querySelector('.wf-col:not(.closing) [data-wf-group="type"]')?.querySelectorAll(".wf-row") ?? [])].map((r) => r.dataset.wfTag);`);
        if (!(await typeRows()).includes("Preset")) v.push(`presets on: the filter's Type rows ${J(await typeRows())} (want Preset)`);
        await ev("settings-changed", { allowScenes: true });
        await at(0);
        if (!(await js(`!!document.querySelector(${J(PROW)})`))) v.push("scene support off: no Presets row before the change — proved nothing");
        else {
          await ev("settings-changed", { allowScenes: false }); await sleep(500);
          if (await js(`!!document.querySelector(${J(PROW)})`)) v.push("scene support off: the open scene sidebar still offers Presets");
          const rows = await typeRows();
          if (rows.includes("Preset") || !rows.includes("Scene")) v.push(`scene support off: the filter's Type rows ${J(rows)} (want no Preset)`);
        }
      } finally { await presetsDone(); }
      return v;
    });

    // ws:presetsEmpty — a scene with no Workshop presets: its list says so in the grid, no cards
    await cell("ws:presetsEmpty", async () => {
      const v = [];
      try {
        await presetsOn(); await openSide(3);
        if (await sideTitle() !== "ws-lone-scene") return [`the fourth card's sidebar shows ${J(await sideTitle())} — proved nothing`];
        if (!(await waitFor(() => js(`!!document.querySelector(${J(PROW)})`), 2000))) return ["the scene's sidebar has no Presets row"];
        await clickRow(PROW);
        const n = await waitFor(() => page(`const e = document.querySelector("[data-ws-list-note]"); return e ? { kind: e.dataset.wsListNote, text: e.textContent.trim() } : null;`), 4000);
        const b = (await browses()).filter((x) => x.list).at(-1);
        console.log(`        ${J(n)} asked ${J(b?.list)}`);
        if (b?.list?.kind !== "presets" || b.list.id !== "930003") v.push(`the click asked ${J(b?.list)} (want the presets of 930003)`);
        if (!n || n.kind !== "empty" || !/no presets/i.test(n.text)) v.push(`the empty list says ${J(n)} (want that the scene has no presets)`);
        if ((await brTitles()).length) v.push(`cards in an empty list: ${J(await brTitles())}`);
        await shot("ws-presets-empty");
      } finally { await presetsDone(); }
      return v;
    });

    // ws:presetBase — a preset's sidebar says what it uses: "Uses" + its base's title (GET /workshop/base asked once, the creator
    // row's control); a click shows the base's card: its Library card when the library has it, else its Browse card (the list's
    // own when the list holds it, else one of its own) — never a Steam page. Shots steam-ws-preset-base*.png
    await cell("ws:presetBase", async () => {
      const v = [];
      try {
        const s1 = ((await http("GET", "/library")).json ?? []).find((x) => x.title === "s1" && x.workshopId);
        if (!s1) return ["no Workshop scene s1 in the stack's library — proved nothing"];
        const dir = /\.[a-z0-9]{2,5}$/i.test(s1.videoPath) ? path.dirname(s1.videoPath) : s1.videoPath;
        const cases = [
          { what: "in the library", base: { baseId: s1.workshopId, title: "s1", kind: "scene", libraryPath: dir }, tab: "Library", side: "s1" },
          { what: "in the list", base: { baseId: "910000003", title: "Fixture Workshop Three", kind: "scene", libraryPath: null }, tab: "Browse", side: "Fixture Workshop Three", focused: true },
          { what: "nowhere here", base: { baseId: "930099", title: "Elsewhere Scene", kind: "scene", libraryPath: null }, tab: "Browse", side: "Elsewhere Scene" },
        ];
        for (const k of cases) {
          await presetsOn(); await W({ base: k.base }); await openSide(1);
          if (await sideTitle() !== "ws-preset") { v.push(`${k.what}: the second card's sidebar shows ${J(await sideTitle())} — proved nothing`); continue; }
          if (!(await waitFor(() => js(`document.querySelector(${J(BROW)})?.dataset.wsBase === "known"`), 3000))) { v.push(`${k.what}: the preset's sidebar never showed its base`); continue; }
          const r = await rowLook(BROW);
          if (r.by !== "Uses" || r.name !== k.base.title) v.push(`${k.what}: the row reads ${J([r.by, r.name])} (want "Uses", ${J(k.base.title)})`);
          if (k.what === "in the library") {
            await waitFor(() => js(`document.querySelector(${J(CROW)})?.dataset.wsCreator === "known"`), 3000);
            sameLook(v, "the Uses row", r, await rowLook(CROW));
            if (await js(`!!document.querySelector(${J(PROW)})`)) v.push("the preset's sidebar offers Presets");
            await shot("ws-preset-base");
          }
          const q = await wsCalls("/workshop/base");
          if (q.length !== 1 || !/[?&]id=930001\b/.test(q[0].q)) v.push(`${k.what}: the base asked ${q.length}× (${J(q.map((x) => x.q))}), want once for the preset`);
          await clickRow(BROW); await sleep(900);
          const got = await page(`return { tab: document.querySelector(".tab.active")?.textContent.trim() ?? null, side: document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null,
            focused: document.querySelector(".scroll:not(.lib-scroll) .card.focused [data-title]")?.dataset.title ?? null };`);
          console.log(`        ${k.what}: ${J(r)} → ${J(got)}`);
          if (got.tab !== k.tab || got.side !== k.side) v.push(`${k.what}: the click shows ${J(got)} (want ${k.side}'s ${k.tab} card)`);
          if (k.focused && got.focused !== k.side) v.push(`${k.what}: the list's own card isn't the focused one (${J(got.focused)})`);
          if (k.what === "nowhere here") await shot("ws-preset-base-own");
          const pages = (await calls()).filter((c) => c.p === "/steam/open-page");
          if (pages.length) v.push(`${k.what}: the click opened a Steam page (${J(pages)})`);
        }
      } finally { await presetsDone(); }
      return v;
    });

    // ---- the Yours rows as local sets (views/localSet.ts): a ✓ shows the favourites / the library's Workshop items from the
    // store (no /browse, no placeholders), ✕ alone hides them from the Workshop's pages. The data: six favourites (F1–F6,
    // every sort field distinct), the library's four Workshop items (F5, F6 shared; Glacier with details; Zephyr with none),
    // the Workshop's page (three of its own, Aurora, Glacier, Ember) — answered by the STUB from __probe_yours ----
    const WSP = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
    const yItem = (id, title, o = {}) => ({ title, thumbnailUrl: libThumb ?? "", animatedThumbnailUrl: null, pageUrl: WSP(id), resolution: "1920 x 1080",
      isScene: false, workshopId: String(id), addedAt: null, description: "fake", authorName: null, authorId: "76561190000000099", fileSizeBytes: 1000,
      subscriptions: null, favorites: null, tags: ["Video"], trailerKnown: true, createdAt: null, score: null, children: null, ...o });
    const ym = (s) => new Date(`${s}-15T00:00:00Z`).toISOString();
    const yFavs = ({ scene = false, preset = false } = {}) => [
      yItem(950001, "Aurora", { authorName: "Probe Creator", authorId: "76561190000000007", createdAt: ym("2024-01"), addedAt: ym("2026-01"), subscriptions: 3000, score: 0.91, favorites: 400, tags: ["Video", "Everyone", "Anime"] }),
      yItem(950002, "Bamboo", { authorName: "Probe Creator", authorId: "76561190000000007", createdAt: ym("2023-01"), addedAt: ym("2026-04"), subscriptions: 6000, score: 0.92, favorites: 200, tags: ["Video", "Mature", "Anime"] }),
      yItem(950003, "Cinder", { authorName: "Nimbus Works", createdAt: ym("2024-06"), addedAt: ym("2026-05"), subscriptions: 2000, score: 0.93, favorites: 100,
        ...(scene ? { isScene: true, tags: ["Scene", "Everyone", "Landscape"] } : { tags: ["Video", "Everyone", "Landscape"] }) }),
      yItem(950004, "Dune", { createdAt: ym("2022-01"), addedAt: ym("2026-02"), subscriptions: 5000, score: 0.94, favorites: 600,
        ...(preset ? { isScene: true, isPreset: true, tags: ["Preset", "Scene", "Questionable"], children: ["950009"] } : { tags: ["Video", "Questionable", "Anime"] }) }),
      yItem(950005, "Ember", { createdAt: ym("2022-06"), addedAt: ym("2026-06"), subscriptions: 1000, score: 0.95, favorites: 300, tags: ["Video", "Anime"] }),
      yItem(950006, "Fjord", { createdAt: ym("2023-06"), addedAt: ym("2026-03"), subscriptions: 4000, score: 0.96, favorites: 500, tags: ["Video", "Everyone", "Landscape"] }),
    ];
    const GLACIER = yItem(950007, "Glacier", { createdAt: ym("2024-03"), addedAt: ym("2025-12"), subscriptions: 2500, score: 0.5, favorites: 450, tags: ["Video", "Everyone"] });
    const BASE_SCENE = yItem(950009, "Base Scene", { isScene: true, tags: ["Scene", "Everyone"] });
    const favState = (items) => ({ signedIn: true, version: 1, loading: null, error: null, items });
    // the library's own data: the date each was added (Date Added), Zephyr known to Steam not at all
    const Y_LIB = [{ title: "Ember", workshopId: "950005", addedAt: ym("2026-03"), tags: ["Anime"] }, { title: "Fjord", workshopId: "950006", addedAt: ym("2026-01"), tags: ["Landscape"] },
      { title: "Glacier", workshopId: "950007", addedAt: ym("2026-05"), tags: ["Anime"] }, { title: "Zephyr", workshopId: "950008", addedAt: ym("2025-01"), tags: ["Anime"], ageRating: null, isScene: false }];
    const yData = (o = {}) => {
      const favs = yFavs(o);
      return { favs: favState(favs), details: { 950005: favs[4], 950006: favs[5], 950007: GLACIER }, lib: Y_LIB,
        page: [yItem(930000, "ws-a", { authorId: "76561190000000007" }), yItem(930001, "ws-b"), favs[0], GLACIER, favs[4], yItem(930002, "ws-c"), ...(o.preset ? [BASE_SCENE] : [])],
        creatorPage: [yItem(930000, "ws-a", { authorId: "76561190000000007" }), favs[0], yItem(930001, "ws-b")],
        presetsPage: [yItem(930010, "ws-preset-x", { isScene: true, isPreset: true, tags: ["Preset", "Scene"], children: ["950009"] }), favs[3]] };
    };
    const BF0 = { sort: "trend", trendDays: 7, include: [], exclude: [], featureMatch: "all", genreMatch: "any" };
    const YCARDS = ".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])";
    const shown = () => js(`[...document.querySelectorAll(${J(YCARDS + " [data-title]")})].map((e) => e.dataset.title)`);
    const sorted = (xs) => [...xs].sort();
    // the cards once they read `want` (in order: ordered; else as a set), else what shows after `ms`
    const shownAs = async (want, ordered = false, ms = 3000) => {
      const norm = (xs) => J(ordered ? xs : sorted(xs));
      return (await waitFor(async () => { const t = await shown(); return norm(t) === norm(want) ? t : null; }, ms)) ?? await shown();
    };
    const yoursOn = async (data, { scenes = false, looks = {} } = {}) => {
      await setSettings({ allowScenes: scenes, morphs: true, glows: true, liveWallpaperBehindAllTabs: false, ...looks });
      await js(`localStorage.setItem("__probe_yours", ${J(J(data))}); localStorage.removeItem("liascape.wsLocalSort");
        localStorage.setItem("liascape.browseFilter", ${J(J(BF0))}); localStorage.setItem("liascape.browseFilterHidden", "false"); true`);
      await browseWs(SIGNED_IN);
      await waitFor(async () => (await shown()).length >= data.page.length, 3000);
    };
    const yoursDone = async () => {
      await js(`localStorage.removeItem("__probe_yours"); localStorage.removeItem("liascape.wsLocalSort"); localStorage.setItem("liascape.browseFilter", ${J(J(BF0))}); true`);
      await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await load(SIGNED_OUT);
    };
    // a filter row's segment ("inc" ✓, "exc" ✕, "off" –), clicked in the Workshop's filter panel (opened when it isn't)
    const setRow = async (tag, s, wait = 600) => {
      const ok = await page(`const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") { t?.click(); await new Promise((r) => setTimeout(r, 450)); }
        const b = document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag=${J(tag)}] [data-seg=${J(s)}]'); if (!b) return false; b.click(); return true;`);
      if (!ok) throw new Error(`no ${s} segment on the ${tag} row`);
      await sleep(wait);
    };
    const search = (q) => page(`const i = document.querySelector(".tsearch input.search"); if (!i) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${J(q)}); i.dispatchEvent(new Event("input", { bubbles: true })); return true;`);
    const sortLabel = () => js(`document.querySelector("[data-sortsplit=browse] .ss-sort")?.textContent.trim() ?? null`);
    const sortOpts = () => page(`document.querySelector("[data-sortsplit=browse] .ss-sort").click(); await new Promise((r) => setTimeout(r, 200));
      const o = [...document.querySelectorAll(".sel-pop .sel-opt")].map((x) => x.textContent.trim()); document.querySelector(".sel-backdrop")?.click();
      await new Promise((r) => setTimeout(r, 150)); return o;`);
    const pickSort = async (label) => {
      const ok = await page(`document.querySelector("[data-sortsplit=browse] .ss-sort").click(); await new Promise((r) => setTimeout(r, 200));
        const o = [...document.querySelectorAll(".sel-pop .sel-opt")].find((x) => x.textContent.trim() === ${J(label)}); if (!o) { document.querySelector(".sel-backdrop")?.click(); return false; }
        o.click(); return true;`);
      await sleep(300);
      return ok;
    };
    const LOCAL_SORTS = ["Most Recent", "Recently Updated", "Most Subscribed", "Top Rated", "Most Favourited", "Title A–Z", "Date Added"];
    // each sort's field (newest / most first; missing last; ties by title)
    const libAdded = Object.fromEntries(Y_LIB.map((l) => [l.workshopId, Date.parse(l.addedAt)]));
    const FIELD = { "Most Recent": (w) => (w.createdAt ? Date.parse(w.createdAt) : null), "Recently Updated": (w) => (w.addedAt ? Date.parse(w.addedAt) : null),
      "Most Subscribed": (w) => w.subscriptions, "Top Rated": (w) => w.score, "Most Favourited": (w) => w.favorites, "Date Added": (w) => libAdded[w.workshopId] ?? null };
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    const orderOf = (items, label) => [...items].sort(label === "Title A–Z" ? byTitle : (a, b) => {
      const x = FIELD[label](a), y = FIELD[label](b);
      return x == null && y == null ? byTitle(a, b) : x == null ? 1 : y == null ? -1 : y - x || byTitle(a, b); }).map((w) => w.title);
    const T = (...xs) => xs;

    // yours:combos — every pair of the two rows' states, by the shown cards: ✓ = the set, both ✓ = the intersection, ✓ + ✕ = the
    // set minus the other, ✕ alone = the Workshop's page minus the set(s), – – = the page. Shots steam-yours-*.png
    await cell("yours:combos", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        const page0 = await shown();
        if (J(sorted(page0)) !== J(sorted(["ws-a", "ws-b", "Aurora", "Glacier", "Ember", "ws-c"]))) return [`the Workshop shows ${J(page0)} before any row — proved nothing`];
        const cases = [
          ["inc", "off", T("Ember", "Fjord", "Glacier", "Zephyr"), "lib"],
          ["off", "inc", T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord"), "favs"],
          ["inc", "inc", T("Ember", "Fjord"), "both"],
          ["exc", "inc", T("Aurora", "Bamboo", "Cinder", "Dune"), null],
          ["inc", "exc", T("Glacier", "Zephyr"), null],
          ["exc", "exc", T("ws-a", "ws-b", "ws-c"), null],
          ["exc", "off", T("ws-a", "ws-b", "Aurora", "ws-c"), null],
          ["off", "exc", T("ws-a", "ws-b", "Glacier", "ws-c"), null],
          ["off", "off", T("ws-a", "ws-b", "Aurora", "Glacier", "Ember", "ws-c"), null],
        ];
        for (const [lib, fav, want, name] of cases) {
          await setRow("@library", lib, 300); await setRow("@favorites", fav);
          const got = await shownAs(want);
          console.log(`        library ${lib}, favourites ${fav}: ${J(got)}`);
          if (J(sorted(got)) !== J(sorted(want))) v.push(`library ${lib}, favourites ${fav}: ${J(sorted(got))} (want ${J(sorted(want))})`);
          if (name) await shot(`yours-${name}`);
        }
      } finally { await yoursDone(); }
      return v;
    });

    // yours:noScan — a ✓ on: toggling a tag, searching, sorting and scrolling to the end send no /browse and show no
    // placeholder card; the last ✓ off → one /browse (page 1) with the Workshop's own sort
    await cell("yours:noScan", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        await setRow("@favorites", "inc");
        const favs = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
        if (J(sorted(await shownAs(favs))) !== J(favs)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        const n0 = (await browses()).length;
        const asks = await js(`window.__st.favAsks ?? []`);
        if (!asks.includes("open")) v.push(`Favourites ✓ never asked the favourites with sync=open (${J(asks)})`);
        await setRow("Anime", "inc");
        const anime = await shownAs(T("Aurora", "Bamboo", "Dune", "Ember"));
        if (J(sorted(anime)) !== J(T("Aurora", "Bamboo", "Dune", "Ember"))) v.push(`Anime ✓ narrowed it to ${J(anime)}`);
        await setRow("Anime", "off");
        if (!(await search("ember"))) v.push("no search box on the local set");
        await sleep(500);
        await search(""); await sleep(400);
        if (!(await pickSort("Top Rated"))) v.push("no Top Rated in the local sort menu");
        await page(`const s = document.querySelector(".scroll.br-scroll"); s.scrollTop = s.scrollHeight; await new Promise((r) => setTimeout(r, 300)); s.scrollTop = s.scrollHeight;`);
        await sleep(900);
        const skel = await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length`);
        const mid = (await browses()).slice(n0);
        if (mid.length) v.push(`${mid.length} /browse request(s) while a ✓ was on: ${J(mid.map((b) => [b.page, b.query ?? null, b.filter?.include]))}`);
        if (skel) v.push(`${skel} placeholder cards with a ✓ on`);
        await setRow("@favorites", "off", 1200);
        const after = (await browses()).slice(n0 + mid.length).filter((b) => b.page === 1);
        if (after.length !== 1 || after[0].filter?.sort !== "trend" || after[0].filter?.trendDays !== 7)
          v.push(`the ✓ off sent ${J(after.map((b) => b.filter && [b.filter.sort, b.filter.trendDays]))} (want one /browse with trend / 7)`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:search — on a local set the search narrows by a title word, an author's name and a tag, ignoring case; no request
    await cell("yours:search", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        await setRow("@favorites", "inc");
        const all = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
        if (J(sorted(await shownAs(all))) !== J(all)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        const n0 = (await browses()).length;
        for (const [q, want] of [["AURORA", T("Aurora")], ["nimbus", T("Cinder")], ["LandScape", T("Cinder", "Fjord")], ["probe CREATOR", T("Aurora", "Bamboo")], ["", all]]) {
          await search(q);
          const got = await shownAs(want, false, 2000);
          console.log(`        search ${J(q)}: ${J(got)}`);
          if (J(sorted(got)) !== J(sorted(want))) v.push(`search ${J(q)}: ${J(sorted(got))} (want ${J(want)})`);
        }
        await search("landscape"); await sleep(400); await shot("yours-search"); await search(""); await sleep(300);
        const n1 = (await browses()).length;
        if (n1 !== n0) v.push(`${n1 - n0} /browse request(s) for a search on the local set`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:sort — the local sort menu's labels (Date Added only with In my library ✓); each orders the set by its field, the
    // library item Steam has nothing on last; no option a no-op (Library ✓: each pick changes the order; Favourites ✓: all six
    // orders differ). The default is Most Subscribed; Date Added falls back to it once Library ✓ goes
    await cell("yours:sort", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        const favs = yFavs(), Z = { title: "Zephyr", workshopId: "950008", createdAt: null, addedAt: null, subscriptions: null, score: null, favorites: null };
        const libSet = [favs[4], favs[5], GLACIER, Z];
        await setRow("@library", "inc");
        if (J(sorted(await shownAs(libSet.map((w) => w.title)))) !== J(T("Ember", "Fjord", "Glacier", "Zephyr"))) return [`Library ✓ shows ${J(await shown())} — proved nothing`];
        const lbl0 = await sortLabel();
        if (lbl0 !== "Most Subscribed") v.push(`the local sort starts at ${J(lbl0)} (want "Most Subscribed")`);
        const o1 = await sortOpts();
        if (J(o1) !== J(LOCAL_SORTS)) v.push(`Library ✓: the sort menu ${J(o1)} (want ${J(LOCAL_SORTS)})`);
        let prev = await shown();
        if (J(prev) !== J(orderOf(libSet, "Most Subscribed"))) v.push(`the default order ${J(prev)} (want ${J(orderOf(libSet, "Most Subscribed"))})`);
        for (const l of LOCAL_SORTS) {
          if (!(await pickSort(l))) { v.push(`Library ✓: no ${l} option`); continue; }
          const want = orderOf(libSet, l), got = await shownAs(want, true, 2000);
          console.log(`        Library ✓, ${l}: ${J(got)}`);
          if (J(got) !== J(want)) v.push(`Library ✓, ${l}: ${J(got)} (want ${J(want)})`);
          if (got.at(-1) !== "Zephyr") v.push(`Library ✓, ${l}: the item Steam has nothing on isn't last (${J(got)})`);
          if (J(got) === J(prev)) v.push(`Library ✓, ${l}: the order didn't change (${J(got)})`);
          if (l === "Date Added") await shot("yours-sort-added");
          prev = got;
        }
        // Date Added picked → Library ✓ off, Favourites ✓: the menu has no Date Added and reads Most Subscribed
        await setRow("@favorites", "inc"); await setRow("@library", "off");
        await shownAs(favs.map((w) => w.title));
        const o2 = await sortOpts(), lbl2 = await sortLabel();
        if (J(o2) !== J(LOCAL_SORTS.slice(0, 6))) v.push(`Favourites ✓: the sort menu ${J(o2)} (want ${J(LOCAL_SORTS.slice(0, 6))})`);
        if (lbl2 !== "Most Subscribed") v.push(`Date Added without Library ✓ reads ${J(lbl2)} (want "Most Subscribed")`);
        const seen = new Map();
        for (const l of LOCAL_SORTS.slice(0, 6)) {
          if (!(await pickSort(l))) { v.push(`Favourites ✓: no ${l} option`); continue; }
          const want = orderOf(favs, l), got = await shownAs(want, true, 2000);
          console.log(`        Favourites ✓, ${l}: ${J(got)}`);
          if (J(got) !== J(want)) v.push(`Favourites ✓, ${l}: ${J(got)} (want ${J(want)})`);
          if (seen.has(J(got))) v.push(`Favourites ✓, ${l} orders like ${seen.get(J(got))} (${J(got)})`);
          seen.set(J(got), l);
        }
        const kept = await js(`localStorage.getItem("liascape.wsLocalSort")`);
        if (kept !== J("title")) v.push(`the local sort saved as ${kept} (want "title")`);
        const bf = JSON.parse(await js(`localStorage.getItem("liascape.browseFilter")`) || "{}");
        if (bf.sort !== "trend" || bf.trendDays !== 7) v.push(`the local sorts changed the Workshop's sort (${bf.sort} / ${bf.trendDays})`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:trendSort — the Workshop's "Most Popular · Week"; Favourites ✓ → the menu reads Most Subscribed and offers no Most
    // Popular; ✓ off → "Most Popular · Week" again and the next /browse carries trend / 7
    await cell("yours:trendSort", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        await pickSort("Most Recent"); await sleep(400);
        if (!(await pickSort("Most Popular · Week"))) return ["no Most Popular · Week in the Workshop's menu — proved nothing"];
        await sleep(500);
        if (await sortLabel() !== "Most Popular · Week") return [`the Workshop's sort reads ${J(await sortLabel())} — proved nothing`];
        await setRow("@favorites", "inc");
        await shownAs(T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord"));
        const l1 = await sortLabel(), o1 = await sortOpts();
        if (l1 !== "Most Subscribed") v.push(`Favourites ✓: the sort reads ${J(l1)} (want "Most Subscribed")`);
        if (o1.some((x) => /Most Popular/.test(x))) v.push(`Favourites ✓ offers ${J(o1)}`);
        await pickSort("Top Rated");
        const n0 = (await browses()).length;
        await setRow("@favorites", "off", 1000);
        const l2 = await sortLabel(), b = (await browses()).slice(n0).find((x) => x.page === 1);
        if (l2 !== "Most Popular · Week") v.push(`✓ off: the sort reads ${J(l2)} (want "Most Popular · Week")`);
        if (b?.filter?.sort !== "trend" || b.filter.trendDays !== 7) v.push(`✓ off: the next /browse carried ${J(b?.filter && [b.filter.sort, b.filter.trendDays])} (want trend / 7)`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:switches — on Favourites ✓ (Cinder a scene, scenes on) Type Video, an age and a genre narrow the set; any age
    // filter drops the untagged Ember
    await cell("yours:switches", async () => {
      const v = [];
      try {
        await yoursOn(yData({ scene: true }), { scenes: true });
        await setRow("@favorites", "inc");
        const all = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
        if (J(sorted(await shownAs(all))) !== J(all)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        for (const [tag, s, want] of [["Video", "inc", T("Aurora", "Bamboo", "Dune", "Ember", "Fjord")], ["Everyone", "inc", T("Aurora", "Cinder", "Fjord")],
          ["Mature", "exc", T("Aurora", "Cinder", "Dune", "Fjord")], ["Landscape", "inc", T("Cinder", "Fjord")]]) {
          await setRow(tag, s);
          const got = await shownAs(want);
          console.log(`        ${tag} ${s}: ${J(got)}`);
          if (J(sorted(got)) !== J(sorted(want))) v.push(`${tag} ${s}: ${J(sorted(got))} (want ${J(want)})`);
          await setRow(tag, "off");
        }
      } finally { await yoursDone(); }
      return v;
    });

    // yours:inList — inside a creator's list ✓ shows that creator's favourites only, ✕ hides the favourites from the list's
    // pages; inside a scene's presets list ✓ shows its presets among the favourites, ✕ hides them; the search shows on a local
    // set inside a list
    await cell("yours:inList", async () => {
      const v = [];
      try {
        await yoursOn(yData({ preset: true }), { scenes: true });
        const at = async (t) => (await shown()).indexOf(t);
        await openSide(await at("ws-a"));
        if (!(await waitFor(() => js(`document.querySelector("${SIDE} [data-ws-creator]")?.dataset.wsCreator === "known"`), 3000))) return ["ws-a's sidebar has no creator row"];
        await page(`document.querySelector("${SIDE} [data-ws-creator]").click();`);
        const list = T("ws-a", "Aurora", "ws-b");
        if (J(sorted(await shownAs(list))) !== J(sorted(list))) return [`the creator's list shows ${J(await shown())} — proved nothing`];
        const searchIn = () => js(`!!document.querySelector(".tsearch input.search")`);
        if (await searchIn()) v.push("a creator's list (no ✓) shows the search");
        // the list's own paging settles first (its page 2 answers [], its placeholders go)
        await waitFor(() => js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length === 0`), 3000);
        const n0 = (await browses()).length;
        await setRow("@favorites", "inc");
        const c1 = await shownAs(T("Aurora", "Bamboo"));
        console.log(`        creator, Favourites ✓: ${J(c1)}`);
        if (J(sorted(c1)) !== J(T("Aurora", "Bamboo"))) v.push(`creator, Favourites ✓: ${J(sorted(c1))} (want the creator's favourites, Aurora and Bamboo)`);
        const sentC = (await browses()).slice(n0);
        if (sentC.length) v.push(`creator, Favourites ✓ sent /browse ${J(sentC.map((b) => [b.page, b.list?.kind ?? null]))}`);
        if (!(await searchIn())) v.push("creator, Favourites ✓: no search");
        // the list's empty / error note is the list's pages', never the set's (WorkshopSocial.tsx WsListNote)
        const note = await js(`document.querySelector("[data-ws-list-note]")?.textContent ?? null`);
        if (note) v.push(`creator, Favourites ✓ shows the list's note ${J(note)}`);
        const af = await field("creator");
        if (af?.value !== "Probe Creator" || af.state !== "on") v.push(`creator, Favourites ✓: the Author field ${J(af)} (want the creator, on)`);
        await shot("yours-inlist-creator");
        await setRow("@favorites", "exc", 900);
        const c2 = await shownAs(T("ws-a", "ws-b"));
        const lb = (await browses()).at(-1);
        if (J(sorted(c2)) !== J(T("ws-a", "ws-b"))) v.push(`creator, Favourites ✕: ${J(sorted(c2))} (want ws-a, ws-b)`);
        if (lb?.list?.kind !== "creator") v.push(`creator, Favourites ✕ asked ${J(lb?.list)} (want the creator's list)`);
        await setRow("@favorites", "off");
        await clearField("creator"); await sleep(700);
        await openSide(await at("Base Scene"));
        if (!(await waitFor(() => js(`!!document.querySelector("${SIDE} [data-ws-presets]")`), 3000))) return [...v, "Base Scene's sidebar has no Presets row"];
        await page(`document.querySelector("${SIDE} [data-ws-presets]").click();`);
        const pl = T("ws-preset-x", "Dune");
        if (J(sorted(await shownAs(pl))) !== J(sorted(pl))) return [...v, `the presets list shows ${J(await shown())} — proved nothing`];
        await setRow("@favorites", "inc");
        const p1 = await shownAs(T("Dune"));
        if (J(p1) !== J(T("Dune"))) v.push(`presets, Favourites ✓: ${J(p1)} (want its preset among the favourites, Dune)`);
        await setRow("@favorites", "exc", 900);
        const p2 = await shownAs(T("ws-preset-x"));
        if (J(p2) !== J(T("ws-preset-x"))) v.push(`presets, Favourites ✕: ${J(p2)} (want ws-preset-x)`);
        await setRow("@favorites", "off");
      } finally { await yoursDone(); }
      return v;
    });

    // yours:scenes — Favourites ✓ with scene support on: the scene shows, the preset only with Type's Preset ticked (as the
    // Workshop lists them); scene support off → the scene and the preset leave at once
    await cell("yours:scenes", async () => {
      const v = [];
      try {
        await yoursOn(yData({ scene: true, preset: true }), { scenes: true });
        await setRow("@favorites", "inc");
        const noPreset = T("Aurora", "Bamboo", "Cinder", "Ember", "Fjord");
        const g0 = await shownAs(noPreset);
        if (J(sorted(g0)) !== J(noPreset)) v.push(`Preset unticked: ${J(sorted(g0))} (want every favourite but the preset Dune)`);
        await setRow("Preset", "inc");
        const g1 = await shownAs(T("Dune"));
        if (J(g1) !== J(T("Dune"))) v.push(`Preset ✓: ${J(g1)} (want the preset Dune)`);
        await setRow("Video", "inc", 200); await setRow("Scene", "inc");
        const all = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
        const g2 = await shownAs(all);
        if (J(sorted(g2)) !== J(all)) v.push(`Video + Scene + Preset ✓: ${J(sorted(g2))} (want all six)`);
        await ev("settings-changed", { allowScenes: false });
        await sleep(150);
        const g3 = await shown(), want = T("Aurora", "Bamboo", "Ember", "Fjord");
        console.log(`        scene support off: ${J(g3)}`);
        if (J(sorted(g3)) !== J(want)) v.push(`scene support off: ${J(sorted(g3))} at once (want ${J(want)})`);
        await ev("settings-changed", { allowScenes: true });
      } finally { await yoursDone(); }
      return v;
    });

    // yours:big — 2,000 favourites: all of them show at once, no placeholder; typing a search sends no request and narrows the
    // count; every card keeps content-visibility: auto
    await cell("yours:big", async () => {
      const v = [];
      try {
        const big = Array.from({ length: 2000 }, (_, i) => yItem(960000 + i, `big-${String(i).padStart(4, "0")}`, { subscriptions: i, tags: ["Video", "Anime"] }));
        await yoursOn({ ...yData(), favs: favState(big) });
        await setRow("@favorites", "inc");
        const n = await waitFor(async () => { const c = await js(`document.querySelectorAll(${J(YCARDS)}).length`); return c === 2000 ? c : null; }, 8000)
          ?? await js(`document.querySelectorAll(${J(YCARDS)}).length`);
        if (n !== 2000) return [`Favourites ✓ shows ${n} cards (want 2000)`];
        const cv = await js(`(() => { const cs = [...document.querySelectorAll(${J(YCARDS)})]; return [cs.filter((c) => getComputedStyle(c).contentVisibility !== "auto").length, document.querySelectorAll(".skel-card").length]; })()`);
        if (cv[0]) v.push(`${cv[0]} cards without content-visibility: auto`);
        if (cv[1]) v.push(`${cv[1]} placeholder cards`);
        const b0 = (await js(`window.__st.bodies.length`));
        await page(`document.querySelector(".tsearch input.search").focus();`);
        await type("BIG-01");
        const m = await waitFor(async () => { const c = await js(`document.querySelectorAll(${J(YCARDS)}).length`); return c === 100 ? c : null; }, 3000)
          ?? await js(`document.querySelectorAll(${J(YCARDS)}).length`);
        if (m !== 100) v.push(`"BIG-01" shows ${m} cards (want 100: big-0100 … big-0199)`);
        const sent = (await js(`window.__st.bodies.slice(${b0}).map((b) => b.p)`)).filter((p) => /^\/(browse|detail|workshop\/)/.test(p));
        if (sent.length) v.push(`typing the search sent ${J(sent)}`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:signFlip — a saved Favourites ✓ alone follows the sign-in: signed out the Workshop shows (its pages, endless: its
    // placeholders stay); a signed-in steam-status event → the favourites set (sync=open asked, no placeholder card, no
    // /browse); signed out again → one /browse and the Workshop's cards
    await cell("yours:signFlip", async () => {
      const v = [];
      try {
        const data = { ...yData(), endless: true }, pageTitles = data.page.map((w) => w.title), favs = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
        await js(`localStorage.setItem("__probe_yours", ${J(J(data))}); localStorage.removeItem("liascape.wsLocalSort");
          localStorage.setItem("liascape.browseFilter", ${J(J({ ...BF0, include: ["@favorites"] }))}); localStorage.setItem("liascape.browseFilterHidden", "false"); true`);
        await browseWs(SIGNED_OUT);
        const hasPage = async () => { const t = await shown(); return pageTitles.every((x) => t.includes(x)) && t.every((x) => pageTitles.includes(x) || /^ws-p\d+-/.test(x)) ? t : null; };
        const g0 = await waitFor(hasPage, 3000);
        const skel0 = await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length`);
        console.log(`        signed out, saved Favourites ✓: ${J(g0)}, ${skel0} placeholders`);
        if (!g0) v.push(`signed out, a saved Favourites ✓ alone: ${J(await shown())} (want the Workshop's pages)`);
        if (!skel0) return [...v, "the Workshop's pages show no placeholders before the sign-in — proved nothing"];
        const asks0 = (await js(`window.__st.favAsks ?? []`)).filter((x) => x === "open").length;
        const n0 = (await browses()).length;
        await js(`window.__st.status = ${J(SIGNED_IN)}; true`);
        await ev("steam-status", SIGNED_IN);
        const g1 = await shownAs(favs);
        const skel1 = await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length`);
        const asks1 = (await js(`window.__st.favAsks ?? []`)).filter((x) => x === "open").length;
        // the Workshop's endless pages may still have had one page on its way when the event landed: no page 1 (a reload), and
        // nothing at all once the set shows
        const n1a = (await browses()).length;
        await sleep(800);
        const sent1 = (await browses()).slice(n0).filter((b) => b.page === 1).concat((await browses()).slice(n1a));
        console.log(`        signed in: ${J(g1)}, ${skel1} placeholders, ${asks1 - asks0} sync=open, ${sent1.length} /browse`);
        if (J(sorted(g1)) !== J(favs)) v.push(`signed in: ${J(sorted(g1))} (want the favourites ${J(favs)})`);
        if (skel1) v.push(`signed in: ${skel1} placeholder cards over the set`);
        if (asks1 <= asks0) v.push("signed in: the favourites were never asked with sync=open");
        if (sent1.length) v.push(`signed in: ${sent1.length} /browse request(s) for the set`);
        await shot("yours-signflip-in");
        const n1 = (await browses()).length;
        await js(`window.__st.status = ${J(SIGNED_OUT)}; true`);
        await ev("steam-status", SIGNED_OUT);
        const g2 = (await waitFor(hasPage, 3000)) ?? await shown();
        await sleep(600);
        const sent2 = (await browses()).slice(n1).filter((b) => b.page === 1);
        console.log(`        signed out again: ${J(g2)}, ${sent2.length} /browse page 1`);
        if (!pageTitles.every((x) => g2.includes(x)) || favs.some((x) => !pageTitles.includes(x) && g2.includes(x))) v.push(`signed out again: ${J(g2)} (want the Workshop's pages)`);
        if (sent2.length !== 1) v.push(`signed out again: ${sent2.length} /browse page-1 request(s) (want one)`);
      } finally { await yoursDone(); }
      return v;
    });

    // ---- the favourites' load line (components/WsSetLoad.tsx) and the favourites following Liascape and Steam live ----
    const LINE = "[data-ws-set-load]";
    const LOAD_ERR = "Couldn't load your favourites from Steam. Try again in a moment.";
    const FAV_INC = `document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"] [data-seg="inc"]').click();`;
    const favAsks = () => js(`window.__st.favAsks ?? []`);
    const glowless = (x) => !x || x === "none" || x.split(/,(?![^(]*\))/).every((p) => /rgba\(0, 0, 0, 0\)/.test(p) || /0px 0px 0px 0px/.test(p));
    const lineNow = () => js(`(() => { const e = document.querySelector(${J(LINE)}); if (!e) return null; const f = e.querySelector(".wsl-fill"), t = e.querySelector(".wsl-text");
      return { kind: e.dataset.wsSetLoad, text: t?.textContent ?? null, op: +getComputedStyle(e).opacity, closing: e.classList.contains("closing"),
        retry: !!e.querySelector("[data-wsl-retry]"), fill: f ? +new DOMMatrix(getComputedStyle(f).transform).a.toFixed(3) : null,
        fillGlow: f ? getComputedStyle(f).boxShadow : null, textFilter: t ? getComputedStyle(t).filter : null,
        // what of its words and its bar / Retry lies outside its own drawn box (its fill), in px: [] = all inside
        outside: [t, f?.parentElement, e.querySelector("[data-wsl-retry]")].filter(Boolean).flatMap((x) => { const a = e.getBoundingClientRect(), b = x.getBoundingClientRect();
          return !b.width || !b.height ? [x.className + ": empty"] : b.left < a.left - 0.5 || b.right > a.right + 0.5 || b.top < a.top - 0.5 || b.bottom > a.bottom + 0.5
            ? [x.className + ": " + [b.left - a.left, a.right - b.right, b.top - a.top, a.bottom - b.bottom].map((n) => n.toFixed(1)).join(" ")] : []; }) }; })()`);
    // the line per frame for `ms`, the sampling started before `act` runs in the page: [t, opacity, translateY, its words, the
    // fill's scaleX, the properties its running animations / transitions change] | [t, null] while it isn't there
    const lineFrames = (act, ms) => page(`const out = [], t0 = performance.now();
      const props = (e) => [...new Set(e.getAnimations({ subtree: true }).flatMap((a) => a.transitionProperty ? [a.transitionProperty]
        : (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((x) => !["offset", "easing", "composite", "computedOffset"].includes(x)))))];
      const rec = new Promise((res) => { const f = () => { const t = Math.round(performance.now() - t0), e = document.querySelector(${J(LINE)});
        if (!e) out.push([t, null]); else { const m = new DOMMatrix(getComputedStyle(e).transform), fl = e.querySelector(".wsl-fill");
          out.push([t, +(+getComputedStyle(e).opacity).toFixed(3), +m.m42.toFixed(2), e.querySelector(".wsl-text")?.textContent ?? "", fl ? +new DOMMatrix(getComputedStyle(fl).transform).a.toFixed(3) : null, props(e)]); }
        if (t < ${ms}) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); });
      ${act}
      return await rec;`);
    // the cards the line's box overlaps (their titles)
    const covered = () => js(`(() => { const e = document.querySelector(${J(LINE)}); if (!e) return null; const c = e.getBoundingClientRect();
      return [...document.querySelectorAll(${J(YCARDS)})].filter((k) => { const r = k.getBoundingClientRect();
        return Math.min(c.right, r.right) - Math.max(c.left, r.left) > 0.5 && Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top) > 0.5; })
        .map((k) => k.querySelector("[data-title]")?.dataset.title ?? "?"); })()`);
    const CARD_Y = `(() => { const c = document.querySelector(${J(YCARDS)}); return c ? +c.getBoundingClientRect().y.toFixed(1) : null; })()`;
    // the first card's y per frame for `ms`, the sampling started before `act`: [[t, y]]
    const cardFrames = (act, ms) => page(`const out = [], t0 = performance.now();
      const rec = new Promise((res) => { const f = () => { const t = Math.round(performance.now() - t0); out.push([t, ${CARD_Y}]); if (t < ${ms}) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); });
      ${act}
      return await rec;`);
    // the error taking its own room above the grid: [y before, y after, in-between frames]
    const errorRoom = async (version, items) => {
      const y0 = await js(CARD_Y);
      await js(`window.__favs.answer = ${J(fv(version, items, { error: LOAD_ERR }))}; true`);
      const fr = await cardFrames(`window.__fakeWs("workshop-favorites", ${J({ version, loading: null })});`, 700);
      const y1 = fr.at(-1)[1];
      return { y0, y1, mid: fr.filter(([, y]) => y != null && y > y0 + 0.75 && y < y1 - 0.75).length, ys: fr.map(([, y]) => y).filter((y, i, a) => i === 0 || y !== a[i - 1]).slice(0, 12) };
    };
    const moved = (frs, allowed) => [...new Set(frs.flatMap((f) => f[5] ?? []))].filter((p) => !allowed.includes(p));
    const SIX = T("Aurora", "Bamboo", "Cinder", "Dune", "Ember", "Fjord");
    const fv = (version, items, o = {}) => ({ signedIn: true, version, loading: null, error: null, items, ...o });

    // yours:loadLine — a first Favourites ✓ with the answer held: the line shows within a frame of the click ("Loading your
    // favourites…", rising in), "— 120 so far" then "— 120 of 450" as workshop-favorites events land (the bar eases), the grid
    // fills with what's loaded, and at the end the line fills out and fades; per frame only opacity / transform change.
    // Shots steam-yours-load-*.png
    await cell("yours:loadLine", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        const favs = yFavs();
        await js(`window.__favs = { hold: true }; true`);
        await setRow("@library", "off", 450);
        if (await lineNow()) return ["the load line shows before any Favourites row — proved nothing"];
        const fr0 = await lineFrames(FAV_INC, 500);
        const i0 = fr0.findIndex((f) => f[1] != null);
        console.log(`        appear: first at frame ${i0}, opacity ${MO.brief(fr0)}, y [${fr0.filter((f) => f[1] != null).slice(0, 8).map((f) => f[2])}]`);
        if (i0 < 0) return ["Favourites ✓ with the answer held: no load line"];
        if (i0 > 1) v.push(`the line first showed ${i0} frames after the click (want within one)`);
        if (fr0[i0][3] !== "Loading your favourites…") v.push(`held: it reads ${J(fr0[i0][3])} (want "Loading your favourites…")`);
        const midOp = fr0.filter((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95).length, midY = fr0.filter((f) => f[1] != null && Math.abs(f[2]) > 0.3 && Math.abs(f[2]) < 5.9).length;
        if (midOp < 2) v.push(`it popped in: ${midOp} in-between opacity frame(s)`);
        if (midY < 1) v.push(`it didn't rise in: ${midY} in-between offset frame(s)`);
        await sleep(300); await shot("yours-load-held");
        const lh = await lineNow();
        if (lh?.outside?.length) v.push(`held: parts of the line lie outside its box ${J(lh.outside)}`);
        await js(`window.__favsLet(${J(fv(2, [], { loading: { done: 0, total: null } }))})`);
        await sleep(300);
        const l1 = await lineNow();
        if (l1?.text !== "Loading your favourites…") v.push(`nothing loaded yet: it reads ${J(l1?.text)} (want "Loading your favourites…")`);
        await js(`window.__favs.answer = ${J(fv(3, favs.slice(0, 2), { loading: { done: 120, total: null } }))}; true`);
        await ev("workshop-favorites", { version: 3, loading: { done: 120, total: null } });
        const l2 = (await waitFor(async () => { const l = await lineNow(); return l?.text === "Loading your favourites — 120 so far" ? l : null; }, 2000)) ?? await lineNow();
        if (l2?.text !== "Loading your favourites — 120 so far") v.push(`the total unknown: it reads ${J(l2?.text)} (want "Loading your favourites — 120 so far")`);
        const g2 = await shownAs(T("Aurora", "Bamboo"));
        if (J(sorted(g2)) !== J(T("Aurora", "Bamboo"))) v.push(`120 so far: the grid shows ${J(g2)} (want what's loaded, Aurora and Bamboo)`);
        await js(`window.__favs.answer = ${J(fv(4, favs.slice(0, 3), { loading: { done: 120, total: 450 } }))}; true`);
        const fr1p = lineFrames(`window.__fakeWs("workshop-favorites", ${J({ version: 4, loading: { done: 120, total: 450 } })});`, 900);
        await sleep(160); await shot("yours-load-mid");
        const fr1 = await fr1p, want = +(120 / 450).toFixed(3), last1 = fr1.at(-1);
        const eased = new Set(fr1.filter((f) => f[4] != null && f[4] > 0.005 && f[4] < want - 0.005).map((f) => f[4])).size;
        console.log(`        120 of 450: ${J(last1?.[3])}, bar [${fr1.map((f) => f[4]).filter((x, i, a) => i === 0 || x !== a[i - 1]).slice(0, 10)}]`);
        if (last1?.[3] !== "Loading your favourites — 120 of 450") v.push(`the total known: it reads ${J(last1?.[3])} (want "Loading your favourites — 120 of 450")`);
        if (!(Math.abs((last1?.[4] ?? -1) - want) < 0.01)) v.push(`the bar ends at ${last1?.[4]} (want ${want})`);
        if (eased < 3) v.push(`the bar jumped to 120 / 450 (${eased} in-between value(s))`);
        const g3 = await shownAs(T("Aurora", "Bamboo", "Cinder"));
        if (J(sorted(g3)) !== J(T("Aurora", "Bamboo", "Cinder"))) v.push(`120 of 450: the grid shows ${J(g3)} (want Aurora, Bamboo, Cinder)`);
        // the loading chip takes no click: a real click on it where it lies over a card reaches the card (its sidebar opens)
        const over = await js(`(() => { const c = document.querySelector(${J(LINE)}).getBoundingClientRect();
          for (const k of document.querySelectorAll(${J(YCARDS)})) { const r = k.getBoundingClientRect();
            const x0 = Math.max(c.left, r.left), x1 = Math.min(c.right, r.right), y0 = Math.max(c.top, r.top), y1 = Math.min(c.bottom, r.bottom);
            if (x1 - x0 > 8 && y1 - y0 > 8) return { title: k.querySelector("[data-title]")?.dataset.title ?? null, x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) }; }
          return null; })()`);
        if (!over) v.push("the loading chip lies over no card — the click-through check proved nothing");
        else {
          send({ type: "mouseMove", x: over.x, y: over.y }); await sleep(60);
          send({ type: "mouseDown", x: over.x, y: over.y, button: "left", clickCount: 1 }); await sleep(40);
          send({ type: "mouseUp", x: over.x, y: over.y, button: "left", clickCount: 1 });
          const got = await waitFor(() => js(`document.querySelector("${SIDE} .side-title, ${SIDE} h2")?.textContent.trim() ?? null`), 1500);
          console.log(`        a click on the chip over ${over.title}: the sidebar shows ${J(got)}`);
          if (got !== over.title) v.push(`a click on the loading chip over ${over.title} didn't reach the card (the sidebar shows ${J(got)})`);
          await key("Escape"); await sleep(400);
        }
        await js(`window.__favs.answer = ${J(fv(5, favs))}; true`);
        const fr2p = lineFrames(`window.__fakeWs("workshop-favorites", ${J({ version: 5, loading: null })});`, 1200);
        await sleep(260); await shot("yours-load-end");
        const fr2 = await fr2p, lastShown = fr2.findLastIndex((f) => f[1] != null);
        console.log(`        the end: opacity ${MO.brief(fr2)}, bar [${fr2.map((f) => f[4]).filter((x, i, a) => x != null && (i === 0 || x !== a[i - 1])).slice(0, 10)}]`);
        if (fr2.at(-1)[1] != null) v.push("the line never left at the end of the load");
        else {
          const outOp = fr2.slice(0, lastShown + 1).filter((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95).length;
          if (outOp < 2) v.push(`it popped out: ${outOp} in-between opacity frame(s)`);
          if (!fr2.some((f) => f[4] != null && f[4] > 0.99)) v.push("the bar didn't fill out before the line left");
        }
        const g4 = await shownAs(SIX);
        if (J(sorted(g4)) !== J(SIX)) v.push(`the end: the grid shows ${J(g4)} (want all six)`);
        const bad = moved([...fr0, ...fr1, ...fr2], ["opacity", "transform"]);
        if (bad.length) v.push(`the line animates ${J(bad)} (only opacity / transform)`);
      } finally { await yoursDone(); }
      return v;
    });

    // yours:loadLineOff — motion off: the line fades in and out in place (motion-off.js) and its bar changes at once (no sweep);
    // Glow effects off: no glow on the bar; the live wallpaper behind: its words carry the drop-shadow. Shots steam-yours-load-off*.png
    await cell("yours:loadLineOff", async () => {
      const v = [];
      try {
        await yoursOn(yData(), { looks: { morphs: false } });
        if (!(await js(`document.documentElement.classList.contains("no-motion")`))) return ["motion off: the page isn't in no-motion — proved nothing"];
        const favs = yFavs();
        await js(`window.__favs = { hold: true }; true`);
        await setRow("@library", "off", 450);
        const smp = js(MO.SAMPLE({ line: LINE }, 500)); await sleep(40);
        await page(FAV_INC);
        const sIn = await smp;
        console.log(`        motion off: in ${MO.brief(sIn.line)}`);
        v.push(...MO.judge("motion off: the line appearing", sIn.line, { appear: true }));
        const g0 = await lineNow();
        if (glowless(g0?.fillGlow)) v.push(`Glow effects on: the bar has no glow (${g0?.fillGlow}) — the no-glow check below would prove nothing`);
        await js(`window.__favsLet(${J(fv(2, [], { loading: { done: 0, total: null } }))})`);
        await sleep(300);
        await js(`window.__favs.answer = ${J(fv(3, favs.slice(0, 3), { loading: { done: 120, total: 450 } }))}; true`);
        const want = +(120 / 450).toFixed(3);
        const fr = await lineFrames(`window.__fakeWs("workshop-favorites", ${J({ version: 3, loading: { done: 120, total: 450 } })});`, 600);
        const mid = fr.filter((f) => f[4] != null && f[4] > 0.005 && f[4] < want - 0.005).length;
        console.log(`        motion off: bar [${fr.map((f) => f[4]).filter((x, i, a) => i === 0 || x !== a[i - 1]).slice(0, 10)}]`);
        if (!fr.some((f) => f[4] != null && Math.abs(f[4] - want) < 0.01)) v.push(`motion off: the bar never reached 120 / 450 — proved nothing`);
        if (mid > 1) v.push(`motion off: the bar eased (${mid} in-between frames; want it to change at once)`);
        const bad = moved(fr, ["opacity"]);
        if (bad.length) v.push(`motion off: the line animates ${J(bad)} (only a fade)`);
        await shot("yours-load-off");
        // the error under motion off: its room comes at once, no glide; it covers no card
        const room = await errorRoom(4, favs.slice(0, 3));
        console.log(`        motion off, the error's room: ${room.y0} → ${room.y1}, y [${room.ys}]`);
        if (!(room.y1 > room.y0 + 5)) v.push(`motion off: the error took no room above the grid (${room.y0} → ${room.y1})`);
        else if (room.mid > 1) v.push(`motion off: the cards glided for the error (${room.mid} in-between frames; want it at once)`);
        const covOff = await covered();
        if (covOff?.length) v.push(`motion off: the error covers ${J(covOff)}`);
        await sleep(300); await shot("yours-load-error-off");
        await js(`window.__favs.answer = ${J(fv(5, favs))}; true`);
        const smp2 = js(MO.SAMPLE({ line: LINE }, 600)); await sleep(40);
        await ev("workshop-favorites", { version: 5, loading: null });
        const sOut = await smp2;
        console.log(`        motion off: out ${MO.brief(sOut.line)}`);
        v.push(...MO.judge("motion off: the line leaving", sOut.line, { leave: true }));
        await yoursDone();
        await yoursOn(yData(), { looks: { glows: false, liveWallpaperBehindAllTabs: true } });
        const html = await js(`document.documentElement.className`);
        if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
        await js(`window.__favs = { hold: true }; true`);
        await setRow("@library", "off", 450);
        await page(FAV_INC); await sleep(300);
        await js(`window.__favsLet(${J(fv(2, yFavs().slice(0, 3), { loading: { done: 120, total: 450 } }))})`);
        await sleep(900);
        const l = await lineNow();
        console.log(`        no-glow + bg-live: ${J({ glow: l?.fillGlow, words: l?.textFilter })}`);
        if (!l) v.push("no-glow + bg-live: no load line");
        else {
          if (l.outside?.length) v.push(`bg-live: parts of the line lie outside its box ${J(l.outside)}`);
          if (!glowless(l.fillGlow)) v.push(`no-glow: the bar glows (${l.fillGlow})`);
          if (!/drop-shadow/.test(l.textFilter ?? "")) v.push(`bg-live: its words have no drop-shadow (${l.textFilter})`);
        }
        await shot("yours-load-off-live");
        await js(`window.__favs.answer = ${J(fv(3, yFavs().slice(0, 3), { error: LOAD_ERR }))}; true`);
        await ev("workshop-favorites", { version: 3, loading: null });
        await sleep(700);
        const covLive = await covered(), le = await lineNow();
        if (le?.kind !== "error") v.push(`no-glow + bg-live: the error line ${J(le)}`);
        if (covLive?.length) v.push(`no-glow + bg-live: the error covers ${J(covLive)}`);
        if (le?.outside?.length) v.push(`no-glow + bg-live: parts of the error line lie outside its box ${J(le.outside)}`);
        await shot("yours-load-error-live");
      } finally { await yoursDone(); }
      return v;
    });

    // yours:loadError — Steam unreachable mid-load: the line says so with Retry, the favourites loaded so far stay in the grid;
    // Retry asks sync=open once and the rest comes in. Shot steam-yours-load-error.png
    await cell("yours:loadError", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        const favs = yFavs();
        await js(`window.__favs = { hold: true }; true`);
        await setRow("@library", "off", 450);
        await page(FAV_INC); await sleep(300);
        // two loaded, the load still going: the chip floats over the grid's top
        await js(`window.__favsLet(${J(fv(2, favs.slice(0, 2), { loading: { done: 2, total: null } }))})`);
        await shownAs(T("Aurora", "Bamboo")); await sleep(400);
        // Steam unreachable: the error takes its own room above the grid, the cards glide down under it
        const room = await errorRoom(3, favs.slice(0, 2));
        console.log(`        the error's room: the first card ${room.y0} → ${room.y1}, y [${room.ys}]`);
        if (!(room.y1 > room.y0 + 5)) v.push(`the error took no room above the grid (the first card ${room.y0} → ${room.y1})`);
        else if (room.mid < 2) v.push(`the cards jumped down for the error (${room.mid} in-between frame(s); want a glide)`);
        const l = (await waitFor(async () => { const x = await lineNow(); return x?.kind === "error" ? x : null; }, 2000)) ?? await lineNow();
        const cov = await covered();
        if (cov?.length) v.push(`the error covers ${J(cov)}`);
        console.log(`        error: ${J(l)}`);
        await sleep(400); // the words cross-fade in
        const ew = await js(`(() => { const t = document.querySelector(${J(LINE + " .wsl-text")}); if (!t) return null; let op = 1; for (let x = t; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
          // the line takes no click (hit-testing looks through it): what lies at its words' centre must not be a card
          const r = t.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { op: +op.toFixed(2), card: !!at?.closest(".card") }; })()`);
        if (!ew || ew.op < 0.95 || ew.card) v.push(`the error's words don't show: ${J(ew)} (want them at full opacity, over no card)`);
        if (l?.kind !== "error" || l.text !== LOAD_ERR) v.push(`the line on an error: ${J(l)} (want kind error, ${J(LOAD_ERR)})`);
        if (!l?.retry) v.push("the error line has no Retry");
        if (l?.outside?.length) v.push(`the error: parts of the line lie outside its box ${J(l.outside)}`);
        const g0 = await shownAs(T("Aurora", "Bamboo"));
        if (J(sorted(g0)) !== J(T("Aurora", "Bamboo"))) v.push(`the error: the grid shows ${J(g0)} (want the two loaded, kept)`);
        await shot("yours-load-error");
        const n0 = (await favAsks()).length;
        await js(`window.__favs.answer = ${J(fv(4, favs))}; true`);
        await page(`document.querySelector(${J(LINE + " [data-wsl-retry]")})?.click();`);
        await sleep(400);
        const asks = (await favAsks()).slice(n0);
        if (J(asks) !== J(["open"])) v.push(`Retry asked ${J(asks)} (want one sync=open)`);
        const g1 = await shownAs(SIX);
        if (J(sorted(g1)) !== J(SIX)) v.push(`after Retry: ${J(g1)} (want all six)`);
        if (!(await waitFor(async () => !(await lineNow()), 2000))) v.push("after Retry: the line stayed");
      } finally { await yoursDone(); }
      return v;
    });

    // yours:starLive — on Favourites ✓, the sidebar's star (the POST stubbed) and the workshop-favorites event that follows:
    // unstarred, the card leaves the grid; starred again (a non-favourite now), it joins; no reload, no /browse
    await cell("yours:starLive", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        const favs = yFavs();
        await setRow("@favorites", "inc");
        if (J(sorted(await shownAs(SIX))) !== J(SIX)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        await W({ fav: { signedIn: true, favorited: true } });
        await openSide((await shown()).indexOf("Aurora"));
        const FAV = `${SIDE} [data-ws-fav]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "on"`), 3000))) return ["Aurora's favourite tile never read as on"];
        await js(`window.__noReload = true; true`);
        const b0 = (await browses()).length;
        await page(`document.querySelector(${J(FAV)}).click();`); await sleep(300);
        const posts = (await calls()).filter((c) => c.p === "/workshop/favorite" && c.m === "POST");
        if (posts.at(-1)?.body?.favorite !== false) v.push(`the unstar posted ${J(posts.at(-1)?.body)}`);
        const five = SIX.filter((t) => t !== "Aurora");
        await js(`window.__favs = { answer: ${J(fv(2, favs.filter((w) => w.title !== "Aurora")))} }; true`);
        await ev("workshop-favorites", { version: 2, loading: null });
        const g1 = await shownAs(five);
        console.log(`        unstarred: ${J(g1)}`);
        if (J(sorted(g1)) !== J(five)) v.push(`unstarred: ${J(sorted(g1))} (want Aurora gone)`);
        if (!(await js(`!!document.querySelector(${J(FAV)})`))) return [...v, "the sidebar closed with its card: no star to click again"];
        await page(`document.querySelector(${J(FAV)}).click();`); await sleep(300);
        const posts2 = (await calls()).filter((c) => c.p === "/workshop/favorite" && c.m === "POST");
        if (posts2.at(-1)?.body?.favorite !== true) v.push(`the star posted ${J(posts2.at(-1)?.body)}`);
        await js(`window.__favs = { answer: ${J(fv(3, favs))} }; true`);
        await ev("workshop-favorites", { version: 3, loading: null });
        const g2 = await shownAs(SIX);
        console.log(`        starred: ${J(g2)}`);
        if (J(sorted(g2)) !== J(SIX)) v.push(`starred: ${J(sorted(g2))} (want Aurora back)`);
        if (!(await js(`window.__noReload === true`))) v.push("the page reloaded");
        const sent = (await browses()).slice(b0);
        if (sent.length) v.push(`${sent.length} /browse request(s)`);
      } finally { await js(`window.__favs = null; true`).catch(() => {}); await yoursDone(); }
      return v;
    });

    // yours:check — Browse open with Favourites ✕: one sync=open, then sync=check each (shortened) minute; none while the window
    // is inactive, again once it's back; none with no Favourites row on
    await cell("yours:check", async () => {
      const v = [];
      const since = async (n) => (await favAsks()).slice(n);
      try {
        await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await js(`localStorage.setItem("__probe_yours", ${J(J(yData()))}); localStorage.setItem("__probe_fav_tick", "400"); localStorage.removeItem("liascape.wsLocalSort");
          localStorage.setItem("liascape.browseFilter", ${J(J({ ...BF0, exclude: ["@favorites"] }))}); localStorage.setItem("liascape.browseFilterHidden", "true"); true`);
        await browseWs(SIGNED_IN);
        await sleep(200);
        const a0 = await favAsks();
        console.log(`        Browse open, Favourites ✕: ${J(a0)}`);
        const opens = a0.filter((x) => x === "open").length;
        if (opens !== 1) v.push(`Browse open with Favourites ✕ asked sync=open ${opens} time(s) (want once)`);
        let n = (await favAsks()).length; await sleep(1300);
        const a1 = await since(n);
        console.log(`        active, 1.3 s: ${J(a1)}`);
        if (a1.filter((x) => x === "check").length < 2) v.push(`active: ${J(a1)} in 1.3 s (want a sync=check each 400 ms)`);
        if (a1.some((x) => x !== "check")) v.push(`active: asks other than the check ${J(a1)}`);
        await js(`document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); true`);
        await sleep(100); n = (await favAsks()).length; await sleep(1300);
        const a2 = await since(n);
        if (a2.length) v.push(`the window inactive: ${J(a2)} (want none)`);
        await js(`delete document.hasFocus; window.dispatchEvent(new Event("focus")); true`);
        n = (await favAsks()).length; await sleep(1000);
        const a3 = await since(n);
        if (!a3.includes("check")) v.push(`active again: ${J(a3)} (want the check back)`);
        await setRow("@favorites", "off", 300);
        n = (await favAsks()).length; await sleep(1300);
        const a4 = await since(n);
        console.log(`        inactive: ${J(a2)}, active again: ${J(a3)}, no row: ${J(a4)}`);
        if (a4.length) v.push(`no Favourites row on: ${J(a4)} (want none)`);
      } finally { await js(`localStorage.removeItem("__probe_fav_tick"); true`); await yoursDone(); }
      return v;
    });

    // yours:oneOpen — the favourites unread (the answer held from the start) with Favourites ✓ saved: the start's reads and a
    // socket reconnect's all share one sync=open
    await cell("yours:oneOpen", async () => {
      const v = [];
      try {
        await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await js(`localStorage.setItem("__probe_yours", ${J(J(yData()))}); localStorage.setItem("__probe_favs_hold", "1"); localStorage.removeItem("liascape.wsLocalSort");
          localStorage.setItem("liascape.browseFilter", ${J(J({ ...BF0, include: ["@favorites"] }))}); localStorage.setItem("liascape.browseFilterHidden", "true"); true`);
        await browseWs(SIGNED_IN);
        await js(`localStorage.removeItem("__probe_favs_hold"); true`);
        const a0 = await favAsks();
        if (!a0.includes("open")) return [`the held start never asked the favourites (${J(a0)}) — proved nothing`];
        const s0 = await js(`window.__st.bodies.filter((b) => b.p === "/steam/status").length`);
        await js(`window.__wsDrop()`);
        if (!(await waitFor(async () => (await js(`window.__st.bodies.filter((b) => b.p === "/steam/status").length`)) > s0, 4000))) v.push("the socket's reconnect never re-read the backend — proved nothing");
        await sleep(400);
        await js(`window.__favsLet()`);
        const g = await shownAs(SIX);
        await sleep(400);
        const asks = await favAsks();
        console.log(`        asks: ${J(asks)}, shown ${J(g)}`);
        const opens = asks.filter((x) => x === "open").length;
        if (opens !== 1) v.push(`the start and a reconnect with the favourites unread asked sync=open ${opens} times (want one shared ask)`);
        if (J(sorted(g)) !== J(SIX)) v.push(`then: ${J(g)} (want the six favourites)`);
      } finally { await js(`localStorage.removeItem("__probe_favs_hold"); true`); await yoursDone(); }
      return v;
    });

    // yours:steamUnknown — /steam/status can't be read: the Favourites row isn't dimmed ("Sign in to Steam" would be a guess),
    // but ✓ can't be set until the status says signed in; then it can
    await cell("yours:steamUnknown", async () => {
      const v = [];
      const row = () => js(`(() => { const r = document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"]'); if (!r) return null; const w = r.querySelector("[data-wf-why]");
        return { off: r.hasAttribute("data-wf-off"), why: w && w.checkVisibility() ? w.textContent.trim() : null, st: r.dataset.state }; })()`);
      try {
        await js(`localStorage.setItem("__probe_steam_status_fail", "1"); true`);
        await yoursOn(yData());
        await setRow("@library", "off", 450);
        if (!(await js(`window.__st.bodies.some((b) => b.p === "/steam/status")`))) return ["the page never asked /steam/status — proved nothing"];
        const r0 = await row();
        console.log(`        status unknown: ${J(r0)}`);
        if (!r0) return ["no Favourites row on the Workshop's column"];
        if (r0.off || r0.why) v.push(`Steam's status unknown: the row is dimmed (${J(r0)}) as if signed out`);
        await page(FAV_INC); await sleep(400);
        const r1 = await row();
        if (r1?.st !== "off") v.push(`unknown: a click on ✓ turned it ${r1?.st} (want it refused until the status is known)`);
        const asked = (await favAsks()).length;
        if (asked) v.push(`unknown: the favourites were asked ${asked} time(s)`);
        await js(`window.__st.status = ${J(SIGNED_IN)}; true`);
        await ev("steam-status", SIGNED_IN); await sleep(200);
        await page(FAV_INC);
        const g = await shownAs(SIX);
        if (J(sorted(g)) !== J(SIX)) v.push(`signed in, Favourites ✓: ${J(g)} (want the six favourites)`);
      } finally { await js(`localStorage.removeItem("__probe_steam_status_fail"); true`); await yoursDone(); }
      return v;
    });

    // yours:empty — a local set nothing matches: "Nothing here matches" with a control that clears the search and the other tags
    // but never the Yours rows; inside a creator's list too (its own empty note hidden on a set); motion off it fades in place,
    // over the live wallpaper its words carry the drop-shadow. Shots steam-yours-empty*.png
    await cell("yours:empty", async () => {
      const v = [];
      const NONE = "[data-wf-none=set]";
      const none = () => js(`(() => { const e = document.querySelector(${J(NONE)}); if (!e) return null; const b = e.querySelector("button"), s = e.querySelector("span");
        return { text: s?.textContent ?? null, btn: b?.textContent.trim() ?? null, filter: s ? getComputedStyle(s).filter : null }; })()`);
      const rowSt = (tag) => js(`document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag=${J(tag)}]')?.dataset.state ?? null`);
      const typed = () => js(`document.querySelector(".tsearch input.search")?.value ?? null`);
      try {
        await yoursOn(yData());
        await setRow("@favorites", "inc");
        if (J(sorted(await shownAs(SIX))) !== J(SIX)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        if (await none()) v.push("the whole set shows the empty message");
        await setRow("Landscape", "inc");
        await shownAs(T("Cinder", "Fjord"));
        await search("zzz-nothing");
        const n1 = await waitFor(none, 2000);
        console.log(`        nothing matches: ${J(n1)}`);
        if (n1?.text !== "Nothing here matches") v.push(`an empty set: ${J(n1?.text)} (want "Nothing here matches")`);
        if (!n1?.btn) v.push("an empty set: no control to clear the search and the tags");
        await sleep(400); await shot("yours-empty");
        await page(`document.querySelector(${J(NONE + " button")})?.click();`);
        const g1 = await shownAs(SIX);
        const after = { fav: await rowSt("@favorites"), landscape: await rowSt("Landscape"), search: await typed() };
        console.log(`        cleared: ${J(g1)} ${J(after)}`);
        if (J(sorted(g1)) !== J(SIX)) v.push(`the clear shows ${J(g1)} (want the six favourites)`);
        if (after.fav !== "inc") v.push(`the clear turned Favourites ${after.fav} (the Yours rows stay)`);
        if (after.landscape !== "off" || after.search !== "") v.push(`the clear left ${J(after)} (want Landscape off, the search empty)`);
        // inside a creator's list
        await setRow("@favorites", "off");
        await openSide((await shown()).indexOf("ws-a"));
        if (!(await waitFor(() => js(`document.querySelector("${SIDE} [data-ws-creator]")?.dataset.wsCreator === "known"`), 3000))) return [...v, "ws-a's sidebar has no creator row"];
        await page(`document.querySelector("${SIDE} [data-ws-creator]").click();`);
        await shownAs(T("ws-a", "Aurora", "ws-b"));
        await waitFor(() => js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length === 0`), 3000);
        await setRow("@favorites", "inc");
        const c0 = await shownAs(T("Aurora", "Bamboo"));
        if (J(sorted(c0)) !== J(T("Aurora", "Bamboo"))) return [...v, `the creator's favourites: ${J(c0)} — proved nothing`];
        await search("zzz-nothing");
        const n2 = await waitFor(none, 2000);
        const note = await js(`document.querySelector("[data-ws-list-note]")?.textContent ?? null`);
        console.log(`        in a creator's list: ${J(n2)}, list note ${J(note)}`);
        if (n2?.text !== "Nothing here matches") v.push(`in a creator's list: ${J(n2?.text)} (want "Nothing here matches")`);
        if (note) v.push(`in a creator's list: the list's own note shows too (${J(note)})`);
        await page(`document.querySelector(${J(NONE + " button")})?.click();`);
        const c1 = await shownAs(T("Aurora", "Bamboo"));
        if (J(sorted(c1)) !== J(T("Aurora", "Bamboo"))) v.push(`in a creator's list, cleared: ${J(c1)} (want Aurora, Bamboo)`);
        // inside a scene's presets list (its Type ignored: views/Browse.tsx withoutType)
        await yoursDone();
        await yoursOn(yData({ preset: true }), { scenes: true });
        await openSide((await shown()).indexOf("Base Scene"));
        if (!(await waitFor(() => js(`!!document.querySelector("${SIDE} [data-ws-presets]")`), 3000))) return [...v, "Base Scene's sidebar has no Presets row"];
        await page(`document.querySelector("${SIDE} [data-ws-presets]").click();`);
        if (J(sorted(await shownAs(T("ws-preset-x", "Dune")))) !== J(T("Dune", "ws-preset-x"))) return [...v, `the presets list shows ${J(await shown())} — proved nothing`];
        await waitFor(() => js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length === 0`), 3000);
        await setRow("@favorites", "inc");
        if (J(await shownAs(T("Dune"))) !== J(T("Dune"))) return [...v, `the presets list's favourites: ${J(await shown())} — proved nothing`];
        await search("zzz-nothing");
        const n4 = await waitFor(none, 2000);
        const note4 = await js(`document.querySelector("[data-ws-list-note]")?.textContent ?? null`);
        console.log(`        in a presets list: ${J(n4)}, list note ${J(note4)}`);
        if (n4?.text !== "Nothing here matches") v.push(`in a presets list: ${J(n4?.text)} (want "Nothing here matches")`);
        if (note4) v.push(`in a presets list: the list's own note shows too (${J(note4)})`);
        await sleep(300); await shot("yours-empty-presets");
        await page(`document.querySelector(${J(NONE + " button")})?.click();`);
        const p1 = await shownAs(T("Dune"));
        if (J(p1) !== J(T("Dune"))) v.push(`in a presets list, cleared: ${J(p1)} (want Dune)`);
        // only a Type tag besides the Yours rows, which a presets list ignores: no "Clear filters" (it would change nothing)
        await setRow("Video", "inc");
        if (J(await shownAs(T("Dune"))) !== J(T("Dune"))) return [...v, `a presets list with Video ✓: ${J(await shown())} (its Type is ignored there) — proved nothing`];
        await setRow("@library", "inc");
        const p5 = await shownAs([]);
        const n5 = await waitFor(none, 2000);
        console.log(`        in a presets list, Type alone: ${J(p5)} ${J(n5)}`);
        if (p5.length || n5?.text !== "Nothing here matches") v.push(`in a presets list, Favourites ✓ + In my library ✓: ${J(p5)} ${J(n5)} (want empty, "Nothing here matches") — proved nothing`);
        else if (n5.btn) v.push(`in a presets list with only a Type tag besides the Yours rows: a ${J(n5.btn)} control that changes nothing`);
        await setRow("@library", "off"); await setRow("Video", "off");
        await yoursDone();
        await yoursOn(yData(), { looks: { morphs: false, liveWallpaperBehindAllTabs: true } });
        await setRow("@favorites", "inc");
        await shownAs(SIX);
        const smp = js(MO.SAMPLE({ none: NONE }, 500)); await sleep(40);
        await search("zzz-nothing");
        const s = await smp;
        console.log(`        motion off: in ${MO.brief(s.none)}`);
        v.push(...MO.judge("motion off: the message appearing", s.none, { appear: true }));
        const n3 = await none();
        if (!/drop-shadow/.test(n3?.filter ?? "")) v.push(`bg-live: its words have no drop-shadow (${n3?.filter})`);
        await sleep(300); await shot("yours-empty-live");
      } finally { await yoursDone(); }
      return v;
    });

    // yours:signOut — Favourites ✓ showing: a signed-out steam-status → the favourites leave the grid at once and the row dims with
    // its reason; another account signing in (its answer held) never shows the first one's favourites: the line, sync=open, then
    // its own. Shots steam-yours-signout*.png
    await cell("yours:signOut", async () => {
      const v = [];
      try {
        await yoursOn(yData());
        await setRow("@favorites", "inc");
        if (J(sorted(await shownAs(SIX))) !== J(SIX)) return [`Favourites ✓ shows ${J(await shown())} — proved nothing`];
        const onlyFavs = T("Bamboo", "Cinder", "Dune", "Fjord"); // not on the Workshop's page
        await js(`window.__st.status = ${J(SIGNED_OUT)}; true`);
        await ev("steam-status", SIGNED_OUT);
        await sleep(50);
        const g0 = await shown();
        const r0 = await js(`(() => { const r = document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"]'); const w = r?.querySelector("[data-wf-why]");
          return { off: !!r?.hasAttribute("data-wf-off"), why: w ? w.textContent.trim() : null }; })()`);
        console.log(`        signed out: ${J(g0)} ${J(r0)}`);
        if (g0.some((t) => onlyFavs.includes(t))) v.push(`signed out: the favourites still show (${J(g0)})`);
        if (!r0.off || r0.why !== "Sign in to Steam") v.push(`signed out: the row ${J(r0)} (want dimmed, "Sign in to Steam")`);
        await shot("yours-signout");
        // another account signs in, its favourites held
        const B = { ...SIGNED_IN, accountName: "probe-acct-2" };
        await js(`window.__favs = { hold: true }; true`);
        const n0 = (await favAsks()).length;
        await js(`window.__st.status = ${J(B)}; true`);
        await ev("steam-status", B);
        await sleep(400);
        const g1 = await shown(), l1 = await lineNow(), asks = (await favAsks()).slice(n0);
        console.log(`        another account, held: ${J(g1)}, line ${J(l1?.text)}, asks ${J(asks)}`);
        if (g1.some((t) => SIX.includes(t))) v.push(`another account signed in: the first one's favourites show (${J(g1)})`);
        if (l1?.text !== "Loading your favourites…") v.push(`another account signed in: the line reads ${J(l1?.text)} (want "Loading your favourites…")`);
        if (!asks.includes("open")) v.push(`another account signed in: no sync=open (${J(asks)})`);
        await js(`window.__favsLet(${J(fv(9, [GLACIER]))})`);
        const g2 = await shownAs(T("Glacier"));
        if (J(g2) !== J(T("Glacier"))) v.push(`another account's favourites: ${J(g2)} (want its own, Glacier)`);
        await shot("yours-signout-other");
      } finally { await js(`window.__favs = null; true`).catch(() => {}); await yoursDone(); }
      return v;
    });

    // The Library's Favourites row (lib:yours:*): three Workshop items (Ember starred, Glacier and Zephyr not) and one non-Workshop item
    const LIB_ALL = T("Ember", "Glacier", "Plain", "Zephyr");
    const LIB_Y = [{ title: "Ember", workshopId: "950005" }, { title: "Glacier", workshopId: "950007" }, { title: "Zephyr", workshopId: "950008" },
      { title: "Plain", workshopId: null }];
    const libCards = () => js(`[...document.querySelectorAll(".lib-scroll .card.lib:not([data-leaving]) [data-title]")].map((e) => e.dataset.title)`);
    const libCardsAs = async (want, ordered = false, ms = 3000) => {
      const norm = (xs) => J(ordered ? xs : sorted(xs));
      return (await waitFor(async () => { const t = await libCards(); return norm(t) === norm(want) ? t : null; }, ms)) ?? await libCards();
    };
    // the Library signed in with the library above and a clean filter and sort; false = it didn't show the four items
    const libYoursOn = async () => {
      await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await js(`localStorage.setItem("__probe_yours", ${J(J({ ...yData(), lib: LIB_Y }))}); for (const k of ["libFilter", "libSort", "wsLocalSort"]) localStorage.removeItem("liascape." + k);
        localStorage.setItem("liascape.libFilterHidden", "false"); true`);
      await load(SIGNED_IN); await tab("Library");
      return J(sorted(await libCardsAs(LIB_ALL))) === J(LIB_ALL);
    };
    const libYoursDone = async () => {
      await js(`window.__favs = null; localStorage.removeItem("__probe_yours"); for (const k of ["libFilter", "libFilterHidden", "libSort"]) localStorage.removeItem("liascape." + k); true`).catch(() => {});
      await load(SIGNED_OUT);
    };
    // the Library's load line / error: the cards' y moves under it, the line's box over a card
    const libCardY = () => js(`(() => { const c = document.querySelector(".lib-scroll .card.lib:not([data-leaving])"); return c ? +c.getBoundingClientRect().y.toFixed(1) : null; })()`);

    // lib:yours:fav — the Library's Favourites row: ✓ keeps the library's items starred on the Workshop, ✕ the rest (a non-Workshop
    // item included), – all; signed out the row is dimmed and means nothing; the Library's own sort and search still apply on top;
    // a workshop-favorites event that adds a second star updates ✓ live; one that removes a selected card's star empties the
    // selection and leaves the scroll where it was. Shots steam-libyours-*.png
    await cell("lib:yours:fav", async () => {
      const v = [];
      const cards = libCards, cardsAs = libCardsAs, ALL = LIB_ALL;
      const rowOf = () => js(`(() => { const r = document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"]'); if (!r) return null; const w = r.querySelector("[data-wf-why]");
        return { off: r.hasAttribute("data-wf-off"), why: w && w.checkVisibility() ? w.textContent.trim() : null, st: r.dataset.state }; })()`);
      const libSort = async (label) => {
        const ok = await page(`document.querySelector("[data-sortsplit=library] .ss-sort").click(); await new Promise((r) => setTimeout(r, 200));
          const o = [...document.querySelectorAll(".sel-pop .sel-opt")].find((x) => x.textContent.trim() === ${J(label)}); if (!o) { document.querySelector(".sel-backdrop")?.click(); return false; }
          o.click(); return true;`);
        await sleep(300);
        return ok;
      };
      try {
        if (!(await libYoursOn())) return [`the Library shows ${J(await cards())} before any row — proved nothing`];
        await setRow("@favorites", "inc");
        const g1 = await cardsAs(T("Ember"));
        console.log(`        Favourites ✓: ${J(g1)}`);
        if (J(g1) !== J(T("Ember"))) v.push(`Favourites ✓: ${J(g1)} (want only the starred Ember)`);
        if ((await favAsks()).filter((x) => x === "open").length < 1) v.push("Favourites ✓: the favourites were never read (sync=open)");
        // a capture straight after a card leaves still holds the old frame (the Library's video cards repaint late under Xvfb)
        await sleep(1500); await shot("libyours-inc");
        await setRow("@favorites", "exc");
        const g2 = await cardsAs(T("Glacier", "Plain", "Zephyr"));
        console.log(`        Favourites ✕: ${J(g2)}`);
        if (J(sorted(g2)) !== J(T("Glacier", "Plain", "Zephyr"))) v.push(`Favourites ✕: ${J(g2)} (want the three others, the non-Workshop Plain included)`);
        await sleep(1500); await shot("libyours-exc");
        // the Library's own sort and search apply on top
        await libSort("Name Z–A");
        const g3 = await cardsAs(T("Zephyr", "Plain", "Glacier"), true);
        if (J(g3) !== J(T("Zephyr", "Plain", "Glacier"))) v.push(`✕ with Name Z–A: ${J(g3)} (want Zephyr, Plain, Glacier)`);
        await search("e");
        const g4 = await cardsAs(T("Zephyr", "Glacier"), true);
        if (J(g4) !== J(T("Zephyr", "Glacier"))) v.push(`✕ with Name Z–A and the search "e": ${J(g4)} (want Zephyr, Glacier)`);
        await setRow("@favorites", "inc");
        const g5 = await cardsAs(T("Ember"));
        if (J(g5) !== J(T("Ember"))) v.push(`✓ with the search "e": ${J(g5)} (want Ember)`);
        await search("zephyr");
        const g6 = await cardsAs([]);
        if (g6.length) v.push(`✓ with the search "zephyr": ${J(g6)} (want none)`);
        if (!(await js(`!!document.querySelector(".lib-scroll [data-wf-none]")`))) v.push("✓ with nothing left: no empty message");
        await search(""); await libSort("Name A–Z");
        // a second star arrives
        await cardsAs(T("Ember"));
        await js(`window.__favs = { answer: ${J(fv(5, [...yFavs(), GLACIER]))} }; true`);
        await ev("workshop-favorites", { version: 5, loading: null });
        const g7 = await cardsAs(T("Ember", "Glacier"));
        console.log(`        a second star: ${J(g7)}`);
        if (J(sorted(g7)) !== J(T("Ember", "Glacier"))) v.push(`a second star: ${J(g7)} (want Ember and Glacier)`);
        // a star leaves while its card is selected and the grid is scrolled: the selection empties, the scroll stays
        const eb = await cardBox("Ember");
        if (!eb) v.push("no Ember card to select — proved nothing");
        else {
          send({ type: "mouseDown", x: Math.round(eb.x), y: Math.round(eb.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(40);
          send({ type: "mouseUp", x: Math.round(eb.x), y: Math.round(eb.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(250);
          const sel0 = await js(`+(/(\\d+) selected/.exec(document.querySelector(".status")?.textContent ?? "")?.[1] ?? 0)`);
          const top0 = await js(`(() => { const g = document.querySelector(".lib-scroll .grid"), sc = g.parentElement; g.style.minHeight = "3000px"; sc.scrollTop = 200; return sc.scrollTop; })()`);
          if (sel0 !== 1 || top0 < 100) v.push(`the setup: ${sel0} selected, scrolled to ${top0} — proved nothing`);
          else {
            await js(`window.__favs = { answer: ${J(fv(6, [GLACIER]))} }; true`);
            await ev("workshop-favorites", { version: 6, loading: null });
            const g7b = await cardsAs(T("Glacier"));
            // the selection's own size: a card that left the grid shows no class, but the status line still counts it (its old line
            // fades out for a moment: waited on)
            const selN = () => js(`+(/(\\d+) selected/.exec(document.querySelector(".status")?.textContent ?? "")?.[1] ?? 0)`);
            await waitFor(async () => (await selN()) === 0, 2000);
            const sel1 = await selN();
            const top1 = await js(`document.querySelector(".lib-scroll").scrollTop`);
            console.log(`        Ember's star removed: ${J(g7b)}, selected ${sel0} → ${sel1}, scroll ${top0} → ${top1}`);
            if (J(g7b) !== J(T("Glacier"))) v.push(`Ember unstarred: ${J(g7b)} (want Glacier)`);
            if (sel1 !== 0) v.push(`Ember unstarred while selected: ${sel1} card(s) still selected (want the selection emptied)`);
            if (Math.abs(top1 - top0) > 1) v.push(`Ember unstarred: the grid scrolled ${top0} → ${top1} (want it kept)`);
          }
          await js(`document.querySelector(".lib-scroll .grid").style.minHeight = ""; true`);
        }
        await js(`window.__favs = { answer: ${J(fv(7, [...yFavs(), GLACIER]))} }; true`);
        await ev("workshop-favorites", { version: 7, loading: null });
        await cardsAs(T("Ember", "Glacier"));
        // – shows all
        await setRow("@favorites", "off");
        const g8 = await cardsAs(ALL);
        if (J(sorted(g8)) !== J(ALL)) v.push(`Favourites –: ${J(g8)} (want all four)`);
        // signed out: the row is dimmed with its reason, a saved ✓ means nothing
        await setRow("@favorites", "inc");
        await cardsAs(T("Ember", "Glacier"));
        await js(`window.__st.status = ${J(SIGNED_OUT)}; true`);
        await ev("steam-status", SIGNED_OUT);
        const g9 = await cardsAs(ALL);
        const r9 = await rowOf();
        console.log(`        signed out: ${J(g9)} ${J(r9)}`);
        if (J(sorted(g9)) !== J(ALL)) v.push(`signed out, a saved ✓: ${J(g9)} (want all four)`);
        if (!r9?.off || r9.why !== "Sign in to Steam") v.push(`signed out: the row ${J(r9)} (want dimmed, "Sign in to Steam")`);
        await sleep(400); await shot("libyours-signedout");
        await js(`window.__st.status = ${J(SIGNED_IN)}; true`);
        await ev("steam-status", SIGNED_IN);
        const g10 = await cardsAs(T("Ember", "Glacier"), false, 4000);
        if (J(sorted(g10)) !== J(T("Ember", "Glacier"))) v.push(`signed in again: ${J(g10)} (want the ✓ back: Ember, Glacier)`);
      } finally { await libYoursDone(); }
      return v;
    });

    // lib:yours:load — Library ✓ with the first read still on its way: the whole Library shows under the load line ("Loading your
    // favourites…", then its counts as the list comes in, the grid narrowing to what's in), never a silent no-op; the read done, the
    // line leaves and the set shows. Shots steam-libyours-load*.png
    await cell("lib:yours:load", async () => {
      const v = [];
      try {
        if (!(await libYoursOn())) return [`the Library shows ${J(await libCards())} before any row — proved nothing`];
        const favs = yFavs();
        await js(`window.__favs = { hold: true }; true`);
        if (await lineNow()) return ["the load line shows before any Favourites row — proved nothing"];
        const fr = await lineFrames(FAV_INC, 500);
        const i0 = fr.findIndex((f) => f[1] != null);
        if (i0 < 0) return ["Library Favourites ✓ with the answer held: no load line"];
        if (i0 > 1) v.push(`the line first showed ${i0} frames after the click (want within one)`);
        if (fr[i0][3] !== "Loading your favourites…") v.push(`held: it reads ${J(fr[i0][3])} (want "Loading your favourites…")`);
        const g0 = await libCardsAs(LIB_ALL);
        console.log(`        held: ${J(g0)}, line ${J(fr[i0][3])}`);
        if (J(sorted(g0)) !== J(LIB_ALL)) v.push(`held: the Library shows ${J(g0)} (want all four until the list is in)`);
        if (await js(`!!document.querySelector(".lib-scroll [data-wf-none]")`)) v.push("held: an empty message shows");
        await sleep(400); await shot("libyours-load-held");
        // the chip floats over the grid's top and takes no click: what lies under its words is a card (or nothing), never the chip
        const at = await js(`(() => { const t = document.querySelector(${J(LINE + " .wsl-text")}); if (!t) return null; const r = t.getBoundingClientRect();
          const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { chip: !!e?.closest(${J(LINE)}), card: !!e?.closest(".card") }; })()`);
        if (at?.chip) v.push("held: the load line takes the click meant for what lies under it");
        // the first answer: nothing in yet, then the first two (Ember is one) with a count
        await js(`window.__favsLet(${J(fv(2, [], { loading: { done: 0, total: null } }))})`);
        await sleep(300);
        const g1 = await libCards();
        if (J(sorted(g1)) !== J(LIB_ALL)) v.push(`loading, none in: the Library shows ${J(g1)} (want all four)`);
        await js(`window.__favs.answer = ${J(fv(3, favs.slice(4, 6), { loading: { done: 2, total: 6 } }))}; true`);
        await ev("workshop-favorites", { version: 3, loading: { done: 2, total: 6 } });
        const g2 = await libCardsAs(T("Ember"));
        const l2 = (await waitFor(async () => { const l = await lineNow(); return l?.text === "Loading your favourites — 2 of 6" ? l : null; }, 2000)) ?? await lineNow();
        console.log(`        2 of 6: ${J(g2)}, line ${J(l2?.text)}`);
        if (l2?.text !== "Loading your favourites — 2 of 6") v.push(`2 of 6: the line reads ${J(l2?.text)}`);
        if (J(g2) !== J(T("Ember"))) v.push(`2 of 6: the Library shows ${J(g2)} (want what's in so far: Ember)`);
        await js(`window.__favs.answer = ${J(fv(4, favs))}; true`);
        await ev("workshop-favorites", { version: 4, loading: null });
        const g3 = await libCardsAs(T("Ember"));
        if (J(g3) !== J(T("Ember"))) v.push(`loaded: the Library shows ${J(g3)} (want Ember)`);
        if (!(await waitFor(async () => !(await lineNow()), 2500))) v.push("loaded: the line stayed");
      } finally { await libYoursDone(); }
      return v;
    });

    // lib:yours:error — Library ✓ with Steam unreachable and nothing read: the whole Library shows (never an empty grid), the error
    // and Retry take their own room above it (the cards glide down, none covered); Retry reads again and the set shows.
    // Shot steam-libyours-error.png
    await cell("lib:yours:error", async () => {
      const v = [];
      try {
        if (!(await libYoursOn())) return [`the Library shows ${J(await libCards())} before any row — proved nothing`];
        const favs = yFavs();
        await js(`window.__favs = { hold: true }; true`);
        await page(FAV_INC); await sleep(300);
        const y0 = await libCardY();
        await js(`window.__favs.answer = ${J(fv(2, [], { error: LOAD_ERR }))}; true`);
        await js(`window.__favsLet()`);
        const l = (await waitFor(async () => { const x = await lineNow(); return x?.kind === "error" ? x : null; }, 2000)) ?? await lineNow();
        await sleep(500);
        const y1 = await libCardY();
        const g0 = await libCards();
        console.log(`        error: ${J(l?.text)}, retry ${l?.retry}, cards ${J(g0)}, first card y ${y0} → ${y1}`);
        if (l?.kind !== "error" || l.text !== LOAD_ERR) v.push(`the line on an error: ${J(l)} (want kind error, ${J(LOAD_ERR)})`);
        if (!l?.retry) v.push("the error line has no Retry");
        if (J(sorted(g0)) !== J(LIB_ALL)) v.push(`the error: the Library shows ${J(g0)} (want all four, not an empty grid)`);
        if (await js(`!!document.querySelector(".lib-scroll [data-wf-none]")`)) v.push("the error: \"Nothing here matches\" shows");
        if (!(y1 > y0 + 5)) v.push(`the error took no room above the grid (the first card ${y0} → ${y1})`);
        const cov = await js(`(() => { const e = document.querySelector(${J(LINE)}); if (!e) return null; const c = e.getBoundingClientRect();
          return [...document.querySelectorAll(".lib-scroll .card.lib:not([data-leaving])")].filter((k) => { const r = k.getBoundingClientRect();
            return Math.min(c.right, r.right) - Math.max(c.left, r.left) > 0.5 && Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top) > 0.5; }).map((k) => k.querySelector("[data-title]")?.dataset.title); })()`);
        if (cov?.length) v.push(`the error covers ${J(cov)}`);
        await shot("libyours-error");
        const n0 = (await favAsks()).length;
        await js(`window.__favs.answer = ${J(fv(4, favs))}; true`);
        await page(`document.querySelector(${J(LINE + " [data-wsl-retry]")})?.click();`);
        await sleep(400);
        const asks = (await favAsks()).slice(n0);
        if (J(asks) !== J(["open"])) v.push(`Retry asked ${J(asks)} (want one sync=open)`);
        const g1 = await libCardsAs(T("Ember"));
        if (J(g1) !== J(T("Ember"))) v.push(`after Retry: ${J(g1)} (want the starred Ember)`);
        if (!(await waitFor(async () => !(await lineNow()), 2500))) v.push("after Retry: the line stayed");
      } finally { await libYoursDone(); }
      return v;
    });

    // yours:errorFirst — the error as the first line a page's load line shows: an error already read (Browse's Favourites ✕,
    // then –), then the row turned on in a page whose line never showed (the Library's ✓; Browse rebuilt by a tab switch, ✕):
    // the error's room glides the cards down in both, per frame, never a jump. The dock is no box while it holds no line
    // (index.css .ws-set-load-dock:empty), so it has no first size of its own to glide from
    await cell("yours:errorFirst", async () => {
      const v = [];
      const firstY = (sel) => `(() => { const c = document.querySelector(${J(sel)}); return c ? +c.getBoundingClientRect().y.toFixed(1) : null; })()`;
      const glideOf = async (sel, act, what) => {
        const y0 = await js(firstY(sel));
        const fr = await page(`const out = [], t0 = performance.now();
          const rec = new Promise((res) => { const f = () => { const t = Math.round(performance.now() - t0); out.push([t, ${firstY(sel)}]); if (t < 700) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); });
          ${act}
          return await rec;`);
        const l = await lineNow();
        const y1 = fr.at(-1)[1], mid = fr.filter(([, y]) => y != null && y > y0 + 0.75 && y < y1 - 0.75).length;
        console.log(`        ${what}: the line ${J(l?.kind)}, the first card ${y0} → ${y1}, ${mid} in-between frame(s), y [${fr.map(([, y]) => y).filter((y, i, a) => i === 0 || y !== a[i - 1]).slice(0, 12)}]`);
        if (l?.kind !== "error") v.push(`${what}: the line reads ${J(l)} (want the error)`);
        if (!(y1 > y0 + 5)) v.push(`${what}: the error took no room above the grid (the first card ${y0} → ${y1})`);
        else if (mid < 2) v.push(`${what}: the cards jumped down for the error (${mid} in-between frame(s); want a glide)`);
      };
      const segOf = (s) => `document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"] [data-seg="${s}"]').click();`;
      try {
        await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await js(`localStorage.setItem("__probe_yours", ${J(J({ ...yData(), lib: LIB_Y }))}); for (const k of ["libFilter", "libSort", "wsLocalSort"]) localStorage.removeItem("liascape." + k);
          localStorage.setItem("liascape.libFilterHidden", "false"); localStorage.setItem("liascape.browseFilter", ${J(J(BF0))}); localStorage.setItem("liascape.browseFilterHidden", "false"); true`);
        await browseWs(SIGNED_IN);
        const page0 = yData().page.map((w) => w.title);
        if (J(sorted(await shownAs(page0))) !== J(sorted(page0))) return [`Browse shows ${J(await shown())} — proved nothing`];
        // the error read first, on Browse: Steam unreachable
        // nothing read: the Library's ✓ then shows the whole Library under the error (lib:yours:error)
        await js(`window.__favs = { answer: ${J(fv(3, [], { error: LOAD_ERR }))} }; true`);
        await setRow("@favorites", "exc", 900);
        if ((await lineNow())?.kind !== "error") return [`Favourites ✕ with Steam unreachable shows the line ${J(await lineNow())} — proved nothing`];
        await setRow("@favorites", "off", 900);
        if (!(await waitFor(async () => !(await lineNow()), 2500))) return ["the error line stayed with the row off — proved nothing"];
        // the Library, its line never shown: ✓ (the whole Library under the error: nothing read)
        await tab("Library");
        if (J(sorted(await libCardsAs(LIB_ALL))) !== J(LIB_ALL)) return [`the Library shows ${J(await libCards())} — proved nothing`];
        await glideOf(".lib-scroll .card.lib:not([data-leaving])", segOf("inc"), "the Library");
        await shot("yours-errorfirst-lib");
        await page(segOf("off")); await sleep(900);
        // Browse built again (a tab switch), its line never shown: ✕
        await tab("Browse");
        if (J(sorted(await shownAs(page0))) !== J(sorted(page0))) return [...v, `Browse shows ${J(await shown())} after the tab switch — proved nothing`];
        await page(`const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") { t?.click(); await new Promise((r) => setTimeout(r, 450)); }`);
        await glideOf(YCARDS, segOf("exc"), "Browse");
        await shot("yours-errorfirst-browse");
      } finally {
        await js(`window.__favs = null; localStorage.removeItem("__probe_yours"); localStorage.setItem("liascape.browseFilter", ${J(J(BF0))});
          for (const k of ["libFilter", "libFilterHidden", "libSort", "wsLocalSort"]) localStorage.removeItem("liascape." + k); true`).catch(() => {});
        await setSettings({ allowScenes: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
        await load(SIGNED_OUT);
      }
      return v;
    });

    // the Browse warm-up (api.steamWarm → POST /steam/warm, SteamAnonymous.Warm): a hover or focus on the Browse tab while it
    // shows the Workshop, or on a Workshop pill, asks the backend to connect Steam's session ahead of the page; at most one
    // ask per 20 s; nothing from the tab while another source shows, nothing from the other sources' pills
    await cell("browse:warm", async () => {
      const v = [];
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((s) => s.supportsTagFilter && s.available)?.name, other = srcs.find((s) => s.supportsLocalFilter && s.available)?.name;
      if (!wsName || !other) return [`no Workshop source (${wsName}) or no other source (${other}) — proved nothing`];
      const warms = async () => (await calls()).filter((c) => c.p === "/steam/warm").length;
      const at = (sel, text) => page(`const e = [...document.querySelectorAll(${J(sel)})].find((x) => x.textContent.trim() === ${J(text)}); if (!e) return null;
        const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
      const away = async () => { send({ type: "mouseMove", x: 700, y: 600 }); await sleep(150); };
      const hover = async (sel, text) => { const p = await at(sel, text); if (!p) return false; send({ type: "mouseMove", ...p }); await sleep(400); return true; };
      // the Workshop shown on Browse, then a fresh page on the Library (the source is remembered; the throttle starts over)
      await browseWs(SIGNED_OUT);
      await away(); await load(SIGNED_OUT); await away();
      if (await warms()) v.push(`${await warms()} warm-up(s) before any hover`);
      if (!(await hover(".tab", "Browse"))) return [...v, "no Browse tab — proved nothing"];
      if (await warms() !== 1) v.push(`the Browse tab hovered (the Workshop shown there): ${await warms()} warm-ups, want 1`);
      await away(); await hover(".tab", "Browse");
      if (await warms() !== 1) v.push(`hovered again within 20 s: ${await warms()} warm-ups, want still 1`);
      // another source on Browse (the local Wallpaper Engine folder, the stub's: nothing leaves the stack): the tab's hover
      // asks nothing; the Workshop pill's does, the other pill's doesn't
      await js(`localStorage.setItem("__probe_we_local", "1"); true`);
      try {
        await tab("Browse");
        await page(`[...document.querySelectorAll(".pill-strip > .pill")].find((e) => e.textContent.trim() === ${J(other)})?.click();`); await sleep(400);
        await away(); await load(SIGNED_OUT); await away();
        await hover(".tab", "Browse");
        if (await warms()) v.push(`the Browse tab hovered while ${other} shows there: ${await warms()} warm-up(s), want none`);
        await tab("Browse"); await away();
        if (!(await hover(".pill-strip > .pill", other))) v.push(`no ${other} pill`);
        if (await warms()) v.push(`the ${other} pill hovered: ${await warms()} warm-up(s), want none`);
        if (!(await hover(".pill-strip > .pill", wsName))) return [...v, "no Workshop pill — proved nothing"];
        if (await warms() !== 1) v.push(`the Workshop pill hovered: ${await warms()} warm-ups, want 1`);
      } finally { await js(`localStorage.removeItem("__probe_we_local"); true`); }
      return v;
    });

    // browse:appPresence — "Use the Steam app" holds its Steam connection while the Liascape window is open
    // (hooks/useSteamAppPresence.ts → Helpers/SteamClientHold.cs): the page beats on every tab at the interval the backend
    // names, without a gap as the user moves between tabs, says nothing on pagehide (the backend's tail runs from the last
    // beat), and never under another download mode
    await cell("browse:appPresence", async () => {
      const v = [], EVERY = 250;
      const beats = () => js(`window.__st.beats ?? []`);
      const mode0 = (await http("GET", "/settings")).json?.workshopDownloadMode ?? "subscribe";
      await js(`localStorage.setItem("__probe_beat_ms", "${EVERY}"); true`);
      try {
        await setSettings({ workshopDownloadMode: "steamapp" });
        await load(SIGNED_OUT); await tab("Library");
        const a0 = (await beats()).length; await sleep(1500);
        const onLib = (await beats()).length - a0;
        if (!a0 && !onLib) return ["no beat at all on the Library tab — the window open is the hold, any tab"];
        if (onLib < 4 || onLib > 9) v.push(`on the Library tab: ${onLib} beats in 1.5 s at the backend's ${EVERY} ms, want ≈ 6`);
        const bodies = (await calls()).filter((c) => c.p === "/steam/app-presence" && c.body != null);
        if (bodies.length) v.push(`a beat carried a body: ${J(bodies[0].body)}`);
        // moving between tabs: the beats go on, never a gap past two intervals
        const b0 = (await beats()).length;
        for (const t of ["Browse", "Settings", "Library", "Browse"]) { await tab(t); await sleep(200); }
        const bs = (await beats()).slice(Math.max(0, b0 - 1));
        const gap = Math.max(...bs.slice(1).map((t, i) => t - bs[i]));
        console.log(`        ${bs.length - 1} beats across four tab switches, the longest gap ${Math.round(gap)} ms`);
        if (bs.length < 6 || gap > EVERY * 2) v.push(`across tab switches: ${bs.length - 1} beats, the longest gap ${Math.round(gap)} ms (want ≤ ${EVERY * 2})`);
        // the page going away says nothing more (no keepalive request, no beat out of turn): the backend lets go a tail after
        // the last beat
        const h0 = (await beats()).at(-1);
        await js(`dispatchEvent(new Event("pagehide")); true`); await sleep(60);
        const h1 = await beats();
        if (await js(`(window.__st.keepalive || []).length`)) v.push("pagehide sent a request (keepalive)");
        if (h1.filter((t) => t > h0).some((t) => t - h0 < EVERY * 0.8)) v.push("pagehide sent a beat out of turn");
        // another download mode (as the page hears it: its own save, or settings-changed): the beats stop at once, and a fresh
        // page sends none
        await setSettings({ workshopDownloadMode: "subscribe" }); await ev("settings-changed", { workshopDownloadMode: "subscribe" }); await sleep(EVERY * 2);
        const s0 = (await beats()).length; await sleep(1000);
        if ((await beats()).length > s0) v.push(`under "Subscribe with Steam login": ${(await beats()).length - s0} beat(s) after the switch`);
        await load(SIGNED_OUT); await tab("Browse"); await sleep(800);
        if ((await beats()).length) v.push(`a fresh page under "Subscribe with Steam login" beat ${(await beats()).length} time(s)`);
      } finally {
        await setSettings({ workshopDownloadMode: mode0 });
        await js(`localStorage.removeItem("__probe_beat_ms"); true`);
      }
      return v;
    });

    // browse:fixture — a page WITHOUT this probe's stub (a second window) on Browse → the Workshop: the stack's own Steam
    // fixture answers (LIASCAPE_STEAM_CM_FIXTURE "@query", scripts/test-ui-matrix.sh), never Steam; the backend opened no
    // session to Steam's servers and refused no call to a real one (LIASCAPE_TEST_NO_NETWORK, Helpers/TestNetwork.cs)
    await cell("browse:fixture", async () => {
      const v = [], LOG = E.LIASCAPE_BACKEND_LOG;
      if (!LOG || !fs.existsSync(LOG)) return [`no backend log (${LOG}) — proved nothing`];
      if (E.LIASCAPE_TEST_NO_NETWORK !== "1") v.push("the stack doesn't set LIASCAPE_TEST_NO_NETWORK=1");
      const wsName = (await http("GET", "/sources")).json.find((s) => s.supportsTagFilter && s.available)?.name;
      if (!wsName) return ["no Workshop source in /sources — proved nothing"];
      const from = fs.statSync(LOG).size;
      const w2 = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
      const p2 = (code) => w2.webContents.executeJavaScript(`(async () => { ${code} })()`);
      try {
        await w2.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100 && (await p2(`return document.querySelectorAll(".tab").length`)) < 3; i++) await sleep(100);
        await p2(`[...document.querySelectorAll(".tab")].find((e) => e.textContent.trim() === "Browse")?.click();`); await sleep(500);
        await p2(`[...document.querySelectorAll(".pill-strip > .pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
        let titles = [];
        for (let i = 0; i < 100; i++) {
          titles = await p2(`return [...document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) [data-title]")].map((e) => e.dataset.title);`);
          if (titles.length) break;
          await sleep(100);
        }
        console.log(`        ${J(titles)}`);
        const want = ["Fixture Workshop One", "Fixture Workshop Two"]; // the scene needs "allow scenes" (off here)
        if (J(titles) !== J(want)) v.push(`the Workshop's cards ${J(titles)} (want the fixture's ${J(want)})`);
      } finally { w2.destroy(); }
      const since = () => fs.readFileSync(LOG).subarray(from).toString("utf8").split("\n"); // a byte offset: the log holds "—"
      const asked = (l) => /steam-cm: QueryFiles page 1 — \d+ item\(s\) \(fixture\)/.test(l);
      for (let i = 0; i < 30 && !since().some(asked); i++) await sleep(100);
      const log = since();
      if (!log.some(asked)) v.push(`no fixture QueryFiles in the backend log since the cell began: ${J(log.slice(-8))}`);
      for (const l of log.filter((l) => /steam-cm: connected|test-network: REFUSED|browse: Workshop via Workshop page/.test(l))) v.push(`backend: ${l}`);
      return v;
    });

    // yours:stack — Favourites ✓ end to end on the stack's own backend (a page without this probe's stub): a fake sign-in (a
    // pasted cookie, beside a refresh token that is no token, so /steam/status reads signed in and nothing is minted) and the
    // account's favourites in the stack's Steam fixture ("@userfiles"), both undone at the end; the ✓ lists exactly them from
    // GET /workshop/my-favorites, sends no /browse, and the backend opened no session to Steam and refused no real-network call
    await cell("yours:stack", async () => {
      const v = [], LOG = E.LIASCAPE_BACKEND_LOG, FX = E.LIASCAPE_STEAM_CM_FIXTURE, AUTH = `${E.XDG_CONFIG_HOME}/liascape/steam-auth.json`;
      if (!LOG || !fs.existsSync(LOG) || !FX || !fs.existsSync(FX)) return [`no backend log (${LOG}) or Steam fixture (${FX}) — proved nothing`];
      if (fs.existsSync(AUTH)) return ["the stack already holds a sign-in — proved nothing"];
      const wsName = (await http("GET", "/sources")).json.find((s) => s.supportsTagFilter && s.available)?.name;
      if (!wsName) return ["no Workshop source in /sources — proved nothing"];
      const ME = "76561198000000077", FAVS = ["Stack Fav One", "Stack Fav Two", "Stack Fav Three"];
      const fx0 = fs.readFileSync(FX, "utf8"), fx = JSON.parse(fx0);
      // no preview_url: /img would go out to fetch it
      (fx["@userfiles"] ??= {})[`${ME}:myfavorites`] = FAVS.map((title, i) => ({ publishedfileid: String(912000001 + i), title, creator: "76561190000000007",
        time_created: 1700000000 + i, time_updated: 1790000000 - i, subscriptions: 30 - i * 10, favorited: 5, score: 0.5, tags: ["Video", "Everyone", "Nature"] }));
      const ls0 = await js(`JSON.stringify(Object.entries(localStorage))`);
      const from = fs.statSync(LOG).size;
      let w2 = null;
      try {
        fs.writeFileSync(FX, J(fx));
        fs.writeFileSync(AUTH, J({ "steam-refresh-token": "probe-not-a-token", "steam-login-secure": `${ME}||probe` }), { mode: 0o600 });
        w2 = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
        const p2 = (code) => w2.webContents.executeJavaScript(`(async () => { ${code} })()`);
        const wait2 = async (code, ms = 6000) => { for (let t = 0; t < ms; t += 100) { const r = await p2(code); if (r) return r; await sleep(100); } return p2(code); };
        const titles2 = () => p2(`return [...document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) [data-title]")].map((e) => e.dataset.title);`);
        await w2.loadURL(withToken(U + "/"));
        // every request (the page's own fetch, looked up at each call)
        await p2(`const f = window.fetch; window.__asked = []; window.fetch = (u, o) => { window.__asked.push(String(u?.url ?? u)); return f(u, o); }; return true;`);
        await wait2(`return document.querySelectorAll(".tab").length >= 3`);
        await p2(`[...document.querySelectorAll(".tab")].find((e) => e.textContent.trim() === "Browse")?.click();`); await sleep(500);
        await p2(`[...document.querySelectorAll(".pill-strip > .pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
        const ws0 = await wait2(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving])").length > 0`);
        if (!ws0) return [`the Workshop showed no cards ${J(await titles2())} — proved nothing`];
        // the pill's own reload settled (no new /browse for 600 ms), then only what the ✓ asks counts
        const nBrowse = () => p2(`return window.__asked.filter((u) => /\\/browse(\\?|$)/.test(u)).length;`);
        for (let n = await nBrowse(), quiet = 0, t = 0; quiet < 600 && t < 6000; t += 100) {
          await sleep(100); const m = await nBrowse(); if (m === n) quiet += 100; else { n = m; quiet = 0; } }
        await p2(`window.__asked = []; return true;`);
        const row = await wait2(`const r = document.querySelector(".wf-row[data-wf-tag='@favorites']"); if (r) return { off: r.hasAttribute("data-wf-off") };
          const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") !== "true") t?.click(); return null;`, 3000);
        if (!row || row.off) return [`the Favourites row ${row ? "reads signed out" : "never showed"} with the stack signed in — proved nothing`];
        await sleep(450);
        await p2(`document.querySelector('.wf-col:not(.closing) .wf-row[data-wf-tag="@favorites"] [data-seg="inc"]').click(); return true;`);
        const want = J([...FAVS].sort());
        await wait2(`const t = [...document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card):not([data-leaving]) [data-title]")].map((e) => e.dataset.title).sort(); return JSON.stringify(t) === ${J(want)};`, 8000);
        await sleep(400);
        const got = await titles2(), asked = await p2(`return window.__asked;`);
        console.log(`        Favourites ✓: ${J(got)}; asked ${J(asked.map((u) => u.replace(/^https?:\/\/[^/]+/, "").replace(/[?&]token=[^&]*/, "")))}`);
        if (J([...got].sort()) !== want) v.push(`Favourites ✓ shows ${J(got)} (want the account's favourites ${J(FAVS)})`);
        if (!asked.some((u) => /\/workshop\/my-favorites\?sync=open/.test(u))) v.push("the ✓ never asked GET /workshop/my-favorites?sync=open");
        const br = asked.filter((u) => /\/browse(\?|$)/.test(u));
        if (br.length) v.push(`the ✓ sent /browse ${br.length}×`);
        if (await p2(`return document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length`)) v.push("the ✓ shows placeholder cards");
      } finally {
        w2?.destroy();
        fs.rmSync(AUTH, { force: true });
        fs.writeFileSync(FX, fx0);
        fs.rmSync(`${E.XDG_CACHE_HOME}/liascape/workshop/favorites-${ME}.json`, { force: true });
        await js(`localStorage.clear(); for (const [k, x] of JSON.parse(${J(ls0)})) localStorage.setItem(k, x); true`);
      }
      const log = fs.readFileSync(LOG).subarray(from).toString("utf8").split("\n");
      if (!log.some((l) => /steam-cm: GetUserFiles myfavorites .*\(fixture\)/.test(l))) v.push(`the backend never read the favourites from the fixture: ${J(log.slice(-8))}`);
      for (const l of log.filter((l) => /steam-cm: connected|test-network: REFUSED/.test(l))) v.push(`backend: ${l}`);
      if (log.some((l) => l.includes(ME))) v.push("the backend log names the account's Steam ID");
      return v;
    });

    // ---- the Library sidebar's Workshop pieces — the Browse sidebar's own components (components/WorkshopSocial.tsx), after the
    // scene properties — and every Library item's size on disk (ItemSide.tsx). The stack's scenes s1..s3 are Workshop copies
    // (workshop/<id>); its empty CM fixture marks every id off the Workshop, so __probe_lib_off names the only ones that are.
    // Shots steam-libws*.png
    const libWs = async ({ off = [], nosize = [], wsOf = {} } = {}, ws = {}) => {
      await js(`localStorage.setItem("__probe_lib_sub", "{}"); localStorage.setItem("__probe_lib_off", ${J(J(off))}); localStorage.setItem("__probe_lib_nosize", ${J(J(nosize))});
        localStorage.setItem("__probe_lib_ws", ${J(J(wsOf))}); true`);
      await load(SIGNED_OUT);
      await W(ws);
    };
    const libWsDone = async () => {
      await js(`for (const k of ["__probe_lib_sub", "__probe_lib_off", "__probe_lib_nosize", "__probe_lib_ws"]) localStorage.removeItem(k); true`);
      win.setContentSize(1400, 900); await sleep(200);
    };
    // openLib, waiting on the title's own text: back as soon as it shows
    const openLibWs = async (t) => {
      await tab("Library");
      return page(`const c = [...document.querySelectorAll(".card.lib:not([data-leaving])")].find((x) => x.querySelector('[data-title="${t}"]'));
        if (!c) return false;
        c.querySelector(".thumb-wrap").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        for (let i = 0; i < 30 && document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() !== "${t}"; i++) await new Promise((r) => setTimeout(r, 100));
        return document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() === "${t}" && !!document.querySelector("${SIDE} .side-hero");`);
    };
    const kb = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(0)} MB` : `${(b / 1024).toFixed(0)} KB`);
    const WS_PARTS = `(() => { const q = (s) => !!document.querySelector("${SIDE} " + s);
      return { stats: q("[data-ws-stats]"), creator: q(".ws-creator-row"), fav: q("[data-ws-fav]"), comments: q("[data-ws-comments]") }; })()`;
    const BODY_ORDER = `(() => { const b = document.querySelector("${SIDE} .side-body"); if (!b) return null; const kids = [...b.children], at = (f) => kids.findIndex(f);
      return { n: kids.length, playback: at((k) => k.matches('[data-sec="playback"]')), props: at((k) => k.matches("[data-scene-props]")),
        hero: at((k) => k.matches(".side-hero")), statsInHero: !!b.querySelector(":scope > .side-hero > [data-ws-stats]"),
        stats: at((k) => k.matches("[data-ws-stats]")), creator: at((k) => k.matches(".ws-creator-row")),
        cta: at((k) => k.matches(".side-cta")), tiles: at((k) => k.matches(".side-tiles")), favInHero: !!b.querySelector(":scope > .side-hero [data-ws-fav]"),
        comments: at((k) => k.matches("[data-ws-comments]")),
        gaps: kids.slice(1).map((k, i) => +(k.getBoundingClientRect().top - kids[i].getBoundingClientRect().bottom).toFixed(1)) }; })()`;

    // lib:ws:order — a Workshop item's Library sidebar: its counts in the hero row (the favourites pill its toggle), the action
    // area, the creator under it (as in Browse), the tiles before the Playback card and the scene properties, the comments last (the order Browse
    // shows too: components/ItemSide.tsx), in the body's rhythm (12 px apart); none of them for an item the Workshop no longer
    // has, a non-Workshop item, or a multi-selection. Shot steam-libws.png
    await cell("lib:ws:order", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, settingsLevel: "standard" });
      await libWs({ off: ["900000003"] });
      try {
        if (!(await openLibWs("s1"))) return ["no sidebar for s1 — proved nothing"];
        await sleep(1000);
        const o = await js(BODY_ORDER);
        console.log(`        s1: ${J(o)}`);
        if (!o || o.props < 0) return ["s1's sidebar shows no scene properties — proved nothing"];
        if (!(o.hero === 0 && o.statsInHero && o.favInHero && o.cta === 1 && o.creator === 2 && o.tiles > o.creator && o.playback > o.tiles && o.playback < o.props && o.comments > o.props && o.comments === o.n - 1))
          v.push(`the order: ${J(o)} (want the counts in the hero row with the favourite, the action area, the creator, the tiles, then Playback, the scene properties and the comments, last)`);
        for (const i of [0, ...Array.from({ length: Math.max(0, o.n - 1 - Math.max(o.props, 0)) }, (_, k) => Math.max(o.props, 0) + k)])
          if (Math.abs(o.gaps[i] - 12) > 0.75) v.push(`blocks ${i} → ${i + 1}: ${o.gaps[i]} px apart (want the body's 12)`);
        await shot("libws");
        const plain = await plainTitle();
        for (const t of ["s3", plain]) {
          if (!t || !(await openLibWs(t))) { v.push(`no sidebar for ${t}`); continue; }
          await sleep(900);
          const w = await js(WS_PARTS);
          if (Object.values(w).some((x) => x)) v.push(`${t === "s3" ? "s3 (off the Workshop)" : `${t} (not a Workshop item)`} shows Workshop pieces: ${J(w)}`);
        }
        // a multi-selection (s1's sidebar, s1 + s2 Ctrl-clicked): each item has its own, so none
        if (!(await openLibWs("s1"))) return [...v, "no sidebar for s1 (multi)"];
        await sleep(600);
        for (const t of ["s1", "s2"]) {
          const b = await cardBox(t); if (!b) { v.push(`no card ${t}`); continue; }
          send({ type: "mouseDown", x: Math.round(b.x), y: Math.round(b.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(40);
          send({ type: "mouseUp", x: Math.round(b.x), y: Math.round(b.y), button: "left", clickCount: 1, modifiers: ["control"] }); await sleep(250);
        }
        const multi = await page(`return { sel: document.querySelectorAll(".card.lib:not([data-leaving]).selected").length, title: document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null };`);
        if (multi.sel !== 2 || multi.title !== "s1") v.push(`the multi-selection didn't happen: ${J(multi)} — proved nothing`);
        else { await sleep(700); const w = await js(WS_PARTS); if (Object.values(w).some((x) => x)) v.push(`a multi-selection shows Workshop pieces: ${J(w)}`); }
      } finally { await libWsDone(); }
      return v;
    });

    // lib:ws:pillRow — the counts are hero pills: for a Workshop scene (s1) and a Workshop video (a plain item given an id), the
    // subscribers and favourites pills sit in the hero row beside the others (inside its box, on a line another hero pill
    // shares) before the Workshop ID, then the size, last (components/ItemSide.tsx: one order on both tabs); the creator row
    // comes right under the hero; both above the Playback card.
    // Shots steam-libws-pillrow*.png
    await cell("lib:ws:pillRow", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, settingsLevel: "standard" });
      const plain = (((await http("GET", "/library")).json ?? []).find((i) => !i.workshopId && !i.isScene) ?? {}).title;
      if (!plain) return ["no plain video in the library — proved nothing"];
      await libWs({ wsOf: { [plain]: "900000077" } }, { avatar: libThumb });
      try {
        for (const t of ["s1", plain]) {
          if (!(await openLibWs(t))) { v.push(`no sidebar for ${t}`); continue; }
          await sleep(1200);
          const r = await js(`(() => { const b = document.querySelector("${SIDE} .side-body"), h = b?.querySelector(":scope > .side-hero"); if (!h) return null;
            const R = (e) => { const x = e.getBoundingClientRect(); return { x: +x.x.toFixed(1), y: +x.y.toFixed(1), w: +x.width.toFixed(1), h: +x.height.toFixed(1) }; };
            const subs = h.querySelector("[data-side-stat=subscribers]"), favs = h.querySelector("[data-side-stat=favorites]");
            const others = [...h.querySelectorAll(".side-pill, .side-chip")].filter((e) => !e.closest("[data-ws-stats]") && getComputedStyle(e).visibility !== "hidden").map(R);
            const pb = b.querySelector('[data-sec="playback"]'), cr = b.querySelector(":scope > .ws-creator-row");
            return { hero: R(h), subs: subs && R(subs), favs: favs && R(favs), others, last: [...h.children].slice(-2).map((e) => e.dataset.sideRow ?? null),
              known: h.querySelector("[data-ws-stats]")?.dataset.wsStats ?? null, creatorNext: h.nextElementSibling?.matches(".side-cta") && h.nextElementSibling.nextElementSibling === cr, creator: cr && R(cr), playback: pb && R(pb),
              loose: b.querySelectorAll(":scope > [data-ws-stats]").length }; })()`);
          console.log(`        ${t}: ${J(r)}`);
          if (!r) { v.push(`${t}: no hero row`); continue; }
          if (!r.subs || !r.favs) { v.push(`${t}: the counts aren't in the hero row (${J({ subs: r.subs, favs: r.favs, loose: r.loose })})`); continue; }
          if (r.known !== "known") v.push(`${t}: the counts never landed (${r.known})`);
          for (const [k, p] of [["subscribers", r.subs], ["favourites", r.favs]]) {
            if (p.x < r.hero.x - 0.5 || p.x + p.w > r.hero.x + r.hero.w + 0.5 || p.y < r.hero.y - 0.5 || p.y + p.h > r.hero.y + r.hero.h + 0.5) v.push(`${t}: the ${k} pill lies outside the hero row (${J(p)} vs ${J(r.hero)})`);
            if (!r.others.some((o) => Math.abs(o.y + o.h / 2 - (p.y + p.h / 2)) < 1.5) && r.others.length) v.push(`${t}: the ${k} pill shares no line with the other pills (${J(p)})`);
          }
          if (J(r.last) !== J(["workshop-id", "size"])) v.push(`${t}: the hero's last pills are ${J(r.last)} (want the ID, then the size: a late measure moves nothing)`);
          if (!r.creatorNext) v.push(`${t}: the creator row isn't right under the hero's action area`);
          if (!r.playback || !r.creator || r.creator.y > r.playback.y || r.subs.y > r.playback.y) v.push(`${t}: the counts / creator sit below Playback (${J({ creator: r.creator, playback: r.playback })})`);
          await shot(t === "s1" ? "libws-pillrow" : "libws-pillrow-video");
        }
      } finally { await libWsDone(); }
      return v;
    });

    // lib:ws:counts[Off] — the counts: the row is held (its pills unseen) while Steam is asked, asked once with the item's id
    // after the sidebar settles; they fade in where they stay (motion on: rising a little; Off: only the fade) and the creator
    // row after them never moves; Steam's current numbers with the people and the star, no views; no answer → no row.
    // On: no-glow + bg-live keep the community blocks' own fills. Shots steam-libws-counts*.png, steam-libws-live.png
    for (const motion of [true, false]) {
      await cell(`lib:ws:counts${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
        await libWs({}, { countsDelay: 1300 });
        try {
          if (!(await openLibWs("s1"))) return ["no sidebar for s1 — proved nothing"];
          await sleep(600);
          const ST = `${SIDE} [data-ws-stats]`, SUBS = `${ST} [data-side-stat=subscribers]`;
          const held = await js(`document.querySelector(${J(ST)})?.dataset.wsStats ?? null`);
          if (held !== "loading") v.push(`while Steam is asked the row is ${J(held)} (want held, "loading")`);
          await scrollSideTo(ST);
          const smp = js(MO.SAMPLE({ subs: SUBS, next: `${SIDE} .side-cta` }, 1300));
          if (motion) { await sleep(1080); await shot("libws-counts-in"); }
          const s = await smp;
          console.log(`        subscribers ${MO.brief(s.subs)} | y ${J([...new Set(s.subs.filter((f) => f[1] > 0.02).map((f) => f[3]))].slice(0, 8))}`);
          const ys = s.next.filter((f) => f[1] != null).map((f) => f[3]);
          if (!ys.length || Math.max(...ys) - Math.min(...ys) > 0.75) v.push(`the action area under the pills moved while the counts landed (y ${J([...new Set(ys)].slice(0, 6))})`);
          if (motion) {
            const ops = s.subs.map((f) => f[1]).filter((x) => x != null), py = s.subs.filter((f) => f[1] > 0.02).map((f) => f[3]);
            if (!ops.some((x) => x > 0.05 && x < 0.95)) v.push(`the counts popped in (opacity ${J([...new Set(ops)].slice(0, 10))})`);
            if (!(py.length > 2 && Math.max(...py) - Math.min(...py) > 1)) v.push(`the counts didn't rise in (y ${J([...new Set(py)].slice(0, 8))})`);
          } else v.push(...MO.judge("motion off: the counts appearing", s.subs, { appear: true, size: false }));
          const r = await page(`const h = document.querySelector(${J(ST)}); if (!h) return null;
            const pill = (k) => { const e = h.querySelector('[data-side-stat="' + k + '"]'); return e ? { text: e.textContent.trim(), icon: [...(e.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-") && c !== "lucide") } : null; };
            return { state: h.dataset.wsStats, subs: pill("subscribers"), favs: pill("favorites"), eye: !!h.querySelector(".lucide-eye, .lucide-heart"), n: h.children.length };`);
          console.log(`        ${J(r)}`);
          if (r?.state !== "known" || r.subs?.text !== "4.3k" || r.subs?.icon !== "lucide-users" || r.favs?.text !== "87" || r.favs?.icon !== "lucide-star" || r.eye || r.n !== 2)
            v.push(`the counts: ${J(r)} (want 4.3k with lucide-users, 87 with lucide-star, nothing else)`);
          const c = await wsCalls("/workshop/counts");
          if (c.length !== 1 || !/[?&]id=900000001(&|$)/.test(c[0].q)) v.push(`counts asked ${c.length}× (${J(c)}), want once for 900000001`);
          if (motion) {
            await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
            await libWs({}, { comments: COMMENTS.slice(0, 3) }); await openLibWs("s1"); await sleep(1000);
            await scrollSideTo(`${SIDE} [data-ws-stats]`); await sleep(500);
            const cr = await js(`(() => { const r = document.querySelector("${SIDE} [data-ws-creator]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            await mvTo(cr.x, cr.y, 400);
            const lk = { creator: await looks(`${SIDE} [data-ws-creator]`), fav: await looks(`${SIDE} [data-ws-fav]`), comments: await looks(`${SIDE} [data-ws-comments]`) };
            console.log(`        no-glow + bg-live: ${J(lk)}`);
            if (!/no-glow/.test(lk.creator.html) || !/bg-live/.test(lk.creator.html)) v.push(`the toggles didn't apply: ${lk.creator.html}`);
            for (const [k, x] of Object.entries(lk)) if (/rgba\(0, 0, 0, 0\)|transparent/.test(x.bg)) v.push(`bg-live: the ${k} block has no fill of its own (${x.bg})`);
            if ((lk.creator.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((x) => !/rgba\(0, 0, 0/.test(x))) v.push(`no-glow: the hovered creator row glows (${lk.creator.shadow})`);
            await shot("libws-live"); await mvTo(3, 3);
            await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
          }
          // no answer: the held pills leave, the size after them takes their room (motion on: glides there per frame; off: at
          // once, nothing in between), the rest stays
          await libWs({}, { countsFail: true, countsDelay: 1300 }); await openLibWs("s1"); await sleep(600);
          const SZ = `${SIDE} .side-hero [data-side-row=size]`;
          // its travel from where it was held: how far it has come, per frame (it may change lines)
          const gx = frames("", `(() => { const e = document.querySelector(${J(SZ)}); if (!e) return null; const r = e.getBoundingClientRect();
            window.__sz0 ??= [r.x, r.y]; return +Math.hypot(r.x - window.__sz0[0], r.y - window.__sz0[1]).toFixed(1); })()`, 1400);
          const ds = (await gx).filter((x) => x != null); await js(`delete window.__sz0; true`);
          const xs = ds.map((d) => -d);
          const w = await js(WS_PARTS);
          console.log(`        Steam unreachable: ${J(w)}; the size's x per frame ${J([...new Set(xs)].slice(0, 10))}`);
          if (w.stats || !w.creator) v.push(`Steam unreachable: ${J(w)} (want no counts, the creator row still there)`);
          if (!xs.length || xs[0] - xs.at(-1) < 20) v.push(`Steam unreachable: the size didn't take the counts' room (x ${xs[0]} → ${xs.at(-1)}) — proved nothing`);
          else if (motion && between(xs, 1) < 3) v.push(`motion on: the size jumped into the counts' room (x per frame ${J([...new Set(xs)].slice(0, 10))})`);
          else if (!motion && between(xs, 1) > 0) v.push(`motion off: the size glided into the counts' room (x per frame ${J([...new Set(xs)].slice(0, 10))})`);
        } finally { await libWsDone(); }
        return v;
      });
    }

    // lib:ws:size[Off] — every Library item's size on disk: the backend's measure (GET /library diskBytes) as the hero row's last
    // pill, "Size on disk", for a Workshop scene and a plain item alike; one not measured yet has none, and when its measure
    // lands (library-item-changed) it fades in at the row's end (motion on: rising a little; Off: only the fade) while the
    // Workshop ID pill before it never moves. Shot steam-libws-size.png
    for (const motion of [true, false]) {
      await cell(`lib:ws:size${motion ? "" : "Off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, settingsLevel: "standard" });
        const lib = (await http("GET", "/library")).json ?? [];
        const s1 = lib.find((i) => i.title === "s1"), s2 = lib.find((i) => i.title === "s2"), k = lib.find((i) => !i.workshopId && i.diskBytes > 0);
        if (!(s1?.diskBytes > 0) || !k || !s2) return [`the backend measured no size (s1 ${s1?.diskBytes}, a plain item ${k?.title}) — proved nothing`];
        await libWs({ nosize: ["s2"] });
        try {
          const LAST = `(() => { const h = document.querySelector("${SIDE} .side-hero"), e = h?.lastElementChild; return e ? { row: e.dataset.sideRow ?? null, text: e.textContent.trim(), title: e.title } : null; })()`;
          for (const it of motion ? [s1, k] : []) {
            if (!(await openLibWs(it.title))) { v.push(`no sidebar for ${it.title}`); continue; }
            await sleep(500);
            const l = await js(LAST);
            if (l?.row !== "size" || l.text !== kb(it.diskBytes) || l.title !== "Size on disk") v.push(`${it.title}: the hero's last pill is ${J(l)} (want "Size on disk" ${kb(it.diskBytes)})`);
          }
          if (motion) await shot("libws-size");
          if (!(await openLibWs("s2"))) return [...v, "no sidebar for s2"];
          await sleep(700);
          const SIZE = `${SIDE} .side-hero [data-side-row=size]`, ID = `${SIDE} .side-hero [data-side-row=workshop-id]`;
          if (await js(`!!document.querySelector(${J(SIZE)})`)) return [...v, "s2 (not measured yet) shows a size — proved nothing"];
          const smp = js(MO.SAMPLE({ size: SIZE, id: ID }, 600)); await sleep(40);
          await ev("library-item-changed", { path: s2.videoPath, diskBytes: 123456789 });
          const s = await smp;
          console.log(`        late size ${MO.brief(s.size)} | y ${J([...new Set(s.size.filter((f) => f[1] > 0.02).map((f) => f[3]))].slice(0, 8))}`);
          v.push(...MO.judge("the Workshop ID pill", s.id));
          if (motion) {
            const ops = s.size.map((f) => f[1]).filter((x) => x != null), py = s.size.filter((f) => f[1] > 0.02).map((f) => f[3]);
            if (!ops.some((x) => x > 0.05 && x < 0.95)) v.push(`the late size popped in (opacity ${J([...new Set(ops)].slice(0, 10))})`);
            if (!(py.length > 2 && Math.max(...py) - Math.min(...py) > 1)) v.push(`the late size didn't rise in (y ${J([...new Set(py)].slice(0, 8))})`);
          } else v.push(...MO.judge("motion off: the late size appearing", s.size, { appear: true }));
          const l = await js(LAST);
          if (l?.row !== "size" || l.text !== "118 MB") v.push(`after its measure: ${J(l)} (want "118 MB" last)`);
        } finally { await libWsDone(); }
        return v;
      });
    }

    // lib:ws:creator — the creator row, asked without an owner (the backend finds it): a click lists their wallpapers in Browse —
    // the Browse tab shows with its filter column's Author field holding the creator, the list asked
    await cell("lib:ws:creator", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
      await libWs({}, { avatar: libThumb });
      try {
        if (!(await openLibWs("s1"))) return ["no sidebar for s1 — proved nothing"];
        const ROW = `${SIDE} [data-ws-creator]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(ROW)})?.dataset.wsCreator === "known"`), 3000))) return ["the creator row never showed the creator"];
        const c = await wsCalls("/workshop/creator");
        if (c.length !== 1 || !/[?&]id=900000001/.test(c[0].q) || /owner=/.test(c[0].q)) v.push(`creator asked ${J(c)}, want once for 900000001 without an owner`);
        const name = await js(`document.querySelector("${ROW} [data-ws-row-name]")?.textContent`);
        if (name !== "Probe Creator") v.push(`the row says ${J(name)}`);
        const nb = (await browses()).length;
        await page(`document.querySelector(${J(ROW)}).click();`); await sleep(900);
        const b = (await browses()).slice(nb).at(-1);
        const st = await page(`return { tab: document.querySelector(".tab.active")?.textContent.trim() ?? null, page: document.querySelector(".app")?.dataset.page ?? null };`);
        const af = await field("creator");
        console.log(`        after the click: ${J(st)} | ${J(b?.list)}`);
        if (st.tab !== "Browse" || st.page !== "browse") v.push(`the click didn't take the user to Browse: ${J(st)}`);
        if (b?.list?.kind !== "creator" || b.list.id !== "76561190000000007") v.push(`the click asked /browse ${J(b?.list)}`);
        if (af?.value !== "Probe Creator" || af.state !== "on") v.push(`Browse's Author field: ${J(af)} (want the creator, on)`);
      } finally { await libWsDone(); }
      return v;
    });

    // lib:ws:favorite — the favourite tile, the Browse sidebar's: reads the state, a click POSTs the Library item's id
    await cell("lib:ws:favorite", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
      await libWs({}, { fav: { signedIn: true, favorited: false } });
      try {
        if (!(await openLibWs("s1"))) return ["no sidebar for s1 — proved nothing"];
        const FAV = `${SIDE} [data-ws-fav]`;
        if (!(await waitFor(() => js(`document.querySelector(${J(FAV)})?.dataset.wsFav === "off"`), 3000))) return ["the favourite tile never read its state"];
        await page(`document.querySelector(${J(FAV)}).click();`); await sleep(500);
        const post = (await wsCalls("/workshop/favorite")).filter((c) => c.m === "POST");
        if (post.length !== 1 || post[0].body.workshopId !== "900000001" || post[0].body.favorite !== true) v.push(`POSTs: ${J(post)}`);
        const t = await js(`document.querySelector(${J(FAV)})?.dataset.wsFav`);
        if (t !== "on") v.push(`after the click the tile is ${J(t)}`);
      } finally { await libWsDone(); }
      return v;
    });

    // lib:ws:comments — the comments, the Browse sidebar's: read only once in view (10 of 23, newest first); signed in, a post
    // goes out with the Library item's id and drops in on top
    await cell("lib:ws:comments", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
      win.setContentSize(1400, 560); await sleep(300);
      await libWs({}, { comments: COMMENTS, signedIn: true });
      try {
        if (!(await openLibWs("s1"))) return ["no sidebar for s1 — proved nothing"];
        await sleep(900);
        const SEC = `${SIDE} [data-ws-comments]`;
        const inView = await page(`const e = document.querySelector(${J(SEC)}), sc = e?.closest(".side-scroll"); if (!e) return null;
          return e.getBoundingClientRect().top < sc.getBoundingClientRect().bottom + 120;`);
        if (inView === null) return ["no comments section"];
        if (inView) v.push("the comments section is in view at once — the lazy read proved nothing");
        else if ((await wsCalls("/workshop/comments")).length) v.push("the comments were read before their section came into view");
        await scrollSideTo(SEC); await sleep(700);
        const calls = await wsCalls("/workshop/comments");
        if (calls.length !== 1 || calls[0].start !== 0 || calls[0].count !== 10) v.push(`reads: ${J(calls)} (want one, start 0, count 10)`);
        const r = await page(`const s = document.querySelector(${J(SEC)}); return { n: s.querySelectorAll(".ws-c").length, count: s.querySelector("[data-ws-count]")?.textContent, box: !!s.querySelector("textarea") };`);
        if (r.n !== 10 || r.count !== "23" || !r.box) v.push(`shown: ${J(r)} (want 10 of 23, a comment box)`);
        await page(`document.querySelector("${SEC} textarea").focus();`); await type("from the library");
        await page(`document.querySelector("${SEC} [data-ws-post-btn]").click();`); await sleep(600);
        const p = (await wsCalls("/workshop/comment")).at(-1);
        if (p?.body?.text !== "from the library" || p?.body?.workshopId !== "900000001") v.push(`the POST: ${J(p)}`);
        const first = await js(`document.querySelector("${SEC} .ws-c [data-ws-text]")?.textContent ?? null`);
        if (first !== "from the library") v.push(`the new comment isn't on top (${J(first)})`);
        await shot("libws-comments");
      } finally { await libWsDone(); }
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`STEAM pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "steam.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
