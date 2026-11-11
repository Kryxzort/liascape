---
paths:
  - "CLAUDE.md"
  - ".claude/**"
  - "docs/**"
---

# Writing rules and docs

Follows Anthropic's guidance: https://code.claude.com/docs/en/memory and https://code.claude.com/docs/en/best-practices.

## Where a new fact goes
- Derivable by reading the code (file lists, function walkthroughs, dependency lists a script checks) → nowhere.
- A must/never for one area → that area's rule in `.claude/rules/` (the table in `CLAUDE.md` says which).
- Needed on every task → `CLAUDE.md` (keep it ≤100 lines).
- A multi-step procedure → a skill, `.claude/skills/<name>/SKILL.md`.
- Rationale, measurements, module walkthroughs, design notes → `docs/` (`docs/player/`), linked from the rule.
- What happened, who said what, dates, Task/Phase/R-numbers → the commit message or `docs/history/<area>.md`.
- A zero-exception ban → a hook or a permission rule, not prose.

## Shape
- One imperative bullet per rule: what to do, not only what to avoid. No CAPS, no "CRITICAL".
- Add a ≤1-line "why" only when it stops a wrong "fix"; name the guard test that pins the behaviour.
- Specific and checkable: name the file, function, setting or test. Grep that it exists before writing it.
- One fact, one place: link to its home, never copy it. Rules must not contradict each other.
- Changing behaviour → edit or delete the old bullet in the same commit. Never append a new section that overrides an old one.
- `<!-- -->` comments are stripped before loading: use them for maintainer notes only.

## Files
- One topic per file, a descriptive name, YAML frontmatter `paths:` (a list of quoted globs) by default.
  Invalid YAML makes a rule load on every task. `paths` is the only field read.
- A scoped rule loads when Claude reads or edits a matching file: glob the code it governs.
- Budget: ≤250 lines and ≤30,000 chars per rule file. Files over 40,000 chars are truncated when loaded.
- Subagents do not see auto memory: never point a rule at "memory X"; put the fact here.
- Run `bash scripts/check-rules.sh` after editing; run `/doctor prompt-audit` after a big edit if available.
