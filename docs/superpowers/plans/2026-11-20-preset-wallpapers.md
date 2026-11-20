# Preset Wallpapers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse, subscribe to and play Workshop presets as their own Library items over their base scene, plus a scene's "Presets" list.

**Architecture:** A preset is an item folder whose project.json has a `preset` object and a `dependency` (no `type` key; Task 1), resolved at play time: the backend finds its base scene in the
library by Workshop id and hands liascape-player a scene source whose identity (`path`) is the preset's own folder and
whose `scene_dir` is the base's folder, with the layered property map (scene defaults → preset values → the card's own
tweaks). Downloads fetch the base through the same mode and action; Steam's `QueryFiles` `child_publishedfileid`
lists a scene's presets.

**Tech Stack:** C# backend (`src/backend`), Rust player (`src/player`), React UI (`app/ui`), SteamKit2 3.4.0 (has
`child_publishedfileid`, `includechildren`, `return_children`), bash/node hermetic tests.

**Spec:** `docs/superpowers/specs/2026-11-20-preset-wallpapers-design.md` (read it whole, including "Calls made after the builder check").

**Order and parallel work (at most 2 agents, never on the same files):** 1 alone → **2 ∥ 3** → **4 ∥ 6** → **5 ∥ 8** →
**7 ∥ 9** → 10 alone. Each pair was checked for file overlap; anything a task touches outside its **Files** list it
first raises with the coordinator.

> **Confirmed format (Task 1, a99b1a33 — overrides any guessed name below):** no `type` key; a preset is recognised by a
> `preset` object plus `dependency` (the base's Workshop id as a digit string). `preset` values use the base scene's
> own encoding; it also holds WE's own settings (`_d0`, `alignment*`, `rate`, `wec_*`) that are not scene properties —
> ignore keys the base doesn't define. `scenetexture` values are `"files/<name>"`, relative to the preset folder; the
> `files/` folder holds only those images and overrides no base file. Steam's `Preset` tag is only in Steam's tags
> (with `Scene` or `Web`), never in project.json. See `.claude/rules/backend/library.md` § Presets.

## Global Constraints

- Preset is its own option in the Workshop type filter, unticked by default, offered only when scene support is on (and the engine is liascape-player); default Browse lists stay as they are today.
- A preset is its **own item all the way down**: rotation history, advance, crash marks, restore, playlists, `LiascapePlayerMedia` and the player's sources key on the preset's own folder, never the base scene's path.
- Property layering: the scene's defaults, then the preset's values, then the user's own tweaks for that preset card (`LibMeta.SceneProps`, `SceneProperties.Coerce` against the base scene's definitions; a value equal to the preset's value drops the key).
- Two presets of one scene are two items: a switch between them is an ordinary S→S transition (two workers during a crossfade), never a live property change on one source. Loudness is measured per item.
- The base follows the preset's action and download mode: subscribed preset → subscribed base; one-off → one-off base; "Open in the Steam app" opens the preset's page only and relies on Steam's required-items prompt. No mode borrows another's route (`docs/decisions.md` § "Offer three Workshop download modes, the user's choice").
- Unsubscribing or deleting a preset never touches its base. Deleting a base that presets use asks first, naming how many presets use it.
- Missing or unplayable = greyed out up front with the reason; never silently the plain base scene, never a silent failure.
- Never copy the base scene into a preset.
- Legacy engine: presets unplayable with the reason. Web and Application wallpapers stay unplayable.
- Library state (`index.json`, `LibMeta`) is written field-level and atomically (`.claude/rules/backend/state-files.md`); no compatibility code (pre-release).
- Every new UI element follows `.claude/rules/ui/design.md`'s checklist, reuses existing controls, and gets a probe cell.
- The repo is public: test presets are referred to by Workshop id only; no account names in code, docs or commits.
- Tests hermetic; settings apply live; features compose (`CLAUDE.md` § Hard rules). Commits: title-case, no period, one `Claude-Agent:` trailer per model; stage exactly the task's **Files** list (never `git add -A`: the other agent's edits share the tree).

## Review Focus

1. **A preset saved against an older base** (a property the base dropped, its type changed, a combo option gone): those values drop one by one, the rest apply, the sidebar lists the base's current properties. → Task 4 test `preset values the base no longer has`.
2. **The base arrives late or comes and goes while the app runs** (slow Steam under the page mode, a trash and Undo): the preset turns greyed / playable live — the card, the program's `skip` flag — without a restart. → Task 5 IT `trash the base mid-rotation, then Undo`; Task 7 `base lands after the preset`.
3. **The base changes form** (a `local/<id>` link ↔ the library's own copy via `KeepOwnCopy` / `RelinkOwnCopies`, or an imported folder): resolved by Workshop id, never by path; a playing preset keeps playing, its next play loads the new folder. → Task 3 test-presets.sh § base forms.
4. **A malformed preset** (no base id, base id = its own id, a base that is itself a preset): greyed with its reason, never resolved recursively. → Task 3 test-presets.sh § malformed.
5. **A scene with no presets, or more than one page of them**: the list says there are none; paging continues past 100. → Task 6 workshop-social § presets list.

---

### Task 1: Confirm the preset format from real Workshop items

Research on the real Workshop, then a committed fixture. Nothing in Liascape's own library, the running app, the Steam
client's folders or `~/.cache/liascape/steamcmd_workshop` (refused by the corpus scripts) is touched.

**Files:**
- Create: `scripts/test-fixtures/presets/<presetId>/project.json` (3–5 items)
- Modify: `.claude/rules/backend/library.md` (new § Presets, the confirmed shape)

**Interfaces:**
- Produces: the confirmed field names used by Task 3's `Presets.Read`. Expected (to confirm, not facts): `type: "preset"`,
  the base id in `dependency` (digits as a string), the values in a `preset` object keyed by property name in WE's
  encoding; Steam lists the base as the preset's child (`children` / "Required items"); presets carry the `Preset` type
  tag. If any differs, edit the names in Tasks 3, 4 and 6 before starting them and say so in this task's commit.

- [ ] **Step 1: Pick 3–5 popular presets of different base scenes** — one read of `https://steamcommunity.com/workshop/browse/?appid=431960&requiredtags[]=Preset&browsesort=trend&days=7` (curl, ≥ 10 s between any two steamcommunity.com requests), ids from `filedetails/?id=` hrefs; include one whose base is not a scene if the page shows one.
- [ ] **Step 2: Record the Steam-side facts per id** — keyless `POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/` (`itemcount`, `publishedfileids[0]`): tags (does a preset also carry `Scene`?), title, size; each item's page (spaced as above): its "Required items" (the base id).
- [ ] **Step 3: Download them into a scratch dir** — try `steamcmd +force_install_dir <scratch>/steamcmd +login anonymous +workshop_download_item 431960 <id> +quit` (expected to fail: Wallpaper Engine isn't free); else the machine's cached steamcmd login of an account that owns Wallpaper Engine (never written anywhere in the repo). Files land in `<scratch>/steamcmd/steamapps/workshop/content/431960/<id>/`.
- [ ] **Step 4: Write the record** — in `.claude/rules/backend/library.md` § Presets: the keys a preset's `project.json` carries, where the base id and values live, the values' encoding (combo key as string or number, colour text), whether a preview / `file` / `general.properties` copy is present, and the tags. Mark one bullet per fact, no item titles.
- [ ] **Step 5: Add the fixtures** — each `project.json` minimised: every real key and value type kept, the real base id and values kept, `title` → `Preset fixture <n>`, `description` → `""`, no preview file (tests generate one).
- [ ] **Step 6: Verify**

Run: `for f in scripts/test-fixtures/presets/*/project.json; do jq -e '(has("type") | not) and (.dependency | test("^[0-9]+$")) and (.preset | type == "object")' "$f" >/dev/null || echo "BAD $f"; done` (with the confirmed names)
Expected: no `BAD` line. `bash scripts/check-rules.sh` clean.

- [ ] **Step 7: Commit** — `git add scripts/test-fixtures/presets .claude/rules/backend/library.md && git commit -m "Record The Workshop Preset Format"`

---

### Task 2: Player — a scene source loads `scene_dir` under its own `path`

**Files:**
- Modify: `src/player/src/graph/props.rs` (Source schema, beside `scene_props` ~line 473)
- Modify: `src/player/src/sources/scene.rs` (`SceneOpts` ~line 231, `SceneSource::open` ~line 631, `spawn` ~line 846, `change_path` ~line 1756, the `set` match ~line 2569)
- Modify: `src/player/src/sources/mpv.rs:2482` (stored-only props list)
- Test: `src/player/tests/api.rs`, `src/player/tests/program.rs`, `src/player/tests/supervise.rs`
- Docs: `docs/player/modules/scene-source.md` § Assets, properties, inputs; `.claude/rules/player/scenes.md` § The `scene` source kind

**Interfaces:**
- Produces: Source prop `scene_dir` (Str, settable, default `""`): the folder the worker loads; `""` = `path`. Rust:
  `SceneOpts.load_dir: Option<PathBuf>`, `SceneOpts::load_path(&self) -> &Path`. `ToWorker::Start.path`, `--preload`,
  `synthetic`, `steam_dir` come from `load_path()`; everything else — `source.*` / `scene.*` events' `path`, the
  loudness `book_key(path, key)`, the snapshot, `probe` — stays `path`. No `PROTOCOL` bump (the worker's message shape
  is unchanged). A `scene_dir` change = a new worker on the new folder (like a `path` change), not a crash.

- [ ] **Step 1: Write the failing tests**

```rust
// tests/api.rs
fn scene_dir_plays_under_its_own_path()        // path = an empty preset dir, scene_dir = synthetic solid scene,
    // scene_props {"rgb":[0,0,255]} → capture pixel (100,100) == [0,0,255]; source.ready / logs name path == preset dir;
    // `get <id>.path` == preset dir, `get <id>.scene_dir` == scene dir; no source.error
fn two_paths_over_one_scene_dir_are_two_sources() // same scene_dir, paths A/B, rgb red / green on VIRTUAL-1 / -2 →
    // two different worker pids (worker_of), each output its own colour
fn presets_of_one_scene_measure_apart()        // loudness_serve; tone scene as scene_dir under two paths → each
    // scene.loudness report carries its own path; audible_s of each counts only its own play (never shared)
fn scene_dir_change_is_a_new_worker_not_a_crash() // set scene_dir to another synthetic scene → new pid, new colour,
    // no worker.restart / worker.broken / crash file
// tests/program.rs
fn two_presets_of_one_scene_rotate_as_two_items() // scene_program with items (path P1, scene_dir S, rgb red) and
    // (path P2, scene_dir S, rgb green): program.current alternates P1/P2; each switch is a transition.started with two
    // distinct source ids; never a `set …scene_props` on one source between them
// tests/supervise.rs
fn scene_dir_survives_a_restore()               // like scene_snapshot_restores_at_position: after a supervised restart
    // the source still has path P, scene_dir S and shows S's picture
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo test -q --manifest-path src/player/Cargo.toml --test api scene_dir` (and `--test program two_presets`, `--test supervise scene_dir`; `presets_of_one_scene` under `--test api`)
Expected: FAIL (`scene_dir` is not a known prop → `bad_request`).

- [ ] **Step 3: Implement** `scene_dir` in the Source schema (comment: the folder to load; identity stays `path`), `"scene_dir"` in `mpv.rs`'s stored-only list, `SceneOpts.load_dir` + `load_path()`, read in `open`, used by `spawn` / `preload_args` / synthetic / `steam_root_of_item`; the `set` match routes a `scene_dir` change through the same new-worker path as `path`.
- [ ] **Step 4: Run the tests to verify they pass, then the whole player suite**

Run: `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo test -q --manifest-path src/player/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Docs** — scene-source.md: one paragraph on `scene_dir` vs `path`; scenes.md: a bullet "`scene_dir` = the folder the worker loads (a preset's base scene); identity — events, the loudness Book, snapshot — stays `path`. Guard: `tests/api.rs::scene_dir_plays_under_its_own_path`, `presets_of_one_scene_measure_apart`". `bash scripts/check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Load A Scene Source's Folder Apart From Its Identity"`

---

### Task 3: Backend — presets in the library

**Files:**
- Create: `src/backend/Helpers/Presets.cs`
- Create: `scripts/test-presets.sh` (hermetic: `scripts/test-tmp.sh`, `scripts/test-lock.sh`, private HOME/XDG dirs and backend, `LIASCAPE_TEST_NO_NETWORK=1`, `LIASCAPE_STEAM_CM_FIXTURE` = an empty `{}`, `[--no-build]` like `scripts/test-item-actions.sh`)
- Modify: `src/backend/Helpers/LibraryService.cs` (`BuildItem` ~525, `Build` ~590, `SyncWallpaperEngine` ~729, `SteamCopyWhole` ~796)
- Modify: `src/backend/Helpers/LibraryStore.cs` (`LibMeta`), `src/backend/Models/LibraryItem.cs`
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (new `PresetAssertions`, called from `Run`)
- Modify: `CLAUDE.md` § Verify your work (one line), `scripts/matrix-cells-for.sh` (`scripts/test-presets.sh` → "its own script"), `.claude/rules/backend/library.md` § Presets

**Interfaces:**
- Consumes: Task 1's confirmed field names.
- Produces (C#):
  - `public sealed record PresetFile(string? BaseId, IReadOnlyDictionary<string, JsonElement> Values)`
  - `public enum PresetProblem { None, NoBase, BaseNotScene, NeedsBase, Legacy }`
  - `public readonly record struct PresetStatus(PresetProblem Problem, string? BaseDir, string? Reason)`
  - `Presets.Read(string itemDir) : PresetFile?` — null = not a preset folder; cached by `project.json` mtime + size; never throws
  - `Presets.BaseDirOf(string baseId) : string?` — the library item folder: `local/<id>`, else `workshop/<id>`, else an `imported/` entry whose index `WorkshopId` is the id; no cache
  - `Presets.StatusOf(string presetDir, bool liascapePlayer) : PresetStatus`
  - `internal Presets.StatusFor(PresetFile f, string? selfId, string? baseKind, Func<string, string?> baseDirOf, Func<string, bool> isPresetDir, bool liascapePlayer) : PresetStatus` (pure; the self-test's table)
  - `Presets.LoadDirOf(string itemPath) : string?` — a scene: itself; a preset structurally playable (engine ignored): its base's folder; else null
  - `Presets.PresetPathsOf(string baseWorkshopId) : List<string>`
  - Reasons (exact copy, tests assert them): `"Needs its base scene"`, `"Its preset file names no base scene"`, `$"Its base is a {kind} wallpaper, not a scene"`, `"Presets play only in the Liascape player"`. Precedence: NoBase (no id, or id = its own) → BaseNotScene (`LibMeta.BaseKind` set) → NeedsBase (no folder) → BaseNotScene (the folder is a preset → kind `preset`, or a video) → Legacy → None.
  - `LibMeta.BaseKind : string?`, `LibMeta.BaseTitle : string?` (set by Task 7 at download)
  - `LibraryItem`: `bool IsPreset`, `string? BaseWorkshopId`, `string? BasePath`, `string? BaseTitle` (the base item's title, else `LibMeta.BaseTitle`), `string? PresetReason` (null = plays; includes the legacy reason, read at `GET /library` time). A preset is also `IsScene = true`.

- [ ] **Step 1: Write the failing tests**

`PresetAssertions` (pure, no library):
```csharp
// StatusFor table: ("123" base, dir found, scene)      → None, BaseDir set, Reason null
//                  (null id)                           → NoBase, "Its preset file names no base scene"
//                  (id == selfId)                      → NoBase
//                  (baseKind "web")                    → BaseNotScene, "Its base is a web wallpaper, not a scene"
//                  (dir null)                          → NeedsBase, "Needs its base scene"
//                  (dir is a preset folder)            → BaseNotScene, "Its base is a preset wallpaper, not a scene"
//                  (all fine, liascapePlayer false)    → Legacy, "Presets play only in the Liascape player"
// Read: each scripts/test-fixtures/presets/*/project.json → non-null, BaseId digits, Values.Count > 0;
//       a scene's project.json → null; malformed JSON → null, no throw
```
`scripts/test-presets.sh` § 1 (library), with a synthetic base `900000001` (the adapter IT's `mk_scene` shape plus a
`color` / `clock` / `style` property set) and presets written in the confirmed shape:
- each Task 1 fixture copied to `workshop/<id>` → `GET /library`: `isPreset`, `isScene`, `baseWorkshopId` = its file's base id, `presetReason == "Needs its base scene"`, its own `thumbnailPath` / title
- § base forms: base as `local/900000001` (a link to a fake WE folder), as `workshop/900000001`, as an `imported/<name>` entry with `WorkshopId` 900000001 → `presetReason null`, `basePath` = that folder, `baseTitle` = its title; `KeepOwnCopy`-style swap (link → copy at the same path) keeps it resolved
- § malformed: no base id → `"Its preset file names no base scene"`; base id = own id → same; base `900000009` is itself a preset → `"Its base is a preset wallpaper, not a scene"`
- § auto-import: a preset folder in the fake WE folder + `AllowScenes` on → `POST /library/sync` adds `local/<id>` with index `isScene: true`; `AllowScenes` off → not added
- § legacy: settings `PlayerEngine: legacy` → a resolvable preset's `presetReason == "Presets play only in the Liascape player"`
- deleting (trash) a preset leaves the base's folder and entry untouched
- a preset with no preview file lists with `thumbnailPath: null` (nothing borrowed from the base)

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build src/backend && LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`; `bash scripts/test-presets.sh`
Expected: FAIL (no `Presets`; `/library` has no `isPreset`).

- [ ] **Step 3: Implement `Presets.cs`** (comment: why resolution is by id, not path — the path is the base item's identity and changes form) and wire `BuildItem` (a scene-branch folder that `Presets.Read` accepts → the preset fields), `SyncWallpaperEngine` (a project.json with a `preset` object + digit-string `dependency` imports like a scene, only with `allowScenes`), `SteamCopyWhole` (a preset folder is whole). `FolderScanner` stays as is (presets arrive through the Workshop and auto-import).
- [ ] **Step 4: Run the tests to verify they pass**

Run: same as Step 2. Expected: PASS, `player-selftest` 0 fails.

- [ ] **Step 5: Docs** — library.md § Presets: identity = the preset's folder; resolution order of `BaseDirOf`; the reasons and their precedence; "Guard: `scripts/test-presets.sh` § 1". CLAUDE.md line: ``- Presets: their base scene, layered properties, the base's delete (fake Steam servers, no network): `bash scripts/test-presets.sh` ``. `bash scripts/check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Recognise Preset Wallpapers In The Library"`

---

### Task 4: Backend — layered properties and per-item loudness for presets

**Files:**
- Modify: `src/backend/Helpers/SceneProperties.cs` (`SceneProp` ~26, `ForItem` ~57, `PlayerMap` ~248, `Describe` ~286)
- Modify: `src/backend/Helpers/SceneLoudnessPlanner.cs` (`Estimate` ~50)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`ScenePropertyAssertions`)
- Modify: `scripts/test-presets.sh` (§ 2), `.claude/rules/backend/library.md` § Scene properties

**Interfaces:**
- Consumes: `Presets.Read`, `Presets.LoadDirOf` (Task 3).
- Produces: `SceneProp.SceneDefault : JsonNode?` (the base scene's own default; = `Default` for a plain scene);
  `SceneProperties.WithPreset(IReadOnlyList<SceneProp> sceneProps, IReadOnlyDictionary<string, JsonElement> presetValues) : List<SceneProp>`
  (pure: `Default` = the preset's value where `Coerce` accepts it, else the scene's). `ForItem(presetDir)` =
  `WithPreset(ForItem(baseDir), values)`, cached on both files' mtime + size; an unresolvable preset → `[]`. Through
  `ForItem`, `Find` / `SaveSceneProp` / `PlayerDefault` / `Describe` / `AppOps.SceneProps` work on a preset path
  unchanged: the preset's value is the default, a tweak equal to it drops the key, Reset returns to it.

The layering the spec fixes (`PlayerMap`, per editable property `p` of the base scene; each layer only when `Coerce(p, v)` succeeds):

```
v = transient[p] ?? override[p] ?? preset[p]      // preset[p]: null for a plain scene → today's behaviour
if (v != null) map[p.Name] = ToPlayer(p, v)        // the scene's own default is never sent: LWE loads it itself
```

`WithResets` keeps sending `PlayerDefault` for a name the map lacks; such a name has no preset value, so that is the scene default.

- [ ] **Step 1: Write the failing tests**

`ScenePropertyAssertions` (pure, `WithPreset` over the existing test scene's parsed props):
```csharp
// preset {schemecolor:"0 0 1", clock:false} → Default of schemecolor "0 0 1", SceneDefault "0.5 0.25 1"
// preset values the base no longer has: {gone:1, clock:"notabool", style:"9"} → those three ignored, the rest applied
// slider beyond range in the preset → clamped by Coerce (bars 999 → 64)
```
`scripts/test-presets.sh` § 2 (API on preset `910000101` over base `900000001`, preset values `color "0 0 1"`, `clock false`):
- `GET /library/scene-props?path=<preset>`: the base's properties, `color.default == color.value == "0 0 1"`, `overridden: false`, `style` hidden (`clock false` condition)
- `POST` `color "0 1 0"` → index `sceneProps {"color":"0 1 0"}` on the preset only; base's entry has no `sceneProps`
- `POST` `color "0 0 1"` (= the preset's value) → the key drops; `reset: true` → back to `"0 0 1"`
- tweaking the base's own `color` leaves the preset's `GET` unchanged, and the other way round
- a preset whose base is missing → `props: []`, `POST` → 400

- [ ] **Step 2: Run to verify they fail** — `player-selftest`; `bash scripts/test-presets.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** `SceneDefault`, `WithPreset`, the preset branch of `ForItem` and the layering above; `SceneLoudnessPlanner.Estimate` runs the CLI on `Presets.LoadDirOf(scenePath)` (null → `error = "needs its base scene"`, return null) with `PropsOf(scenePath, …)` (the merged map) and stores under `scenePath` — the preset's own entry.
- [ ] **Step 4: Run the tests to verify they pass** — same commands. Expected: PASS.
- [ ] **Step 5: Docs** — library.md § Scene properties: the layering bullet ("a preset: scene defaults → preset values → the card's tweaks; Guard: `test-presets.sh` § 2"). `check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Layer A Preset's Values Over Its Base Scene"`

---

### Task 5: Backend — playing presets (adapter, gates, the base's delete)

**Files:**
- Modify: `src/backend/Player/LiascapePlayerMedia.cs` (`SourceProps` ~862)
- Modify: `src/backend/Helpers/PlayerHelper.cs` (`Apply` ~829, `IsSkippedPath(path, scenesPlayable)` ~4062)
- Modify: `src/backend/Web/AppOps.cs` (`Trash` ~480, `Undo` ~578)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`SceneAdapterAssertions`, `SceneSkipAssertions`)
- Modify: `scripts/test-liascape-player-adapter.sh` (new section; `LIASCAPE_IT_ONLY` accepts `presets`)
- Modify: `scripts/test-presets.sh` (§ 3)
- Docs: `.claude/rules/backend/player-adapter.md` § Scenes and loudness; `docs/player/adapter.md` § Scenes

**Interfaces:**
- Consumes: Task 2's `scene_dir`; Task 3's `Presets.StatusOf` / `LoadDirOf` / `PresetPathsOf`; Task 4's `PlayerMap`.
- Produces: `SourceProps(presetPath)` adds `scene_dir` = `Presets.LoadDirOf(path)` when it differs from `path` (so every
  program item's props carry it through `DesiredItem`). Gates: `Apply` of a preset whose `StatusOf(…).Reason` is set
  throws `InvalidOperationException(reason)` (both engines; `/apply` answers `{error}`); `IsSkippedPath` skips such a
  preset (the pickers and the program's `skip`). `AppOps.Trash` of a base: its library presets (`PresetPathsOf`) are
  treated like trashed items on screen (advance / stop) but stay in the playlist; `LiascapePlayerProgram.PushItems()`
  and WS `library-synced` follow; `Undo` restores and pushes again.

- [ ] **Step 1: Write the failing tests**

Self-test: `SourceProps(presetDir)` → `path` = preset dir, `kind` scene, `preview` = the preset's own preview, `scene_dir` = base dir; a plain scene has no `scene_dir`.

Adapter IT section `== presets: their own items over a synthetic base scene` (base S1 = the existing scene with `color`; presets P1 `color "0 0 1"`, P2 `color "0 1 0"` in `$LIB/workshop/910000101|2`):
- `/apply P1` → the source's `path` = P1, `scene_dir` = S1, pixel `0 0 255`, `/current` = P1
- `sp_set` on P1 `color "1 1 0"` → live `255 255 0` on the same worker; S1's index has no `sceneProps`
- `sp_set` on S1 `color "0 0 1"` → P1's live `scene_props` unchanged
- playlist [a clip, P1, P2] timed 2 s → all shown in turn (V→S and S→S), each preset switch a `transition.started` with two source ids; advance-on-end with a minimum play time; shuffle → both seen; `/stop` + `liascape restore` → a preset resumes with its `scene_dir`
- a preset P3 over a crashing synthetic base S3 (`crash_after_ms`) → `source.broken` marks P3's entry `crashed`, not S3's
- trash the base mid-rotation (`/library/trash` S1) → P1 on screen advances / stops, `GET /library` P1/P2 `presetReason "Needs its base scene"`, `/random` never lands on them; `/library/undo` → reasons null, the rotation plays them again
- engine `legacy` → `/apply P1` → `{error: "Presets play only in the Liascape player"}`

`scripts/test-presets.sh` § 3 (no player): trash S1 → presets' `presetReason`; undo → null; WS `library-synced` seen.

- [ ] **Step 2: Run to verify they fail**

Run: `LIASCAPE_IT_ONLY=presets bash scripts/test-liascape-player-adapter.sh`; `player-selftest`; `bash scripts/test-presets.sh`
Expected: FAIL (no `scene_dir`: the preset folder plays as a broken scene).

- [ ] **Step 3: Implement** `SourceProps`' `scene_dir`, the two gates, the base-trash handling in `AppOps.Trash` / `Undo`.
- [ ] **Step 4: Run the tests to verify they pass** — the three commands, then the whole adapter IT (`bash scripts/test-liascape-player-adapter.sh`) and `bash scripts/test-ui-matrix.sh --changed`. Expected: PASS.
- [ ] **Step 5: Docs** — player-adapter.md: "A preset plays as its own source: `path` = its folder, `scene_dir` = its base's (`SourceProps`); gates read `Presets.StatusOf`. Guard: adapter IT § presets". adapter.md § Scenes: one paragraph. `check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Play Presets As Their Own Items"`

---

### Task 6: Steam — the Preset type, a preset's base, a scene's presets

**Files:**
- Modify: `src/backend/Helpers/SteamWorkshopDetails.cs` (`Details`, `GetDetailsAsync`, `FromFixture`, `QueryFromFixture`, `ToDetail`; new `QueryChildrenAsync`)
- Modify: `src/backend/Helpers/WorkshopTags.cs` (`Type`, `Unplayable`, `Build`; new `ForPresets`)
- Modify: `src/backend/Scrapers/SteamWorkshopScraper.cs` (`MapToResults`, `PublishedFileDetail`, `BrowseAsync`'s call)
- Modify: `src/backend/Services/SteamWorkshopService.cs` (`AllowPresets`, `ListAsync`, `FetchAsync`)
- Modify: `src/backend/Models/WorkshopList.cs`, `src/backend/Models/WallpaperResult.cs`
- Modify: `src/backend/Web/ServerHost.cs` (`ConfigureProvider` ~200, route `GET /workshop/base`)
- Modify: `src/backend/Web/WorkshopSocialOps.cs` (`BaseOfAsync`, `BaseAsync`)
- Test: `src/backend/Web/SteamSelfTest.cs` (`NoNetwork` fixture section), `scripts/test-workshop-social.sh`
- Docs: `.claude/rules/backend/sources-steam.md`

**Interfaces:**
- Consumes: Task 1's tag facts (whether presets also carry `Scene`).
- Produces:
  - `WorkshopTags.Build(WorkshopFilter? filter, bool allowScenes, bool allowPresets = false)`: `Type` tags `["Video", "Scene", "Preset"]`; none included → Video + Scene (unchanged); `Preset` allowed only when included AND `allowPresets`; `Excluded` always has Web, Application, and Preset unless it is allowed; `Preset` included without `allowPresets` → `Plan.Empty`. `Unplayable` = `["Web", "Application"]`.
  - `WorkshopTags.ForPresets(WorkshopFilter? filter) : Plan` — the filter's other groups, Type = `["Preset"]`.
  - `MapToResults(ids, details, bool allowScenes, bool allowPresets = false)`; `WallpaperResult.IsPreset` (a preset result is also `IsScene = true`).
  - `SteamWorkshopService.AllowPresets` (set by `ConfigureProvider` = `AllowScenes && PlayerEngine.IsLiascapePlayer`; a change invalidates the prefetch).
  - `Details(..., string? Title = null, ulong[]? Children = null)`; `GetDetails` asks `includechildren = true`; the fixture reads `"title"` and `"children": ["<id>"]`.
  - `SteamWorkshopDetails.QueryChildrenAsync(ulong parentId, WorkshopTags.Plan plan, string sort, int page, int perPage, TimeSpan timeout, CancellationToken ct = default) : Task<List<PublishedFileDetail>?>` — `QueryFiles` with `child_publishedfileid = parentId`, `return_children = true`, `query_type` 21 (`lastupdated`) / 0 (`score`); keeps only items whose children contain `parentId`. `PublishedFileDetail.Children : string[]`. The fixture's `@query` honours `child_publishedfileid` through each item's `children`.
  - `WorkshopList.IsPresets` (`Kind == "presets"`, `Id` digits ≤ 20), part of `Active` and `Key()` (`presets:<id>|<sort>`). `ListAsync` serves it with `QueryChildrenAsync` + `ForPresets`; Steam unreachable → `InvalidOperationException("Steam's servers didn't answer — try again in a moment.")` (the creator list's precedent: lists have no page fallback); `AllowPresets` off → `[]`.
  - `record PresetBaseInfo(string BaseId, string? Title, string? Kind)`; `WorkshopSocialOps.BaseOfAsync(string presetId, CancellationToken ct) : Task<PresetBaseInfo?>` (GetDetails of the preset → its first child → GetDetails of that; Kind from the base's type tag: `scene` / `video` / `web` / `application` / `preset`, else null; kept 15 min like `/workshop/counts`, a failure not kept). `GET /workshop/base?id=` → `{baseId, title, kind, libraryPath}` (`libraryPath` = `Presets.BaseDirOf`), 404 when it isn't a preset, 400 on a non-digit id.

- [ ] **Step 1: Write the failing tests**

`SteamSelfTest.NoNetwork` (fixture with `1001` Video, `1003` Scene, `2001` / `2002` Preset with `children: ["1003"]`, `2003` Preset with `children: ["1001"]`):
```csharp
// Build(default, true, true): type group [Video, Scene], Excluded ⊇ {Web, Application, Preset} → query "1001,1003"
// Build(include Preset, true, true) → "2001,2002,2003"; include Scene+Preset → "1003,2001,2002,2003"
// Build(include Preset, true, false).Empty
// QueryChildrenAsync(1003, ForPresets(null), "lastupdated", 1, …) → "2001,2002"; QueryChildrenAsync(1002) → ""
// GetDetailsAsync([2001]) → Children [1003], Title set
// MapToResults: a Preset-tagged detail → dropped without allowPresets; with it IsPreset && IsScene
```
`scripts/test-workshop-social.sh` § presets list (its fixture gains the presets above and 150 presets of scene `1004`):
- `POST /browse {list: {kind: "presets", id: "1003"}}` with `AllowScenes` + `PlayerEngine liascape-player` → exactly 2001, 2002; `id: "1002"` → `[]`; scene `1004`: page 1 has 100, page 2 has 50
- `AllowScenes` off → `[]`; the whole Workshop's default list never contains a preset
- `GET /workshop/base?id=2001` → `{baseId: "1003", kind: "scene"}`; `id=1001` → 404; `id=x` → 400

- [ ] **Step 2: Run to verify they fail** — `bash scripts/test-steam-signin.sh` (§ 1 runs steam-selftest), `bash scripts/test-workshop-social.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces above (the fallback browse page passes `allowPresets` too).
- [ ] **Step 4: Run the tests to verify they pass** — same commands. Expected: PASS.
- [ ] **Step 5: Verify `child_publishedfileid` on the real route (not hermetic; one request)** — a private backend (own HOME/XDG dirs, no fixture, network allowed), `AllowScenes` on, liascape-player engine: `POST /browse {list: {kind: "presets", id: <a base id from Task 1>}}`. Record in sources-steam.md which route answered and how many presets came back. Browse's other routes need no check: the page fallback is never used by lists, and no Browse query is signed in (only the private-favourites page is).
- [ ] **Step 6 (only if Step 5 returns nothing for a scene Task 1 showed has presets: Steam ignored the child filter): the search fallback** — `ListAsync` for presets runs `QueryAsync` with `ForPresets(filter)` and `search_text` = the scene's title (`GetDetailsAsync([id]).Title`), `return_children = true`, kept only when the children contain the scene; `/browse` adds header `X-Liascape-List-Note: Found by searching the scene's name — some presets may be missing`. Fixture switch `"@childquery": false` makes `QueryFromFixture` ignore the child filter; a workshop-social case asserts the kept set and the header. Tell Task 8 to show the note.
- [ ] **Step 7: Docs** — sources-steam.md: the Type rule (Preset offered only with scenes + liascape-player), the presets list (`QueryChildrenAsync`, Step 5's result), `/workshop/base`. `check-rules.sh`.
- [ ] **Step 8: Commit** — `git commit -m "List A Scene's Workshop Presets"`

---

### Task 7: Downloads — a preset brings its base

**Files:**
- Create: `src/backend/Web/PresetDownloads.cs`
- Modify: `src/backend/Helpers/WorkshopDownloader.cs` (`TryGetMediaPath` ~879; `maxWaitMs` in `WaitForSteamCopyAsync` ~281 → `MaxWaitMs`, `LIASCAPE_WORKSHOP_WAIT_MS` like `PollMs`)
- Modify: `src/backend/Web/AppOps.cs` (`DownloadAsync` ~246: one call after the import), `src/backend/Web/WorkshopSubOps.cs` (`SubscribeAsync` ~100, `WatchTodoAsync`), `src/backend/Web/ServerHost.cs` (`Providers` is `private` ~line 36: expose the Workshop provider as `internal static SteamWorkshopService Workshop`)
- Modify: `scripts/test-steam-signin.sh` (§ 2, § 3: a CM fixture file for every backend), `scripts/test-fixtures/fake_steamclient.c` (`install`: copy `$FAKE_UGC_DIR/template-<id>/` when present), `scripts/test-fixtures/drive-steam-client.mjs`
- Docs: `.claude/rules/backend/sources-steam.md` § Workshop downloads

**Interfaces:**
- Consumes: `Presets.Read` / `BaseDirOf` (Task 3), `WorkshopSocialOps.BaseOfAsync` (Task 6).
- Produces:
  - `TryGetMediaPath(dir)`: a folder `Presets.Read` accepts → its `project.json` (a preset is ready when it parses).
  - `PresetDownloads.FetchBaseAsync(LibraryItem preset, bool oneOff) : Task` — background, never throws: base id from `Presets.Read`, else `BaseOfAsync`; base in the library → done; `BaseOfAsync` kind not `scene` → `LibMeta.BaseKind` / `BaseTitle` saved field-level + `library-item-changed {presetReason}`; else by the preset's mode and action: `subscribe` / `steamapp` → `AppOps.DownloadAsync(base, …, oneOff)` with the base's detail from `ServerHost.Workshop.GetDetailAsync` (as `/download` does); `steampage` → wait for the base's folder with no page (`WaitForSteamCopyAsync` without a to-do entry, text "Waiting for Steam to download its base scene…", `MaxWaitMs`) then the same import (nothing opened), a timeout leaves it. Success → `library-synced`, `LiascapePlayerProgram.PushItem(preset)`, `SceneLoudnessOps.Imported(preset, "base")`; failure → `download-progress {id: <base page url>, error}`.
  - `PresetDownloads.SubscribeBaseAsync(string presetId) : Task` — after a subscribe-only of a preset (`/workshop/subscribe`, incl. its to-do entry ending Done) under `subscribe` / `steamapp`: subscribes a scene base that is neither subscribed nor in the library (`WorkshopSubOps.SubscribeAsync`); `steampage` relies on Steam's prompt.

- [ ] **Step 1: Write the failing tests** (fixture: preset `910000101` with `children ["900000001"]`, base `900000001` tagged Scene, preset `910000103` whose base `900000005` is tagged Web; the test drops the preset folder from a Task 1 fixture with its base id rewritten, and a base folder with `project.json` type scene + `scene.pkg`)
- § 2 page mode: download the preset → its page only opens; the test drops it, then drops the base → both in the library, no page for the base, the preset's `presetReason` null; another run never drops the base → after `LIASCAPE_WORKSHOP_WAIT_MS` the preset reads "Needs its base scene"
- § 2 signed in (fake community), plain download → the community saw subscribe 910000101 then 900000001; both imported
- § 2 signed in, "Download without subscribing" → both own `workshop/<id>` copies, both let go (unsubscribed) after their copies
- § 2 base already in the library → no subscribe for 900000001, reused
- § 2 web base → 900000005 never asked for; the preset reads "Its base is a web wallpaper, not a scene"
- § 3 steamapp (fake client templates): download → `calls` has `subscribe 910000101` and `subscribe 900000001`; one-off → `downloads` has both; `POST /workshop/subscribe` of the preset → `calls` has the base's subscribe
- unsubscribing / Delete from source of the preset → no unsubscribe of the base anywhere

- [ ] **Step 2: Run to verify they fail** — `bash scripts/test-steam-signin.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces above (comment on `FetchBaseAsync`: the base follows the preset's mode and action, never another route; link `docs/decisions.md` § "Offer three Workshop download modes, the user's choice").
- [ ] **Step 4: Run the tests to verify they pass** — `bash scripts/test-steam-signin.sh`. Expected: PASS.
- [ ] **Step 5: Docs** — sources-steam.md § Workshop downloads: one bullet "A preset brings its base…" with the guard. `check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Fetch A Preset's Base Scene With It"`

---

### Task 8: UI — Browse: the Preset filter, a scene's Presets, a preset's base

**Files:**
- Modify: `app/ui/src/components/workshopFilter.ts` (`WF_GROUPS` Type, `groupsFor`, `facetsOf`), `app/ui/src/components/WorkshopFilterColumn.tsx`
- Modify: `app/ui/src/api/client.ts` (`WsList`, `Wallpaper`, `api.workshopBase`), `app/ui/src/store/index.ts` (`wireList`, `setWsList`; dropping a ticked Preset when presets go off)
- Modify: `app/ui/src/components/WorkshopSocial.tsx` (extract the creator row's button as `WsListRow`; `PresetsRow`, `BaseRow`; the empty-list note), `app/ui/src/components/SourcePills.tsx`, `app/ui/src/components/BrowseSide.tsx`, `app/ui/src/index.css`
- Test: `app/shell/probe-steam.js`, `app/shell/probe-filters.js`, `scripts/test-ui-matrix.sh` (CM fixture: scene `910000003` gets presets `910000011` / `910000012` with `children`), `scripts/matrix-cells-for.sh` (any new file)
- Docs: `.claude/rules/ui/state-and-api.md` § Workshop filter

**Interfaces:**
- Consumes: `/browse` list kind `presets`, `isPreset` on results, `GET /workshop/base` (Task 6).
- Produces: `type WsList = … | { kind: "presets"; id: string; name: string | null }`; `api.workshopBase(id) : Promise<{ baseId: string; title: string | null; kind: string | null; libraryPath: string | null }>`; `usePresetsOn() : boolean` (`settings.allowScenes && settings.playerEngine === "liascape-player"`); `groupsFor(scope, presets: boolean)`; `facetsOf` adds `preset` (and keeps `scene`) for `isPreset`; components `WsListRow`, `PresetsRow({ workshopId, title, onListed })`, `BaseRow({ presetId })` exported from `WorkshopSocial.tsx` (Task 9 reuses them).

- [ ] **Step 1: Write the failing probe cells**
  - probe-filters `filter:preset:offered` — Preset in the Type group only with scenes on + liascape-player, unticked; the default list holds no preset; `filter:preset:on` — ticking it lists 910000011/12; `filter:preset:cleared` — scenes turned off with Preset ticked → the tag leaves the filter, the list is the default one
  - probe-steam `ws:presets` / `ws:presetsOff` — a scene's sidebar shows "Presets" (the creator row's look), a click lists exactly the two presets with a "Presets · <scene title>" pill (×back), one already in the library carries Browse's in-library mark, the list sorts (WS_LIST_SORTS) and pages; motion on/off, `no-glow`, `bg-live` judged; `ws:presetsHidden` — scenes off, legacy engine, a video or a preset sidebar: no link; `ws:presetsEmpty` — a scene without presets: the list says so; `ws:presetBase` — a preset's sidebar shows "Uses: <base title>", a click goes to the base's Library card (in the library) or opens the base's page (`/steam/open-page` with its id) when not
- [ ] **Step 2: Run them to verify they fail** — `cd app/ui && npm run build && npm run lint`; `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^ws:preset'`, `--probe probe-filters.js --only '^filter:preset'`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces; if Task 6 Step 6 ran, the store reads `X-Liascape-List-Note` into `wsListNote` as a non-error note.
- [ ] **Step 4: Run them to verify they pass**, then `bash scripts/test-ui-matrix.sh --changed`. Look at the mid-animation screenshots (`ui-verify` skill). Expected: PASS.
- [ ] **Step 5: Docs** — state-and-api.md § Workshop filter: Preset's offered rule and the `presets` list kind. `check-rules.sh`.
- [ ] **Step 6: Commit** — `git commit -m "Browse Workshop Presets And A Scene's Presets"`

---

### Task 9: UI — Library: preset cards, the needs-base state, the base's delete

**Files:**
- Create: `app/ui/src/components/baseConfirm.ts`, `app/ui/src/components/BaseSceneConfirm.tsx`
- Modify: `app/ui/src/api/client.ts` (`LibraryItem`), `app/ui/src/components/LibraryCard.tsx`, `app/ui/src/components/LibrarySide.tsx`, `app/ui/src/views/Library.tsx` (`doTrash`, `onDeleteSource`), `app/ui/src/components/BrowseSide.tsx` (its Unsubscribe of a library item awaits the confirm), `app/ui/src/App.tsx`, `app/ui/src/store/index.ts` (re-read the library when `playerEngine` or `allowScenes` changes), `app/ui/src/index.css`
- Test: `app/shell/probe-sidebar.js` (cells add their preset folders to the stack's library at start and remove them at the end, so the shared library other cells count stays as is), `scripts/matrix-cells-for.sh`

**Interfaces:**
- Consumes: `LibraryItem` preset fields (Task 3), `PresetsRow` / `BaseRow` / `WsListRow` (Task 8), `/download` (unchanged).
- Produces: TS `LibraryItem` gains `isPreset?: boolean; baseWorkshopId?: string | null; basePath?: string | null; baseTitle?: string | null; presetReason?: string | null`; `confirmBaseRemoval(items: LibraryItem[], library: LibraryItem[]) : Promise<boolean>` (true at once when no library preset names any of them; else the modal); `<BaseSceneConfirm />` on the existing modal shell (`ErrorModal.tsx`'s `.modal-backdrop` / `.modal` / `.modal-actions`, `useFadeOff`).

- [ ] **Step 1: Write the failing probe cells**
  - `lib:preset:props` — a preset's sidebar lists the base's properties with the preset's values as defaults; a tweak marks it overridden; Reset returns to the preset's value
  - `lib:preset:uses` — "Uses: <base title>" focuses the base's card
  - `lib:preset:needsBase` / `lib:preset:needsBaseOff` — base missing: the card greyed with its reason (status icon, `title` = the reason), a click doesn't play and the status bar says why; the sidebar's notice (the crash notice's `.side-crash` block) with "Download it again" → `/download` of the base's id, as a one-off only when the preset is the library's own copy and `/workshop/one-off` has a route; the notice leaves when the base lands; motion on/off, `no-glow`, `bg-live`
  - `lib:preset:legacy` — legacy engine: every preset greyed with "Presets play only in the Liascape player"; back to liascape-player → playable without a reload
  - `lib:presets:scene` — a Library scene with a Workshop id shows "Presets" (Task 8's row) and lists its presets on the Browse tab
  - `lib:baseDelete` / `lib:baseDeleteOff` — Delete (card button, Delete key, sidebar) on a base two presets use → a dialog naming 2; Cancel deletes nothing; Delete trashes the base and both presets turn greyed; a scene no preset uses → no dialog; Delete from source of a base asks the same
- [ ] **Step 2: Run them to verify they fail** — `npm run build && npm run lint`; `bash scripts/test-ui-matrix.sh --probe probe-sidebar.js --only '^lib:(preset|presets|baseDelete)'`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces; the dialog's words in the app's voice (draft: "Delete “<title>”? 2 presets in your library use this scene. They stay, greyed out, until you download it again." — Delete / Keep it).
- [ ] **Step 4: Run them to verify they pass**, then `bash scripts/test-ui-matrix.sh --changed`; look at the screenshots. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Show Presets And Their Base Scene In The Library"`

---

### Task 10: Finish — docs, the to-do, the spec and this plan

**Files:**
- Modify: `docs/decisions.md` § Library, `README.md:24`, `docs/README-next.md:28`, `docs/TODO.md` (delete #108)
- Delete: `docs/superpowers/specs/2026-11-20-preset-wallpapers-design.md`, `docs/superpowers/plans/2026-11-20-preset-wallpapers.md`

- [ ] **Step 1: Move the still-true facts home** — read the spec once more; anything true and not yet in a rule or doc goes to its home per `.claude/rules/writing-rules.md` § Where a new fact goes (nothing about who decided what or when).
- [ ] **Step 2: decisions.md** — `### Play a preset as its own item over its base scene's folder (2026-11-20)`: the choice; copying the scene into each preset ruled out (hundreds of MB, stale when the base updates, fights the overrides); presets as their own cards so several of one scene share a playlist; enforced by `.claude/rules/backend/library.md` § Presets and the adapter IT § presets.
- [ ] **Step 3: READMEs** — replace the "web, application and preset wallpapers don't play" line: web and application wallpapers don't play; presets play over their base scene in the Liascape player (Browse's Type filter, a scene's Presets).
- [ ] **Step 4: Delete** #108 from `docs/TODO.md`, the spec and this plan.
- [ ] **Step 5: Verify** — `bash scripts/check-rules.sh` (no dead citation of the spec or plan); the full `bash scripts/test-ui-matrix.sh`; `bash scripts/test-presets.sh`; `bash scripts/test-steam-signin.sh`; `bash scripts/test-workshop-social.sh`; the adapter IT; the player suite. Expected: all green.
- [ ] **Step 6: Commit** — `git commit -m "Finish Preset Wallpapers"`
