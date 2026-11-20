# Preset wallpapers: design

Covers the backlog item **Preset wallpapers** in `docs/TODO.md`. Agreed with the owner on 2026-11-20.

## Intent
Let people browse, subscribe to and play other people's Wallpaper Engine **presets** from the Steam Workshop. A preset
has no art of its own: it is a scene's property values (colours, toggles, sliders, combos) saved under its own title,
preview and author, and it names the scene it customises (its base scene). Today Liascape treats presets as
unplayable: `WorkshopTags.Unplayable` hides them from Browse and the filter can't include them.

Why: the Workshop holds many presets of popular scenes, and the owner wants to use them like any other wallpaper.
Several presets of the same scene must be able to sit side by side in one playlist.

## Goals
- Workshop presets show in Browse with their own cards, through their own **Preset** option in the type filter
  (owner, 2026-11-20): unticked by default, offered only when scene support is on.
- Subscribing or downloading a preset also fetches its base scene, through the same download mode, as Wallpaper
  Engine does on Steam.
- A preset is its **own Library item**: its own card, title, preview, author, favourite, crash mark and playlist
  entry. Shuffle, timed rotation, advance-on-end and restore treat it like any scene.
- Playing a preset plays its base scene with layered property values: the scene's defaults, then the preset's values,
  then the user's own tweaks for that preset card (the existing per-item scene-property overrides).
- **All presets of a scene** (owner, 2026-11-20): a scene's sidebar, in Browse and in the Library, has a "Presets"
  link that opens a Browse list of every Workshop preset made for that scene, with the usual card actions, sort and
  paging; presets already in the Library show as such. Shown only for scenes, only with scene support on.
- The preset's sidebar shows its properties (as for a scene, with the preset's values as the defaults) and a
  "Uses: <base scene>" link to the base scene's card.

## Non-goals
- Making presets (saving your own property setups as a new preset). Not asked for.
- Publishing presets to the Workshop.
- Presets under the legacy engine. New features are liascape-player only (`docs/decisions.md` and the legacy sunset):
  under `PlayerEngine=legacy` a preset shows as unplayable with the reason.
- Web and Application wallpapers stay unplayable (the backlog item's own note).

## Anti-goals (a failure even if it works)
- Copying the base scene into each preset: it duplicates hundreds of MB and goes stale when the base updates.
- A preset that silently plays the plain base scene, or fails silently, when something is missing. Missing or
  unplayable = greyed out up front with the reason (`liascape-no-mode-fallback` spirit: never borrow another route).
- Unsubscribing or deleting a preset removing the base scene the user may also want.
- A preset card whose property tweaks write into the base scene's overrides, or the other way round.

## Constraints
- Follow `CLAUDE.md`: features compose (presets × playlists, shuffle, timed, advance-on-end, restore, transitions
  V→S / S→S, per-monitor where it exists); settings apply live; tests hermetic; no compat code (pre-release).
- Library state (`index.json`, `LibMeta`) is written field-level and atomically (`.claude/rules/backend/state-files.md`).
- Scene property encoding and validation stay `SceneProperties` (WE encoding; `Coerce`; a value equal to the default
  drops the key), `.claude/rules/backend/library.md` § Scene properties.
- Download modes: a preset's base scene uses the same mode as the preset (`WorkshopDownloader`, no mode fallback).
- Every new UI element follows `.claude/rules/ui/design.md`'s checklist and reuses existing controls (the scene
  sidebar's property panel, the existing link/pill styles); a probe covers it.
- The repo is public: test presets are referred to by Workshop id only.

## Approaches
1. **Resolve at play time (picked).** A preset is a Library item of type `preset` holding its own `project.json` and
   preview, plus its base scene's id. At apply time the backend resolves the base scene's folder and hands the player
   that scene with the merged property map. Reuses the scene path and the live property system; the base scene's
   updates reach every preset; no duplicate data.
2. **Copy at download time.** Materialise each preset as a full scene copy with the values baked in. Simplest to
   play, but duplicates data, goes stale, and fights the override system. Rejected for those reasons.

The owner picked 1 for its own reason too: presets as their own cards (not variants under the scene's card), so
several presets of one scene can be added to one playlist.

## Decided behaviour (owner-approved defaults)
- **The base scene is a normal Library card.** Downloading a preset that brings its base scene adds that scene as an
  ordinary item; if the scene is already in the Library, it is reused.
- **Unsubscribing / deleting a preset** never touches its base scene.
- **Deleting a base scene that presets use** asks first, naming how many presets use it. Afterwards those presets
  show "needs its base scene" (greyed out, not playable) with a button that downloads the base scene again through
  the current mode.
- **Browse**: Preset is its own option in the Workshop type filter, unticked by default, offered only when scene
  support is on; default Browse lists stay as they are today.
- **Legacy engine**: presets are unplayable with the reason shown.

## Data and flow (the builder's starting map)
- **Preset item format**: confirm from real Workshop presets first (download 3–5 popular ones by id into a hermetic
  library); WE's `project.json` for a preset is expected to carry `type: "preset"`, the base item's id (e.g.
  `dependency`), and the saved values (e.g. a `preset` object keyed by property name). Record the confirmed shape in
  `.claude/rules/backend/library.md` and handle what real items contain (values that no longer exist in the scene,
  types that changed, missing preview).
- **Library**: `LibraryService` recognises `preset` folders (today it checks `type == "scene"`); the item lists its
  base scene id and whether that base is present. Presets count as scenes for the scene-support switch and the
  type filter.
- **Properties**: for a preset card, `SceneProperties.Describe` uses the base scene's property list with the preset's
  values as defaults; the user's tweaks live in the preset card's own `LibMeta.SceneProps` (`SceneProperties.Coerce`
  against the base scene's definitions; a value equal to the preset's value drops the key).
- **Play**: wherever a scene's path and property map go to the player (`PlayerHelper`, `SceneProperties.PlayerMap`,
  `AppOps` scene-props routes, the scene loudness planner), a preset resolves to its base scene's folder plus the
  merged map. Live property changes on a playing preset apply live, as for scenes.
- **Download**: subscribing/downloading a preset queues its base scene in the same mode; the preset becomes playable
  when both are present. A base scene that can't be fetched leaves the preset in "needs its base scene".
- **Presets of a scene**: first confirm Steam's reverse lookup (`IPublishedFileService/QueryFiles` with
  `child_publishedfileid`: items that reference a given item) through each route Browse already uses (signed-in,
  anonymous, the fake Steam servers in the tests). If it isn't available on a route, fall back to a Preset-tagged
  search on the scene's title whose results are kept only when their required item is confirmed to be the scene, and
  say in the list that it may be incomplete.
- **Browse / filter**: remove Preset from `WorkshopTags.Unplayable` when scene support is on; keep it excluded
  otherwise and under legacy.

## Verification the builder must show
- Real Workshop presets (by id) download with their base scene in each download mode the test fixtures cover (fake
  Steam servers, no network in the hermetic suite).
- A preset plays its base scene with the preset's values (pixel or property-map check), and the user's tweaks layer on
  top; changing a tweak live updates the playing preset; the base scene's own card and tweaks are unaffected.
- Two presets of one scene in one playlist rotate correctly (timed, advance-on-end, shuffle, restore).
- Deleting the base scene asks, then greys out its presets with the reason; the re-download button restores them.
- Legacy engine: presets unplayable with the reason.
- "Presets" on a scene lists exactly the presets that reference it (fake Steam server fixture with known children), in
  Browse and from the Library sidebar.
- UI matrix for the changed areas, probes for the new sidebar link, the greyed state and the confirmation.

## Calls made after the builder check (Claude's, for the owner to check while reading)
- **Identity: a preset is its own item all the way down.** Its path (the preset's own folder) is what rotation
  history, advance, crash marks, restore, playlists, `LiascapePlayerMedia` and the player's sources key on — never
  the base scene's path. The player receives the preset as its own scene source (the base scene's folder to load plus
  the merged property map, under the preset's identity); a player-side change is in scope where the player keys by
  folder today. Two presets of one scene are two different items: a switch between them is an ordinary S→S
  transition (two instances during a crossfade, as for any two scenes), never a live property change on one source.
  The scene's loudness measurement is per item too (presets can change audio-relevant properties).
- **Downloads: the base follows the preset's action.** A subscribed preset subscribes its base scene; a one-off
  ("Download without subscribing") preset gets a one-off base. In "Open on the Steam page" mode Liascape opens the
  preset's page and relies on Steam's required-items prompt; if the base doesn't arrive, the preset stays in
  "needs its base scene", whose button opens the base scene's page in that mode.
- **Presets whose base is not a scene** (web, application, video): shown in Browse like other presets (no extra Steam
  lookup per card); after download they are greyed out with the reason ("its base is a web wallpaper"). If Steam's
  item details already name the base's type cheaply, the builder may mark them earlier.

## Left to the builder
- Exact field names once confirmed from real items; where the base-scene link lives in the index.
- How the "needs its base scene" state and the re-download button look, within the design rules (reuse existing
  disabled-card and action styles).
- The confirmation dialog's wording, in the app's voice (as the status bar rewrite set it).
