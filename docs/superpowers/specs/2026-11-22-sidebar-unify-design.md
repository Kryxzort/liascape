# Sidebar and filter cleanup — design

Owner-approved direction (2026-11-22). Build after #114 lands (it touches the same files).

## Why
Browse's and the Library's item sidebars drifted apart, and each grew extras nobody asked for (a state chip, a link among
the info pills, a subscription toggle, a hint line, a separate Favourite tile). The fix is one layout for both and rules
that make additions replace rather than pile up.

## The sidebar (Browse and Library: one skeleton)
Order: picture → title → info pills (facts and tags only) → one action area → creator / presets rows → About → tiles →
comments. The tabs differ only in what the action area holds.

- Not downloaded (Browse): two buttons, Download & Apply and Download. Removed: the subscription indicator and
  Subscribe/Unsubscribe toggle (`SubToggle`), the hint line under the buttons (`side-cta-note`). Right-click keeps the
  download menu it has now.
- Downloaded (Browse; Library for Workshop items): one split button, Play | Unsubscribe. Right-click on Unsubscribe:
  "Unsubscribe, keep the files". Library items not from the Workshop: Play only (owner to confirm the second half).
- "Show in Library": an icon button under the close button, in the head's tool slot (`SideHeadTools`); the "In your
  library" chip goes.
- Favourite: the favourites count pill is the toggle (star filled when favourited, click toggles; signed out it
  explains sign-in). The Favourite tile goes.
- Creator and presets rows: no generic trailing icons; the whole row is the target, with a hover lift and a chevron
  that slides on hover.
- The presets button and row look too plain: mock 2–3 looks in the motion lab for the owner to pick by eye.

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
full slide, cards glide nearest first and stay visible under a backdrop that fades in, content soft-cascades in late
and from further back (values: owner's pick in the lab).

## UI rules added to `.claude/rules/ui/design.md`
1. Agents decide visual details themselves; every visual decision beyond the brief is one line in the report
   ("added X, because Y").
2. One skeleton per concept: both sidebars share one layout; a probe fails if their section order differs.
3. Each area has one job: info pills = facts and tags, the action area = actions, rows = navigation.
4. State shows on the control that changes it, never twice.
5. Every addition names what it replaces (merges into or removes something), or says why it can't.
6. No hint text under buttons: reasons go in the disabled control's tooltip or its right-click menu.
7. Icons only where they carry meaning; none on a row that is already fully clickable.
8. Filters live in the filter column, not as top-bar pills.
9. Every UI review compares Browse and Library screenshots side by side.
