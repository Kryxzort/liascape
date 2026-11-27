#!/usr/bin/env bash
# Land a finished agent's worktree on lp-player with the checks a lander would otherwise run by hand, in order:
#   1. rebase onto the branch (the docs merge driver settles docs/TODO.md and docs/decisions.md; a code conflict stops
#      here with the files named and nothing moved: it goes back to the agent);
#   2. with --report: refuse while the agent's report names a part left undone or a follow-up that docs/TODO.md (the
#      rebased one, so the agent's own queued items count) doesn't carry, matched by the line's rarest words;
#   3. UI build + lint, backend build, scripts/check-rules.sh (the builds are skipped for a docs-only change);
#   4. the UI matrix: when scripts/matrix-cells-for.sh says FULL, a passing full run of this very commit (the stamp a
#      run here leaves, or --matrix-result newer than the head) or a run now; otherwise the --changed cells. Failed
#      cells run again alone: one that passes alone is a load flake (named, landing goes on), one that fails alone
#      stops it;
#   5. the local CodeRabbit review (`coderabbit review --agent --base <branch>`), saved for the lander; findings stop
#      the landing until they are judged (`--reviewed` reuses the saved review of the same diff); the rate limit or a
#      missing CLI is said and skipped;
#   6. scripts/land.sh (fast-forward, check-rules, push unless LAND_NO_PUSH=1);
#   7. the worktree and its branch removed by `git worktree remove` / `git branch -d`, which refuse to lose work (a
#      locked worktree, its agent maybe still running, is left for scripts/reap-worktrees.sh).
# Never stashes, never `add -A` / `commit -a`, never force-pushes; the only files it deletes are the landed worktree's,
# through git.
#
#   bash scripts/land-agent.sh <worktree> [options]
#     --report <file>       the agent's report, checked for leftovers docs/TODO.md doesn't carry
#     --ack <reason>        land despite those leftovers (the reason is printed for the night notes)
#     --reviewed            the saved CodeRabbit findings for this diff were judged: land without a new review
#     --skip-review <why>   no CodeRabbit review
#     --matrix-result <f>   a full matrix run's output (its MATRIX line with fail=0 error=0 setup=0), newer than the head
#     --skip-matrix <why>   no matrix run (a machine that runs only per-area probes by day; say what ran instead)
#     --keep                land, but leave the worktree and its branch
#     --branch <name>       the branch to land on (default lp-player)
#     --dry-run             print the steps and the read-only findings; change nothing
#   LAND_NO_PUSH=1 is passed on to land.sh. LAND_AGENT_STATE=<dir>: where reviews, matrix logs and stamps go (default
#   <git common dir>/land-agent). For tests, each step's command (run with `bash -c` in the worktree):
#   LAND_AGENT_UI_CMD, LAND_AGENT_BACKEND_CMD, LAND_AGENT_RULES_CMD, LAND_AGENT_MATRIX_CMD (the matrix script; its
#   arguments are appended), LAND_AGENT_CODERABBIT (the CLI).
# Exit: 0 landed (or a clean dry run); 1 usage or a failed check; 3 a code conflict; 4 CodeRabbit findings to judge;
#   5 leftovers docs/TODO.md doesn't carry. Guard: scripts/test-land-agent.sh
set -euo pipefail
usage() { sed -n '/^#   bash scripts\/land-agent.sh/,/^#   5 leftovers/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 1; }
say() { echo "land-agent: $*"; }
die() { echo "land-agent: $*" >&2; exit "${2:-1}"; }

wt="" report="" ack="" reviewed=0 skip_review="" matrix_result="" skip_matrix="" keep=0 branch=lp-player dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --report) report=${2:?--report needs a file}; shift ;;
    --ack) ack=${2:?--ack needs a reason}; shift ;;
    --reviewed) reviewed=1 ;;
    --skip-review) skip_review=${2:?--skip-review needs a reason}; shift ;;
    --matrix-result) matrix_result=${2:?--matrix-result needs a file}; shift ;;
    --skip-matrix) skip_matrix=${2:?--skip-matrix needs a reason}; shift ;;
    --keep) keep=1 ;;
    --branch) branch=${2:?--branch needs a name}; shift ;;
    --dry-run) dry=1 ;;
    -h|--help) usage ;;
    -*) echo "land-agent: unknown option $1" >&2; usage ;;
    *) [ -z "$wt" ] || usage; wt=$1 ;;
  esac
  shift
done
[ -n "$wt" ] || usage
[ -z "$report" ] || [ -r "$report" ] || die "can't read the report $report"
[ -z "$matrix_result" ] || [ -r "$matrix_result" ] || die "can't read the matrix result $matrix_result"

root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
[ -d "$wt" ] || die "no such worktree: $wt"
wt=$(cd "$wt" && git rev-parse --show-toplevel)
[ "$wt" != "$root" ] || die "give the agent's worktree, not the main checkout"
common() { (cd "$1" && cd "$(git rev-parse --git-common-dir)" && pwd -P); }
[ "$(common "$wt")" = "$(common "$root")" ] || die "$wt is not a worktree of $root"
br=$(git -C "$wt" symbolic-ref --short -q HEAD) || die "$wt has no branch checked out (a detached HEAD)"
[ "$br" != "$branch" ] || die "$wt has $branch itself checked out"
git -C "$root" rev-parse -q --verify "refs/heads/$branch" >/dev/null || die "no branch $branch"
state=${LAND_AGENT_STATE:-$(common "$root")/land-agent}
name=${wt##*/}

dirty=$(git -C "$wt" status --porcelain --untracked-files=no)
new=$(git -C "$wt" ls-files --others --exclude-standard)
[ -z "$dirty" ] || die "$wt has uncommitted tracked changes — the agent commits or drops them first:
$dirty"
[ -z "$new" ] || die "$wt has files git doesn't track or ignore — commit or delete them first (removing the worktree would lose them):
$new"
[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || die "$root has uncommitted tracked changes — they'd block the fast-forward"
[ "$(git -C "$root" symbolic-ref --short -q HEAD)" = "$branch" ] || die "$root doesn't have $branch checked out"
[ -n "$(git -C "$root" config merge.liascape-docs.driver)" ] ||
  say "warning: the docs merge driver isn't set in this clone (bash scripts/setup-clone.sh): TODO / decisions edits on both sides will stop the rebase"

if [ "$dry" = 1 ]; then
  base=$(git -C "$wt" merge-base HEAD "$branch")
  say "dry run for $name ($br): $(git -C "$wt" rev-list --count "$base..HEAD") commit(s) over $branch"
  git -C "$wt" log --oneline "$base..HEAD" | sed 's/^/    /'
else
  mkdir -p "$state"
fi

# ---- 1. rebase -------------------------------------------------------------------------------------------------------
rebase() {
  if [ "$dry" = 1 ]; then say "would rebase $br onto $branch ($(git -C "$root" rev-parse --short "$branch"))"; return; fi
  if ! git -C "$wt" rebase -q "$branch" >"$state/$name-rebase.log" 2>&1; then
    local files; files=$(git -C "$wt" diff --name-only --diff-filter=U 2>/dev/null || true)
    git -C "$wt" rebase --abort 2>/dev/null || true
    die "rebasing $br onto $branch conflicts in:
$(printf '%s\n' "$files" | sed 's/^/    /')
nothing moved (git's output: $state/$name-rebase.log): hand the conflict back to the agent (rebase $wt onto $branch and resolve it there), then run this again" 3
  fi
  say "rebased onto $branch ($(git -C "$root" rev-parse --short "$branch")): $(git -C "$wt" rev-list --count "$branch..HEAD") commit(s) to land"
}

# ---- 2. the report's leftovers -----------------------------------------------------------------------------------------
# A line that names something left undone (or a list under such a heading) is carried when one docs/TODO.md item holds
# three of its four rarest words (rarest = in the fewest items; two of two or three); a line with none is not.
leftovers() {  # <report> <todo>: prints the leftovers the TODO doesn't carry; exit 5 when there are any
  python3 -I - "$1" "$2" <<'PY'
import re, sys
rep = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
try: todo = open(sys.argv[2], encoding="utf-8", errors="replace").read().splitlines()
except OSError: todo = []
TOK = re.compile(r"[a-z0-9][a-z0-9_.:/'-]*[a-z0-9]")
def stem(t):  # hook / hooks / hook's are one word; paths and cell names stay as written
    t = t.strip("'")
    if t.endswith("'s"): t = t[:-2]
    return t[:-1] if len(t) > 4 and t.endswith("s") and not t.endswith("ss") and not re.search(r"[:/._]", t) else t
def toks(s): return {stem(t) for t in TOK.findall(s.lower())}
items, cur = [], None
for ln in todo:
    if re.match(r"\s*(\d+\.|[-*]) \[[ x]\]", ln): cur = [ln]; items.append(cur)
    elif ln.startswith("#") or not ln.strip(): cur = None
    elif cur is not None: cur.append(ln)
items = [toks(" ".join(i)) for i in items]
TRIG = re.compile(r"(?i)(\bleft\s*[:—–-]|\bleft (to do|undone|over|open|for)\b|what'?s left|\b(is|are|was|remains?|still) left\b"
                  r"|\bleftovers?\b|\bfollow[- ]?ups?\b|\bundone\b|\bunfinished\b|\bout of scope\b|\bdeferred\b"
                  r"|\bnot (yet )?(done|built|implemented|fixed|wired|covered|handled|finished|addressed)\b"
                  r"|\bstill (to do|open|missing|needs?|to be|fails?|failing|broken|flaky)\b|\bwhat remains\b|\bremains (to|open|undone)\b"
                  r"|\bremaining (work|parts?|items?|steps?|bits?)\b)")
NEG = re.compile(r"(?i)\b(nothing|none|no|zero|without)\b[^.;]{0,25}\b(left|leftovers?|follow[- ]?ups?|remain\w*|undone|unfinished|open)\b")
HEAD = re.compile(r"^\s*(#+\s+.*|\*\*[^*]+\*\*\s*:?|[^.!?]{1,40}:(\*\*)?)\s*$")
LIST = re.compile(r"^\s*([-*•]|\d+[.)])\s+")
STOP = set("""that this with from have been were will would should could they them their there then than when what which
while into onto over under about after before because also just only still left part parts done undone follow followup
follow-up follow-ups leftover leftovers item items todo queue queued later work needs need make made more most some such
each every other same does doesn't didn't isn't aren't wasn't can't won't it's here where like very much many able being
both either those these your owner agent report branch commit commits test tests file files line lines code change
changes remaining remains deferred unfinished scope yet built implemented fixed wired covered handled finished addressed
open missing step steps bits want wants into once case cases thing things time pass passes fail fails""".split())
def cands(s):
    out = []
    for t in toks(TRIG.sub(" ", s)):
        if t in STOP: continue
        if re.search(r"[:/._]", t) or (len(t) >= 4 and not t.isdigit()): out.append(t)
    return out
def live(s): return bool(TRIG.search(s)) and not NEG.search(s)
# what to judge: a line naming a leftover, and each list item under a heading or label naming leftovers (an indented
# continuation of a wrapped item joins it)
entries, under = [], False
for ln in rep:
    s = ln.strip()
    if not s: continue
    is_list = bool(LIST.match(ln))
    if s.startswith("#") or (not is_list and HEAD.match(s)):
        under = live(s)
        if under and len(cands(s)) >= 2: entries.append(s)
        continue
    if under and is_list:
        if not NEG.search(s): entries.append(s)
        continue
    if under and ln[:1] in " \t" and entries: entries[-1] += " " + s; continue
    under = False
    if live(s): entries.append(s)
df = {}
def freq(w):
    if w not in df: df[w] = sum(1 for i in items if w in i)
    return df[w]
found, seen = [], set()
for s in entries:
    if s in seen: continue
    seen.add(s)
    c = sorted(set(cands(s)), key=lambda w: (freq(w), -len(w)))[:4]
    # carried: one item holds 3 of the 4 rarest (2 of 2 or 3, 1 of 1): two common words meet in many items
    if c and max(sum(w in i for w in c) for i in items or [set()]) >= min(len(c), max(2, -(-3 * len(c) // 5))): continue
    found.append(f"    {s[:160]}\n        rarest words: {', '.join(c) if c else '(none)'}")
if found: print("\n".join(found))
sys.exit(5 if found else 0)
PY
}
check_report() {
  [ -n "$report" ] || return 0
  local out rc=0
  out=$(leftovers "$report" "$wt/docs/TODO.md") || rc=$?
  if [ "$rc" = 0 ]; then say "the report's leftovers are all in docs/TODO.md"; return 0; fi
  [ "$rc" = 5 ] || die "the report check failed (exit $rc)"
  echo "land-agent: the report names parts left over that docs/TODO.md doesn't carry:"
  echo "$out"
  if [ -n "$ack" ]; then say "landing anyway (--ack): $ack"; return 0; fi
  [ "$dry" = 1 ] && { say "(dry run: a real run stops here)"; return 0; }
  die "queue them in docs/TODO.md (a commit in $wt, or on $branch), or pass --ack '<why they need no item>'" 5
}

# ---- 3. builds, lint, rules ----------------------------------------------------------------------------------------------
run_in_wt() {  # <label> <command>
  if [ "$dry" = 1 ]; then say "would run $1: $2"; return 0; fi
  say "$1 …"
  local log; log="$state/$name-$(echo "$1" | tr -c 'a-zA-Z0-9\n' '-').log"
  if (cd "$wt" && bash -c "$2") >"$log" 2>&1; then say "$1: ok"
  else tail -n 30 "$log" | sed 's/^/    /' >&2; die "$1 failed (full output: $log)"; fi
}
docs_only() {
  local f
  while IFS= read -r f; do
    case "$f" in docs/*|.claude/*|*.md|'') ;; *) return 1 ;; esac
  done < <(git -C "$wt" diff --name-only "$(git -C "$wt" merge-base HEAD "$branch")" HEAD)
}
if command -v nix >/dev/null 2>&1 && [ -f "$root/flake.nix" ]; then devsh="env -u LD_LIBRARY_PATH nix develop -c"; else devsh=""; fi
ui_cmd=${LAND_AGENT_UI_CMD:-"bash scripts/test-lock.sh $devsh bash -c 'cd app/ui && { [ -e node_modules ] || npm ci --no-audit --no-fund; } && npm run build && npm run lint'"}
backend_cmd=${LAND_AGENT_BACKEND_CMD:-"bash scripts/test-lock.sh $devsh dotnet build src/backend"}
rules_cmd=${LAND_AGENT_RULES_CMD:-"bash scripts/check-rules.sh"}
checks() {
  if docs_only; then say "docs-only change: no builds"
  else run_in_wt "UI build + lint" "$ui_cmd"; run_in_wt "backend build" "$backend_cmd"; fi
  run_in_wt "check-rules" "$rules_cmd"
}

# ---- 4. the UI matrix ----------------------------------------------------------------------------------------------------
matrix_cmd=${LAND_AGENT_MATRIX_CMD:-"bash scripts/test-ui-matrix.sh"}
passing() { grep -E '^MATRIX ' "$1" | tail -n 1 | grep -qE ' fail=0 error=0 .*setup=0'; }
escape_re() { printf '%s' "$1" | sed 's/[][\\.*+?^${}()|/]/\\&/g'; }
run_matrix() {  # <label> <args…>: runs it, reruns failed cells alone; 0 = passed (maybe with flakes)
  local label=$1; shift
  local head log; head=$(git -C "$wt" rev-parse HEAD); log="$state/matrix-$head.log"
  if [ "$dry" = 1 ]; then say "would run the $label UI matrix: $matrix_cmd $*"; return 0; fi
  say "the $label UI matrix (output: $log) …"
  local rc=0; (cd "$wt" && bash -c "$matrix_cmd $(printf '%q ' "$@")") >"$log" 2>&1 || rc=$?
  if [ "$rc" = 0 ] && passing "$log"; then say "matrix: $(grep -E '^MATRIX ' "$log" | tail -n 1)"; : > "$state/matrix-$head.$label.ok"; return 0; fi
  grep -q '^FAIL real network' "$log" && die "the matrix reached a real server (see $log)"
  local cells; cells=$(grep -E '^(FAIL|ERROR|SETUP) .+ × .+' "$log" | sed -E 's/^(FAIL|ERROR|SETUP) //' | sort -u || true)
  [ -n "$cells" ] || { tail -n 20 "$log" | sed 's/^/    /' >&2; die "the matrix failed without naming a cell (exit $rc; $log)"; }
  say "matrix: $(grep -E '^MATRIX ' "$log" | tail -n 1 || echo "exit $rc") — running the failed cells again, each alone"
  local c real="" flaky="" alone
  while IFS= read -r c; do
    alone="$state/matrix-$head-alone.log"
    if (cd "$wt" && bash -c "$matrix_cmd --no-build --jobs 1 --only $(printf '%q' "^$(escape_re "$c")\$")") >"$alone" 2>&1 && passing "$alone"
    then flaky+="    $c"$'\n'; else real+="    $c"$'\n'; fi
  done <<<"$cells"
  [ -z "$flaky" ] || { echo "land-agent: passed alone (load flakes; a full run's 6 shards load the machine):"; printf '%s' "$flaky"; }
  [ -z "$real" ] || die "these cells fail alone too — a real failure (see $log):
$real"
  : > "$state/matrix-$head.$label.ok"
}
matrix() {
  if [ -n "$skip_matrix" ]; then say "no UI matrix (--skip-matrix): $skip_matrix"; return 0; fi
  local base verdict head; base=$(git -C "$wt" merge-base HEAD "$branch"); head=$(git -C "$wt" rev-parse HEAD)
  verdict=$(bash "$wt/scripts/matrix-cells-for.sh" "$base" 2>/dev/null) || die "scripts/matrix-cells-for.sh failed in $wt"
  case "$verdict" in
    NONE) say "the UI matrix covers nothing this changes" ;;
    FULL)
      if [ -f "$state/matrix-$head.full.ok" ]; then say "a full UI matrix already passed on ${head:0:8}"; return 0; fi
      if [ -n "$matrix_result" ]; then
        local t; t=$(git -C "$wt" log -1 --format=%ct HEAD)
        if [ "$(stat -c %Y "$matrix_result")" -gt "$t" ] && passing "$matrix_result"; then
          say "the full UI matrix passed in $matrix_result (newer than ${head:0:8})"; return 0; fi
        say "$matrix_result is older than ${head:0:8} or not a pass: running the full matrix"
      fi
      say "central files changed: the full UI matrix"
      run_matrix full ;;
    *)
      if [ -f "$state/matrix-$head.changed.ok" ]; then say "the changed cells already passed on ${head:0:8}"; return 0; fi
      run_matrix changed --changed "$base" ;;
  esac
}

# ---- 5. CodeRabbit ----------------------------------------------------------------------------------------------------
cr=${LAND_AGENT_CODERABBIT:-coderabbit}
review() {
  if [ -n "$skip_review" ]; then say "no CodeRabbit review (--skip-review): $skip_review"; return 0; fi
  # keyed by the agent's diff, not the head: a rebase onto a moved branch keeps a judged review valid
  local id out
  id=$(git -C "$wt" diff "$(git -C "$wt" merge-base HEAD "$branch")" HEAD | git -C "$wt" patch-id --stable | cut -c1-12)
  out="$state/$name-coderabbit-${id:-empty}.jsonl"
  if [ "$dry" = 1 ]; then say "would run: $cr review --agent --base $branch (in $wt) → $out"; return 0; fi
  if [ "$reviewed" = 1 ]; then
    [ -f "$out" ] || die "--reviewed, but no saved review of this diff ($out): it changed since — review again (or --skip-review <why>)"
    say "CodeRabbit's findings in $out were judged (--reviewed)"; return 0
  fi
  if ! command -v "${cr%% *}" >/dev/null 2>&1; then say "no CodeRabbit CLI ($cr): no review — judge the diff yourself"; return 0; fi
  say "CodeRabbit review … (→ $out)"
  local rc=0; (cd "$wt" && bash -c "$cr review --agent --base $(printf '%q' "$branch")") >"$out" 2>&1 || rc=$?
  # the CLI's refusal: {"type":"error","errorType":"rate_limit","message":"Rate limit exceeded",…} and exit 1 (only that
  # record: a finding's text may well mention a rate limit)
  if grep -qE '^\{"type":"error","errorType":"rate_limit"' "$out"; then
    say "CodeRabbit refused (its rate limit): no review this time — landing goes on; review later or judge the diff yourself"
    mv -f "$out" "$state/$name-coderabbit-refused.txt"; return 0
  fi
  local n; n=$(grep -o '"type":"complete"[^}]*"findings":[0-9]*' "$out" | grep -o '[0-9]*$' | tail -n 1 || true)
  if [ "$rc" != 0 ] || [ -z "$n" ]; then
    say "CodeRabbit didn't finish (exit $rc; $out): no review — landing goes on"; return 0
  fi
  if [ "$n" = 0 ]; then say "CodeRabbit: no findings"; return 0; fi
  die "CodeRabbit: $n finding(s) in $out — judge each against the code, fix the real ones in $wt (test-first), then run this again (--reviewed if nothing changed)" 4
}

# ---- 6. land, 7. remove ------------------------------------------------------------------------------------------------
land() {
  if [ "$dry" = 1 ]; then say "would run: bash scripts/land.sh $wt $branch${LAND_NO_PUSH:+ (LAND_NO_PUSH)}"; return 0; fi
  bash "$root/scripts/land.sh" "$wt" "$branch" || die "scripts/land.sh refused (above)"
}
cleanup() {
  if [ "$keep" = 1 ]; then say "kept $wt and $br (--keep)"; return 0; fi
  if [ "$dry" = 1 ]; then say "would remove the worktree $wt and the branch $br (git worktree remove; git branch -d)"; return 0; fi
  if git -C "$root" worktree list --porcelain | awk -v w="worktree $wt" '$0 == w {f = 1; next} /^worktree /{f = 0} f && /^locked/ {found = 1} END {exit !found}'; then
    say "$wt is locked (its agent may still be running): left in place — once it has stopped, \`git worktree unlock\` it and run bash scripts/reap-worktrees.sh --go"
    return 0
  fi
  git -C "$root" worktree remove "$wt" || die "git wouldn't remove $wt (above); nothing else was touched"
  git -C "$root" branch -d -q "$br" || die "git wouldn't delete the branch $br (above)"
  say "removed $wt and $br"
}

rebase
check_report
for round in 1 2 3; do
  base_at=$(git -C "$root" rev-parse "$branch")
  checks
  matrix
  [ "$round" -gt 1 ] || review
  # The branch moved while the checks ran: rebase again and repeat the builds and the matrix (the tree is a new one; a
  # stamp is per head). The review stands: the agent's diff is the same.
  if [ "$dry" = 1 ] || [ "$(git -C "$root" rev-parse "$branch")" = "$base_at" ]; then break; fi
  [ "$round" = 3 ] && die "$branch keeps moving under the checks: try again later"
  say "$branch moved during the checks: rebasing again"
  rebase
  check_report
done
land
cleanup
[ "$dry" = 1 ] && say "dry run: nothing changed" || say "landed $name${ack:+ (leftovers acknowledged: $ack)}"
