#!/usr/bin/env bash
# PostToolUse (Edit / Write / MultiEdit): after an edit under docs/ or .claude/, or to CLAUDE.md, run that checkout's
# scripts/check-rules.sh. Silent when clean; its problems go to Claude (exit 2) when not. The checkout is the edited
# file's own, so an agent in a worktree checks its tree, not the main one ($CLAUDE_PROJECT_DIR stays the main checkout).
# Guard: scripts/test-land-agent.sh
read -r -d '' f < <(python3 -c '
import json, os, sys
d = json.load(sys.stdin); f = (d.get("tool_input") or {}).get("file_path") or ""
print(f if not f or os.path.isabs(f) else os.path.join(d.get("cwd") or ".", f), end="")' 2>/dev/null)
[ -n "${f:-}" ] || exit 0
dir=$(dirname "$f"); while [ ! -d "$dir" ]; do dir=$(dirname "$dir"); done
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
case "${f#"$top"/}" in docs/*|.claude/*|CLAUDE.md) ;; *) exit 0 ;; esac
[ -f "$top/scripts/check-rules.sh" ] || exit 0
out=$(bash "$top/scripts/check-rules.sh" 2>&1) && exit 0
{ echo "scripts/check-rules.sh after editing ${f#"$top"/}:"; grep -E '^PROBLEM ' <<<"$out" || tail -n 5 <<<"$out"; } >&2
exit 2
