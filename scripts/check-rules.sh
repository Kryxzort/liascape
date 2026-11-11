#!/usr/bin/env bash
# Checks the agent-facing rules against .claude/rules/writing-rules.md:
#  - every .claude/rules/**/*.md starts with YAML frontmatter whose only key is `paths:` = a list of quoted globs
#    (invalid YAML would make Claude Code load the rule on every task), each glob matching a tracked file;
#  - every rule file is ≤ 250 lines and ≤ 30,000 chars; CLAUDE.md ≤ 100 lines; reference docs (docs/player/*.md, modules) ≤ 15,000 chars, docs/decisions.md ≤ 30,000; every SKILL.md has name + description;
#  - every backticked repo path in CLAUDE.md, the rules and the skills exists (exact, a tracked directory, a glob, or
#    a suffix of a tracked path such as `hooks/useLinger.ts`; runtime and build-output paths are skipped);
#  - no "see memory X" pointers (auto memory is invisible to subagents);
#  - no dead citations: every `.claude/rules/….md` or `docs/….md` path named in any tracked or new text file (code
#    comments included) exists — one problem per missing path, with its count and the files citing it.
# Uses PyYAML when installed; otherwise a strict parser for the one allowed shape (any file it accepts is valid YAML).
# Usage: bash scripts/check-rules.sh    Exit 0 = clean; prints every problem.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2
exec python3 -I - "$ROOT" <<'PY'
import fnmatch, glob, os, re, subprocess, sys
root = sys.argv[1]
os.chdir(root)
tracked = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True).stdout.split("\0")
tracked = [t for t in tracked if t]
tracked_set = set(tracked)
tops = {t.split("/")[0] for t in tracked}
dirs = {os.path.dirname(t) for t in tracked}
for t in list(dirs):
    while t:
        t = os.path.dirname(t); dirs.add(t)
try:
    import yaml
except ImportError:
    yaml = None
problems = []
def bad(f, msg): problems.append(f"{f}: {msg}")

def braces(p):
    m = re.search(r"\{([^{}]*)\}", p)
    if not m: return [p]
    return [x for alt in m.group(1).split(",") for x in braces(p[:m.start()] + alt + p[m.end():])]

def glob_matches(g):
    out = []
    for pat in braces(g):
        rx = re.compile("^" + re.escape(pat).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*").replace(r"\?", "[^/]") + "$")
        out += [t for t in tracked if rx.match(t)]
    return out

def frontmatter(f, text):
    if not text.startswith("---\n"):
        bad(f, "no YAML frontmatter (a rule without `paths:` loads on every task)"); return None
    end = text.find("\n---\n", 4)
    if end < 0: bad(f, "unterminated frontmatter"); return None
    block = text[4:end]
    if yaml:
        try: data = yaml.safe_load(block)
        except Exception as e: bad(f, f"invalid YAML: {e}"); return None
        if not isinstance(data, dict) or set(data) != {"paths"} or not isinstance(data["paths"], list) \
           or not all(isinstance(p, str) and p for p in data["paths"]):
            bad(f, "frontmatter must be exactly `paths:` with a list of glob strings"); return None
        return data["paths"]
    lines = block.split("\n")
    if lines[0] != "paths:": bad(f, "frontmatter must start with `paths:`"); return None
    globs = []
    for ln in lines[1:]:
        m = re.fullmatch(r'  - "([^"\\]+)"', ln)
        if not m: bad(f, f"frontmatter line not of the form `  - \"<glob>\"`: {ln!r}"); return None
        globs.append(m.group(1))
    if not globs: bad(f, "empty `paths:`"); return None
    return globs

PATHISH = re.compile(r"^[A-Za-z0-9_.@\-]+(/[A-Za-z0-9_.@\-*{},]*)+$")
def path_exists(p):
    p = p.rstrip("/")
    if p in tracked_set or p in dirs or os.path.exists(p): return True
    if any(c in p for c in "*{?"): return bool(glob_matches(p))
    return any(t.endswith("/" + p) for t in tracked) or any(d.endswith("/" + p) for d in dirs)

def check_paths(f, text):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    for tok in re.findall(r"`([^`\n]+)`", text):
        for word in tok.split():
            w = word.strip("'\",;()")
            if "/" not in w or not PATHISH.match(w) or w.startswith(("http", "/")): continue
            # Only repo paths: under a tracked top-level entry, or a name with an extension (a suffix such as
            # `hooks/useLinger.ts`). Runtime paths (`workshop/<id>`), build outputs and mpv property paths are skipped.
            if w.split("/")[0] not in tops and not re.search(r"\.[A-Za-z]{1,5}$", w.rstrip("/*")): continue
            if not path_exists(w): bad(f, f"backticked path does not exist: {w}")
    for m in re.finditer(r"(?i)see memory|memory `|auto[- ]memory file", text):
        bad(f, f"memory pointer (invisible to subagents): …{text[max(0, m.start()-30):m.end()+30]!r}…")

rule_files = sorted(glob.glob(".claude/rules/**/*.md", recursive=True))
for f in rule_files:
    text = open(f, encoding="utf-8").read()
    lines, chars = text.count("\n"), len(text)
    if lines > 250: bad(f, f"{lines} lines > 250")
    if chars > 30000: bad(f, f"{chars} chars > 30,000")
    globs = frontmatter(f, text)
    for g in globs or []:
        if not glob_matches(g): bad(f, f"paths glob matches no tracked file: {g}")
    check_paths(f, text)
    print(f"{f}: {lines} lines, {chars} chars, paths: {', '.join(globs or [])}")

text = open("CLAUDE.md", encoding="utf-8").read()
if text.count("\n") > 100: bad("CLAUDE.md", f"{text.count(chr(10))} lines > 100")
check_paths("CLAUDE.md", text)
print(f"CLAUDE.md: {text.count(chr(10))} lines, {len(text)} chars")

# Doc budgets (writing-rules.md § Files): reference docs ≤ 15,000 chars, the decision log ≤ 30,000. Reports and spikes
# under docs/player/ are dated data, not reference material, so they're exempt.
if os.path.exists("docs/decisions.md"):
    n = len(open("docs/decisions.md", encoding="utf-8").read())
    if n > 30000: bad("docs/decisions.md", f"{n} chars > 30,000")
for f in sorted(glob.glob("docs/player/*.md") + glob.glob("docs/player/modules/*.md")):
    n = len(open(f, encoding="utf-8").read())
    if n > 15000: bad(f, f"{n} chars > 15,000 (reference doc)")

for f in sorted(glob.glob(".claude/skills/*/SKILL.md")):
    t = open(f, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---\n", t, re.S)
    if not m or not re.search(r"^name: \S", m.group(1), re.M) or not re.search(r"^description: \S", m.group(1), re.M):
        bad(f, "skill frontmatter needs `name:` and `description:`")
    check_paths(f, t)
    print(f"{f}: {t.count(chr(10))} lines")

# Dead citations: every `.claude/rules/….md` / `docs/….md` path named in a tracked (or new, not ignored) text file —
# code comments, docs, rules — must exist. One problem per missing path, with its count and where it is cited.
listed = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                        capture_output=True, text=True, check=True).stdout.split("\0")
CITE = re.compile(r"(?<![\w./-])((?:\.claude/rules|docs)/[\w./-]*[\w-]\.md)\b")
SKIP_DIRS = ("node_modules/", "target/", "bin/", "obj/", "dist/", ".git/")
dead = {}
for f in sorted(set(listed)):
    if not f or any(("/" + f).find("/" + d) >= 0 for d in SKIP_DIRS) or not os.path.isfile(f): continue
    try:
        with open(f, "rb") as fh: raw = fh.read()
    except OSError: continue
    if b"\0" in raw[:8192]: continue
    for p in CITE.findall(raw.decode("utf-8", "replace")):
        if not os.path.exists(p): dead.setdefault(p, []).append(f)
for p, where in sorted(dead.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    files = sorted(set(where))
    bad(p, f"dead citation: {len(where)}× in {len(files)} file(s): {', '.join(files[:6])}{' …' if len(files) > 6 else ''}")
print(f"dead citations: {len(dead)} missing path(s), {sum(len(w) for w in dead.values())} citation(s)")

if not yaml: print("(PyYAML not installed: frontmatter checked with the strict built-in parser)")
for p in problems: print("PROBLEM " + p)
print(f"RESULT problems={len(problems)}")
sys.exit(1 if problems else 0)
PY
