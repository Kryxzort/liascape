#!/usr/bin/env bash
# Catch the recurring main-thread wedge. Samples the Electron renderer's instantaneous CPU + RSS +
# thread/fd count every ~12s, logs to /tmp/lp-monitor.log. When CPU stays pegged (>140% twice) it
# captures an OS-level snapshot (RSS/threads/fds — these work even when the main thread is wedged and
# CDP can't respond) and exits, so the trajectory leading up to the wedge is preserved for diagnosis.
LOG=/tmp/lp-monitor.log
HZ=$(getconf CLK_TCK)
: > "$LOG"
echo "$(date '+%H:%M:%S') monitor start (HZ=$HZ)" >> "$LOG"

inst_cpu() { # %CPU of pid $1 over $2s (process incl threads: utime+stime)
  local pid=$1 dur=$2 a b
  a=$(awk '{print $14+$15}' /proc/$pid/stat 2>/dev/null) || return 1
  sleep "$dur"
  b=$(awk '{print $14+$15}' /proc/$pid/stat 2>/dev/null) || return 1
  awk -v a="$a" -v b="$b" -v hz="$HZ" -v d="$dur" 'BEGIN{printf "%.0f", (b-a)/hz/d*100}'
}

hi=0
while true; do
  # match LIVEPAPER's renderer specifically via --app-path (NOT any Electron app — Discord/VSCode also
  # spawn "type=renderer", which caused a wrong-process mixup before).
  rpid=$(pgrep -f -- "type=renderer.*app-path=.*livepaper-pro/app/shell" | head -1)
  [ -z "$rpid" ] && { echo "$(date '+%H:%M:%S') no livepaper renderer" >> "$LOG"; sleep 8; continue; }
  cpu=$(inst_cpu "$rpid" 3) || { sleep 8; continue; }
  rss=$(awk '{print int($1*4096/1048576)}' /proc/$rpid/statm 2>/dev/null)   # MB
  thr=$(ls /proc/$rpid/task 2>/dev/null | wc -l)
  fds=$(ls /proc/$rpid/fd 2>/dev/null | wc -l)
  echo "$(date '+%H:%M:%S') pid=$rpid cpu=${cpu}% rss=${rss}MB threads=$thr fds=$fds" >> "$LOG"
  if [ "${cpu:-0}" -gt 130 ]; then
    hi=$((hi+1))
    if [ "$hi" -ge 3 ]; then
      {
        echo "=== WEDGE DETECTED $(date '+%H:%M:%S') pid=$rpid cpu=${cpu}% rss=${rss}MB threads=$thr fds=$fds ==="
        echo "--- per-thread cpu (top consumers) ---"
        top -b -n1 -H -p "$rpid" 2>/dev/null | tail -n +8 | sort -k9 -nr | head -6
        echo "--- wchan (what kernel call) ---"; cat /proc/$rpid/wchan 2>/dev/null; echo
      } >> "$LOG"
      echo "WEDGE_CAPTURED" >> "$LOG"
      exit 0
    fi
  else
    hi=0
  fi
  sleep 9
done
