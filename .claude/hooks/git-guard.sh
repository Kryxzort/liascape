#!/usr/bin/env bash
# PreToolUse (Bash): refuses `git stash`, `git add -A` / `--all` / `.` and `git commit -a` / `--all`. Agents share one
# stash stack and one checkout's index can hold another agent's edits: a sweep commits or hides work that isn't the
# committer's. Stage files by name instead. The command is split the way the shell would (quotes, `;` `&&` `|`, new
# lines), so message text (`-m "… --all …"`) is never read as an option. A command it can't split passes.
# Guard: scripts/test-land-agent.sh
exec python3 -I -c '
import json, shlex, sys
try:
    cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command") or ""
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()\n")
    lex.whitespace = " \t\r"; lex.whitespace_split = True
    toks = list(lex)
except Exception:
    sys.exit(0)
GLOBAL_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
VALUE = {"-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--reuse-message",
         "--reedit-message", "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file"}
def refused(args):
    i = 0
    while i < len(args) and args[i].startswith("-"):          # global options before the subcommand
        i += 2 if args[i] in GLOBAL_ARG else 1
    if i >= len(args): return False
    sub, rest = args[i], args[i + 1:]
    if sub == "stash": return True
    if sub == "add": return any(a in ("-A", "--all", ".") for a in rest)
    if sub == "commit":
        j = 0
        while j < len(rest):
            a = rest[j]
            if a == "--": break
            if a == "--all": return True
            if a in VALUE: j += 2; continue
            if a.startswith("-") and not a.startswith("--"):
                for k, ch in enumerate(a[1:]):                # -vam msg: -a before the value letter
                    if ch == "a": return True
                    if ch in "mFCct": break
            j += 1
    return False
seg = []
for t in toks + [";"]:
    if t and set(t) <= set(";&|()\n"):
        for n, w in enumerate(seg):
            if w == "git" or w.endswith("/git"):
                if refused(seg[n + 1:]):
                    print("git-guard: refused — no git stash, git add -A / --all / ., or git commit -a here (they sweep up"
                          " other agents\x27 work); stage files by name (git add <file>…) and commit those", file=sys.stderr)
                    sys.exit(2)
                break
        seg = []
    else:
        seg.append(t)
sys.exit(0)
'
