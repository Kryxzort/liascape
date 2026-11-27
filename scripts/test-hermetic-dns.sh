#!/usr/bin/env bash
# Hermetic test of the hermetic wrapper itself: a name looked up inside a test's network namespace gets no answer.
# glibc asks nscd's socket (/run/nscd/socket) before its own resolver, and nscd (or NixOS's nsncd) answers from the
# host's network, outside the namespace; nss modules that talk to a daemon over a unix socket (mdns via avahi,
# mymachines via machined) would too. Inside the wrapper every suite uses, both lookups must fail within a few seconds:
#  getent:  `getent hosts example.com` (glibc's getaddrinfo, as curl, ffmpeg and mpv resolve)
#  dotnet:  System.Net.Dns.GetHostAddresses("example.com") (the backend's own resolver path)
#  local:   `localhost` still resolves (/etc/hosts: the suites' fake servers listen on it)
#  hidden:  nscd's socket, up on the host, isn't there inside (a host without nscd: SKIP, proved nothing; the lookups still count)
#
# Usage: scripts/test-hermetic-dns.sh   LIASCAPE_KEEP_TMP=1 keeps the temp folder.
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), getent, timeout. Last line `RESULT pass=N fail=M skip=K`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
NAME=example.com
if [ -z "${LIASCAPE_HDNS_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip getent timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  T=$(mktemp -d /tmp/liascape-hdns-XXXXXX)
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-hdns- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  # the .NET probe, built here (the namespace has no network for a restore)
  mkdir -p "$T/dns"
  cat > "$T/dns/dns.cs" <<'CS'
var sw = System.Diagnostics.Stopwatch.StartNew();
try { var a = System.Net.Dns.GetHostAddresses(args[0]); Console.WriteLine($"ANSWER {string.Join(' ', a.Select(x => x.ToString()))}"); return 0; }
catch (Exception e) { Console.WriteLine($"FAILED {e.GetType().Name}: {e.Message}"); return 1; }
CS
  DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$DOTNET" build "$T/dns/dns.cs" -o "$T/dns/out" -nologo -v q > "$T/dns/build.log" 2>&1 \
    || { cat "$T/dns/build.log"; echo "ABORT: can't build the .NET lookup"; exit 2; }
  NSCD=0; [ -S /run/nscd/socket ] && NSCD=1
  export DOTNET LIASCAPE_HDNS_T=$T LIASCAPE_HDNS_NSCD=$NSCD
  timeout -k 10 120 unshare -rnm bash "$ROOT/scripts/test-netns.sh" "$T" bash "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_HDNS_T
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
ms() { echo $(( $(date +%s%N) / 1000000 )); }
BUDGET=5000   # glibc's own resolver gives up at once on a refused port; nscd's answer, or a real DNS timeout, is what fails

SKIP=0
if [ "$LIASCAPE_HDNS_NSCD" = 1 ]; then
  [ ! -e /run/nscd/socket ] && ok "nscd's socket, up on the host, is hidden inside" || bad "nscd's socket is reachable inside the namespace"
else   # a pass here would prove nothing; failing would fail every machine without nscd
  echo "SKIP  nscd's socket hidden: no nscd on this host — proved nothing here (the lookups below still count)"; SKIP=1
fi

t0=$(ms); out=$(timeout 30 getent hosts "$NAME" 2>&1); rc=$?; dt=$(( $(ms) - t0 ))
[ $rc != 0 ] && [ -z "$out" ] && [ $dt -lt $BUDGET ] && ok "getent hosts $NAME: no answer (rc $rc, ${dt} ms)" \
  || bad "getent hosts $NAME: rc $rc in ${dt} ms, answered: ${out:-nothing}"

t0=$(ms); out=$(timeout 30 "$DOTNET" "$T/dns/out/dns.dll" "$NAME" 2>&1); rc=$?; dt=$(( $(ms) - t0 ))
case "$out" in
  FAILED*) [ $dt -lt $((BUDGET + 3000)) ] && ok ".NET Dns.GetHostAddresses($NAME): no answer (${dt} ms incl. start: ${out#FAILED })" \
             || bad ".NET Dns.GetHostAddresses($NAME): failed, but only after ${dt} ms" ;;
  *) bad ".NET Dns.GetHostAddresses($NAME): rc $rc in ${dt} ms: ${out:-nothing}" ;;
esac

out=$(timeout 10 getent hosts localhost 2>&1)
[ -n "$out" ] && ok "localhost still resolves (${out%%$'\n'*})" || bad "localhost doesn't resolve inside the namespace"

echo "RESULT pass=$PASS fail=$FAIL skip=$SKIP"
[ $FAIL = 0 ]
