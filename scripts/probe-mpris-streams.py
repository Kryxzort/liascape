#!/usr/bin/env -S python3 -I
"""Feasibility probe: link MPRIS players to PipeWire output streams (read-only).

Stdlib only, plus `busctl` and `pw-dump` subprocesses. Run as: python3 -I scripts/probe-mpris-streams.py [--json]
Rules, in order (liascape phase-3 Task 14): pid-tree, app-id, name.
"""
import json, os, re, subprocess, sys


def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout


def bus_json(*args):
    rc, out = run("busctl", "--user", "--json=short", *args)
    if rc != 0 or not out.strip():
        return None
    try:
        return json.loads(out)["data"]
    except Exception:
        return None


def prop(name, iface, p):
    d = bus_json("get-property", name, "/org/mpris/MediaPlayer2", iface, p)
    return d


def mpris_players():
    rc, out = run("busctl", "--user", "--json=short", "list")
    names = [n["name"] for n in json.loads(out) if n["name"].startswith("org.mpris.MediaPlayer2.")]
    players = []
    for n in names:
        pid = bus_json("call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
                       "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", n)
        if not pid:  # activatable-only (playerctld) has no owner
            continue
        md = prop(n, "org.mpris.MediaPlayer2.Player", "Metadata") or {}
        title = (md.get("xesam:title") or {}).get("data")
        players.append(dict(bus=n, pid=pid[0],
                            desktop=prop(n, "org.mpris.MediaPlayer2", "DesktopEntry"),
                            identity=prop(n, "org.mpris.MediaPlayer2", "Identity"),
                            status=prop(n, "org.mpris.MediaPlayer2.Player", "PlaybackStatus"),
                            title=title))
    return players


def streams():
    rc, out = run("pw-dump")
    res = []
    dump = json.loads(out)
    # native-PipeWire clients (mpv's pw ao, liascape-player) carry the pid on the Client object, not the node
    clients = {o["id"]: (o.get("info") or {}).get("props") or {} for o in dump if o.get("type", "").endswith(":Client")}
    for o in dump:
        p = dict((o.get("info") or {}).get("props") or {})
        if p.get("media.class") == "Stream/Output/Audio":
            cp = clients.get(p.get("client.id"), {})
            for k in ("application.process.id", "application.process.binary", "pipewire.sec.pid", "pipewire.sec.flatpak.app_id"):
                if k in cp and k not in p:
                    p[k] = cp[k]
            if "application.process.id" not in p and "pipewire.sec.pid" in p:
                p["application.process.id"] = p["pipewire.sec.pid"]
        if p.get("media.class") != "Stream/Output/Audio":
            continue
        mute, vols = None, None
        for pr in ((o["info"].get("params") or {}).get("Props") or []):
            if "mute" in pr:
                mute = pr["mute"]
            if "channelVolumes" in pr:
                vols = [round(v, 3) for v in pr["channelVolumes"]]
        pid = p.get("application.process.id")
        res.append(dict(id=o["id"],
                        pid=int(pid) if pid is not None else None,
                        binary=p.get("application.process.binary"),
                        app=p.get("application.name"),
                        appid=p.get("pipewire.access.portal.app_id") or p.get("application.id")
                              or p.get("pipewire.sec.flatpak.app_id") or p.get("pipewire.access.portal.flatpak_app_id"),
                        sandboxed=p.get("pipewire.sec.flatpak") or p.get("pipewire.access.portal.is_portal"),
                        media=p.get("media.name"), mute=mute, vols=vols,
                        client=p.get("client.id"), node=p.get("node.name")))
    return res


def ppid(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            s = f.read()
        return int(s[s.rindex(")") + 2:].split()[1])
    except Exception:
        return None


def in_tree(root, pid):
    """True when pid is root or a descendant of it (walk up from the stream's pid)."""
    seen = 0
    while pid and pid > 1 and seen < 64:
        if pid == root:
            return True
        pid = ppid(pid)
        seen += 1
    return False


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def match(pl, st):
    if st["pid"] and in_tree(pl["pid"], st["pid"]):
        return "pid-tree"
    d = norm(pl["desktop"])
    if d and st["appid"] and (d == norm(st["appid"]) or d in norm(st["appid"]) or norm(st["appid"]) in d):
        return "app-id"
    for cand in (pl["desktop"], pl["identity"]):
        c = norm(cand)
        if not c:
            continue
        for s in (st["binary"], st["app"]):
            n = norm(s)
            if n and (n == c or c in n or n in c):
                return "name"
    return None


def main():
    pls, sts = mpris_players(), streams()
    out = dict(players=pls, streams=sts, matches=[])
    for pl in pls:
        hits = [(match(pl, st), st["id"]) for st in sts]
        hits = [(r, i) for r, i in hits if r]
        out["matches"].append(dict(player=pl["bus"], rules=hits or [("none", None)]))
    if "--json" in sys.argv:
        print(json.dumps(out, indent=1))
        return
    print("== MPRIS players")
    for pl in pls:
        print(f"  {pl['bus']} pid={pl['pid']} desktop={pl['desktop']} identity={pl['identity']} "
              f"status={pl['status']} title={pl['title']!r}")
    print("== PipeWire output streams")
    for s in sts:
        print(f"  #{s['id']} pid={s['pid']} (ppid={ppid(s['pid']) if s['pid'] else None}) bin={s['binary']} "
              f"app={s['app']!r} appid={s['appid']} media={s['media']!r} mute={s['mute']} vol={s['vols']}")
    print("== matches")
    for m in out["matches"]:
        print(f"  {m['player']}: " + ", ".join(f"{r}->#{i}" for r, i in m["rules"]))
        pl = next(p for p in pls if p["bus"] == m["player"])
        for r, i in m["rules"]:
            if i is not None:
                st = next(s for s in sts if s["id"] == i)
                t = norm(pl["title"])
                mn = norm(st["media"])
                print(f"     media.name~title: {bool(t and mn and (t in mn or mn in t))}")


main()
