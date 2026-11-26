#!/usr/bin/env bash
# The docs merge driver (scripts/merge-docs.py) in a throwaway repo: a rebase where the target added Queued items next
# to an item the branch built and deleted (the conflict git's line merge stops on), both sides adding decisions at the
# top, an added item whose number the target already uses, and a real conflict (both changed one item).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
cd "$T"; git init -q -b main; git config user.email t@t; git config user.name t
git config merge.liascape-docs.driver "python3 $ROOT/scripts/merge-docs.py %O %A %B"
mkdir docs; printf 'docs/TODO.md merge=liascape-docs\ndocs/decisions.md merge=liascape-docs\n' > .gitattributes
cat > docs/TODO.md <<'T'
# TODO

## Queued (in order)
8. [ ] Item eight.
       More of eight.

9. [ ] Item nine, the one the branch builds.
       Its second line.

10. [ ] Item ten.

## UI
- [ ] A UI thing.
T
cat > docs/decisions.md <<'T'
# Decisions

Intro line.

### Old decision — 2026-11-01
Body.
T
git add -A; git commit -qm base
git checkout -qb branch
python3 - <<'P'
p='docs/TODO.md'; s=open(p).read()
s=s.replace("9. [ ] Item nine, the one the branch builds.\n       Its second line.\n\n","")
s=s.replace("10. [ ] Item ten.\n","10. [ ] Item ten.\n\n11. [ ] Branch follow-up.\n")
s=s.replace("- [ ] A UI thing.\n","- [ ] A UI thing.\n- [ ] Branch UI leftover.\n")
open(p,'w').write(s)
p='docs/decisions.md'; s=open(p).read()
s=s.replace("### Old decision","### Branch decision — 2026-11-27\nBranch body.\n\n### Old decision")
open(p,'w').write(s)
P
git commit -qam "branch work"
git checkout -q main
python3 - <<'P'
p='docs/TODO.md'; s=open(p).read()
s=s.replace("9. [ ] Item nine, the one the branch builds.\n       Its second line.\n","9. [ ] Item nine, the one the branch builds.\n       Its second line.\n\n10. [ ] Main's new item next to nine.\n")
s=s.replace("10. [ ] Item ten.\n","11. [ ] Item ten.\n\n12. [ ] Main's later item.\n")
s=s.replace("10. [ ] Main's new item","10. [ ] Main's new item")
open(p,'w').write(s)
p='docs/decisions.md'; s=open(p).read()
s=s.replace("### Old decision","### Main decision — 2026-11-27\nMain body.\n\n### Old decision")
open(p,'w').write(s)
P
git commit -qam "main work"
git checkout -q branch
if git rebase -q main >/dev/null 2>&1; then ok "rebase completes without stopping"; else bad "rebase stopped"; git rebase --abort; fi
todo=$(cat docs/TODO.md); dec=$(cat docs/decisions.md)
grep -q 'Item nine' <<<"$todo" && bad "the item the branch deleted came back" || ok "the built item stays deleted"
grep -q "Main's new item next to nine" <<<"$todo" && grep -q "Main's later item" <<<"$todo" && ok "the target's new items kept" || bad "a target item lost"
grep -q '^13\. \[ \] Branch follow-up' <<<"$todo" && ok "the branch's item takes the next free number (13)" || bad "numbering: $(grep -n 'Branch follow-up' <<<"$todo")"
grep -q 'Branch UI leftover' <<<"$todo" && ok "the branch's UI leftover kept" || bad "UI leftover lost"
grep -q '<<<<<<<' <<<"$todo$dec" && bad "conflict markers left" || ok "no markers"
grep -q 'Branch decision' <<<"$dec" && grep -q 'Main decision' <<<"$dec" && grep -q 'Old decision' <<<"$dec" && ok "both decisions kept" || bad "a decision lost"
# A real conflict: both sides change the same item differently.
git checkout -q main; sed -i 's/Item eight\./Item eight, main wording./' docs/TODO.md; git commit -qam m2
git checkout -q branch; sed -i 's/Item eight\./Item eight, branch wording./' docs/TODO.md; git commit -qam b2
if git rebase -q main >/dev/null 2>&1; then bad "a real conflict went through"; else
  grep -q '<<<<<<< ours' docs/TODO.md && ok "a real conflict stops with markers on that item only" || bad "no markers on the real conflict"
  git rebase --abort; fi
[ $fail = 0 ] && echo "RESULT ok" || { echo "RESULT fail"; exit 1; }
