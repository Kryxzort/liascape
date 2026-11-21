#!/usr/bin/env bash
# Land a worktree's commits on a branch and push it: rebase the worktree onto the branch, fast-forward the branch to it
# (in the checkout that has the branch out, so its files follow), check the rules, push. Refuses rather than guessing:
# uncommitted tracked changes on either side, a rebase conflict, or a result that isn't a fast-forward stop it with
# nothing moved.
#
#   bash scripts/land.sh <worktree path> [branch]        # branch: default lp-player
#   LAND_NO_PUSH=1 bash scripts/land.sh …                 # everything but the push
set -euo pipefail
wt=${1:?usage: scripts/land.sh <worktree path> [branch]}
branch=${2:-lp-player}
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
wt=$(cd "$wt" && git rev-parse --show-toplevel)
[ "$wt" != "$root" ] || { echo "land: give the worktree, not the main checkout" >&2; exit 2; }

dirty() { git -C "$1" status --porcelain --untracked-files=no | grep -q .; }
dirty "$wt" && { echo "land: $wt has uncommitted tracked changes — commit or drop them first" >&2; exit 1; }
dirty "$root" && { echo "land: $root has uncommitted tracked changes — they'd block the fast-forward" >&2; exit 1; }
[ "$(git -C "$root" symbolic-ref --short HEAD)" = "$branch" ] || { echo "land: $root doesn't have $branch checked out" >&2; exit 1; }

old=$(git -C "$root" rev-parse "$branch")
if ! git -C "$wt" rebase -q "$branch"; then
  git -C "$wt" rebase --abort 2>/dev/null || true
  echo "land: rebasing onto $branch conflicts — resolve it in $wt, then run this again" >&2; exit 1
fi
new=$(git -C "$wt" rev-parse HEAD)
[ "$new" != "$old" ] || { echo "land: nothing to land ($branch already has it)"; exit 0; }
git -C "$root" merge-base --is-ancestor "$old" "$new" || { echo "land: not a fast-forward of $branch" >&2; exit 1; }

echo "land: $branch ${old:0:8} → ${new:0:8}"
git -C "$root" log --oneline "$old..$new"
git -C "$root" merge -q --ff-only "$new"
bash "$root/scripts/check-rules.sh" | tail -1
if [ -n "${LAND_NO_PUSH:-}" ]; then echo "land: not pushed (LAND_NO_PUSH)"; exit 0; fi
# no askpass popups: a push that would prompt fails instead
env -u SSH_ASKPASS -u GIT_ASKPASS GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$root" -c core.askPass= push -q origin "$branch"
echo "land: pushed $branch ${new:0:8}"
