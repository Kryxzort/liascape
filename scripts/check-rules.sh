#!/usr/bin/env bash
# Checks the agent-facing rules against .claude/rules/writing-rules.md:
#  - every .claude/rules/**/*.md starts with YAML frontmatter whose only key is `paths:` = a list of quoted globs
#    (invalid YAML would make Claude Code load the rule on every task), each glob matching a tracked file;
#  - every rule file is ≤ 250 lines and ≤ 30,000 chars; CLAUDE.md ≤ 100 lines; reference docs (docs/player/*.md, modules) ≤ 15,000 chars, docs/decisions.md ≤ 30,000; every SKILL.md and .claude/agents/*.md has name + description;
#  - .claude/settings.json parses and every hook script it runs exists;
#  - every backticked repo path in CLAUDE.md, the rules and the skills exists (exact, a tracked directory, a glob, or
#    a suffix of a tracked path such as `hooks/useLinger.ts`; runtime and build-output paths are skipped);
#  - no "see memory X" pointers (auto memory is invisible to subagents); no emails / real IPs in rules and docs (public repo);
#  - code paths named in rules, reference docs and the README exist (plans, specs, spikes, reports exempt).
#  - guards resolve: every `Guard: probe-<area> <cell>` names a cell in that probe, every `Guard: scripts/….sh` exists.
#  - no dead citations: every `.claude/rules/….md` or `docs/….md` path named in any tracked or new text file (code
#    comments included) exists — one problem per missing path, with its count and the files citing it.
#  - every scripts/*.sh that runs in `unshare -…n…` enters it through scripts/test-netns.sh (no name lookup leaves it).
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
    personal(f, text)

# The repo is public (writing-rules.md § Files): no emails or real IP addresses in the agent-facing text. Loopback, link-local (the SSRF examples),
# unspecified and documentation-range examples are fine; dated reports, upstream patches and credits aren't scanned.
OK_IP = re.compile(r"^(127\.|169\.254\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)")
def personal(f, text):
    for m in re.finditer(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}", text):
        if m.group().endswith(("@anthropic.com", "@users.noreply.github.com")): continue
        bad(f, f"email address in public text: {m.group()}")
    for m in re.finditer(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])", text):
        if not OK_IP.match(m.group(1)): bad(f, f"IP address in public text: {m.group(1)}")

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

for f in ["docs/decisions.md"] + sorted(glob.glob("docs/player/*.md") + glob.glob("docs/player/modules/*.md")):
    if os.path.exists(f): personal(f, open(f, encoding="utf-8").read())

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

# Agent definitions (.claude/agents/*.md) load like a skill: `name:` and `description:`, and the paths they name exist.
for f in sorted(glob.glob(".claude/agents/*.md")):
    t = open(f, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---\n", t, re.S)
    if not m or not re.search(r"^name: \S", m.group(1), re.M) or not re.search(r"^description: \S", m.group(1), re.M):
        bad(f, "agent frontmatter needs `name:` and `description:`")
    check_paths(f, t)
    personal(f, t)
    print(f"{f}: {t.count(chr(10))} lines")

# The repo's Claude Code settings parse (a broken file drops every hook silently) and each hook's script exists.
if os.path.exists(".claude/settings.json"):
    import json
    try:
        st = json.load(open(".claude/settings.json", encoding="utf-8"))
        cmds = [h.get("command", "") for groups in (st.get("hooks") or {}).values() for g in groups for h in g.get("hooks", [])]
        for c in cmds:
            for sp in re.findall(r"\$\{?CLAUDE_PROJECT_DIR\}?/([\w./-]+)", c):
                if not os.path.isfile(sp): bad(".claude/settings.json", f"a hook runs a missing script: {sp}")
        print(f".claude/settings.json: {len(cmds)} hook(s)")
    except (ValueError, AttributeError, TypeError) as e:
        bad(".claude/settings.json", f"not valid settings JSON: {e}")

# Dead citations: every `.claude/rules/….md` / `docs/….md` path named in a tracked (or new, not ignored) text file —
# code comments, docs, rules — must exist, unless git ignores the path. One problem per missing path, with its count and where it is cited.
listed = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                        capture_output=True, text=True, check=True).stdout.split("\0")
CITE = re.compile(r"(?<![\w./-])((?:\.claude/rules|docs)/[\w./-]*[\w-]\.md)\b")
SKIP_DIRS = ("node_modules/", "target/", "bin/", "obj/", "dist/", ".git/")
dead = {}
# a gitignored path (a checkout's own notes, like docs/NIGHT-NOTES.md) exists only in some checkouts: citing it is fine,
# and a fresh clone or a worktree without it is no dead citation
_ign = {}
def ignored(p):
    if p not in _ign: _ign[p] = subprocess.run(["git", "check-ignore", "-q", p]).returncode == 0
    return _ign[p]
for f in sorted(set(listed)):
    if not f or any(("/" + f).find("/" + d) >= 0 for d in SKIP_DIRS) or not os.path.isfile(f): continue
    try:
        with open(f, "rb") as fh: raw = fh.read()
    except OSError: continue
    if b"\0" in raw[:8192]: continue
    for p in CITE.findall(raw.decode("utf-8", "replace")):
        if not os.path.exists(p) and not ignored(p): dead.setdefault(p, []).append(f)
for p, where in sorted(dead.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    files = sorted(set(where))
    bad(p, f"dead citation: {len(where)}× in {len(files)} file(s): {', '.join(files[:6])}{' …' if len(files) > 6 else ''}")
print(f"dead citations: {len(dead)} missing path(s), {sum(len(w) for w in dead.values())} citation(s)")

# Guards: a `Guard: probe-<area> <cell>` comment names a cell that exists in app/shell/probe-<area>.js (a templated cell
# like `icon:centre:<scene>` counts when its fixed parts are there), and a `Guard: scripts/<suite>.sh …` names a script
# that exists. A guard that names nothing pins nothing, and a reader trusting it skips the check it thinks exists.
GUARD = re.compile(r"Guard:[^\n]*")
G_PROBE = re.compile(r"\b(probe-[a-z]+)(?:\.js)?\s+`?([\w:*.\-|]+)`?")
G_SCRIPT = re.compile(r"\b(scripts/[\w.-]+\.sh)\b")
_probe = {}
def cell_found(body, cell):
    c = cell.rstrip('.').split('*')[0].rstrip(':')
    if not c or c in body: return True
    segs = c.split(':')
    if len(segs) > 1 and (':'.join(segs[:-1]) + ':') in body and segs[-1] in body: return True
    return len(segs[-1]) >= 6 and segs[-1] in body
nguards = 0
for f in sorted(set(listed)):
    if not f or f.startswith('docs/') or any(('/' + f).find('/' + d) >= 0 for d in SKIP_DIRS) or not os.path.isfile(f): continue
    try:
        with open(f, 'rb') as fh: raw = fh.read()
    except OSError: continue
    if b'\0' in raw[:8192] or b'Guard:' not in raw: continue
    for g in GUARD.findall(raw.decode('utf-8', 'replace')):
        for sp in G_SCRIPT.findall(g):
            nguards += 1
            if not os.path.exists(sp): bad(f, f'guard names a missing script: {sp}')
        for pr, cell in G_PROBE.findall(g):
            nguards += 1
            pf = f'app/shell/{pr}.js'
            if not os.path.exists(pf): bad(f, f'guard names a missing probe: {pr}'); continue
            if pf not in _probe:
                with open(pf, encoding='utf-8', errors='replace') as fh: _probe[pf] = fh.read()
            if not cell_found(_probe[pf], cell): bad(f, f'guard names a cell {pr} lacks: {cell}')
print(f'guards: {nguards} checked')

# Code paths in the rules, reference docs and README (`scripts/….sh`, `src/…/x.rs`, `app/shell/probe-x.js`) exist: a rule
# that sends an agent to a moved file costs it a search, and a README command that names a deleted script fails for a
# user. Plans and specs (they name files still to be written), spikes and dated reports are exempt.
CODE = re.compile(r"(?<![\w./-])((?:scripts|app/shell|app/ui/src|src/[\w-]+)/[\w./-]*[\w-]\.(?:sh|mjs|js|ts|tsx|cs|rs))\b")
ncode = 0
for f in sorted(set(listed)):
    if not f.endswith('.md') or not (f in ('CLAUDE.md', 'README.md') or f.startswith(('.claude/', 'docs/'))): continue
    if re.match(r'docs/(superpowers|player/spikes|player/reports)/', f) or not os.path.isfile(f): continue
    with open(f, encoding='utf-8', errors='replace') as fh: text = fh.read()
    for cp in CODE.findall(text):
        ncode += 1
        if not os.path.exists(cp) and not ignored(cp): bad(f, f'names a code path that does not exist: {cp}')
print(f'code paths in docs: {ncode} checked')

# Every open spec or plan under docs/superpowers/ is named by docs/TODO.md: work that lives only in a spec gets forgotten
# (an owner-approved sidebar design was half built and its rest dropped out of sight for days). A spec is deleted when its
# work is done; until then a TODO item says what of it is left.
with open('docs/TODO.md', encoding='utf-8', errors='replace') as fh: todo_text = fh.read()
nspec = 0
for f in sorted(set(listed)):
    if not re.match(r'docs/superpowers/.+\.md$', f) or not os.path.isfile(f): continue
    nspec += 1
    if f not in todo_text and os.path.basename(f) not in todo_text:
        bad(f, 'an open spec or plan that docs/TODO.md does not name: add the item for what of it is left, or delete it if done')
print(f'open specs and plans: {nspec} checked against docs/TODO.md')

# A hermetic suite's network namespace starts with scripts/test-netns.sh: `unshare -rn` alone leaves name lookups going
# through the host's nscd socket (and nss daemons), which answer from the real network. Guard: scripts/test-hermetic-dns.sh.
nns = 0
for f in sorted(set(listed)):
    if not re.match(r'scripts/[^/]+\.sh$', f) or f == 'scripts/test-netns.sh' or not os.path.isfile(f): continue
    with open(f, encoding='utf-8', errors='replace') as fh: code = [l for l in fh if not l.lstrip().startswith('#')]
    # each invocation on its own: the helper on its line or the continuation line after it
    for i, l in enumerate(code):
        if not re.search(r'\bunshare\s+-[A-Za-z]*n', l): continue
        nns += 1
        if not any('scripts/test-netns.sh' in x for x in code[i:i + 2]):
            bad(f, f'`{l.strip()[:80]}` runs in `unshare -…n…` without scripts/test-netns.sh: a name looked up inside reaches the host\'s nscd and the real DNS')
print(f'network namespaces: {nns} unshare calls checked for scripts/test-netns.sh')

# Every hermetic suite that starts a backend (the dll, or its CLI: `liascape-backend`) or an Electron (`$ELECTRON`, the
# one name the suites start it by) runs in that namespace: the backend's own LIASCAPE_TEST_NO_NETWORK guard covers only
# its own connections, not Electron, ffmpeg, mpv or the player beside it. Text, not tracing: a suite that started one
# under another name would pass unseen, so a new way to start either one belongs in these two patterns.
starts = re.compile(r'\bliascape-backend\b|\$\{?ELECTRON\b')
nsuite = 0
for f in sorted(set(listed)):
    if not re.match(r'scripts/test-[^/]+\.sh$', f) or not os.path.isfile(f): continue
    with open(f, encoding='utf-8', errors='replace') as fh: code = [l for l in fh if not l.lstrip().startswith('#')]
    if not any(starts.search(l) for l in code): continue
    nsuite += 1
    if not any(re.search(r'\bunshare\s+-[A-Za-z]*n', l) for l in code):
        bad(f, 'starts a backend or an Electron outside a network namespace: enter it through scripts/test-netns.sh (.claude/rules/testing.md § No network)')
print(f'network namespaces: {nsuite} suites that start a backend or an Electron checked for one')

if not yaml: print("(PyYAML not installed: frontmatter checked with the strict built-in parser)")
for p in problems: print("PROBLEM " + p)
print(f"RESULT problems={len(problems)}")
sys.exit(1 if problems else 0)
PY
