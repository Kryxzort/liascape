---
name: land-agent
description: Land a finished agent's worktree branch on lp-player — rebase, builds, lint, check-rules, the UI matrix, the local CodeRabbit review, the fast-forward, the worktree removed — then judge what the script can't (each review finding, a conflict, a matrix failure, leftovers). Use when an implementer agent has reported its work done.
---

# Landing an agent's branch

The script does the mechanical part and stops, with nothing landed, wherever a judgement is needed. Run it from the
main checkout (it must have lp-player checked out and no uncommitted tracked changes). Its header lists every option.

## 1. Run the script
- Save the agent's final report to a file, then, in the background (a full matrix takes 10–20 min):
  `bash scripts/land-agent.sh <worktree> --report <report file>`. Try `--dry-run` first when unsure what it will do.
- Exit 0: landed and pushed (`LAND_NO_PUSH=1` skips the push), the worktree and its branch removed (a locked one, its
  agent maybe still running, stays: `scripts/reap-worktrees.sh` takes it later).
- Its reviews, matrix logs and stamps stay in `<git common dir>/land-agent/`; a rerun reuses a passing matrix of the
  same head and, with `--reviewed`, the judged review of the same diff.

## 2. Exit 3: a code conflict
- Hand it back to the agent that wrote the branch (or a fresh one with its report): the files the script named, and
  "rebase onto lp-player and resolve". Never resolve another agent's code conflict blind; a `docs/TODO.md` or
  `docs/decisions.md` conflict the merge driver couldn't settle (both sides changed one item) you may merge by hand.
- No merge driver set (the script warns): `bash scripts/setup-clone.sh` once.

## 3. Exit 5: leftovers the TODO doesn't carry
- Read each line it printed. A real leftover → a `docs/TODO.md` item (Queued when it was agreed work, else its
  section), committed on lp-player or by the agent in its worktree; then run again.
- Not a leftover (a word match on something done, a note with no product work) → `--ack '<why>'`; the reason is printed.

## 4. A matrix failure
- Cells that passed alone are listed as load flakes: nothing to do.
- A cell that fails alone: rerun it on lp-player too (`.claude/rules/testing.md` § A red result). Fails on both → older
  than the branch: a TODO item with the cell and its cause, then `--skip-matrix '<cell> fails on lp-player too, queued'`.
  Fails only on the branch → back to the agent with the cell and the log the script named.
- Where full runs belong to the night, pass `--skip-matrix '<what ran instead>'` by day and run the full matrix before
  the next merge to main.

## 5. Exit 4: CodeRabbit findings
- Open the saved review. For each finding read the code it points at and decide: real (a bug, a broken rule, a missing
  guard) or not (a misread, a style wish against the repo's rules). Never apply one unread.
- Real ones: fix test-first in the worktree (or send them to the agent), commit, run again; the new diff gets a new
  review, or `--skip-review '<why>'` when the hourly limit is spent. None real: run again with `--reviewed`.
- A review refused for the limit doesn't stop the landing: review the diff yourself or run CodeRabbit on lp-player later.

## 6. After landing
- Tell the owner what landed (short hash and title), the flakes, every `--ack` reason and the findings judged not real.
- A night run also adds that line to the checkout's own night notes, when it keeps them (a gitignored file).
