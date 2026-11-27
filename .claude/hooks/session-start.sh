#!/usr/bin/env bash
# SessionStart: the next work (the first Queued titles in docs/TODO.md) and the agent worktrees whose branches hold
# commits lp-player doesn't (by patch: a rebased copy counts as landed), so a finished agent's work isn't forgotten.
# Its output joins the session's context. Read-only and quick: rev-list first, `git cherry` only for a branch ahead.
# Guard: scripts/test-land-agent.sh
root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}
cd "$root" 2>/dev/null || exit 0
branch=lp-player
if [ -f docs/TODO.md ]; then
  q=$(awk '/^## Queued/ {on = 1; next} /^## / {on = 0}
           on && /^[0-9]+\. \[ \]/ {sub(/ \[ \]/, ""); print; if (++n == 8) exit}' docs/TODO.md | cut -c1-140)
  [ -z "$q" ] || { echo "Queued in docs/TODO.md (first $(grep -c . <<<"$q")):"; sed 's/^/  /' <<<"$q"; }
fi
git rev-parse -q --verify "refs/heads/$branch" >/dev/null || exit 0
out=$(git worktree list --porcelain | awk '
    /^worktree / {w = substr($0, 10); b = ""; l = ""} /^branch / {b = substr($0, 8)} /^locked/ {l = " (locked: its agent may still run)"}
    /^$/ {if (w != "" && b != "") print w "\t" b "\t" l; w = ""}
    END {if (w != "" && b != "") print w "\t" b "\t" l}' |
  while IFS=$'\t' read -r wt ref lock; do
    case "$wt" in "$root"/.claude/worktrees/agent-*) ;; *) continue ;; esac
    [ "$(git rev-list --count "$branch..$ref" 2>/dev/null || echo 0)" -gt 0 ] || continue
    n=$(git cherry "$branch" "$ref" 2>/dev/null | grep -c '^+')
    [ "$n" -gt 0 ] || continue
    echo "  ${wt##*/}: $n commit(s) not on $branch$lock — last: $(git log -1 --format=%s "$ref")"
  done)
[ -z "$out" ] || { echo "Agent worktrees with unlanded commits (land one: the land-agent skill):"; echo "$out"; }
exit 0
