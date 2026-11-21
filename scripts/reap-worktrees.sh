#!/usr/bin/env bash
# Remove landed git worktrees under .claude/worktrees/ one at a time, gently. A worktree holds build output (target/,
# bin/obj, node_modules links): removing several at once is a multi-GB delete, and on btrfs with async discard the
# trim backlog that follows can saturate a drive for minutes. So: one worktree, then wait until the filesystem's
# discard backlog is under LIMIT before the next.
#
# A worktree is removed only when nothing in it would be lost:
#   - every commit on its branch is on BRANCH, by patch (`git cherry`: a rebased copy counts as landed);
#   - no uncommitted tracked change except an exact copy of BRANCH's version of that file (a worktree left behind on
#     an old base shows BRANCH's later edits as "changes" — those exist already);
#   - no new file git doesn't ignore (an agent's work in progress is often all new, uncommitted files);
#   - not locked (`git worktree lock`), not the worktree this is run from, and not one named in KEEP.
# Ignored files (build output, linked node_modules) go with it. FORCE names worktrees whose uncommitted tracked changes
# were checked by hand and may go (e.g. a path sweep left on an old base); unlanded commits and new files still keep them.
#
#   bash scripts/reap-worktrees.sh            # list what would go and what stays, and why (nothing removed)
#   bash scripts/reap-worktrees.sh --go       # remove them
#   REAP_BRANCH=lp-player REAP_KEEP="fav-114 other" REAP_FORCE="weref-2d …" REAP_DISCARD_LIMIT_MB=500 …
set -uo pipefail
go=0; [ "${1:-}" = --go ] && go=1
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
branch=${REAP_BRANCH:-lp-player}
keep=" ${REAP_KEEP:-} "
force=" ${REAP_FORCE:-} "
limit=$(( ${REAP_DISCARD_LIMIT_MB:-500} * 1024 * 1024 ))
here=$(git rev-parse --show-toplevel 2>/dev/null || true)

# the discard backlog of the filesystem holding the repo, in bytes; empty where there is none to read (not btrfs, no
# async discard)
backlog() {
  local uuid; uuid=$(findmnt -no UUID -T "$root" 2>/dev/null) || return 0
  cat "/sys/fs/btrfs/$uuid/discard/discardable_bytes" 2>/dev/null || true
}
wait_backlog() {
  local b t0=$SECONDS
  while b=$(backlog); [ -n "$b" ] && [ "$b" -gt "$limit" ]; do
    [ $((SECONDS - t0)) -ge 1800 ] && { echo "reap: discard backlog still $((b / 1048576)) MB after 30 min — stopping" >&2; exit 1; }
    sleep 10
  done
}

why_keep() {  # prints a reason to keep the worktree, nothing if it may go
  local wt=$1 name=${1##*/} f
  [ "$wt" = "$here" ] && { echo "it's the worktree this runs from"; return; }
  [[ "$keep" == *" $name "* ]] && { echo "in REAP_KEEP"; return; }
  [[ " $locked " == *" $wt "* ]] && { echo "locked"; return; }
  local head; head=$(git -C "$wt" rev-parse HEAD 2>/dev/null) || { echo "unreadable"; return; }
  local unlanded; unlanded=$(git -C "$root" cherry "$branch" "$head" 2>/dev/null | grep -c '^+')
  [ "$unlanded" -gt 0 ] && { echo "$unlanded commit(s) not on $branch"; return; }
  local new; new=$(git -C "$wt" ls-files --others --exclude-standard 2>/dev/null | grep -c .)
  [ "$new" -gt 0 ] && { echo "$new new file(s) not committed"; return; }
  [[ "$force" == *" $name "* ]] && return
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! git -C "$root" cat-file -e "$branch:$f" 2>/dev/null ||
       ! cmp -s <(git -C "$root" show "$branch:$f") "$wt/$f" 2>/dev/null; then
      echo "uncommitted change to $f"; return
    fi
  done < <(git -C "$wt" diff --name-only HEAD 2>/dev/null)
}

locked=$(git -C "$root" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^locked/{print w}' | tr "\n" " ")
n=0; kept=0
while IFS= read -r wt; do
  case "$wt" in "$root"/.claude/worktrees/*) ;; *) continue ;; esac
  reason=$(why_keep "$wt")
  if [ -n "$reason" ]; then echo "keep  ${wt##*/}: $reason"; kept=$((kept + 1)); continue; fi
  if [ "$go" = 0 ]; then echo "would remove  ${wt##*/}"; n=$((n + 1)); continue; fi
  wait_backlog
  br=$(git -C "$wt" symbolic-ref --short -q HEAD || true)
  echo "remove ${wt##*/}"
  git -C "$root" worktree remove --force --force "$wt" || { echo "reap: couldn't remove $wt" >&2; continue; }
  [ -n "$br" ] && [ "$br" != "$branch" ] && git -C "$root" branch -D -q "$br" 2>/dev/null
  n=$((n + 1))
done < <(git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p')
[ "$go" = 1 ] && wait_backlog
echo "reap: $n $([ "$go" = 1 ] && echo removed || echo removable), $kept kept"
