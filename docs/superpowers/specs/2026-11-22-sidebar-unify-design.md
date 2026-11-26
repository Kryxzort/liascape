# Filter and sidebar-motion cleanup — design

Owner-approved direction (2026-11-22). Its sidebar half is built (`components/ItemSide.tsx`, `docs/decisions.md` § "One
sidebar for an item, the same on both tabs"); its UI rules are `.claude/rules/ui/design.md` § Layout discipline. Left: the
filters (`docs/TODO.md` item 17) and the sidebar's motion (item 18).

## Filters
- The top-bar creator / presets pill goes. The filter column gets two editable fields: **Author** (a Steam ID, a profile
  URL, or a custom profile name — the `name` in steamcommunity.com/id/name) and **Presets of** (a scene's Workshop ID or URL).
- A click on the sidebar's creator or presets row fills that field; clearing the field leaves the list.
- Steam has no author search syntax (its search matches titles and descriptions only), so the Author field resolves to a
  Steam ID itself, always the same way: a custom profile name or URL through the public profile page. Display names are
  not accepted (they aren't unique and Steam has no lookup for them); typing one says so and asks for the profile link,
  ID or custom name.

## Motion
The sidebar open/close is variant E from the motion lab (worktree `agent-a841082c364487870`, `app/ui/motion-lab/`):
full slide, cards glide nearest first and stay visible under a backdrop that fades in, content soft-cascades in (`--spring-soft`, no overshoot, the 1× pace) starting
30 % into the panel slide, each item travelling 6× the current offset (owner's pick in the lab: "start 30 % · travel 6×").
Item switches keep B's quick carousel; close is B's slide out. Motion off: fades only.
