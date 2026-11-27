---
paths:
  - "CLAUDE.md"
  - ".claude/**"
  - "docs/**"
---

# Writing rules and docs

Follows Anthropic's guidance: https://code.claude.com/docs/en/memory and https://code.claude.com/docs/en/best-practices.

## This file is meta
- It says how to write and where to put a fact, never a fact about the app; an app fact here goes to its own home.
- It obeys itself: every bullet below holds for this file too (shape, one place, budget, `check-rules.sh`).
- Changing how docs are organised (a new kind of doc, a new folder, a new check) starts here: add or edit its line
  under "Where a new fact goes" in the same commit, and teach `scripts/check-rules.sh` to check it when it can.
- Keep this section meta too: when you add a meta rule, say here how the new rule is itself kept honest.
- This file only loads for `CLAUDE.md`, `.claude/**` and `docs/**`: a section that must apply while editing code (like
  "Code comments") also needs a one-line pointer in `CLAUDE.md`, or it is never read where it matters.

## Where a new fact goes
- Derivable by reading the code (file lists, function walkthroughs, dependency lists a script checks) → nowhere.
- A must/never for one area → that area's rule in `.claude/rules/` (the table in `CLAUDE.md` says which).
- Needed on every task → `CLAUDE.md` (keep it ≤100 lines).
- A multi-step procedure → a skill, `.claude/skills/<name>/SKILL.md`.
- The standing brief of a delegated role (what every task of it needs, true on any clone) → `.claude/agents/<name>.md`;
  one person's additions go in their `CLAUDE.local.md` (a same-named user-level agent file is shadowed by the repo's).
- How a part works now, when one read of the code won't tell you → reference material in `docs/` (see below), linked from its rule.
- A choice that ruled out a tempting alternative → one entry in `docs/decisions.md` (see below).
- What happened (incidents, who said what, dates, Task/Phase/R-numbers, measurements of a bug now fixed) → the commit message only. `git log -S` finds it.
- Work not done yet → `docs/TODO.md`: product work only, agreed-but-unstarted work at the top under "Queued", in order;
  delete an item in the commit that does it.
- A design spec or implementation plan → `docs/superpowers/`, only while its work is open, and always named by a
  `docs/TODO.md` item for what of it is left (`check-rules.sh` fails a spec no item names). A commit that builds part of it
  rewrites that item to the remaining part; the commit that finishes the work deletes the spec and moves its still-true
  facts to their homes above (git history keeps the file).
- Every owner request or agreed decision about the app → a `docs/TODO.md` item in the same turn it is agreed, before any
  work or delegation; a chat message, a spec or an agent's brief is never its only record.
- A zero-exception ban → a hook or a permission rule, not prose: hooks in `.claude/settings.json`, their scripts in
  `.claude/hooks/`, quick (well under 2 s) and silent when all is well (`check-rules.sh` checks each named script exists).
- What a user needs to install, start and use the app → `README.md` (see below); never internals or a change log.
- One person's own workflow on their machine (where their notes go, their habits) → `CLAUDE.local.md` (gitignored,
  loaded like `CLAUDE.md` for that checkout only); a tracked file never points at anything that exists only locally.

## Shape (rules)
- One imperative bullet per rule: what to do, not only what to avoid. No CAPS, no "CRITICAL".
- Add a ≤1-line "why" only when it stops a wrong "fix"; name the guard test that pins the behaviour.
- Specific and checkable: name the file, function, setting or test. Grep that it exists before writing it.
- One fact, one place: link to its home, never copy it. Rules must not contradict each other.
- Changing behaviour → edit or delete the old bullet in the same commit. Never append a new section that overrides an old one.
- `<!-- -->` comments are stripped before loading: use them for maintainer notes only.

## `docs/decisions.md`
- One entry per decision, newest first: `### <decision as a short imperative>` then 2–4 lines — the choice, the
  alternative it rules out and why, and where it is enforced (rule file, test). Date it (`2026-11-11`) on the heading line.
- Write it when someone would otherwise "fix" it back: the owner overruled a default, a measured limit, a
  security trade-off. Not for routine choices the code makes obvious.
- Quote the owner only when the quote is the decision; one short line, no transcript.
- A reversed decision: edit its entry to the new choice (say what it replaced in one clause); never keep both.
- Rules link to an entry (`docs/decisions.md` § heading); entries never restate the rule's text.

## Reference material (`docs/player/*.md`, `docs/player/modules/*.md`, other `docs/` walkthroughs)
- Describes the code as it is now: present tense, no dates, no incident stories, no Task/Phase/R-numbers.
- Open with one line naming the code it covers (`src/player/src/sources/`); keep each file to one module or topic.
- Keep only what one read of the code won't give: the contract between parts, invariants, non-obvious why, pitfalls,
  measured numbers that still hold. Drop field-by-field and function-by-function walkthroughs.
- Stale beats missing never: when the code changes, update or cut the paragraph in the same commit; a doc nobody can
  keep true gets deleted. Rules win over reference docs; reference docs never give orders a rule doesn't.
- Measured results and reports (`docs/player/reports/`) are dated snapshots: keep them as data, never cite them as the current state.

## `README.md`
- Written for a person reading top to bottom: what Liascape does for them, how to get it running, everyday use; contributor
  and build detail last and short. Plain sentences, short paragraphs; bullets only for things people scan (commands, keybinds).
- Keep it true, not complete: a change to something it already says (an install step, a command, a feature or setting it
  names, a requirement) updates it in the same commit; a new feature is added only when a user would miss it.
- Never internals (paths under libexec, engine and worker details, pins, tests), dates, history or every setting.

## Code comments
- Say why the code is the way it is when the code can't: the contract, the trap a "simplification" would fall into,
  the measured limit. Name the guard test (`Guard: probe-steam look:dlCentre`) so a reader can check it;
  `check-rules.sh` fails a guard whose probe cell or script doesn't exist.
- No history in comments: no dates, no owner quotes, no R/Phase/Task numbers, no "used to …" stories — those live in
  the commit (`git blame` finds it). A choice the owner made → link its `docs/decisions.md` § heading instead.
- Never describe what the next line plainly does; delete a comment the code made untrue in the same commit.

## Files
- One topic per file, a descriptive name, YAML frontmatter `paths:` (a list of quoted globs) by default.
  Invalid YAML makes a rule load on every task. `paths` is the only field read.
- A scoped rule loads when Claude reads or edits a matching file: glob the code it governs.
- Budget: ≤250 lines and ≤30,000 chars per rule file; reference docs ≤15,000 chars each; `docs/decisions.md` ≤30,000
  chars (past that, merge entries or drop ones the code no longer needs defending). Files over 40,000 chars are truncated when loaded.
- Code comments cite a current rule or doc path (`.claude/rules/…`, `docs/…`), never a deleted one; `check-rules.sh` lists dead citations.
- Write only what a fresh agent on a fresh clone can use: never cite your personal memory, a chat or "as discussed" —
  subagents and other people can't see them; put the fact itself in its home.
- The repo is public: no account names, emails, tokens, IPs, hostnames, serials or other personal details of the owner
  in rules, docs, comments or commit messages. Machine-specific paths only in dated reports, never as instructions.
- Run `bash scripts/check-rules.sh` after editing; run `/doctor prompt-audit` after a big edit if available.
