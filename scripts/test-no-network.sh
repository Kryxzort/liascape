# Sourced by the test scripts whose backends run in the session's own network (no `unshare -rn`): they export
# LIASCAPE_TEST_NO_NETWORK=1 (src/backend/Helpers/TestNetwork.cs: every outbound connection but loopback is refused before
# it is made, logging "test-network: REFUSED <call>") and end on lp_real_network, so a call to a real server fails the
# run ("FAIL real network") instead of quietly reaching Steam or a wallpaper site. A real anonymous Steam session counts
# too, should one ever open past the guard.
#
#   . "$ROOT/scripts/test-no-network.sh"
#   export LIASCAPE_TEST_NO_NETWORK=1
#   …
#   rn=$(lp_real_network "$T"); [ -z "$rn" ] && ok "no real network" || { bad "real network: …"; echo "$rn"; }

# lp_real_network DIR… → one line per distinct call (count + call) found in any *.log under DIR; nothing = none
lp_real_network() {
  grep -rhaE --include='*.log' --include='*.log.[0-9]*' 'test-network: REFUSED|steam-cm: connected \+ logged on anonymously' "$@" 2>/dev/null \
    | sed -E 's/^.*(REFUSED |steam-cm: )//; s/ — LIASCAPE_TEST_NO_NETWORK.*$//' | sort | uniq -c | sed 's/^ */     /'
}

# A suite that enters its own network namespace (scripts/test-netns.sh) runs these two first thing inside it:
#   lp_netns_entered                                      removes the folder test-netns.sh wrote its files to (bound in place by now)
#   lp_no_lookup "<the suite's last line on a failure>" || exit 1
# lp_no_lookup ends the suite at once when a name still resolves inside it (it isn't in the namespace, or the namespace
# lets lookups out): nothing such a run finds would count.
lp_netns_entered() {
  case "${LIASCAPE_NETNS:-}" in /tmp/liascape-ns-*) rm -rf -- "$LIASCAPE_NETNS" ;; esac
}
# Only getent's own "not found" (exit 2, nothing printed) counts: a lookup that timed out, or a getent that failed some
# other way, never showed that the name has no answer.
lp_no_lookup() {
  local a rc; a=$(timeout 20 getent hosts example.com 2>&1); rc=$?
  if [ $rc = 2 ] && [ -z "$a" ]; then echo "  ok   no name lookup: example.com has no answer inside the suite"; return 0; fi
  if [ -n "$a" ] && [ $rc = 0 ]; then
    echo "  FAIL name lookup: example.com answered inside the suite (${a%%$'\n'*}): it must run in scripts/test-netns.sh's namespace"
  else
    echo "  FAIL name lookup: getent hosts example.com ended with $rc${a:+ ($a)}, not \"not found\": the lookup proved nothing"
  fi
  echo "$1"; return 1
}
