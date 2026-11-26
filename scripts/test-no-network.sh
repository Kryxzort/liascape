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
