#!/usr/bin/env bash
# The first process of every hermetic suite's network namespace: it closes the ways a name lookup leaves the namespace,
# brings loopback up, then becomes the suite.
#
#   timeout -k 10 300 unshare -rnm bash "$ROOT/scripts/test-netns.sh" "$T" bash "${BASH_SOURCE[0]}"
#
# (any extra unshare flags too: -C, -pf --mount-proc; it needs its own network AND mount namespace, and fails rather
# than run the suite without them). DIR is the suite's temp folder; its files go in DIR/netns.
#
# `unshare -rn` alone stops sockets, not lookups: glibc asks nscd's socket (/run/nscd/socket) before its own resolver,
# and nscd — NixOS's nsncd — answers from the host's network, outside the namespace, so `example.com` resolved inside a
# suite reached the real DNS. nss modules that ask a daemon over a unix socket (mdns → avahi, mymachines → machined)
# leak the same way. So, in this mount namespace only (the host's files are never touched):
#  - /run/nscd is an empty folder: no socket, glibc resolves by itself;
#  - /etc/nsswitch.conf resolves hosts by `files dns` only (/etc/hosts keeps `localhost` for the fake servers);
#  - /etc/resolv.conf names only 127.0.0.1, where nothing listens unless a suite runs a fake DNS server there
#    (test-card-pictures.sh's answers in 500 ms, inside the 5 s timeout): with none, a lookup is refused at once.
# Guard: scripts/test-hermetic-dns.sh; scripts/check-rules.sh fails a scripts/*.sh `unshare -…n…` that skips this file.
set -eu
[ $# -ge 2 ] || { echo "usage: unshare -rnm … bash scripts/test-netns.sh DIR COMMAND [ARG…]" >&2; exit 2; }
D=$1/netns; shift
mkdir -p "$D/no-nscd"
printf 'nameserver 127.0.0.1\noptions timeout:5 attempts:2\n' > "$D/resolv.conf"
if [ -e /etc/nsswitch.conf ]; then
  sed -E 's/^hosts:.*/hosts: files dns/' /etc/nsswitch.conf > "$D/nsswitch.conf"
  grep -q '^hosts:' "$D/nsswitch.conf" || echo 'hosts: files dns' >> "$D/nsswitch.conf"
fi
# outside its own network namespace this fails (an unprivileged user can't change the host's loopback)
ip link set lo up || { echo "test-netns: not in a network namespace of its own (unshare -rnm …)" >&2; exit 2; }
# and these outside its own mount namespace
fail() { echo "test-netns: can't $1 (run under unshare -rnm …)" >&2; exit 2; }
# (no resolv.conf: glibc asks 127.0.0.1 anyway; no nsswitch.conf: its built-in `dns files` asks no daemon)
[ ! -e /etc/resolv.conf ] || mount --bind "$D/resolv.conf" /etc/resolv.conf || fail "replace /etc/resolv.conf"
[ ! -e /etc/nsswitch.conf ] || mount --bind "$D/nsswitch.conf" /etc/nsswitch.conf || fail "replace /etc/nsswitch.conf"
[ ! -d /run/nscd ] || mount --bind "$D/no-nscd" /run/nscd || fail "hide /run/nscd"
exec "$@"
