# Sourced by the test scripts (scripts/test-*.sh, the on-machine batteries): ONE rule for a test's temp folder.
#   - it is removed when the run ends, pass, fail or interrupt (call lp_tmp_done from the EXIT trap);
#   - LIASCAPE_KEEP_TMP=1 keeps it whole and the last line says where;
#   - a FAILED run keeps only what a human reads (*.log, *.png, *.jsonl, *.txt up to 20 MB) under a new /tmp/liascape-fail-*
#     folder (or the folder given as the 4th argument) and the last line says where.
# It deletes the folder outright, not with `trash`: trash on /tmp moves it into /tmp/.Trash-<uid> on the same disk, which
# frees nothing (103 GB of dead test folders piled up there). Only the folder the script itself made is touched, and only
# when its path starts with the prefix the script's own mktemp used.
#
#   . "$ROOT/scripts/test-tmp.sh"
#   cleanup() { rc=$?; trap - EXIT INT TERM HUP; …stop processes…; lp_tmp_done "$T" /tmp/liascape-xx- "$rc"; }

# lp_tmp_done DIR PREFIX RC [FAILDIR [EXCLUDE]]   (EXCLUDE: a path under DIR, like ./out, whose files the caller keeps itself)
lp_tmp_done() {
  local d=$1 pre=$2 rc=${3:-0} dest=${4:-} ex=${5:-./.none} k
  case "$d" in "$pre"?*) ;; *) return 0 ;; esac
  case "$d" in *..*) return 0 ;; esac
  [ -d "$d" ] && [ ! -L "$d" ] || return 0
  if [ -n "${LIASCAPE_KEEP_TMP:-}" ]; then echo "kept $d (LIASCAPE_KEEP_TMP)"; return 0; fi
  # A user manager run inside the folder (test-backend-stop's unit case) leaves mode-000 entries under its runtime dir
  # (systemd/inaccessible/*) that neither the artefact copy nor rm can get past. chmod -R never follows a symlink, so
  # nothing outside the folder changes.
  chmod -R u+rwx -- "$d" 2>/dev/null
  if [ "$rc" != 0 ]; then
    k=${dest:-$(mktemp -d /tmp/liascape-fail-XXXXXX)}
    mkdir -p "$k" 2>/dev/null
    ( cd "$d" && find . -type f \( -name '*.log' -o -name '*.log.[0-9]*' -o -name '*.png' -o -name '*.jsonl' -o -name '*.txt' \) \
        -size -20480k -not -path './backend/*' -not -path './ui/*' -not -path "$ex/*" -print0 | xargs -0 -r cp --parents -t "$k" ) 2>/dev/null
    if [ -z "$dest" ] && [ -z "$(ls -A "$k" 2>/dev/null)" ]; then rmdir "$k" 2>/dev/null; k=""; fi
    rm -rf -- "$d"
    [ -n "$k" ] && echo "failure artefacts kept in $k"
  else
    rm -rf -- "$d"
  fi
  return 0
}
