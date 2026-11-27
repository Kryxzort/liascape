#!/usr/bin/env bash
# scripts/land-agent.sh in a throwaway repo with fake agent worktrees; the builds, the UI matrix and CodeRabbit are stubs
# (its LAND_AGENT_* commands), nothing is pushed (LAND_NO_PUSH). Cases: a dry run moves nothing and runs nothing; a
# report naming a leftover docs/TODO.md doesn't carry refuses (a queued one, "nothing left" and --ack don't); a real
# landing over a TODO edit on both sides (the merge driver) with a matrix cell that fails in the full run but passes
# alone; a cell that fails alone stops it; CodeRabbit findings stop it until --reviewed, which reuses the matrix stamp;
# the rate limit is said and skipped; a code conflict stops with the file named and nothing moved; a docs-only change
# skips the builds and the matrix; a locked worktree lands but stays.
#   bash scripts/test-land-agent.sh        LIASCAPE_KEEP_TMP=1 keeps the temp folder (the last line says where)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
# no test lock: a few seconds of git in a small temp repo, nothing heavy (like scripts/test-merge-docs.sh)
. "$ROOT/scripts/test-tmp.sh"
T=$(mktemp -d /tmp/liascape-landagent-XXXXXX)
cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-landagent- "$rc"; }
trap cleanup EXIT INT TERM HUP
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# ---- stubs: every step appends its name to $T/steps ----
mkdir -p "$T/bin"
cat > "$T/bin/coderabbit" <<'S'
#!/usr/bin/env bash
echo "coderabbit $*" >> "$STUB_LOG"
[ "${CR_MODE:-}" = limit ] && { echo '{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded","recoverable":true,"metadata":{"waitTime":"6 minutes"}}'; echo 'Error: An unexpected error occurred.'; exit 1; }
[ "${CR_MODE:-}" = crash ] && { echo '{"type":"review_context","reviewType":"all"}'; echo "Error: not signed in"; exit 1; }
echo '{"type":"review_context","reviewType":"all"}'
[ "${CR_FINDINGS:-0}" = 0 ] || echo '{"type":"finding","severity":"major","file":"src/x.cs","comment":"a stub finding"}'
echo "{\"type\":\"complete\",\"status\":\"review_completed\",\"findings\":${CR_FINDINGS:-0}}"
S
cat > "$T/bin/matrix" <<'S'
#!/usr/bin/env bash
# a full run fails $MX_CELL; alone (--only) it passes unless MX_ALONE=fail
echo "matrix $*" >> "$STUB_LOG"
case " $* " in
  *" --only "*) [ "${MX_ALONE:-pass}" = fail ] && { echo "FAIL $MX_CELL"; echo "MATRIX pass=0 fail=1 error=0 skip=0 setup=0 known=0"; exit 1; }
                echo "MATRIX pass=1 fail=0 error=0 skip=0 setup=0 known=0"; exit 0 ;;
esac
[ "${MX_MODE:-}" = abort ] && { echo "ABORT: the backend did not start"; exit 1; }
if [ -n "${MX_CELL:-}" ]; then echo "== failures (all shards)"; echo "FAIL $MX_CELL"; echo "        - a stub violation"
  echo "MATRIX pass=9 fail=1 error=0 skip=0 setup=0 known=0"; exit 1; fi
echo "MATRIX pass=10 fail=0 error=0 skip=0 setup=0 known=0"
S
chmod +x "$T/bin/coderabbit" "$T/bin/matrix"
export STUB_LOG=$T/steps PATH="$T/bin:$PATH" LAND_NO_PUSH=1 LAND_AGENT_STATE=$T/state
export LAND_AGENT_UI_CMD='echo ui >> "$STUB_LOG"' LAND_AGENT_BACKEND_CMD='echo backend >> "$STUB_LOG"' \
  LAND_AGENT_RULES_CMD='echo rules >> "$STUB_LOG"' LAND_AGENT_MATRIX_CMD=matrix LAND_AGENT_CODERABBIT=coderabbit

# ---- the throwaway repo: the real landing scripts, a stub check-rules, a TODO, a central UI file and a backend file ----
R=$T/repo; mkdir -p "$R/scripts" "$R/docs" "$R/app/ui/src/components" "$R/src"
cd "$R" || exit 1
git init -q -b lp-player
git config merge.liascape-docs.driver "python3 $ROOT/scripts/merge-docs.py %O %A %B"
cp "$ROOT/scripts/land.sh" "$ROOT/scripts/land-agent.sh" "$ROOT/scripts/matrix-cells-for.sh" scripts/
printf '#!/usr/bin/env bash\necho "RESULT problems=0"\n' > scripts/check-rules.sh
printf 'docs/TODO.md merge=liascape-docs\n' > .gitattributes
printf '.claude/worktrees/\nbuild-out/\n' > .gitignore
cat > docs/TODO.md <<'X'
# TODO

## Queued (in order)
1. [ ] Make the volume slider's thumb glow on hover.

2. [ ] The thing agent A builds.

3. [ ] Item three.
X
echo 'export const store = 1;' > app/ui/src/store.ts
echo 'export const Card = 1;' > app/ui/src/components/CardPreview.tsx
echo 'class X { int a = 1; }' > src/x.cs
git add .gitattributes .gitignore docs scripts app src; git commit -qm base

steps() { cat "$T/steps" 2>/dev/null | tr '\n' ' '; }
mkagent() {  # <name>: a worktree on its own branch from lp-player
  git worktree add -q -b "worktree-$1" "$R/.claude/worktrees/$1" lp-player
}
commit_in() { git -C "$1" add -- "${@:3}" && git -C "$1" commit -qm "$2"; }
land() { : > "$T/steps"; out=$(bash "$R/scripts/land-agent.sh" "$@" 2>&1); code=$?; }
tip() { git -C "$R" rev-parse lp-player; }

# The agent's work: the item it built deleted, a central UI file changed (the matrix verdict FULL), a follow-up queued.
A=$R/.claude/worktrees/agent-a; mkagent agent-a
python3 - "$A/docs/TODO.md" <<'P'
import sys; p = sys.argv[1]; s = open(p).read()
s = s.replace("2. [ ] The thing agent A builds.\n\n", "")
s = s.replace("3. [ ] Item three.\n", "3. [ ] Item three.\n\n4. [ ] Keyboard nudges for the volume slider's scrubber (arrow keys step 5 %).\n")
open(p, "w").write(s)
P
echo 'export const store = 2;' > "$A/app/ui/src/store.ts"
commit_in "$A" "Build agent A's thing" docs/TODO.md app/ui/src/store.ts
mkdir -p "$A/build-out"; echo junk > "$A/build-out/obj"   # ignored build output: removed with the worktree
# Meanwhile lp-player queues an item next to the one A deleted (the docs merge driver's case).
python3 - "$R/docs/TODO.md" <<'P'
import sys; p = sys.argv[1]; s = open(p).read()
s = s.replace("2. [ ] The thing agent A builds.\n", "2. [ ] The thing agent A builds.\n\n5. [ ] Something lp-player queued meanwhile.\n")
open(p, "w").write(s)
P
commit_in "$R" "Queue meanwhile" docs/TODO.md
base=$(tip); ahead=$(git -C "$A" rev-parse HEAD)

# ---- 1. dry run ----
land "$A" --dry-run
[ $code = 0 ] && ok "dry run exits 0" || bad "dry run exit $code: $out"
grep -q 'would rebase' <<<"$out" && grep -q 'would run the full UI matrix' <<<"$out" && grep -q 'would run: coderabbit review --agent --base lp-player' <<<"$out" \
  && grep -q 'would run: bash scripts/land.sh' <<<"$out" && grep -q 'would remove the worktree' <<<"$out" && ok "dry run prints every step" || bad "dry run steps: $out"
[ "$(tip)" = "$base" ] && [ "$(git -C "$A" rev-parse HEAD)" = "$ahead" ] && [ -d "$A" ] && [ -z "$(steps)" ] && [ ! -e "$T/state" ] \
  && ok "dry run moved nothing and ran nothing" || bad "dry run changed something (steps: $(steps))"

# ---- 2. the report's leftovers ----
cat > "$T/report-bad.md" <<'X'
Built agent A's thing (app/ui/src/store.ts:1).
Left: the scrubber's touch drag on the playlist bar's crossfade handle.
X
land "$A" --report "$T/report-bad.md"
[ $code = 5 ] && grep -q "crossfade handle" <<<"$out" && ok "an unqueued leftover refuses (exit 5, the line named)" || bad "unqueued leftover: exit $code: $out"
[ "$(tip)" = "$base" ] && [ -d "$A" ] && ! grep -q '^ui$' "$T/steps" && ok "the refusal comes before the builds, nothing landed" || bad "refusal landed or built: $(steps)"
cat > "$T/report-list.md" <<'X'
## Follow-ups
- the crossfade handle's touch drag on the playlist bar
X
land "$A" --report "$T/report-list.md" --dry-run
grep -q "crossfade handle's touch drag" <<<"$out" && ok "a list under a Follow-ups heading is checked" || bad "list under heading missed: $out"
cat > "$T/report-ok.md" <<'X'
Built agent A's thing. Nothing left over.
Follow-up queued: keyboard nudges for the volume slider's scrubber.
X
land "$A" --report "$T/report-ok.md" --dry-run
[ $code = 0 ] && grep -q "leftovers are all in docs/TODO.md" <<<"$out" && ok "a queued follow-up and 'nothing left' pass" || bad "queued follow-up flagged: exit $code: $out"
land "$A" --report "$T/report-bad.md" --ack "the owner dropped the crossfade drag" --dry-run
[ $code = 0 ] && grep -q "landing anyway (--ack): the owner dropped the crossfade drag" <<<"$out" && ok "--ack overrides with its reason" || bad "--ack: exit $code: $out"

# ---- 3. a cell that fails alone stops the landing ----
MX_CELL="idle × cardApply" MX_ALONE=fail land "$A" --skip-review "case 3"
[ $code = 1 ] && grep -q "fail alone too" <<<"$out" && grep -q "idle × cardApply" <<<"$out" && ok "a cell failing alone stops it, named" || bad "fail alone: exit $code: $out"
[ "$(tip)" = "$base" ] && [ -d "$A" ] && ok "nothing landed on a real matrix failure" || bad "landed despite a real failure"
grep -q -- "--only ^idle × cardApply\\$" "$T/steps" && ok "the failed cell ran alone (--only, anchored)" || bad "rerun args: $(grep -- --only "$T/steps")"

# ---- 4. CodeRabbit findings stop it; --reviewed lands; a flake is named ----
rm -f "$T"/state/matrix-*.ok
MX_CELL="playing × itemVol" CR_FINDINGS=2 land "$A"
[ $code = 4 ] && grep -q "2 finding(s)" <<<"$out" && ok "CodeRabbit findings stop it (exit 4)" || bad "findings: exit $code: $out"
grep -q "passed alone" <<<"$out" && grep -q "playing × itemVol" <<<"$out" && ok "a cell passing alone is named a flake and the run goes on" || bad "flake: $out"
grep -q '"findings":2' "$T"/state/agent-a-coderabbit-*.jsonl 2>/dev/null && ok "the review is saved for the lander" || bad "no saved review"
[ "$(tip)" = "$base" ] && ok "nothing landed with findings to judge" || bad "landed with findings"
grep -q '^ui$' "$T/steps" && grep -q '^backend$' "$T/steps" && grep -q '^rules$' "$T/steps" && ok "the builds, lint and check-rules ran" || bad "steps: $(steps)"
land "$A" --reviewed
[ $code = 0 ] && ok "--reviewed lands" || bad "--reviewed: exit $code: $out"
! grep -q '^coderabbit' "$T/steps" && ! grep -q '^matrix' "$T/steps" && ok "no second review, the matrix stamp of this head reused" || bad "reran: $(steps)"
new=$(git -C "$R" log -1 --format=%s lp-player)
[ "$new" = "Build agent A's thing" ] && git -C "$R" merge-base --is-ancestor "$base" lp-player && ok "lp-player fast-forwarded to A's rebased commit" || bad "lp-player tip: $new"
todo=$(git -C "$R" show lp-player:docs/TODO.md)
! grep -q "The thing agent A builds" <<<"$todo" && grep -q "Something lp-player queued meanwhile" <<<"$todo" && grep -q "Keyboard nudges" <<<"$todo" \
  && ok "the TODO edits on both sides merged" || bad "TODO after landing: $todo"
[ ! -e "$A" ] && ! git -C "$R" rev-parse -q --verify refs/heads/worktree-agent-a >/dev/null && ok "the worktree (with its ignored build output) and its branch are gone" || bad "worktree or branch left"

# ---- 5. the rate limit is said and skipped; a matrix verdict naming cells runs --changed ----
B=$R/.claude/worktrees/agent-b; mkagent agent-b
echo 'export const Card = 2;' > "$B/app/ui/src/components/CardPreview.tsx"; commit_in "$B" "Change the card preview" app/ui/src/components/CardPreview.tsx
bbase=$(tip)
CR_MODE=limit land "$B"
[ $code = 0 ] && grep -q "rate limit" <<<"$out" && ok "a rate-limited review is said and the landing goes on" || bad "rate limit: exit $code: $out"
grep -q -- "^matrix --changed $bbase" "$T/steps" && ok "a cell verdict runs the --changed cells from the base" || bad "changed run: $(grep '^matrix' "$T/steps")"
[ "$(git -C "$R" log -1 --format=%s lp-player)" = "Change the card preview" ] && ok "B landed" || bad "B not landed"

# ---- 5b. a matrix that fails naming no cell stops with its log; a review that never completes is said, landing goes on
G=$R/.claude/worktrees/agent-g; mkagent agent-g
echo 'export const store = 3;' > "$G/app/ui/src/store.ts"; commit_in "$G" "Change the store again" app/ui/src/store.ts
gbase=$(tip)
MX_MODE=abort land "$G" --skip-review "case 5b"
[ $code = 1 ] && grep -q "failed without naming a cell" <<<"$out" && [ "$(tip)" = "$gbase" ] && ok "a matrix failing without a cell stops it, its log named" || bad "matrix abort: exit $code: $out"
CR_MODE=crash land "$G"
[ $code = 0 ] && grep -q "CodeRabbit didn't finish" <<<"$out" && [ "$(git -C "$R" log -1 --format=%s lp-player)" = "Change the store again" ] \
  && ok "a review that ends without its complete record is said and the landing goes on" || bad "review crash: exit $code: $out"

# ---- 6. a code conflict stops with the file named, nothing moved ----
C=$R/.claude/worktrees/agent-c; mkagent agent-c
echo 'class X { int a = 3; }' > "$C/src/x.cs"; commit_in "$C" "Set a to 3" src/x.cs
echo 'class X { int a = 2; }' > "$R/src/x.cs"; commit_in "$R" "Set a to 2" src/x.cs
cbase=$(tip); chead=$(git -C "$C" rev-parse HEAD)
land "$C" --skip-review "case 6"
[ $code = 3 ] && grep -q "conflicts in" <<<"$out" && grep -q "src/x.cs" <<<"$out" && grep -q "hand the conflict back to the agent" <<<"$out" \
  && ok "a code conflict stops (exit 3) naming the file" || bad "conflict: exit $code: $out"
gd=$(git -C "$C" rev-parse --git-dir)
[ "$(tip)" = "$cbase" ] && [ "$(git -C "$C" rev-parse HEAD)" = "$chead" ] && [ ! -d "$gd/rebase-merge" ] && [ ! -d "$gd/rebase-apply" ] \
  && [ -z "$(git -C "$C" status --porcelain)" ] && ok "nothing moved: the rebase aborted, both branches as they were" || bad "conflict left state behind"
[ -z "$(steps)" ] && ok "no build ran after the conflict" || bad "steps after conflict: $(steps)"

# ---- 7. docs only: no builds, no matrix; a locked worktree lands but stays ----
D=$R/.claude/worktrees/agent-d; mkagent agent-d
echo "More words." >> "$D/docs/TODO.md"; commit_in "$D" "Reword the TODO" docs/TODO.md
git -C "$R" worktree lock "$D"
land "$D" --skip-review "case 7"
[ $code = 0 ] && grep -q "docs-only change: no builds" <<<"$out" && grep -q "covers nothing" <<<"$out" && ok "a docs-only change skips the builds and the matrix" || bad "docs only: exit $code: $out"
[ "$(steps)" = "rules " ] && ok "only check-rules ran" || bad "docs-only steps: $(steps)"
[ -d "$D" ] && grep -q "is locked" <<<"$out" && [ "$(git -C "$R" log -1 --format=%s lp-player)" = "Reword the TODO" ] && ok "a locked worktree lands and stays" || bad "locked: $out"
git -C "$R" worktree unlock "$D"

# ---- 7b. the branch moves during the checks and drops the item a leftover relied on: the second round refuses ----
printf '\n6. [ ] Shader warmup for the spare scene worker pool.\n' >> "$R/docs/TODO.md"; commit_in "$R" "Queue the warmup" docs/TODO.md
F=$R/.claude/worktrees/agent-f; mkagent agent-f
echo 'class F {}' > "$F/src/f.cs"; commit_in "$F" "Add F" src/f.cs
printf 'Added F.\nLeft: shader warmup for the spare scene worker pool (queued).\n' > "$T/report-f.md"
cat > "$T/move.sh" <<S
[ -e "$T/moved" ] && exit 0; : > "$T/moved"
python3 -c 'import sys; p = sys.argv[1]; s = open(p).read(); open(p, "w").write(s.replace("\n6. [ ] Shader warmup for the spare scene worker pool.\n", ""))' "$R/docs/TODO.md"
git -C "$R" commit -qam "Drop the warmup"
S
LAND_AGENT_UI_CMD="echo ui >> \"\$STUB_LOG\"; bash $T/move.sh" land "$F" --report "$T/report-f.md" --skip-review "case 7b"
[ $code = 5 ] && grep -q "moved during the checks" <<<"$out" && grep -q "shader warmup" <<<"$out" && [ "$(git -C "$R" log -1 --format=%s lp-player)" = "Drop the warmup" ] \
  && ok "a leftover whose item the moving branch dropped is refused on the next round" || bad "moved branch: exit $code: $out"

# ---- 8. safety: no stash, add -A, commit -a, force push, rm -rf in the script ----
grep -nE 'git[^|;&]* (stash|add +(-A|--all|\.)( |$)|commit +-a|push[^|;&]*(-f|--force))|rm -rf' "$ROOT/scripts/land-agent.sh" \
  && bad "a forbidden command in land-agent.sh" || ok "no stash / add -A / commit -a / force push / rm -rf in land-agent.sh"

# ---- 9. the Claude Code hooks (.claude/hooks/), each well under 2 s ----
H=$ROOT/.claude/hooks
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
json() { python3 -c 'import json, sys; print(json.dumps({"cwd": sys.argv[1], "tool_input": {sys.argv[2]: sys.argv[3]}}))' "$R" "$1" "$2"; }
guard() { json command "$1" | bash "$H/git-guard.sh" 2>/dev/null; }
for c in 'git stash' 'git stash push -u -m x' 'cd x && git add -A' 'git -C /x add .' 'git add --all' 'git commit -am "x"' \
         'git -c user.name=a commit -a -m x' 'rtk git stash list' 'git --no-pager stash' 'git add "."' "git add '.'" \
         'git commit -m "Explain things" --all' 'git commit -vam x' $'git status\ngit stash' 'env A=1 git stash' '/usr/bin/git add -A'; do
  guard "$c"; [ $? = 2 ] || bad "git-guard let through: $c"; done
for c in 'git add scripts/x.sh docs/TODO.md' 'git commit --amend --no-edit' 'git commit -m "Add all files"' 'git status' \
         'git add ./x' 'echo stash' 'git log --grep stash' 'git -C /x commit -m t' 'git commit -m "Explain --all usage"' \
         'git commit -m "fix -a flag"' 'git commit -F msg.txt' 'git commit -m "Never git stash here"' "echo 'git stash' > notes.txt" \
         'git commit --author "a <b>" -m x' 'unbalanced "quote'; do
  guard "$c"; [ $? = 0 ] || bad "git-guard refused: $c"; done
t0=$(date +%s%N); guard 'ls'; tg=$(ms "$t0")
ok "git-guard refuses stash / add -A / add . / commit -a in every spelling and lets named adds and message text through (${tg} ms)"
# check-rules after an edit: the edited file's own checkout; silent when clean or outside docs/ and .claude/
t0=$(date +%s%N); o=$(json file_path "$R/docs/TODO.md" | bash "$H/check-rules-after-edit.sh" 2>&1); rc=$?; tc=$(ms "$t0")
[ $rc = 0 ] && [ -z "$o" ] && ok "check-rules hook: clean = silent, exit 0 (${tc} ms)" || bad "check-rules hook clean: $rc $o"
printf '#!/usr/bin/env bash\necho "PROBLEM docs/TODO.md: a stub problem"; echo "RESULT problems=1"; exit 1\n' > "$R/scripts/check-rules.sh"
o=$(json file_path "$R/docs/TODO.md" | bash "$H/check-rules-after-edit.sh" 2>&1); rc=$?
[ $rc = 2 ] && grep -q "PROBLEM docs/TODO.md: a stub problem" <<<"$o" && ok "check-rules hook: a problem goes to Claude (exit 2)" || bad "check-rules hook problem: $rc $o"
o=$(json file_path "$R/.claude/skills/x/SKILL.md" | bash "$H/check-rules-after-edit.sh" 2>&1); rc=$?
[ $rc = 2 ] && ok "check-rules hook: a new file under .claude/ (its folder not made yet) is checked" || bad "check-rules hook .claude: $rc $o"
o=$(json file_path "src/x.cs" | bash "$H/check-rules-after-edit.sh" 2>&1); rc=$?
[ $rc = 0 ] && [ -z "$o" ] && ok "check-rules hook: a code edit (relative path) is left alone" || bad "check-rules hook code: $rc $o"
E=$R/.claude/worktrees/agent-e; mkagent agent-e
o=$(json file_path "$E/docs/TODO.md" | bash "$H/check-rules-after-edit.sh" 2>&1); rc1=$?
cp "$R/scripts/check-rules.sh" "$E/scripts/check-rules.sh"; git -C "$R" checkout -q -- scripts/check-rules.sh
o=$(json file_path "$E/docs/TODO.md" | bash "$H/check-rules-after-edit.sh" 2>&1); rc2=$?
git -C "$E" checkout -q -- scripts/check-rules.sh
[ $rc1 = 0 ] && [ $rc2 = 2 ] && ok "check-rules hook: an agent worktree's edit runs that worktree's check-rules, not the main checkout's" \
  || bad "check-rules hook worktree: main failing → $rc1 (want 0), worktree failing → $rc2 (want 2)"
# session start: the first Queued titles and an agent worktree holding a commit lp-player lacks
echo x > "$E/e.txt"; commit_in "$E" "Agent E's unlanded work" e.txt
t0=$(date +%s%N); o=$(CLAUDE_PROJECT_DIR=$R bash "$H/session-start.sh" 2>&1); ts=$(ms "$t0")
grep -q "^Queued in docs/TODO.md" <<<"$o" && grep -q "^  1\. Make the volume slider's thumb glow" <<<"$o" && ! grep -q '\[ \]' <<<"$o" \
  && ok "session start lists the Queued titles (${ts} ms)" || bad "session start queue: $o"
grep -q "agent-e: 1 commit(s) not on lp-player — last: Agent E's unlanded work" <<<"$o" && ! grep -q "agent-d" <<<"$o" \
  && ok "session start names the unlanded agent worktree, not a landed one" || bad "session start worktrees: $o"
for t in "$tg" "$tc" "$ts"; do [ "$t" -lt 2000 ] || bad "a hook took $t ms (budget 2000)"; done

[ $fail = 0 ] && echo "RESULT ok" || { echo "RESULT fail"; exit 1; }
