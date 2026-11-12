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

__lt_lock() {
  [ -n "${LIASCAPE_TEST_LOCK_HELD:-}" ] && return 0
  local f=${LIASCAPE_TEST_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/liascape-tests.lock}
  exec 9>>"$f"
  if ! flock -n 9; then
    local who; who=$(cat "$f.who" 2>/dev/null || echo unknown)
    echo "test-lock: waiting for another test run — $who" >&2
    # the children a run starts inherit the lock: a run that has exited but left one behind (a backend, an Electron) still
    # holds it — name them rather than wait forever on nothing
    local pid=${who#pid }; pid=${pid%% *}
    if [[ $pid =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "test-lock: that run has exited; still holding the lock: $(fuser "$f" 2>/dev/null | xargs -r ps -o pid=,comm= -p | tr '\n' ' ')" >&2
    fi
    local t0=$SECONDS
    flock 9
    echo "test-lock: got it after $((SECONDS - t0)) s" >&2
  fi
  echo "pid $$ since $(date +%T): ${__lt_what:-$0}" >"$f.who"
  export LIASCAPE_TEST_LOCK_HELD=1 LIASCAPE_TEST_LOCK="$f"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  __lt_what="$0 $*"; __lt_lock
else
  [ $# -gt 0 ] || { echo "usage: bash scripts/test-lock.sh <command …>  (or source it from a test script)" >&2; exit 2; }
  __lt_what="$*"; __lt_lock
  exec "$@"
fi
