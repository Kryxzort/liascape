# Filter cleanup — design

Owner-approved direction (2026-11-22). Its sidebar half is built (`components/ItemSide.tsx`, `docs/decisions.md` § "One
sidebar for an item, the same on both tabs"); its UI rules are `.claude/rules/ui/design.md` § Layout discipline. Left: the
filters (`docs/TODO.md` item 17).

## Filters
- The top-bar creator / presets pill goes. The filter column gets two editable fields: **Author** (a Steam ID, a profile
  URL, or a custom profile name — the `name` in steamcommunity.com/id/name) and **Presets of** (a scene's Workshop ID or URL).
- A click on the sidebar's creator or presets row fills that field; clearing the field leaves the list.
- Steam has no author search syntax (its search matches titles and descriptions only), so the Author field resolves to a
  Steam ID itself, always the same way: a custom profile name or URL through the public profile page. Display names are
  not accepted (they aren't unique and Steam has no lookup for them); typing one says so and asks for the profile link,
  ID or custom name.
