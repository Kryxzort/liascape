#!/usr/bin/env bash
# One heavy test run at a time on this machine: the UI matrix runs 6 Electron shards, the player suite saturates the
# cores, and the live benchmark measures frame times; two at once make every timing- and count-based check meaningless
# (a load average of 3-4x the cores was seen with two agents' matrices overlapping). A second run doesn't fail: it waits
# its turn and says who holds the lock.
#
#   . scripts/test-lock.sh                    # at the top of a test script: hold the lock until the script exits
#   bash scripts/test-lock.sh <command …>     # run anything else under it (cargo test, scripts/bench-live-ui.mjs, …)
#
# LIASCAPE_TEST_LOCK_HELD=1 in the environment = an outer run holds it already (a suite that calls another one).
# LIASCAPE_TEST_LOCK=<path> overrides the lock file (default: $XDG_RUNTIME_DIR/liascape-tests.lock).
#
# The lock is held by a small helper beside the run, never by the run's own shell: an open lock fd is inherited by every
# child, and a child that outlives the run (dotnet's VBCSCompiler build server, a backend) would hold the lock for
# minutes with nothing behind it. The helper watches the run's pid and lets go within half a second of it exiting.

__lt_lock() {
  [ -n "${LIASCAPE_TEST_LOCK_HELD:-}" ] && return 0
  local f=${LIASCAPE_TEST_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/liascape-tests.lock} run=$$ ready
  ready=$(mktemp -u "${TMPDIR:-/tmp}/liascape-lock.XXXXXX")
  ( exec 9>>"$f"; flock 9 || exit 1; : >"$ready"
    while kill -0 "$run" 2>/dev/null; do sleep 0.5; done ) </dev/null >/dev/null 2>&1 &
  local helper=$!
  disown 2>/dev/null || true
  local t0=$SECONDS said=""
  while [ ! -e "$ready" ]; do
    if [ -z "$said" ] && [ $((SECONDS - t0)) -ge 1 ]; then
      echo "test-lock: waiting for another test run — $(cat "$f.who" 2>/dev/null || echo unknown)" >&2; said=1
    fi
    kill -0 "$helper" 2>/dev/null || [ -e "$ready" ] || { echo "test-lock: couldn't take $f" >&2; return 1; }
    sleep 0.2
  done
  rm -f "$ready"
  [ -n "$said" ] && echo "test-lock: got it after $((SECONDS - t0)) s" >&2
  echo "pid $run since $(date +%T): ${__lt_what:-$0}" >"$f.who"
  export LIASCAPE_TEST_LOCK_HELD=1 LIASCAPE_TEST_LOCK="$f"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  __lt_what="$0 $*"; __lt_lock
else
  [ $# -gt 0 ] || { echo "usage: bash scripts/test-lock.sh <command …>  (or source it from a test script)" >&2; exit 2; }
  __lt_what="$*"; __lt_lock
  exec "$@"
fi
