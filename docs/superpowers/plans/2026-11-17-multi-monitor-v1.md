# Multi-monitor v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under liascape-player, every screen either follows All or runs its own wallpaper / playlist, picked from a top-bar screen carousel, remembered across replugs and restarts, with per-screen settings, `--screen` on the CLI and the status line moved out of the top bar.

**Architecture:** The player learns output groups: `out:<c>.group` (`all` or a screen id) and `out:<c>.enabled`, an `outs:<group>` alias, and programs that run on an alias whose members change live (one `prog:main` on `outs:all`, one `prog:<screen id>` on `outs:<screen id>` per own screen). The backend keeps per-screen setups in a new `screens.json`, matches the player's outputs to them (make + model + serial / connector), sets each output's group, and targets every switch, program and resolver pass at a group. The UI mirrors `/screens`, and its carousel selection decides where Library clicks and the playlist bar act.

**Tech Stack:** Rust (liascape-player crate, `tests/api.rs`, `tests/program.rs`), C# .NET backend (self-test, adapter IT), React + zustand UI (Electron probes on the hermetic UI-matrix stack, which runs two headless outputs `VIRTUAL-1` 640x360 and `VIRTUAL-2` 320x180).

**Spec:** `docs/superpowers/specs/2026-11-17-multi-monitor-design.md`

**Scope: v1 only.** Deferred to later plans (each keeps a line in `docs/TODO.md`, Task 13): span ("Show as one picture across the screens"); the sortable sound priority list (v1: "First screen" or "All screens"); per-wallpaper-per-screen settings scope (v1: a wallpaper's own values apply on every screen); keybinds on "the focused screen" (and `--screen focused`); per-screen scene FPS (v1: one global "Scene frame rate" for liascape-player, Task 8).

## Global Constraints

- liascape-player only. Legacy keeps Settings' "Scene monitors" and plays the same wallpaper everywhere; a `screen` other than `all` under legacy answers 409 `"Per-screen wallpapers need the liascape-player engine"`.
- Defaults: every screen follows All ("same wallpaper on each screen, each shown whole"); keybind reach = All screens; carousel selection = All.
- The most recent action wins: Apply / Play on a screen → that screen becomes own, others unchanged; Apply / Play on All → every screen rejoins All. No undo.
- Specificity wins, nothing multiplies: the wallpaper's own value > the screen's > the global, for volume, speed, fit and FPS cap. All live (`CLAUDE.md` § Hard rules).
- Followers share one source (one decoder, in sync), so a follower's volume / mute / speed / FPS cap are All's (owner-confirmed 2026-11-18) (= the global settings); only an own screen has its own. Fit is per screen for followers too (a layer prop).
- While any follower has scenes off, All plays no scenes: All's rotation skips them and a scene applied on All is refused with `"<name> doesn't allow scenes"`; on an own screen with scenes off, scenes are refused with the same words.
- Screens are remembered by make + model + connector, and by serial where one is reported; a new screen is used at once, following All; an unplugged screen's setup is kept.
- Arranging screens changes only Liascape's view (carousel order, the All preview); never the compositor's layout.
- At least one screen stays in use: "Don't use this screen" on the last used, connected screen is refused (400 / disabled switch with `"<name> is the last screen in use"`).
- No item context menus; a plain click applies (to the carousel's selection), right-click opens the sidebar (`docs/decisions.md`).
- Every UI element: the checklist at the top of `.claude/rules/ui/design.md` (theme vars, glow / `no-glow`, motion / `no-motion` via `useMotion` / `useLinger`, `--tr` fills and `bg-live`, themed controls: `Segmented`, `Select`, `NumInput`, `MuteButton`, lucide icons) and a probe cell for motion on/off, `no-glow` and `bg-live`.
- Tests hermetic (own HOME / XDG dirs, backend, player socket, audio); heavy runs through `scripts/test-lock.sh`; never touch the owner's app, player, settings or library.
- State files written field-level and atomically (`AtomicFile`, `FileLock`); pre-release: formats change freely, no migration code.
- Code comments say why, never history; a changed user-facing string greps `app/shell/probe-*.js` and `scripts/test-*.sh` first.
- Commits: short title-case subject, body with the story; trailers `Claude-Agent: <model id>, effort <…>, <role>` and the session's `Co-Authored-By` / `Claude-Session` lines.

## Review Focus

1. Two monitors of the same make + model without serials (`Match` gets equal make/model): each keeps the setup of its own connector; never both matched to one setup, never a setup stolen by the second. → Task 4 `ScreenIdentityAssertions` "two of one model".
2. The selected screen unplugged while its popover is open: the popover closes, the carousel moves to All, no request names the gone screen. → Task 13 `screens:pop:unplugged`.
3. A screen leaving All (made own) while All's effect is running on it: the output drops out of the effect, no frame composes a hole on either screen. → Task 3 `leaving_a_group_mid_effect_drops_the_output`.
4. A compositor crash with two programs running: both come back on their own outputs, the groups survive, the backend's reconnect re-asserts nothing that differs. → Task 7 IT "crash with two programs".
5. A page loaded (or reconnected) while an own screen plays: the playing ring of each selection comes from `/current.screens`, not only from events. → Task 11 `screens:ring:reload`.

## File structure

Player (`src/player/`):
- `src/headless.rs` — `OutputInfo` gains identity + position; headless outputs take them.
- `src/wl.rs` — `info_of` fills identity + position; the layer surface follows `enabled`.
- `src/graph/props.rs`, `src/graph/mod.rs` — output props `make model description x y` (read-only), `group enabled` (settable); alias `outs:<group>`.
- `src/runtime.rs` — identity-checked remembered props, group-aware adoption, `output_membership_changed`, per-program set state.
- `src/recipes/transition.rs` — `resolve_outputs` skips outputs out of use.
- `src/recipes/program/mod.rs` — `SetState`, hold on an empty set, `rejoin`.
- `src/api/handlers.rs` — `state.outputs` fields, `headless.add_output` identity args, the membership hook after `set`.

Backend (`src/backend/`):
- `Models/ScreenSetup.cs` (new) — `ScreenSetup`, `ScreensFile`.
- `Helpers/ScreensService.cs` (new) — `screens.json` load / field-level update.
- `Player/ScreenIdentity.cs` (new) — pure matching and serial parsing.
- `Player/LiascapePlayerScreens.cs` (new) — discovery, groups, per-screen layer/output props, `screens-changed`.
- `Player/PlayerProgram.cs` (new, from `LiascapePlayerProgram.cs`) — one instance per program; `LiascapePlayerProgram` becomes a facade over `PlayerProgram.All`.
- `Player/LiascapePlayerMedia.cs` — switches and intents per target; resolver screen level.
- `Web/ScreenOps.cs` (new) — most-recent-wins, per-target apply / play / next, `ScreenTarget.Resolve`.
- `Web/ServerHost.cs`, `Web/AppOps.cs`, `Web/ActionForward.cs`, `Program.cs`, `Helpers/PlaylistService.cs`, `Helpers/MonitorDetector.cs`, `Models/AppSettings.cs`.

UI (`app/ui/src/`):
- `api/client.ts`, `store/index.ts` — screens slice, selection, per-target playing, notices.
- `components/ScreenCarousel.tsx` (new), `components/ScreenPopover.tsx` (new), `components/ScreenMap.tsx` (new, the arrangement drag), `components/Notice.tsx` (new, feedback beside its control), `components/BarStatus.tsx` (new, from `TopbarStatus.tsx`).
- `App.tsx`, `components/PlaylistBar.tsx`, `views/Settings.tsx`, `components/Card.tsx`, `components/BrowseSide.tsx`, `views/Browse.tsx`, `components/SteamModal.tsx`, `components/SteamTodoPanel.tsx`, `index.css`.
- Tests: `app/shell/probe-screens.js` (new), `app/shell/player-ctl.js` (new, the ctl client moved out of `probe-matrix.js`), `app/shell/probe-libops.js`, `scripts/matrix-cells-for.sh`.

---

### Task 1: Output identity, groups and the `outs:` alias (player)

**Files:**
- Modify: `src/player/src/headless.rs` (`OutputInfo`, `Headless::add`, `Headless::set_position`)
- Modify: `src/player/src/wl.rs` (`info_of`)
- Modify: `src/player/src/graph/props.rs` (Output props), `src/player/src/graph/mod.rs` (`Graph::resolve`)
- Modify: `src/player/src/runtime.rs` (`output_added`, `output_changed`, `output_removed`'s `out_props` insert)
- Modify: `src/player/src/api/handlers.rs` (`state`, `add_output`)
- Modify: `docs/player/modules/graph-properties.md` § Aliases, `docs/player/modules/command-api.md` (`headless.add_output` args), `.claude/rules/player/runtime-api.md` § Outputs, hotplug, parking
- Test: `src/player/tests/api.rs`

**Interfaces:**
- Produces: `OutputInfo { name, width, height, hz, refresh_mhz, make: String, model: String, description: String, x: i32, y: i32 }`.
- Produces: output node props `make`, `model`, `description` (Str, read-only), `x`, `y` (I64, read-only, the compositor's logical position), `group` (Str, settable, default `"all"`), `enabled` (Bool, settable, default `true`).
- Produces: alias `outs:<group>` = every Output node with `enabled == true` and `group == <group>`, sorted by id; matching nothing is a broadcast alias (type-checked, `targets: []`).
- Produces: `state.outputs[] = {name, width, height, hz, refresh_mhz, make, model, description, x, y, group, enabled}`; `headless.add_output` takes optional `make`, `model`, `description` (default `""`).
- Produces: remembered `out:` props are re-applied on replug only when the returning output's `make` + `model` equal the remembered ones (a different monitor on the connector starts at the defaults).

- [ ] **Step 1: Write the failing tests** in `src/player/tests/api.rs`:
  - `outs_alias_resolves_enabled_outputs_by_group`: `set out:VIRTUAL-2.group "s1"`; `set outs:all.scene_fps 30` → `targets == ["out:VIRTUAL-1"]`; `set outs:s1.scene_fps 20` → `["out:VIRTUAL-2"]`; `set out:VIRTUAL-2.enabled false`; `set outs:s1.scene_fps 20` → ok, `targets == []`; `set outs:nope.scene_fps 1` → ok, `targets == []`; `set outs:all.scene_fps "x"` → `bad_type`.
  - `state_outputs_carry_identity_and_position`: `headless.add_output {name:"VIRTUAL-3", width:320, height:180, make:"Acme", model:"X1", description:"Acme X1 SN42 (VIRTUAL-3)", x:2000, y:0}` → its `state.outputs` entry has `make "Acme"`, `model "X1"`, `description "Acme X1 SN42 (VIRTUAL-3)"`, `x 2000`, `y 0`, `group "all"`, `enabled true`; `get out:VIRTUAL-3.make == "Acme"`; `set out:VIRTUAL-3.make "B"` → `read_only`.
  - `remembered_output_props_need_the_same_monitor`: VIRTUAL-3 (Acme X1) `group "s1"` → `headless.remove_output` → re-add with Acme X1 → `get out:VIRTUAL-3.group == "s1"`; remove → re-add with `model "Y2"` → `"all"`.
- [ ] **Step 2: Run them, expect FAIL** — `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo test -q --manifest-path src/player/Cargo.toml --test api outs_alias state_outputs_carry remembered_output_props` → unknown prop / alias errors.
- [ ] **Step 3: Implement.** `info_of` reads smithay's `OutputInfo` `make`, `model`, `description.unwrap_or_default()`, position `logical_position.unwrap_or(location)`; headless keeps `pos` in `info.x/y` and pushes `OutputChange::Changed` on `set_position`. `output_added` writes the five read-only props with `set_observed`; `output_changed` updates `x`/`y`/size. `out_props` entries carry the `make`/`model` they were saved with (a small struct beside the props), checked in `output_added`; the snapshot's `remembered` carries them too (a format change, no migration). `resolve("outs:<g>")` filters on the two props.
- [ ] **Step 4: Run them, expect PASS**; then the whole suite: `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo test -q --manifest-path src/player/Cargo.toml` (`tests/supervise.rs::output_props_survive_replug` must stay green: same monitor).
- [ ] **Step 5: Docs** — the alias and the two props in `graph-properties.md`; the `headless.add_output` args in `command-api.md`; the identity check in `runtime-api.md` § Outputs. `bash scripts/check-rules.sh` clean.
- [ ] **Step 6: Commit** `Add Output Groups And Identity` (the files above).

### Task 2: "Don't use this screen" — `out:<c>.enabled` (player)

**Files:**
- Modify: `src/player/src/runtime.rs` (new `output_membership_changed`; factor the retire half of `output_removed` into `release_output`)
- Modify: `src/player/src/recipes/transition.rs` (`resolve_outputs`)
- Modify: `src/player/src/headless.rs` (`OutputBackend::set_shown`, the trait and `Headless`), `src/player/src/wl.rs` (`set_shown`)
- Modify: `src/player/src/api/handlers.rs` (`set` / `set_json`: the hook)
- Modify: `docs/player/modules/runtime.md` § Outputs, hotplug and parking, `.claude/rules/player/runtime-api.md` § Outputs
- Test: `src/player/tests/api.rs`

**Interfaces:**
- Consumes: Task 1's `enabled` / `group` props.
- Produces: `Runtime::output_membership_changed(&mut self, connector: &str, was: (bool /*enabled*/, String /*group*/))` — called by `handlers.rs` after a successful `set`/`set_json` whose resolved targets include an Output and whose prop is `group` or `enabled` (once per changed output). Task 3 extends its group half.
- Produces: `OutputBackend::set_shown(&mut self, gfx: &Gfx, name: &str, shown: bool)`: Wayland destroys the output's layer surface (the compositor's own background shows) and makes a new one on `true`; Headless stops composing it and clears its texture to transparent.
- Produces: `resolve_outputs` drops outputs with `enabled == false`; a request whose alias resolves only to such outputs → `unsupported` "`outputs <alias>` names only outputs out of use (enabled false)", hint `ctl state` lists `enabled`.
- Produces: event `output.enabled {output, enabled}`; `set out:<c>.enabled false` on the last enabled output → `unsupported`, message "at least one output stays in use", nothing changed.

- [ ] **Step 1: Write the failing tests** (`tests/api.rs`):
  - `disabled_output_shows_nothing_and_is_never_a_target`: transition a 2 s clip on `out:*`, tick to handoff; `set out:VIRTUAL-2.enabled false` → `get lay:VIRTUAL-2:main.content == ""`; `capture {target:"out:VIRTUAL-2"}` → every pixel alpha 0; a new `transition {outputs:"out:*"}` → its `transition.scheduled.outputs == ["out:VIRTUAL-1"]`; `transition {outputs:"out:VIRTUAL-2"}` → `unsupported`; an `output.enabled` event with `enabled:false`.
  - `reenabled_output_shows_what_its_group_shows`: then `set … enabled true` → `get lay:VIRTUAL-2:main.content == get lay:VIRTUAL-1:main.content` (the same source id, no new source created).
  - `the_last_output_in_use_cannot_be_disabled`: disable VIRTUAL-2, then VIRTUAL-1 → `unsupported`; `get out:VIRTUAL-1.enabled == true`.
  - `disabling_an_output_retires_what_only_it_showed`: own source on VIRTUAL-2 only (transition `out:VIRTUAL-2`) → disable → `source.retire` for it, `destroy` after its 30 ms ramp (the `destroy_ramps_audible_source_out` pattern).
- [ ] **Step 2: Run them, expect FAIL** (`--test api disabled_output reenabled_output the_last_output disabling_an_output`).
- [ ] **Step 3: Implement** as in Interfaces; on `false`: `Transitions::drop_output`, clear the layer's content, `release_output`, `set_shown(false)`; on `true`: `set_shown(true)` and adopt like `output_added` (the first enabled peer's live transition via `adopt_output`, else its `cur:`). Keep handlers changing only graph/recipe state (the runtime rule): the hook runs inside the request, its source effects land in the iteration's `sync_sources`.
- [ ] **Step 4: Run them, expect PASS**, then the full player suite (as Task 1 Step 4). The Wayland half (`wl.rs set_shown`) has no hermetic test (the agent window's gamescope has no layer-shell): say so in the commit body; the owner checks "Don't use this screen" on the session once Task 13 lands.
- [ ] **Step 5: Docs** — `enabled` in `runtime.md` § Outputs and the runtime-api rule. `bash scripts/check-rules.sh`.
- [ ] **Step 6: Commit** `Let An Output Go Out Of Use`.

### Task 3: Programs on an output group; group-aware hotplug and regroup (player)

**Files:**
- Modify: `src/player/src/runtime.rs` (`output_added`, `output_membership_changed`'s group half, `tick_programs`, `current_wallpaper` → `current_in_group`)
- Modify: `src/player/src/recipes/program/mod.rs` (`Programs::tick`, `Prog::tick`, `Reason`, new `Programs::rejoin`)
- Modify: `docs/player/modules/programs.md` (§ The engine, § Parked), `.claude/rules/player/runtime-api.md` § Programs
- Test: `src/player/tests/program.rs`, `src/player/tests/api.rs`

**Interfaces:**
- Consumes: Task 1 alias, Task 2 hook.
- Produces: `pub enum SetState { Shown, Empty, Parked { owner: bool } }` in `recipes/program/mod.rs`; `Programs::tick(&mut self, g, tr_events, src_events, now, set_state: &dyn Fn(&ProgCfg, Option<&str> /*cur_src*/) -> SetState, active, held, defaults_of)` replaces the `parked: bool` argument. The runtime's closure: no output at all → `Parked { owner: cur_src == runtime.parked id }`; `g.resolve(cfg.outputs)` empty → `Empty`; else `Shown`.
- Produces: `Empty` = both clocks and every rule stop (whatever `while_parked`), phase `parked`, never `transition_parked`. `Parked { owner: false }` = the same hold; `Parked { owner: true }` = today's `while_parked` behaviour.
- Produces: `Programs::rejoin(&mut self, outputs_alias: &str, g: &Graph) -> Vec<ProgramAction>` — the program whose `outputs == outputs_alias`, started, with a current path and no pending step → one `Start` (`align: now`, cut, reason `Reason::Rejoin` = `"rejoin"`) of its current item on its set; nothing otherwise.
- Produces: `output_added` and a group change adopt from a same-group enabled peer only (its live transition, else its `cur:`), else `Programs::rejoin("outs:<group>")`, else (unchanged) the parked rule. A group change also drops the output from a live transition whose other outputs are all in its old group (`drop_output`) and `release_output`s what only it showed (ramped).

- [ ] **Step 1: Write the failing tests** (`tests/program.rs`, stepped clock; both outputs start in `all`):
  - `two_programs_rotate_their_own_output_sets`: `set out:VIRTUAL-2.group "s1"`; `prog:main` `outputs:"outs:all"` items [a, b] `mode timer interval_ms 1000`; `prog:s1` `outputs:"outs:s1"` items [c, d] `interval_ms 1500`; step 3100 ms → every `transition.scheduled` with `origin "program:prog:main"` has `outputs ["out:VIRTUAL-1"]`, with `"program:prog:s1"` `["out:VIRTUAL-2"]`; `program.current` counts 4 (main) and 3 (s1, the first + 2).
  - `a_program_whose_set_empties_holds_and_rejoins`: as above at s1 = c; `set out:VIRTUAL-2.group "all"` → `lay:VIRTUAL-2:main.content` == VIRTUAL-1's content; `prog:s1.phase == "parked"`, `remaining_ms` unchanged over 2000 ms; `set … group "s1"` → the next `program.current` of prog:s1 has `reason "rejoin"`, path c, outputs `["out:VIRTUAL-2"]`.
  - `leaving_a_group_mid_effect_drops_the_output` (Review Focus 3): prog:main with an 800 ms effect (`fade(800)`), mid-effect `set out:VIRTUAL-2.group "s1"` → the transition's `outputs == ["out:VIRTUAL-1"]` (`ctl state` transitions), `Composer::last_missing` empty on both outputs every step until handoff (`switches_never_compose_a_hole`'s probe read).
  - `joining_a_group_mid_effect_joins_the_effect`: VIRTUAL-2 in s1 showing c, prog:main effect running → `group "all"` → a `transition.output_adopted {output:"out:VIRTUAL-2"}`; at handoff both layers show main's B.
  - `parked_with_two_programs_only_the_parked_owner_rotates`: both programs running, remove both outputs, `while_parked rotate` on both → prog:main (owner of the parked wallpaper: it was VIRTUAL-1's, the first output) switches after `PARKED_MIN_PLAY_MS`, prog:s1's `remaining_ms` stays.
  - `hotplug_into_a_group_without_a_peer_rejoins_its_program` (`tests/api.rs`, real clock): VIRTUAL-1 → `s1`, VIRTUAL-2 → `s2`, `prog:main` on `outs:all` holds (`phase parked`); `headless.add_output VIRTUAL-3` (group default `all`) → `program.current {reason:"rejoin", outputs:["out:VIRTUAL-3"]}` within `Harness::within` 3 s.
- [ ] **Step 2: Run them, expect FAIL** (`--test program two_programs a_program_whose leaving_a_group joining_a_group parked_with_two`, `--test api hotplug_into_a_group`).
- [ ] **Step 3: Implement** per Interfaces. `Prog::shown` already reads the first output of its alias (now its set). Step 3 of `Prog::tick` ("another client's switch took over") runs only under `SetState::Shown`.
- [ ] **Step 4: Run them, expect PASS**, then the full player suite (existing single-program tests use `out:*` and must not change behaviour: `out:*` still resolves every output).
- [ ] **Step 5: Docs** — `programs.md` gains "Output sets" (alias, Empty hold, rejoin, the parked owner); runtime-api.md § Programs one rule each for Empty and rejoin with their guards.
- [ ] **Step 6: Commit** `Run Programs On Output Groups`.

### Task 4: Screen setups — model, identity, `screens.json` (backend)

**Files:**
- Create: `src/backend/Models/ScreenSetup.cs`, `src/backend/Helpers/ScreensService.cs`, `src/backend/Player/ScreenIdentity.cs`
- Modify: `src/backend/Helpers/MonitorDetector.cs` (`MonitorInfo` + `Make`, `Model`, `Serial`, `[JsonIgnore]`, parsed from hyprctl / swaymsg / wlr-randr JSON)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (new `ScreenIdentityAssertions`, called from `Run`)
- Modify: `.claude/rules/backend/state-files.md` (the file list: `screens.json`, written by `ScreensService.Update` only), its `paths:` front matter (+ the two new files)

**Interfaces:**
- Produces (`Models/ScreenSetup.cs`):
  ```csharp
  public class ScreenSetup {
      public string Id { get; set; } = "";          // "s1", "s2"…: also its output group and its program `prog:<Id>`
      public string Name { get; set; } = "";        // the user's; default ScreenIdentity.DefaultName
      public string Make { get; set; } = "", Model { get; set; } = "", Serial { get; set; } = "", Connector { get; set; } = ""; // last seen
      public bool Use { get; set; } = true;         // false = "Don't use this screen"
      public bool Follow { get; set; } = true;      // follows All
      public int X { get; set; }  public int Y { get; set; }   // Liascape's arrangement (logical px)
      public bool Arranged { get; set; }            // dragged by the user: the compositor's position no longer overwrites X/Y
      public string? Fit { get; set; }              // "fill" | "fit" | null = the global VideoScale
      public int? FpsCap { get; set; }  public int? Volume { get; set; }  public double? Speed { get; set; }  // null = the global
      public bool Muted { get; set; }  public bool AllowScenes { get; set; } = true;
      public LastSession? Session { get; set; }     // what it plays while own (restore replays it)
  }
  public class ScreensFile { public List<ScreenSetup> Screens { get; set; } = []; public string Keybinds { get; set; } = "all"; /* all | picked */
      public string Sound { get; set; } = "first"; /* first | all */ public string Picked { get; set; } = "all"; public int NextId { get; set; } = 1; }
  ```
- Produces (`Helpers/ScreensService.cs`): `static string FilePath` (`~/.config/liascape/screens.json`), `static ScreensFile Load()`, `static ScreensFile Update(Action<ScreensFile> mutate)` (in-process lock + `FileLock` + `AtomicFile.WriteAllText`, returns the saved copy), `static void Normalize(ScreensFile f)` (unknown `Keybinds` → `"all"`, `Sound` → `"first"`, `Fit` not fill/fit → null, `Volume` 0–100, `Speed` 0.1–4, `FpsCap` 0–480).
- Produces (`Player/ScreenIdentity.cs`): `public sealed record SeenOutput(string Connector, string Make, string Model, string Serial, int X, int Y, int Width, int Height)`; `static ScreenSetup? Match(IReadOnlyList<ScreenSetup> known, SeenOutput seen, ISet<string> takenIds)` — a non-empty serial with the same make + model first, else make + model + connector, never an id in `takenIds`; `static string SerialFrom(string description, string make, string model, string connector)` (`"<make> <model> <serial> (<connector>)"` → serial, else ""); `static string DefaultName(SeenOutput seen, IEnumerable<string> namesInUse)` (the model, else the connector; a taken name gets `" 2"`, `" 3"`…); `static List<ScreenSetup> InOrder(IEnumerable<ScreenSetup>)` (by X, then Y, then Id: the carousel order).

- [ ] **Step 1: Write `ScreenIdentityAssertions`** (fails listed as `fails.Add(...)`):
  - serial across connectors: known `{Acme, X1, SN42, DP-1}`, seen `{HDMI-A-1, Acme, X1, SN42}` → that setup.
  - no serial: same make + model + connector → it; another connector → null (a new screen).
  - two of one model (Review Focus 1): known A `{Acme X1 "" DP-1}`, B `{Acme X1 "" DP-2}`; seen DP-2 then DP-1 with one `takenIds` set → B then A; seen DP-3 → null; seen DP-2 twice → the second null.
  - a serial seen for the first time: known `{Acme X1 "" DP-1}`, seen `{DP-1, Acme, X1, SN42}` → it.
  - `SerialFrom("Acme X1 SN42 (DP-1)", "Acme", "X1", "DP-1") == "SN42"`, `SerialFrom("Acme X1 (DP-1)", …) == ""`, `SerialFrom("", …) == ""`.
  - `DefaultName`: model `"X1"` → `"X1"`; with `"X1"` in use → `"X1 2"`; empty model → `"DP-1"`.
  - `Normalize`: `Keybinds "focused"` → `"all"`, `Volume 140` → 100, `Fit "stretch"` → null.
- [ ] **Step 2: Run, expect FAIL** — `dotnet build src/backend` (missing types).
- [ ] **Step 3: Implement** the three files and the `MonitorInfo` fields.
- [ ] **Step 4: Run, expect PASS** — `dotnet build src/backend && LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest` → `PASS`.
- [ ] **Step 5: Commit** `Add Screen Setups And Identity`.

### Task 5: Discover screens on the player and keep their groups (backend)

**Files:**
- Create: `src/backend/Player/LiascapePlayerScreens.cs`, `src/backend/Web/ScreenOps.cs` (the patch / pick half here; Tasks 6–9 extend it)
- Modify: `src/backend/Player/LiascapePlayerClient.cs` (`Topics` + `"output.added"`, `"output.removed"`, `"output.changed"`), `src/backend/Player/LiascapePlayerMedia.cs` (`Ready`: `LiascapePlayerScreens.SyncNow(client)` once per player generation, beside `AssertSceneFps`; `OnEvent` → `LiascapePlayerScreens.Sync()` on the three output events)
- Modify: `src/backend/Web/ServerHost.cs` (`GET /screens`, `POST /screens/{id}`, `POST /screens/picked`; serve start queues one `Sync`)
- Modify: `scripts/test-liascape-player-adapter.sh` (`LIASCAPE_IT_ONLY` accepts `screens`; a new section), `docs/player/adapter.md` (§ Screens), `.claude/rules/backend/player-adapter.md` (§ Targeting: groups), `.claude/rules/backend/api.md` (the `screens-changed` event)

**Interfaces:**
- Consumes: Task 1 (`state.outputs` identity, `group`, `enabled`), Task 2 (`enabled`, the last-output refusal), Task 4.
- Produces: `LiascapePlayerScreens.Sync()` (coalescible `QueueSet("screens:sync", …)` of `SyncNow`) and `SyncNow(LiascapePlayerClient client)` (on the queue's worker): read `state.outputs`; serial = `SerialFrom(description)` else `MonitorDetector`'s for the connector (cached 30 s, refreshed off the queue); match or create setups under one `ScreensService.Update` (a new one: `Id = "s" + NextId++`, `Follow = true`, `X/Y` from the compositor; a known one: `Connector`/`Serial`/size refreshed, `X/Y` only while `!Arranged`); then for each connected output `set out:<c>.group` = `Follow ? "all" : Id`, `set out:<c>.enabled` = `Use`; broadcast `screens-changed` (the whole `ScreensView`) when the view changed.
- Produces: `LiascapePlayerScreens.GroupOf(string connector) -> string` (`"all"` / an id; from the last sync) and `ConnectorsOf(string target) -> IReadOnlyList<string>`.
- Produces (`ScreenOps`): `static ScreensView View()`; `static string? Patch(string id, JsonElement body)` (this task: `name` (1–40 chars, trimmed), `use`, `x`, `y` (sets `Arranged`)); null = saved and applied, else the 400 reason; unknown id → `"no such screen"` (404); `static string? Pick(string target)` (`"all"` or a known id).
- Produces (`ScreensView`, camelCase JSON): `ScreenView(string Id, string Name, string Connector, bool Connected, bool Use, bool Follows, string Make, string Model, string Serial, int X, int Y, int Width, int Height, string? Fit, int? FpsCap, int? Volume, bool Muted, double? Speed, bool AllowScenes, string? Playing)`; `ScreensView(List<ScreenView> Screens /* InOrder, connected and not */, string Keybinds, string Sound, string Picked, string? AllPlaying, string? ScenesBlockedOnAll)`. Under legacy: `Screens = []`. `Playing` / `AllPlaying` stay null until Task 6; `ScenesBlockedOnAll` null until Task 8.
- Produces: WS `screens-changed` (payload = `ScreensView`).

- [ ] **Step 1: Write the IT section** `== screens: discovery, identity across replug, new screens follow at once, don't use` (runs alone with `LIASCAPE_IT_ONLY=screens`, after a `/apply` of p0):
  - `GET /screens` → 2 screens, connectors `VIRTUAL-1`, `VIRTUAL-2`, both `follows true`, `use true`; `screens.json` exists.
  - `ctl headless.add_output {name:"VIRTUAL-3", width:320, height:180, make:"Acme", model:"X1", description:"Acme X1 SN42 (VIRTUAL-3)"}` → within 2 s `/screens` has 3, the new one `follows true`, `serial "SN42"`, `name "X1"`; `ctl get out:VIRTUAL-3.group == "all"`; `lay:VIRTUAL-3:main.content == lay:VIRTUAL-1:main.content`.
  - `POST /screens/<its id> {name:"TV"}` → `screens.json` name "TV"; remove VIRTUAL-3, add it back as `VIRTUAL-4` with the same make / model / description → `/screens` shows `TV` on `VIRTUAL-4` with the same id, `connected true`, and 3 screens (not 4).
  - `POST /screens/<TV id> {use:false}` → `ctl get out:VIRTUAL-4.enabled == false`; then `use:false` on the other two → the second answers 400 with "is the last screen in use", `out:VIRTUAL-1.enabled` stays true. Restore `use:true` everywhere; remove VIRTUAL-4.
  - `POST /screens/nope {name:"x"}` → 404; `POST /screens/picked {id:"nope"}` → 400.
- [ ] **Step 2: Run it, expect FAIL** — `LIASCAPE_IT_ONLY=screens bash scripts/test-liascape-player-adapter.sh` (404 on `/screens`).
- [ ] **Step 3: Implement** per Interfaces (the queue rules of `.claude/rules/backend/player-adapter.md` § Threading: `Sync` runs on `LiascapePlayerMedia`'s worker, `QuickMs` calls).
- [ ] **Step 4: Run it, expect PASS**, then the whole IT (`bash scripts/test-liascape-player-adapter.sh --no-build`) — every older section still passes (both outputs follow All).
- [ ] **Step 5: Docs** — `docs/player/adapter.md` § Screens (discovery, identity, groups); the rule lines.
- [ ] **Step 6: Commit** `Discover Screens On The Player`.

### Task 6: Apply on a screen — most-recent-wins, per-target intent and what plays (backend)

**Files:**
- Modify: `src/backend/Player/LiascapePlayerMedia.cs` (`Switch`, `SwitchCore`, `SwitchAndWait`, `SwitchAndWaitHandoff`, `QueueSwitch`, `_intent`, `ReconcileShown`, `CurrentPath`, `CurrentPathOrLast`, `ShowsAnything`, `TrackIntent`, `OnEvent`'s `transition.started`)
- Modify: `src/backend/Helpers/PlayerHelper.cs` (`OnWallpaperChanged` → `Action<string?, string>`; every invoke passes `"all"`; `RestoreOnPlayer` replays own screens), `src/backend/Web/EventBus.cs` (`wallpaper-changed {path, screen}`)
- Modify: `src/backend/Web/ScreenOps.cs` (`ApplyOn`), `src/backend/Web/ServerHost.cs` (`PathReq.Screen`, `/apply`, `/current`)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`ScreenTargetAssertions`), `scripts/test-liascape-player-adapter.sh`, `docs/decisions.md` (§ "The most recent action wins: a screen made own, All brings every screen back"), `.claude/rules/backend/player-adapter.md` (§ Targeting, § Reconnection: per target), `.claude/rules/backend/api.md` (`wallpaper-changed` carries `screen`)

**Interfaces:**
- Consumes: Task 5 `GroupOf`, `ConnectorsOf`, `Sync`.
- Produces: `public static string Alias(string target) => target == "all" ? "outs:all" : "outs:" + target;` (in `LiascapePlayerScreens`), and `TargetOf(IReadOnlyList<string> outputs) -> string` (every output's group the same → it; else `"all"`).
- Produces: `LiascapePlayerMedia.Switch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd, string target = "all")` (same extra last parameter on `SwitchAndWait`, `SwitchAndWaitHandoff`, `QueueSwitch`); intents per target (`ConcurrentDictionary<string, Intent>`), `ReconcileShown` puts back each target's intent on its own outputs; `CurrentPath(string target = "all")` / `CurrentPathOrLast(string target = "all")` read `cur:` of the target's first connected output; `ShownByTarget() -> Dictionary<string, string?>`.
- Produces: `PlayerHelper.OnWallpaperChanged: Action<string?, string /*target*/>`; WS `wallpaper-changed {path, screen}` (`screen` = `"all"` or an id), from `transition.started` (target of its `outputs`) and `program.current` (Task 7).
- Produces: `ScreenOps.ApplyOn(string target, string path) -> string?` (null = done, else the 409 reason): `"all"` → every setup `Follow = true` (one `Update`), every own program ended (`PlayerProgram.For(id).End()` from Task 7; in this task: the own screen's intent forgotten), `Sync` queued, then today's `PlayerHelper.Apply` + `LastSession`; an id → refused unless connected and used (`"That screen isn't connected"`, `"That screen isn't in use"`), `Follow = false`, `Session = {Paths = [path]}`, `Sync` queued (its group becomes its id BEFORE the switch: same queue), `QueueNewSession`, `QueueSwitch(path, s, tcfg, false, id)`. Legacy: an id → the Global Constraints' 409.
- Produces: `POST /apply {path, screen?}` (absent = `"all"`); `GET /current` gains `screens: {<id>: path|null}` (own screens only) and `all: path|null`; `path` stays All's.
- Produces: `ScreensView.Playing` / `AllPlaying` filled from `ShownByTarget()`.
- Produces: `RestoreOnPlayer`: after All's decision, each connected, used own screen with a `Session` and nothing shown on its outputs → `ApplyOn(id, Session.Paths[0])` (Task 7 adds playlists).

- [ ] **Step 1: Write the tests.** Self-test `ScreenTargetAssertions`: `TargetOf(["out:VIRTUAL-2"])` with groups `{VIRTUAL-1: all, VIRTUAL-2: s2}` → `"s2"`; both outputs in `all` → `"all"`; one of each → `"all"`; `Alias("s2") == "outs:s2"`. IT section `== screens: apply on a screen (most recent wins)`:
  - `/apply {path:p0}` → both outputs show p0; `/apply {path:p1, screen:<VIRTUAL-2's id>}` → within 3 s `cur:VIRTUAL-2` path p1, `cur:VIRTUAL-1` still p0 (same source id as before), `ctl get out:VIRTUAL-2.group == <id>`, `/current.screens[<id>] == p1`, `/current.path == p0`, `/screens` that screen `follows false`.
  - `ws_listen "$T/ws-screens.log"` (move `ws_listen` up into the shared helpers block at the script's line ~300 so `LIASCAPE_IT_ONLY=screens` has it) → the log has a `wallpaper-changed` with `"path":"…p1…"` and `"screen":"<id>"`.
  - `/apply {path:p2}` (All) → both outputs p2, `/screens` every `follows true`, `out:VIRTUAL-2.group == "all"`.
  - `/apply {path:p1, screen:<id>}` then `/stop`, `ctl quit`, `liascape restore` (the IT's restore shim) → `cur:VIRTUAL-2` p1 and `cur:VIRTUAL-1` p2.
  - `/apply {path:p1, screen:"nope"}` → 409.
- [ ] **Step 2: Run, expect FAIL** (`player-selftest`; `LIASCAPE_IT_ONLY=screens bash scripts/test-liascape-player-adapter.sh`).
- [ ] **Step 3: Implement** per Interfaces; every switch site that named `out:*` takes the target's alias (`grep -n '"out:\*"' src/backend/Player/*.cs` lists them).
- [ ] **Step 4: Run, expect PASS**; whole IT and `bash scripts/test-ui-matrix.sh --changed` in the background (the matrix uses one target: All; its `apply:*`, `load:afterApply:*` and `playlistMark:*` cells guard the event shape).
- [ ] **Step 5: Docs** — the decision entry (why no undo, why All brings everyone back); the rule lines.
- [ ] **Step 6: Commit** `Apply A Wallpaper On One Screen`.

### Task 7: Per-screen playlists — one program per output set (backend)

**Files:**
- Create: `src/backend/Player/PlayerProgram.cs` (the body of `LiascapePlayerProgram.cs`, made an instance)
- Modify: `src/backend/Player/LiascapePlayerProgram.cs` (a static facade over `PlayerProgram.All`), `src/backend/Helpers/PlaylistService.cs`, `src/backend/Web/AppOps.cs` (`PlayPlaylist`, `PlayFrom`, `SavePlaylistState`), `src/backend/Web/ScreenOps.cs` (`Next`, `Prev`, `Random`; `Patch`'s `follow`), `src/backend/Web/ServerHost.cs` (`/playlist/state`, `/playlist/play`, `/playlist/play-from`, `/next`, `/prev`, `/random` take `screen`), `src/backend/Helpers/PlayerHelper.cs` (`RestoreOnPlayer`; `NextLibraryPath` extracted from `TryStepLibrary`)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`ProgramSpecAssertions`: the outputs), `scripts/test-liascape-player-adapter.sh`, `docs/player/adapter.md` § Program wiring, `.claude/rules/backend/player-adapter.md` § Program wiring

**Interfaces:**
- Consumes: Task 3 (programs on `outs:<group>`, `rejoin`), Task 6 (`Alias`, `ApplyOn`, `OnWallpaperChanged(path, target)`).
- Produces: `public sealed class PlayerProgram` with `string Id`, `string Outputs`, `string Target`; `static PlayerProgram All` (`"prog:main"`, `"outs:all"`, `"all"`); `static PlayerProgram For(string screenId)` (`"prog:" + id`, `Alias(id)`, id; cached); `static IReadOnlyList<PlayerProgram> Known`; every member `LiascapePlayerProgram` has today as an instance member of the same name and signature. `Spec` gains `string Outputs` (sent at `create`). `program.*` events route by their `id` field; `Sync` seeds every program in `state.programs`. `program.current` → `OnProgramSwitched(path, Target)`.
- Produces: `LiascapePlayerProgram`'s statics forward to `PlayerProgram.All` (no caller of it changes).
- Produces: `KeyOf(string? name, string target)` → `name:<n>` for a saved name, `bar` (All) / `bar:<id>` (a screen's bar).
- Produces: `PlaylistService.StatePath(string target)` (`playlist_state.json` / `playlist_state.<id>.json`, same folder), `LoadState(string target)`, `SaveState(string target, CustomPlaylist p)`; `LoadCurrentState()` / `SaveCurrentState(p)` = the `"all"` ones.
- Produces: `AppOps.PlayPlaylist(List<string> paths, PlaylistSettings ps, PlaylistSettings? persist = null, List<string>? persistPaths = null, int? playFrom = null, string target = "all")`, `PlayFrom(paths, startIndex, ps, string target = "all")`, `SavePlaylistState(CustomPlaylist p, string target = "all")`: `"all"` = today plus most-recent-wins (every screen follows, own programs ended, `Sync`); an id = `Follow = false`, `Sync`, `SaveState(id, …)`, `PlayerProgram.For(id).Load(spec)`, `Session = {IsTimedPlaylist = true, …}`.
- Produces: `ScreenOps.Next(string target)` / `Prev` / `Random`: `"all"` → `prog:main`'s verb when a follower is connected, plus each connected own screen's (its program's verb, or for a single wallpaper `ApplyOn(id, NextLibraryPath(current, forward))`); an id → that screen's only.
- Produces: `ScreenOps.Patch(id, {follow: true})` → `Follow = true`, its program ended, `Sync` (the player shares a peer's picture or rejoins All's program: Task 3); `follow: false` → 400 `"A screen gets its own wallpaper by applying or playing on it"`.
- Produces: HTTP `GET /playlist/state?screen=`, `POST /playlist/state?screen=`, `POST /playlist/play|play-from {…, screen?}`, `POST /next|prev|random {screen?}` (absent = `"all"`).

- [ ] **Step 1: Write the IT section** `== screens: a playlist per screen`:
  - `POST /playlist/play {paths:[p1,p2], settings:{overrideGlobalSettings:true, switchWhenVideoEnds:false, intervalSeconds:2}, screen:<id2>}` → `ctl get prog:<id2>.outputs == "outs:<id2>"`; over 5 s `prog:<id2>` commits ≥ 2 times while `cur:VIRTUAL-1`'s source id never changes; `GET /playlist/state?screen=<id2>` has `[p1,p2]`; `GET /playlist/state` (All's) unchanged.
  - `POST /next {screen:<id2>}` → only prog:<id2> moves; `POST /next` (All, VIRTUAL-1 follows with a single wallpaper) → VIRTUAL-1 steps the library AND prog:<id2> moves.
  - Crash with two programs (Review Focus 4): `/playlist/play` [p0,p3] on All too; `kill -9` the compositor → within 10 s both `prog:main` (`outs:all`) and `prog:<id2>` exist, `out:VIRTUAL-2.group == <id2>`, and `adapter.log` shows no `set out:…group` after the reconnect (nothing differed).
  - `POST /screens/<id2> {follow:true}` while it runs its own → `prog:<id2>` gone, `lay:VIRTUAL-2:main.content == lay:VIRTUAL-1:main.content`; play it on <id2> again.
  - `POST /playlist/play` on All → `prog:<id2>` gone, `out:VIRTUAL-2.group == "all"`, both outputs show prog:main's item.
  - `/stop` + restore with s2 own on its playlist → `prog:<id2>` back.
- [ ] **Step 2: Run, expect FAIL** (`LIASCAPE_IT_ONLY=screens …`).
- [ ] **Step 3: Implement.** Move first, behaviour second: commit-ready mechanical move of the statics into `PlayerProgram` checked by `dotnet build` + the whole IT before adding the screen paths.
- [ ] **Step 4: Run, expect PASS**; whole IT; `player-selftest`; the matrix `--changed` in the background (its program cells are the guard for the facade).
- [ ] **Step 5: Docs.**
- [ ] **Step 6: Commit** `Give Each Screen Its Own Playlist` (the mechanical move may be its own commit first: `Make The Player Program An Instance`).

### Task 8: Per-screen settings live, the sound rule, scenes allowed, scene frame rate (backend)

**Files:**
- Modify: `src/backend/Player/LiascapePlayerMedia.cs` (`ReadLive`: connectors per source; `Req` + `ScreenId`, `ScreenGainDb`, `ScreenSpeed`; `Desired`; `ResolveNow`; `SourceProps(path, s, target)`; `DesiredGlobal(s, ScreenSetup? screen)`; `Fit` → `FitOf(connector)`; `Ready` and `ResolveNow` set each `lay:<c>:main.fit`; `AssertSceneFps` / `ApplySceneFps` read `SceneFps` under liascape-player)
- Modify: `src/backend/Player/PlayerProgram.cs` (`BuildItems` / `BuildSpec` per target: the screen's defaults, the scene block; `PushDefaults` / `PushItems` on a screen change)
- Create: `src/backend/Player/ScreenRules.cs` (pure)
- Modify: `src/backend/Web/ScreenOps.cs` (`Patch`: the setting fields; `PatchAll`; `ApplyOn` / `PlayOn` scene refusals), `src/backend/Web/ServerHost.cs` (`POST /screens/all`, `PreviewReq.Screen`, `/settings`'s `SceneFps` diff), `src/backend/Models/AppSettings.cs` (`SceneFps`)
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`ScreenLevelAssertions`), `scripts/test-liascape-player-adapter.sh`, `scripts/test-settings-merge.sh` (`sceneFps` clamps), `.claude/rules/backend/player-adapter.md` § Targeting (the screen level, `gain.screen`), `.claude/rules/backend/state-files.md` (`SceneFps` is a liascape-player prop, `SceneMonitors` legacy-only)

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces (`ScreenRules`, pure): `static ScreenSetup? LevelOf(IReadOnlyCollection<string> connectors, IReadOnlyList<ScreenSetup> screens)` — the own screen whose `Connector` is every one of `connectors`, else null (followers and mixed sources use the global); `static string? FirstConnector(IReadOnlyList<ScreenSetup> inOrder)` — the first connected, used screen's connector; `static double ScreenGainDb(IReadOnlyCollection<string> connectors, ScreenSetup? level, string sound, string? firstConnector)` = −96 when `level?.Muted`, or `sound == "first"` and `firstConnector` is not in `connectors`; else 0; `static string? ScenesBlockedOnAll(IReadOnlyList<ScreenSetup> inOrder)` = `"<Name> doesn't allow scenes"` for the first connected, used follower with `AllowScenes == false`; `static string? SceneRefusal(string target, string path, ScreensFile f)` (a scene path on All while blocked, or on an own screen with `AllowScenes == false` → its reason).
- Produces (`Desired`): `gain.user` = item transient ?? item override ?? screen transient (`Req.ScreenGainDb`, its `ScreenId`'s sources only) ?? `level.Volume` ?? global transient ?? global; `speed` likewise with `level.Speed`; `fps_cap` = `level.FpsCap ?? VideoFpsCap`; new dynamic slot `gain.screen` = `ScreenGainDb(…)`, sent as a 30 ms `animate` like `gain.mute` (always on change). Nothing multiplies: each value is the first of the chain that is set.
- Produces: `lay:<c>:main.fit` = `screen(c).Fit ?? VideoScale` per main layer (Ready, ResolveNow's Fresh pass, `LiascapePlayerScreens.Sync`); `out:<c>.scene_fps` = `SceneFps` for every connected output under liascape-player (`AppSettings.SceneFps`, int, default 15, clamped 0–480; 0 = the output's refresh, the player's own meaning).
- Produces: `POST /screens/{id}` also takes `fit` (`"fill"|"fit"|null`), `fpsCap`, `volume`, `muted`, `speed`, `allowScenes` (`null` = back to the global); `volume`/`muted`/`speed`/`fpsCap` on a follower → 400 `"<Name> follows All: its sound, speed and frame rate are All's"`. `POST /screens/all {keybinds?: "all"|"picked", sound?: "first"|"all"}`. `POST /preview {volume|speed, screen}` → a transient screen value (`QueueSet("preview-screen:<prop>:<id>", …)`). Each change runs one resolver pass (`ApplyEffective`), re-pushes the affected program's defaults / items, broadcasts `screens-changed`; `ScreensView.ScenesBlockedOnAll` is filled.
- Produces: `ScreenOps.ApplyOn` and `AppOps.PlayPlaylist` / `PlayFrom` (a target whose items are all scenes it may not play) refuse with `SceneRefusal`'s words (409); All's program items `Skip` a scene while `ScenesBlockedOnAll != null`, an own screen's while its `AllowScenes == false` (pushed live on the change; the player's `skip` lifts back as today).

- [ ] **Step 1: Write the tests.** Self-test `ScreenLevelAssertions`: `LevelOf(["VIRTUAL-2"])` with VIRTUAL-2 own → it; `["VIRTUAL-1","VIRTUAL-2"]` → null; follower → null; `Desired` for an item with override 30 on an own screen with volume 40, global 80 → `gain.user == VolumeDb(30)` (not 30 × 40 %); no override → `VolumeDb(40)`; follower → `VolumeDb(80)`; `ScreenGainDb` (first = VIRTUAL-1): `["VIRTUAL-2"], sound "first"` → −96, `"all"` → 0, `["VIRTUAL-1","VIRTUAL-2"]` → 0, muted own → −96; `ScenesBlockedOnAll` with follower `Left` scenes off → `"Left doesn't allow scenes"`, the same screen own → null. IT section `== screens: per-screen settings live`:
  - VIRTUAL-2 own on p1, `POST /screens/<id2> {volume:40}` → its source `gain.user ≈ VolumeDb(40)`, VIRTUAL-1's source at the global; `{volume:null}` → back to the global.
  - `{muted:true}` → its source `gain.screen == -96`, VIRTUAL-1's 0; `POST /screens/all {sound:"first"}` (default) with `muted:false` → VIRTUAL-2's −96 (VIRTUAL-1 is first: x 0); `{sound:"all"}` → 0.
  - `{fit:"fit"}` → `lay:VIRTUAL-2:main.fit == "fit"`, `lay:VIRTUAL-1:main.fit` the global.
  - `POST /screens/<id1> {volume:10}` (a follower) → 400.
  - `POST /screens/<id1> {allowScenes:false}`, `/apply {path:<a synthetic scene>}` → 409 with `"doesn't allow scenes"`; prog:main with a scene item → its `skip true`; `{allowScenes:true}` → `skip false`.
  - `POST /settings {sceneFps:30}` → `out:VIRTUAL-1.scene_fps == 30` and VIRTUAL-2's.
  - `POST /preview {volume:20, screen:<id2>}` → only VIRTUAL-2's source moves, nothing saved.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per Interfaces (one resolver: the screen level is one more input of `Desired`, never a second computation; `.claude/rules/backend/player-adapter.md` § Targeting).
- [ ] **Step 4: Run, expect PASS**; whole IT; `bash scripts/test-settings-merge.sh`; matrix `--changed` in the background (`set:*`, `globalDrag`, `itemVol` cells guard the resolver).
- [ ] **Step 5: Commit** `Apply Screen Settings Live`.

### Task 9: `--screen` on the CLI and the keybind reach (backend)

**Files:**
- Modify: `src/backend/Program.cs` (`Usage`, `--screen` parsing), `src/backend/Web/ActionForward.cs` (`TryForward(action, screen, …)`), `src/backend/Web/AppOps.cs` (`RunAction(action, screen, out info)`), `src/backend/Web/ServerHost.cs` (`ActionReq(string Name, string? Screen)` for `/action`), `src/backend/Web/ScreenOps.cs` (`ScreenTarget.Resolve`), `README.md`: the command list
- Modify: `src/backend/Player/LiascapePlayerSelfTest.cs` (`ScreenTargetResolveAssertions`), `scripts/test-liascape-player-adapter.sh` (the keybinds section)

**Interfaces:**
- Consumes: Task 7 `ScreenOps.Next/Prev/Random(target)`, `PlayerProgram.For(id).ToggleKeep()`.
- Produces: `static (string? Target, string? Error) ScreenTarget.Resolve(string? arg, ScreensFile f, IReadOnlyCollection<string> connectedIds)`: `arg == null` → `f.Keybinds == "picked"` ? (`f.Picked` when connected and used, else `"all"`) : `"all"`; `"all"` → `"all"`; else an id, a name (case-insensitive) or a connector of a connected, used screen; else `Error = "no screen \"<arg>\" (screens: Left (VIRTUAL-1), Right (VIRTUAL-2))"`.
- Produces: `liascape <command> [--screen <name|connector|all>]`; `--screen` works with `next`, `previous`, `random`, `toggle-loop-current`; with any other command → exit 2, `"--screen works with next, previous, random and toggle-loop-current; <command> acts on every screen"`. Under legacy any `--screen` but `all` → the Global Constraints' message. `Usage` gains the line `--screen <name|connector|all>   next / previous / random / toggle-loop-current on one screen (default: Settings → the All popover's "Keybinds act on")`.

- [ ] **Step 1: Write the tests.** Self-test: `Resolve(null)` with `Keybinds "all"` → `"all"`; `"picked"` + `Picked "s2"` → `"s2"`; `Picked` disconnected → `"all"`; `"right"` (name `Right`) → its id; `"VIRTUAL-2"` → its id; `"nope"` → the error text above. IT keybinds section (one-shot CLI processes, backend running and not, the `cli` helper the "app closed" section uses): `liascape next --screen <id2>` → only prog:<id2> commits; `liascape next --screen VIRTUAL-1` → only VIRTUAL-1's target; `liascape next --screen nope` → exit 1 and the message; `liascape toggle-pause --screen <id2>` → exit 2; `POST /screens/all {keybinds:"picked"}` + `POST /screens/picked {id:<id2>}` → bare `liascape next` moves only prog:<id2>; `{keybinds:"all"}` → both.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The flag is removed from `args` before the action words are joined; `/action` without `screen` = the reach rule (the backend resolves it, so a keybind forwarded to a running app and one run locally agree).
- [ ] **Step 4: Run, expect PASS**; whole IT.
- [ ] **Step 5: Commit** `Add --screen To The Playback Commands`.

### Task 10: The status line leaves the top bar; feedback beside what it's about (UI)

Independent of screens: the Library's now-playing / status line moves into the playlist bar's header; every other tab's message moves next to its control. Ends with the top bar's status slot gone (Task 11 fills the room).

**Files:**
- Create: `app/ui/src/components/BarStatus.tsx` (the body of `TopbarStatus.tsx`, its `Line` logic, cross-fade and toggle unchanged), `app/ui/src/components/Notice.tsx`
- Delete: `app/ui/src/components/TopbarStatus.tsx`
- Modify: `app/ui/src/components/PlaylistBar.tsx` (the head: `<BarStatus />` in place of `.spacer`, between Go to playing and Play), `app/ui/src/App.tsx` (drop the slot; the WS handlers' messages → their slots), `app/ui/src/store/index.ts` (`notices`, `notify`, `downloadFailed`), `app/ui/src/components/Card.tsx` + `BrowseSide.tsx` (a failed download's error + Retry), `app/ui/src/views/Browse.tsx` (a failed search's reason in the grid), `app/ui/src/components/SteamModal.tsx`, `SteamTodoPanel.tsx`, `views/Settings.tsx`, `app/ui/src/index.css` (`.bar-status`, `.notice`, `.card .dl-failed`; `:root.no-glow` / `no-motion` entries)
- Modify: `app/shell/probe-libops.js` (`libops:status`, `libops:toggle`, `libops:combined` read `.playlist-bar-head .status`), `app/shell/probe-filters.js` + `probe-layout.js` (`resize:*`, `search:worst:*`: the bar without the slot), `scripts/matrix-cells-for.sh` (the `TopbarStatus.tsx` line → `BarStatus.tsx`, `Notice.tsx`)
- Modify: `.claude/rules/ui/design.md` § Interaction rules (the sentence "The status slot (`TopbarStatus.tsx`) stays in the bar…" becomes: the Library's line lives in the playlist bar's head, `BarStatus.tsx`, with the same room whatever it says; other tabs' messages sit beside their control, `Notice.tsx`), `app/ui/src/hooks/useTopbarCompact.ts` (its comment's 72 px status slot)

**Interfaces:**
- Produces (store): `notices: Record<string, { text: string; key: number } | undefined>`; `notify(slot: NoticeSlot, text: string, ms = 4000): void` (`ms = 0` holds until replaced); `downloadFailed: Record<string /*pageUrl*/, string /*error*/>`. `type NoticeSlot = "browse:grid" | "steam:signin" | "steam:todo" | `settings:${string}``. `setStatus` stays: the Library's line only.
- Produces: `<Notice slot={…} />` — inline after its control, in the control's own row (`min-width: 0`, one line, ellipsis): it never adds a line, so nothing moves; it leaves with `useLinger`; appear / leave = opacity + 4 px (`no-motion`: opacity only, `FADE_MS`), text `var(--subtext1)`, `--danger` for an error, its glow in the `:root.no-glow` block.
- Call sites (each `setStatus` outside the Library goes to the slot named here; the rest stay `setStatus`):
  | message | where it goes |
  |---|---|
  | `download`'s "Applied / Downloaded / Subscribed: …", `setDownload`'s step words, "Cancelled: …", "Skipped: …" | dropped (the card and the sidebar show the step; the Library shows the result on Apply) |
  | a download that failed (`download`'s catch) | `downloadFailed[pageUrl]`: the card shows the error (2 lines) + a Retry button (`RotateCw`, the act motion), the sidebar the full error + Retry; Retry calls `download(source, w, apply)` again and clears it |
  | `reload`'s failed search (store line ~430), the sources' `off` reason (~437) | `browse:grid` (a centred line in the grid, `.grid-msg`) |
  | `steam-qr-error`, `onSignedIn`'s "Signed in to Steam" | `steam:signin` inside `SteamModal` / the Steam row |
  | `SteamTodoPanel`'s failure | `steam:todo` in the panel |
  | ws subscribe failed (App ~101), unsubscribe results / failures (`unsubStatus`, App ~119/120, store ~618–689) | Browse: the card / sidebar of the item (`downloadFailed`); Library: `setStatus` |
  | "Settings cleared — reset to defaults" | `settings:reset` beside its button |
  | "Library cleared" | `settings:clearLibrary` |
  | "Cache cleared — freed N MB (n files)", "Failed to clear cache" | `settings:cache` |
  | "Scene loudness: estimated / cancelled" (App ~132) | `settings:sceneLoudness` |
  | "Imported: …", "Import failed: …" | Library `setStatus` (Import lives on the Library's top bar) |
  | a library operation's words (`BarStatus`'s `op` line) | Library: `BarStatus` as today; Settings: a `Notice` beside the row that started it (`clips` → "Video preview quality", `video-loudness` → "Audio normalization", `scene-loudness` → the estimate button's row; `facts` only on the Library) |

- [ ] **Step 1: Rewrite the probe cells first** — `libops:*` against `.playlist-bar-head .status`; new cells in `probe-libops.js`: `notice:settings` (Clear cache in Settings → the text "Cache cleared" appears beside the button within 1 s, no `.topbar .status` element exists, the page's other rows don't move: their `getBoundingClientRect().top` unchanged ±0.5 px), `notice:browseFail` (the probe fails `/download` itself: the window's `webContents.debugger` `Fetch.enable {patterns:[{urlPattern:"*/download*"}]}` → `Fetch.fulfillRequest` 500 `{error:"boom"}` → the card shows the error and a Retry button; Retry starts it again), `notice:look` (motion on: in-between opacity frames on appear; `no-motion`: opacity-only frames, `app/shell/motion-off.js`; `no-glow`; `bg-live`), `bar:status:room` (`probe-plbar.js`: the playlist head's buttons left of the line keep their x when the line's text changes).
- [ ] **Step 2: Run, expect FAIL** — `bash scripts/test-ui-matrix.sh --probe probe-libops.js` and `--probe probe-plbar.js`.
- [ ] **Step 3: Implement** per the table.
- [ ] **Step 4: Run, expect PASS** — the two probes; `cd app/ui && npm run build && npm run lint`; `LIASCAPE_MATRIX_SCREEN=2560x1440 bash scripts/test-ui-matrix.sh --probe probe-layout.js` (`resize:*`) and `--probe probe-filters.js` (`search:*`, `split:*`); `bash scripts/test-ui-matrix.sh --changed`.
- [ ] **Step 5: Look** at the screenshots mid-fade (the `ui-verify` skill) for the bar head line and a Settings notice, motion on and off.
- [ ] **Step 6: Commit** `Move The Status Line Next To What It's About`.

### Task 11: Screens in the store and the top-bar screen carousel (UI)

**Files:**
- Create: `app/ui/src/components/ScreenCarousel.tsx`, `app/shell/probe-screens.js`, `app/shell/player-ctl.js` (`ctlClient` moved out of `probe-matrix.js`, which requires it)
- Modify: `app/ui/src/api/client.ts` (`ScreenView`, `ScreensView` types mirroring Task 5; `api.screens()`, `api.patchScreen(id, patch)`, `api.patchScreensAll(p)`, `api.pickScreen(id)`; `apply(path, screen?)`, `next/prev/random(screen?)`, `current()`'s `screens` / `all`), `app/ui/src/store/index.ts`, `app/ui/src/App.tsx` (the carousel where the slot was; WS `screens-changed`; `wallpaper-changed`'s `screen`), `app/ui/src/index.css` (`.screen-car*`)
- Modify: `scripts/matrix-cells-for.sh` (`ScreenCarousel.tsx`, `probe-screens.js`, `player-ctl.js` → `--probe probe-screens.js`), `app/ui/src/hooks/useTopbarCompact.ts` (re-measured widths: the carousel's room on the fullest bar)

**Interfaces:**
- Consumes: `GET /screens`, `screens-changed`, `wallpaper-changed {path, screen}`, `/current.screens`, `/apply {screen}`, `POST /screens/picked`.
- Produces (store): `screens: ScreensView | null` (read in `readBackend`, applied only when its read succeeded); `selected: string` (`"all"` | an id; from `screens.picked` at the first read, then the user's); `select(target: string): void` (sets it, recomputes `playingPath`, `api.pickScreen` debounced 250 ms); `playingBy: Record<string, string | null>` (`"all"` + each own screen); `setPlaying(p: string | null, screen = "all")`. `playingPath` stays and always equals `playingBy[effectiveTarget(selected)]`, where `effectiveTarget(id)` = `"all"` for a follower — so the cards' ring, the bar's ring, Go to playing and the travel-to-playing hooks follow the selection unchanged. `applyItem(path)` → `api.apply(path, selected)` (a follower selected = that screen becomes own). A selection whose screen is no longer connected or used → `select("all")` on the `screens-changed` that says so.
- Produces: `<ScreenCarousel />`: entries = `screens.screens` connected and used (already in arrangement order), then All (legacy: `screens` empty → the All chip alone); more than one → `‹ [preview + name] ›` with dots under it (one per entry, the selected one `--accent`); one → the preview + name chip alone (no arrows, dots or All). Wheel over it → previous / next (one step per notch, touchpad deltas summed to 60 px), ArrowLeft / ArrowRight while it has focus (never through `gridOwnsKey`); the ends wrap. The preview: the playing item's still (`thumb(item.thumbnail)`, nothing decodes while `!appActive`); All: the screens' tiles side by side in arrangement proportions, each its own still. The name under it; All reads "All screens" with "Left follows All · Right has its own" as its `title` (a value the short form hides). A change of entry slides the content 12 px in the step's direction + cross-fades (`no-motion`: cross-fade only); the arrows are lucide `ChevronLeft` / `ChevronRight` with the direction nudge, `aria-label` "Previous screen" / "Next screen"; the preview is a `button` (Task 13 opens the popover; here it has `aria-label` "<name> settings" and does nothing). Stop, pause and mute stay player-wide: with more than one screen the top bar's Stop reads "Stop all" (`aria-label` too).

- [ ] **Step 1: Write the probe** `probe-screens.js` (the matrix stack, two outputs; `player-ctl.js` for `headless.add_output/remove_output` and `get`):
  - `screens:car:order` — entries read `[<VIRTUAL-1's name>, <VIRTUAL-2's name>, "All screens"]`, the selected one All, 3 dots.
  - `screens:car:wheel` / `screens:car:keys` — one real wheel notch (`sendInputEvent`) moves one entry; ArrowRight with focus moves one, wraps at the end; the grid's keys don't move meanwhile.
  - `screens:car:single` — `headless.remove_output VIRTUAL-2` → a chip without arrows or dots, no All entry; add it back → three entries.
  - `screens:car:unplugged` — select VIRTUAL-2's screen, remove the output → `selected` All within 2 s.
  - `screens:apply:screen` — select VIRTUAL-2's screen, click a card (`.thumb-wrap`) → `ctl get cur:VIRTUAL-2` path = that item, `cur:VIRTUAL-1`'s source unchanged; the card has `.playing`; select All → the ring moves to All's item.
  - `screens:apply:all` — select All, click another card → both outputs show it; `/screens` every `follows true`.
  - `screens:ring:reload` (Review Focus 5) — VIRTUAL-2 own on item X, reload the page, select VIRTUAL-2 → X's card `.playing` without any `wallpaper-changed` after the reload.
  - `screens:car:look` — a step's per-frame samples pass through in-between transforms (motion on), opacity only (`no-motion`, `motion-off.js`), `no-glow` (no glow on the selected dot), `bg-live` (drop-shadow on the name); screenshots mid-slide looked at.
  - `screens:car:room` — at 1000 px and 761 px wide the top bar doesn't wrap with Undo + Stop showing (`probe-filters.js`'s `split:noWrap` measure).
- [ ] **Step 2: Run, expect FAIL** — `bash scripts/test-ui-matrix.sh --probe probe-screens.js`.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run, expect PASS**; `npm run build && npm run lint`; `bash scripts/test-ui-matrix.sh --changed` (store/App changes → FULL: run it in the background).
- [ ] **Step 5: Commit** `Add The Screen Carousel`.

### Task 12: The playlist bar follows the selection; per-screen now playing (UI)

**Files:**
- Modify: `app/ui/src/api/client.ts` (`playlistState(screen)`, `savePlaylistState(p, screen)`, `playPlaylist(…, screen)`, `playFrom(…, screen)`), `app/ui/src/store/index.ts` (`select` swaps the bar's state; `savePlaylistDebounced` and `playPlaylist` / `playFrom` / `loadNamedPlaylist` / `savePlaylistAs` act on the shown bar; `buildPlayingStatus`), `app/ui/src/components/PlaylistBar.tsx` (the head's target chip), `app/ui/src/components/BarStatus.tsx` (the per-screen line), `app/ui/src/index.css`
- Modify: `app/shell/probe-screens.js`, `app/shell/probe-plbar.js` (`bar:status:room` with two names)

**Interfaces:**
- Consumes: Task 7's endpoints; Task 11's `selected`, `playingBy`.
- Produces (store): `barTarget(): string` — the selection's own bar for an own screen, `"all"` for All and for a follower. `select` flushes a pending bar save of the old bar first (its own target captured at fire time), then loads `GET /playlist/state?screen=<barTarget>` into `playlist` / `playlistSettings` / `playlistName` (kept while `playlistBarSavePending`, as `readBackend` does). Edits save to `barTarget()`. Play / play-from send `screen: selected` (a follower selected: the backend makes it own on a copy of All's playlist — the bar then shows that screen's own copy).
- Produces: the head shows, with more than one screen, a chip after `PLAYLIST` naming whose list it is: `"All screens"`, the screen's name, or for a follower `"All screens"` with the `title` "<name> follows All". `BarStatus`'s now-playing line with more than one screen: `"<name> · <title> · <name> · <title>"` in arrangement order, one entry per connected, used screen (followers show All's title), collapsing to `"All · <title>"` while every screen follows.

- [ ] **Step 1: Probe cells** (`probe-screens.js`): `screens:bar:follows` (VIRTUAL-2 follows: select it → the bar lists All's items, the chip "All screens"); `screens:bar:own` (play the bar on VIRTUAL-2 → prog:<id2> runs, the bar lists its own copy, chip = its name; select All → All's list back, unchanged); `screens:bar:edit` (remove an item while VIRTUAL-2 is selected → only `playlist_state.<id2>.json` changes — read back through `GET /playlist/state?screen=`); `screens:bar:switchMidSave` (toggle an item, select another screen within 100 ms → the edit lands in the first bar, not the second); `screens:status:perScreen` (two own screens → the line reads `"<n1> · <t1> · <n2> · <t2>"`; Apply on All → `"All · <t>"`); `screens:bar:look` (the chip's appear / change cross-fades; motion off: opacity only; `no-glow`; `bg-live`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; build + lint; matrix `--changed` (FULL) in the background; `--probe probe-plbar.js`.
- [ ] **Step 5: Commit** `Show Each Screen's Playlist In The Bar`.

### Task 13: The per-screen popover, the arrangement, Settings' scene rows, docs (UI)

**Files:**
- Create: `app/ui/src/components/ScreenPopover.tsx`, `app/ui/src/components/ScreenMap.tsx`
- Modify: `app/ui/src/components/ScreenCarousel.tsx` (the preview opens the popover), `app/ui/src/components/LibraryCard.tsx` + `app/ui/src/views/Library.tsx` (the `blocked` scene cards), `app/ui/src/store/index.ts` (`patchScreen` with a 250 ms debounce per field, `previewScreen` for sliders), `app/ui/src/views/Settings.tsx` ("Scene monitors" only when `!liascapeActive`; a "Scene frame rate" row under liascape-player), `app/ui/src/settingsLevel.ts` (`sceneFps`: standard), `app/ui/src/store/index.ts` `SETTINGS_DEFAULTS` (`sceneFps: 15`), `app/ui/src/index.css` (`.screen-pop*`, `.screen-map*`, z-index 90 like the dropdowns)
- Modify: `app/shell/probe-screens.js`, `app/shell/probe-matrix.js` (the cell at ~3304 that sets `sceneMonitors` VIRTUAL-1 45 → the "Scene frame rate" row), `app/shell/probe-settings.js` (`levels:*` with the new row), `app/shell/probe-icons.js` (`icon:act:*` for new acting icons)
- Modify: `README.md` (multi-monitor in the feature list), `docs/TODO.md` (the "Multi-monitor management" item → what remains: span, the sound priority list, per-wallpaper-per-screen settings, "the focused screen" + `--screen focused`, per-screen scene FPS), `docs/decisions.md` (§ "A follower's sound and speed are All's: followers share one source") (dated headings, `.claude/rules/writing-rules.md` § `docs/decisions.md`); this plan file is deleted in the commit that lands Task 13 (its still-true facts moved to their homes), the spec stays while the deferred parts are open

**Interfaces:**
- Consumes: Tasks 8–12 (`POST /screens/{id}`, `/screens/all`, `/preview {screen}`, `ScreensView`).
- Produces: `<ScreenPopover target: string; anchor: DOMRect; onClose(): void />`, portalled to `<body>` inside a `display: contents` wrapper that stops click / contextmenu / pointerdown / keydown; closes on Escape, an outside click, or its screen leaving (`screens-changed` without it connected → close + `select("all")`). Rows (a screen):
  - Name — a text field, saves on Enter / blur (1–40 chars).
  - Fit — `Segmented` "Global" / "Fill" / "Fit" (`fit: null | "fill" | "fit"`).
  - Frame rate cap — `NumInput` 0–480 + a reset to Global (`fpsCap`).
  - Volume — the sidebar's volume slider + `MuteButton` (drag-preview `api.preview({volume, screen})` throttled ~90 ms, persist debounced 250 ms; `volume`, `muted`).
  - Speed — the sidebar's speed slider, same rules (`speed`).
  - Scenes on this screen — a themed checkbox `<label>` (`allowScenes`); off on a follower shows the consequence under it: "All plays no scenes while <name> follows it".
  - Playlist — `Select`: "Follow All", "Its own playlist" (its bar), then the saved names; a saved name loads it into the screen's bar and plays it there (`loadNamedPlaylist` + `playPlaylist` with `selected` = this screen); "Follow All" → `patchScreen(id, {follow: true})` (backend: `Follow = true`, its program ended, `Sync`: the player shares a peer's picture, Task 3).
  - Don't use this screen — a checkbox `<label>`; disabled with the reason as `title` when it's the last screen in use.
  - On a follower the Volume / Speed / Frame rate cap rows are disabled with `title` "<name> follows All, so its sound, speed and frame rate are All's. Give it its own wallpaper to set them here."
- Produces (the All popover): "Screens" — each screen with "Follows All" or "Has its own" and, for an own one, a "Follow All" button; "Keybinds act on" — `Segmented` "All screens" / "The screen picked in the app" (`keybinds`); "Sound from" — `Segmented` "First screen" / "All screens" (`sound`); "Arrange" — `<ScreenMap />`.
- Produces: `<ScreenMap />`: every known screen (connected first, unplugged dimmed) as a tile sized by its pixels, placed at its `x/y` scaled to fit; drag a tile (pointer events, the tile follows the pointer on `transform`), on drop it snaps flush to the nearest edge of another tile (above / below / left / right, aligned on the other axis) and `patchScreen(id, {x, y})` for the moved tile; the carousel's order follows the next `screens-changed`. Keyboard: a focused tile moves with the arrow keys to the next snap position.
- Produces: while `screens.scenesBlockedOnAll` is set and the selection plays All (All or a follower), or an own selected screen has scenes off, every scene card gets `blocked` (a `LibraryCard` prop, one string computed once in `Library.tsx`, never per card): dimmed through `--surface` opacity, its SCENE badge with a lucide `Lock`; a click puts the reason in `BarStatus` (`setStatus(reason, true)`) and sends nothing.
- Produces (Settings, liascape-player): "Scene frame rate" `NumInput` 0–480 fps (`sceneFps`, hint "the frame rate scenes render at on every screen. 0 follows each screen's refresh."), shown when "Play scenes" is on; "Scene monitors" only under legacy.

- [ ] **Step 1: Probe cells** (`probe-screens.js`): `screens:pop:open` (click the preview → the popover, its rows by label `m.row(…)`; Escape closes; focus back on the preview); `screens:pop:rename` (Enter saves → the carousel name changes, `screens.json` too); `screens:pop:volume` (an own screen: drag → its source `gain.user` moves live while dragging, VIRTUAL-1's doesn't; release → saved); `screens:pop:follower` (a follower: Volume / Speed / Frame rate cap disabled with the title); `screens:pop:followAll` (an own screen → "Follow All" → `cur:VIRTUAL-2` = VIRTUAL-1's source id within 2 s, no new source); `screens:pop:scenes` (scenes off on a follower → with All selected the scene cards have `.blocked`, a click switches nothing and the bar line says "<name> doesn't allow scenes"; select an own screen with scenes on → not blocked); `screens:pop:dontUse` (on → `out:VIRTUAL-2.enabled false`, the carousel loses the entry; on the last one the checkbox is disabled); `screens:pop:unplugged` (Review Focus 2: popover open, `headless.remove_output` → it closes, selection All, no request to the gone screen in the backend log after the removal); `screens:all:reach` / `screens:all:sound` (the two `Segmented` save `keybinds` / `sound`); `screens:map:drag` (drag VIRTUAL-2's tile to the left of VIRTUAL-1's → it snaps flush, `/screens` x/y saved, the carousel lists it first; the compositor's layout untouched: `ctl state` outputs' `x` unchanged); `screens:pop:look` (appear 8 px + fade, leave mounted `FADE_EXIT_MS` via `useLinger`; motion off: opacity only; `no-glow`; `bg-live`; the slider rows' rhythm matches the sidebar's: probe-sidebar's `look:sideRhythm` measure); `settings:sceneFps` (`probe-settings.js`: the row sets `out:*.scene_fps`; "Scene monitors" absent under liascape-player).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — reuse first: the sidebar's sliders and `MuteButton` (a control used in a second place becomes one shared component: lift the sidebar's volume / speed slider row into `components/` if it isn't), `Segmented`, `Select`, `NumInput`, `OrderList` is not needed (no sortable list in v1).
- [ ] **Step 4: Run, expect PASS**; build + lint; the full UI matrix (`bash scripts/test-ui-matrix.sh`, background); `bash scripts/check-rules.sh`.
- [ ] **Step 5: Look** at mid-animation screenshots of the popover, the map drag and the carousel step, motion on and off.
- [ ] **Step 6: Commit** `Add The Screen Settings Popover`.

---

## Modes to verify together (CLAUDE.md § Features compose)

After Task 13, each combination below is a cell or an IT step somewhere above; check the list against the run before the merge:
screens {one, two following, one own, both own, one out of use} × {single wallpaper, timed playlist, advance-on-end playlist} × {transitions off, an effect} × {paused, playing, no output} × {apply on a screen, apply on All, Follow All, replug, compositor crash, backend restart, app closed + keybind}. The cover hold, auto-mute and normalization act on every source whatever its screen (no screen logic in them); per-item overrides beat the screen level everywhere (Task 8).
