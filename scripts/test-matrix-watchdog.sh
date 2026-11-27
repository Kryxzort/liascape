#!/usr/bin/env bash
# Hermetic test of the UI matrix runner's limits (scripts/test-ui-matrix.sh): a cell that never answers (probe-matrix.js
# `mx:hang`, present only with LIASCAPE_MATRIX_TEST_HANG=1; its Electron ignores SIGTERM, as a wedged one can) must
# never hold a run, or the lock, for good. Cases, each on its own matrix stacks:
#   hang:    --jobs 2 over mx:hang, mx:passA, mx:passB (shard 0 runs mx:hang then mx:passB) with a 45 s cell limit → the
#            run reports `ERROR idle × mx:hang` with its log lines, mx:passB still runs and passes on the restarted
#            Electron, the run ends in time with a failure
#   ceiling: one stack, mx:hang, the cell limit out of reach and LIASCAPE_MATRIX_RUN_LIMIT short → the run ends at its
#            ceiling with an error naming it
#   term:    one stack, SIGTERM to the run while mx:hang runs → it ends within seconds (its Electron KILLed after 5 s)
#   kill:    one stack, SIGKILL to the run while mx:hang runs → the lock goes at once, the stack is reaped
# After each: the run's lock is free and no process of its stacks is left. The runs take a lock file of their own (this
# script holds the machine's), so "free" is checked on theirs.
# Usage: bash scripts/test-matrix-watchdog.sh [--no-build]   Needs what test-ui-matrix.sh needs (the devShell).
# LIASCAPE_KEEP_TMP=1 keeps the temp folder. Last line `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"
. "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
BUILD=1; [ "${1:-}" = --no-build ] && BUILD=0
T=$(mktemp -d /tmp/liascape-mxwd-XXXXXX)
RUNPID=""
# a case's run still going (it failed a check by not ending): TERM, KILL after 12 s, then everything any case's stacks
# started (they carry LIASCAPE_MATRIX_OUT under $T) — the runner under test may be what doesn't stop
stop_run() {
  local p
  if [ -n "$RUNPID" ] && kill -0 "$RUNPID" 2>/dev/null; then
    kill -TERM "$RUNPID"; for _ in $(seq 1 60); do kill -0 "$RUNPID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$RUNPID" 2>/dev/null; wait "$RUNPID" 2>/dev/null
  fi
  RUNPID=""
  p=$(grep -lz "^LIASCAPE_MATRIX_OUT=$T/" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3)
  if [ -n "$p" ]; then kill -TERM $p 2>/dev/null; kill -CONT $p 2>/dev/null; sleep 3; kill -KILL $p 2>/dev/null; fi
  return 0
}
cleanup() {
  rc=$?; trap - EXIT INT TERM HUP
  stop_run
  lp_tmp_done "$T" /tmp/liascape-mxwd- "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
pass=0; fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1${3:+ — $3}"; fi; }

if [ $BUILD = 1 ]; then
  echo "== build"
  (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  dotnet build "$ROOT/src/backend" -nologo -v q >/dev/null || { echo "dotnet build failed"; exit 2; }
fi
(cd "$ROOT/app/ui" && node node_modules/vite/bin/vite.js build --outDir "$T/ui" --emptyOutDir --logLevel error) || { echo "vite build failed"; exit 2; }

# a run of the matrix runner in the background: start_run <case> [VAR=value …] -- <its arguments>. Its own lock file, the
# test cells on, results under $T/<case>
start_run() {
  local name=$1 envs=(); shift
  stop_run
  while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  mkdir -p "$T/$name"
  env -u LIASCAPE_TEST_LOCK_HELD LIASCAPE_TEST_LOCK="$T/$name/lock" LIASCAPE_MATRIX_TEST_HANG=1 LIASCAPE_MATRIX_OUT="$T/$name/out" "${envs[@]}" \
    bash "$ROOT/scripts/test-ui-matrix.sh" --no-build --ui-dir "$T/ui" "$@" >"$T/$name/run.log" 2>&1 &
  RUNPID=$!; T0=$(date +%s)
}
# waits up to $1 s for the run to end → its exit code in RC, its time in SECS (RC empty: still running after $1 s)
end_run() {
  RC=""
  for _ in $(seq 1 $(( $1 * 5 ))); do kill -0 "$RUNPID" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$RUNPID" 2>/dev/null; then SECS=$(( $(date +%s) - T0 )); return; fi
  wait "$RUNPID"; RC=$?; SECS=$(( $(date +%s) - T0 )); RUNPID=""
}
# the lock's helper lets go within half a second of its run ending: free within 2 s
lock_free() { for _ in $(seq 1 10); do flock -n "$T/$1/lock" true && return 0; sleep 0.2; done; return 1; }
# processes started for the case: every one of its stacks carries LIASCAPE_MATRIX_OUT (a shard's: <out>/shard-i)
leftovers() {
  local p
  for p in $(grep -lz "^LIASCAPE_MATRIX_OUT=$T/$1/out" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); do
    echo "$p $(tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline" | cut -c1-80)"
  done
}
# waits up to $2 s for case $1 to leave no process
no_leftovers() { for _ in $(seq 1 $(( $2 * 5 ))); do [ -z "$(leftovers "$1")" ] && return 0; sleep 0.2; done; return 1; }
# waits up to $2 s for case $1's mx:hang to be running (its Electron ignoring SIGTERM from then on)
cell_started() { for _ in $(seq 1 $(( $2 * 5 ))); do [ -e "$T/$1/out/mx-hang.started" ] && return 0; sleep 0.2; done; return 1; }

echo "== hang: --jobs 2, a 45 s cell limit (above the 20 s a cell's own page load may wait)"
start_run hang LIASCAPE_MATRIX_CELL_LIMIT=45 -- --jobs 2 --only 'idle × mx:'
end_run 400
L=$T/hang/run.log
check "hang: the run ended (in ${SECS} s, at most 400)" "$([ -n "$RC" ]; echo $?)"
check "hang: the run failed (exit $RC)" "$([ -n "$RC" ] && [ "$RC" != 0 ]; echo $?)"
check "hang: the shard names the cell as an ERROR" "$(grep -q '^\[0\] ERROR idle × mx:hang$' "$L"; echo $?)"
check "hang: with its last log lines" "$(grep -A3 '^\[0\] ERROR idle × mx:hang$' "$L" | grep -q 'last log lines:'; echo $?)"
check "hang: its Electron ignored TERM and was KILLed" "$(grep -q '^\[0\]         its Electron ignored TERM: KILLed after 5 s$' "$L"; echo $?)"
check "hang: the failures list names it" "$(grep -A1 '^== failures' "$L" | grep -q '^ERROR idle × mx:hang'; echo $?)"
check "hang: the cell after it on the same shard ran and passed" "$(grep -q '^\[0\] PASS  idle × mx:passB$' "$L"; echo $?)"
check "hang: the other shard's cell passed" "$(grep -q '^\[1\] PASS  idle × mx:passA$' "$L"; echo $?)"
check "hang: the summary counts one error, two passes" "$(grep -q '^MATRIX pass=2 fail=0 error=1 ' "$L"; echo $?)"
hung_ms=$(jq -r 'select(.control == "mx:hang") | .ms' "$T/hang/out/cells.jsonl" 2>/dev/null)
check "hang: cells.jsonl records it at the 45 s limit ($hung_ms ms)" "$([ "$hung_ms" = 45000 ]; echo $?)"
check "hang: the lock is free within 2 s" "$(lock_free hang; echo $?)"
check "hang: nothing of its stacks is left" "$(no_leftovers hang 10; echo $?)" "$(leftovers hang | head -3 | tr '\n' ';')"

echo "== ceiling: one stack, LIASCAPE_MATRIX_RUN_LIMIT=150, the cell limit out of reach"
start_run ceiling LIASCAPE_MATRIX_CELL_LIMIT=900 LIASCAPE_MATRIX_RUN_LIMIT=150 -- --jobs 1 --only 'idle × mx:hang'
end_run 240
check "ceiling: the run ended (in ${SECS} s; ceiling 150 s counted from its stack's start)" "$([ -n "$RC" ] && [ "$SECS" -lt 200 ]; echo $?)"
check "ceiling: exit 4 (exit $RC)" "$([ "$RC" = 4 ]; echo $?)"
check "ceiling: it says so" "$(grep -q '^ERROR: the run passed its ceiling of 150 s' "$T/ceiling/run.log"; echo $?)"
check "ceiling: the lock is free within 2 s" "$(lock_free ceiling; echo $?)"
check "ceiling: nothing of its stack is left" "$(no_leftovers ceiling 10; echo $?)" "$(leftovers ceiling | head -3 | tr '\n' ';')"

for sig in TERM KILL; do
  c=$(echo "$sig" | tr A-Z a-z)
  echo "== $c: SIG$sig to a one-stack run inside mx:hang"
  start_run "$c" LIASCAPE_MATRIX_CELL_LIMIT=900 -- --jobs 1 --only 'idle × mx:hang'
  if ! cell_started "$c" 180; then check "$c: the stack reached its cell" 1 "$(tail -n 3 "$T/$c/run.log" | tr '\n' ';')"; continue; fi
  n=$(leftovers "$c" | wc -l)
  check "$c: its stack's processes are seen before the signal ($n; none would prove nothing)" "$([ "$n" -ge 4 ]; echo $?)"
  kill -"$sig" "$RUNPID"; T0=$(date +%s)
  end_run 30
  check "$c: the run ended (in ${SECS} s after SIG$sig, at most 15)" "$([ -n "$RC" ] && [ "$SECS" -le 15 ]; echo $?)"
  check "$c: the lock is free within 2 s" "$(lock_free "$c"; echo $?)"
  check "$c: nothing of its stack is left within 10 s" "$(no_leftovers "$c" 10; echo $?)" "$(leftovers "$c" | head -3 | tr '\n' ';')"
done

echo "RESULT pass=$pass fail=$fail"
[ "$fail" = 0 ]
