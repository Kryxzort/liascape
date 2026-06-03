# Performance / FPS Notes

Living log of UI performance findings + fixes. **Read before touching scroll/render perf — don't re-derive.**

## Hard ceiling: 60 FPS (not fixable from app code)

- Avalonia's **X11 backend hard-codes the render loop to 60 FPS** (`new SleepLoopRenderTimer(60)` → `RenderLoop.FromTimer`, bound during platform init). The whole UI presents at 60 max on Linux/X11/XWayland (Hyprland), regardless of a 240Hz monitor.
- **Not vsync** (`vblank_mode=0` → still 60) and **not app slowness** (frametimes 2–16ms, far under budget). It's the render clock itself.
- The `ServerCompositor` captures the render loop **during platform init, before any app hook** (`AfterPlatformServicesSetup` etc.). Re-binding `IRenderLoop`/`IRenderTimer` from app code (even via reflection into the internal `AvaloniaLocator.CurrentMutable`) binds successfully but is **inert** — the live compositor already holds the 60 loop. Confirmed dead-end; reverted.
- Known upstream issue: AvaloniaUI/Avalonia#20350 ("Framerate is capped at 60 FPS on X11"). Renderer-agnostic (Glx/Egl/Vulkan/Software all 60).
- **Conclusion: target a rock-solid 60, not 240.** 240 would need a fork of Avalonia.X11 or a different backend (native Wayland/Vulkan) — out of scope.

## Library tab (same engine as Browse; gif gating was the big win)

Measured with a 1030-file / 147-gif library (debug bridge now tab-aware — `tab 1` then `metrics`/`autoscroll` target `LibraryScrollViewer`):

- **Catastrophe (fixed):** Library force-activated **every** gif card — `OnTabChanged` looped *all* `LibraryWallpapers` (not realized), and startup + the AutoPlayGifs toggle did the same. Result: ~147 gifs decoding at once, even off-screen and even while on the Browse tab → **18fps idle / 11fps scroll, 1.3→3.3GB ws**. Fix: mirror Browse — track realized containers (`_realizedLib` via ElementPrepared/Clearing) and animate only those; deactivate the *other* tab's realized gifs on tab switch so nothing decodes in the background. → **idle/Medium/Large back to 60**, activeGif 147→~viewport.
- **Local gifs must load off-thread too.** Library gifs are local files; the old path handed the control an `AnimatedImageSourceStream`, so the lib parsed (allocated frame buffers) **on the UI thread** as each card realized → scroll stutter. Unified onto the remote off-thread path (`GetGifBytesAsync`: remote cache OR async file read → `GifRendererBuilder` off-thread). 
- **Activation must be settle-debounced** (like Browse `ScheduleGifReconcile`, 160ms). Activating in `ElementPrepared` immediately lit every card a fast scroll flew past (~74 concurrent). Debounced: during motion `activeGif`→~0, gifs re-light only when scrolling stops. Settle timer is tab-aware (`ReconcileLibraryGifs` vs `ReconcileBrowseGifs`).
- **Reset the gif debounce on scroll, not just on realization.** Library had no `ScrollChanged` hook, so the 160ms settle-timer only reset when a card realized; a *slow* scroll left >160ms gaps and the timer fired mid-scroll, lighting 15-27 gifs while moving (extra GC + memory). Added `LibraryScrollViewer.ScrollChanged += ScheduleGifReconcile` (like Browse) → `activeGif=0` through the whole scroll, gen0 +146→+8 over a 12s scroll, ws 2.5→2.0GB.
- **Hover-gate the overlay chrome.** The Library card's delete button (`MaterialIcon`) and hover-outline `Border` were composited for *every* card every frame at rest. Bound their `IsVisible` to a per-card `IsHovered` (set from `OnCardPointerEntered/Exited`) so they're only in the tree while hovered. (Playlist-toggle checkbox stays always-visible per product.) **Medium idle 50→62fps, 1%-low 24→60.**
- **Decode thumbnails to card size.** Library thumbs are ~1024-1388px shown in ~280-360px cards → GPU sampled a 1MP+ bitmap per card per frame. `BoundedRamImageLoader.DecodeWidth=512` (`Bitmap.DecodeToWidth` for local files + the remote disk-cache reload). **Medium scroll ws 2.2→1.5GB, 1%-low 20→25-33, gen0 +146→+4.**
- **Where Medium lands after all of the above:** idle locked **60** (with 33 visible gifs), scroll **~33-38fps** with `activeGif=0`. The remaining scroll cost is purely the per-card render below (~58 cards/frame ≈ Browse Medium's count, library cards still marginally heavier). decode-to-size barely moved raw scroll fps (sampling wasn't the dominant cost) but slashed memory + GC + 1%-lows. **To push Medium scroll to a locked 60 needs fewer visible cards (Large) — the per-card render floor is the wall, same as Browse.**
- **Small** stays render-bound (~66 cards, mid-scroll `fps≈14`, `activeGif=0`) — unchanged conclusion; bigger cards are the only lever.

## Root cause of scroll jank: render cost ∝ realized card count

Measured with the debug FPS meter (see below), Workshop grid, fixed loaded set, fetch frozen:

| Card size | realized cards | fps | frametime |
|-----------|----------------|-----|-----------|
| Large     | ~31            | 61  | ~16ms     |
| Medium    | ~58            | 54  | ~18ms     |
| Small     | ~111           | 26  | ~38ms     |

- **frametime ≈ realized_card_count × ~0.34ms.** ItemsRepeater DOES virtualize (realized < total), but Small cards put ~100 cards in the viewport at once → ~34ms/frame → ~26fps. "Lags more the longer you scroll" = more cards loaded → bigger realization window + GC churn.
- **NOT the cause** (ruled out by measurement): GIF animation (debounce suppresses gifs during motion — `activeGif=0` while scrolling), shimmer, new-card *loading* (drops persist with `fetch off` over a fixed set). It's purely the per-frame cost of rendering many cards.
- The lever is **per-card render cost** — must get it low enough that ~110 cards still fit in 16.6ms (≈0.15ms/card, ~2.3× cheaper).

## Fixes applied (chronological)

1. **Async gif pipeline + bounded caches** (commit `58b0dfd`) — see `ui.md`. Removed the multi-second freeze (sync network on UI thread) and unbounded memory growth.
2. **FPS meter + DebugBridge** (commit `2082822`) — measurement infra (below).
3. **Shimmer slides via `Canvas.Left` not `Margin`** (commit `e8a27a6`) — Margin is a layout property; animating it invalidated layout every frame across every placeholder. Canvas.Left is arrange-only. (Correctness/loading win; didn't move steady-scroll fps.)
4. **`VerticalCacheLength="0"`** on both grids — was `1` (~3 viewports of live cards). Cuts the realization buffer so fewer cards render. Helps at large/medium counts; at Small the viewport alone is ~100 cards so limited.
5. **Removed redundant rounded-corner clips** — outer card `Border` already clips to a rounded rect; removed the inner `Button` + `ThumbnailDisplay Panel` `ClipToBounds`. **Result: no measurable fps change** (clips were not the dominant cost). Kept anyway (slightly less work).
6. **Minimal AdvancedImage template** — AsyncImageLoader's `AdvancedImage` (a ContentControl) default template shows an indeterminate (animated) loading spinner while `IsLoading`. As ~100 cards recycle/rebind during scroll, that's ~100 continuously-animating spinners. Overrode it globally (Window.Styles `asyncImageLoader|AdvancedImage`) with a bare `Image` bound to `CurrentImage`, no spinner. (Measuring.)

### GC observation
During steady scroll over a fixed set (fetch off, gifs off, realized ~110), `gen2` climbs ~1 full GC/sec and ws swings ~1GB. The churn is **AdvancedImage rebinding as containers recycle** (Source changes → reload/decode path) — even though the bounded cache avoids re-download. This GC pressure is a second contributor to the drops alongside raw per-card render cost. cache=0 *maximizes* recycle churn (re-realize every edge crossing); a small buffer may trade render cost for less churn — untested.

### Template flattening — TRIED, no gain (reverted)
Cut ~4 structural objects/card (thumbnail Button→Border+tap, inlined images instead of TemplatedControl, dropped inner thumb Grid + overlay Panel). **fps unchanged (26–32 at Small).** Conclusion: per-card cost is **NOT visual/object count** — empty containers are nearly free. It's the **AdvancedImage draw** (sampling a bitmap to fill each card ×N) + **GC churn** as cards recycle (gcHeap swings 100→370MB during scroll, gen2 climbs). Reverted (the Button→Border lost keyboard focus/press feedback for zero benefit). So Small@60 is not reachable by simplifying the template; it needs either far fewer visible cards or a different rendering stack (→ web rewrite, see memory `web-frontend-rewrite-idea`).

### Dead ends (do NOT retry)
- **Template/structural flattening** — no fps gain (cost is image-draw + GC, not object count). See above.
- **240fps render-loop override** — binding a 240 `IRenderLoop`/`IRenderTimer` (incl. reflection into internal `AvaloniaLocator.CurrentMutable`) succeeds but is inert; compositor already holds the 60 loop. Reverted. (See "Hard ceiling" above.)
- **Shimmer Margin animation** — was a layout-storm; fixed (Canvas.Left) but it did not affect steady-scroll fps (only loading).
- **Rounded-clip removal** — no measurable fps change.
- **`vblank_mode=0`** — does not lift the 60 cap.

### Per-card optimization backlog (if still <60 at Small)
- Flatten template depth (nested Grid/Panel), drop always-present state-overlay borders to shared styles.
- Replace AdvancedImage entirely with a plain `Image` + URL→Bitmap converter using the bounded loader (avoid the ContentControl rebind machinery); decode-to-display-size.
- Tune `VerticalCacheLength` (small buffer vs 0) to balance render cost vs recycle GC churn.
- Reduce overdraw / transparency layers per card.

## Why per-card cost is ~0.3ms (GPU is fine; CPU scene-commit is the cost)

- The app **is GPU-rendered** (nvidia-smi lists it as a graphics process; GLX direct rendering on the 3070 Ti). Not software raster.
- The bottleneck is **CPU-side**: during scroll every realized card's position changes, so Avalonia re-records/commits all their visuals to the compositor **every frame** → cost ∝ (visible cards × visuals-per-card). Each card is ~12–15 visuals (Border→Panel→Grid→Grid→Button(template)→TemplatedControl→Panel→2×Image, TextBlock, Button(template), overlay Panel→2 Border). ~110 cards × ~13 ≈ 1400 visuals/frame ≈ 30ms.
- Collapsed (`IsVisible=false`) subtrees (placeholder skeleton, SCENE badge, selected outline) are NOT composited, so they don't add steady scroll cost — only instantiation/memory.

### Final curve (all opts applied)
| Size | realized | fps | verdict |
|------|----------|-----|---------|
| Large | ~30 | 62 (low 58) | **locked 60** |
| Medium | ~58 | 53–57 (low 36) | near, occasional dip |
| Small | ~110 | ~32 (low 21) | cannot reach 60 |

To get Small (~110 visible cards) to 60 would need ~2–3× fewer visuals **per card** (template flattening — uncertain payoff, risks UI changes) or simply fewer visible cards (larger size). Medium/Large are the smooth zone. Open question for product: default to Medium.

## How to measure (debug only)

Launch with `LIVEPAPER_DEBUG_IPC=1` → on-screen FPS overlay (top-right) + Unix-socket bridge at `/tmp/livepaper-debug.sock`. Drive via `socat`:
```
echo "<cmd>" | socat -t6 - UNIX-CONNECT:/tmp/livepaper-debug.sock
```
Commands: `fps`, `metrics` (fps/low/cards/realized/activeGif/ws/gcHeap/gen0/gen2/offset), `source <name>`, `tab N`, `cardsize Small|Medium|Large`, `gifs on|off`, `fetch on|off` (freeze LoadMore to measure a fixed set), `scroll <px>`, `scrollbottom`, `autoscroll <px/s> <secs>` (continuous per-frame scroll — the only way to reproduce real scroll load; discrete jumps don't).

**Gotchas:**
- `SmoothScroller` is disabled under debug (it owns Offset and fights scripted writes).
- Discrete `scroll`/`scrollbottom` hold 60 (renderer idles between jumps) — use `autoscroll` for continuous load.
- Programmatic scroll can't reproduce real mouse-wheel *timing* (socket latency > frame); use `autoscroll` + the on-screen overlay; validate final result with a real wheel.
- `realized` count requires the unconditional tracking in `OnRepeaterElementPrepared` (not gated by AutoPlayGifs).
