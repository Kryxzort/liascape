#!/usr/bin/env python3
"""Phase 3 on-machine battery (programs.sh): numbers from the player's own event file.

  programs_report.py events   <events dir> <t0> <t1> [kind prefix]      → JSON array of the events in [t0, t1]
  programs_report.py switches <events dir> <t0> <t1>                    → the rotation in [t0, t1] (counts, spacing, origins)
  programs_report.py dropout  <events dir> <t0> <t1> <cell> <method> <records.jsonl>
                                                                        → one dropout cell's summary (+ one record per switch)

t0/t1 are wall-clock epoch seconds (`date +%s.%N`); an event's time is its `t_wall`. The files are
`events.2.jsonl`, `events.1.jsonl`, `events.jsonl` (the log's rotation, oldest first). A compositor restart
starts a new segment (`t_mono_ms` restarts); the player clock (`at_ms`) is compared within a segment only.
"""
import json
import os
import statistics
import sys
from datetime import datetime, timezone


def wall(s):
    # RFC3339 with nanoseconds, UTC 'Z' → epoch seconds
    s = s.rstrip("Z")
    head, _, frac = s.partition(".")
    t = datetime.strptime(head, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    return t + (float("0." + frac) if frac else 0.0)


def load(d, t0=None, t1=None, prefix=None):
    out = []
    seg = 0
    last_mono = -1.0
    for name in ("events.2.jsonl", "events.1.jsonl", "events.jsonl"):
        p = os.path.join(d, name)
        if not os.path.exists(p):
            continue
        with open(p, errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                mono = e.get("t_mono_ms") or 0.0
                if mono + 1000 < last_mono:  # a new process
                    seg += 1
                last_mono = mono
                if "t_wall" not in e:
                    continue
                e["_w"] = wall(e["t_wall"])
                e["_seg"] = seg
                if t0 is not None and e["_w"] < t0:
                    continue
                if t1 is not None and e["_w"] > t1:
                    continue
                if prefix and not e.get("kind", "").startswith(prefix):
                    continue
                out.append(e)
    return out


def kind_of(path):
    if not path:
        return "?"
    low = path.lower()
    if low.endswith((".png", ".jpg", ".jpeg", ".webp")):
        return "I"
    if "/workshop/content/" in path or "/scenes/" in path or not os.path.splitext(path)[1]:
        return "S"
    return "V"


def pctl(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


def switches(d, t0, t1):
    ev = load(d, t0, t1)
    cur = [e for e in ev if e["kind"] == "program.current"]
    sch = [e for e in ev if e["kind"] == "transition.scheduled"]
    spacing = []
    for a, b in zip(cur, cur[1:]):
        if a["_seg"] == b["_seg"] and "at_ms" in a and "at_ms" in b:
            spacing.append(b["at_ms"] - a["at_ms"])
    hist = lambda xs: {k: xs.count(k) for k in sorted(set(xs))}
    warn = [e["kind"] for e in ev if e.get("level") in ("warn", "error")]
    return {
        "window_s": round(t1 - t0, 1),
        "currents": len(cur),
        "reasons": hist([e.get("reason") for e in cur]),
        "spacing_ms": {
            "n": len(spacing),
            "min": round(min(spacing), 1) if spacing else None,
            "median": round(statistics.median(spacing), 1) if spacing else None,
            "max": round(max(spacing), 1) if spacing else None,
        },
        "scheduled": len(sch),
        "origins": hist([e.get("origin") for e in sch]),
        "aligns": hist([e.get("align") for e in sch]),
        "parked": sum(1 for e in sch if e.get("parked")),
        "done": sum(1 for e in ev if e["kind"] == "transition.done"),
        "failed": sum(1 for e in ev if e["kind"] == "transition.failed"),
        "cancelled": hist([e.get("reason") for e in ev if e["kind"] == "transition.cancelled"]),
        "program_failed": sum(1 for e in ev if e["kind"] == "program.failed"),
        "player_started": sum(1 for e in ev if e["kind"] == "player.started"),
        "segments": sorted({e["_seg"] for e in ev}),
        "warn": hist(warn),
        "paths": [e.get("path") for e in cur],
        "current_events": [{k: e.get(k) for k in ("t_wall", "at_ms", "reason", "path", "index", "corr")} for e in cur],
    }


def dropout(d, t0, t1, cell, method, recs_path):
    ev = load(d, t0, None)  # probe.dropout may land after t1
    win = [e for e in ev if e["_w"] <= t1]
    by_corr = {}
    for e in ev:
        c = e.get("corr")
        if c:
            by_corr.setdefault(c, []).append(e)
    sch = [e for e in win if e["kind"] == "transition.scheduled" and str(e.get("origin", "")).startswith("program:")]
    ended = [e for e in ev if e["kind"] == "source.ended"]
    cur = [e for e in win if e["kind"] == "program.current" and e.get("reason") != "play"]
    first_play = next((e.get("corr") for e in win if e["kind"] == "program.current" and e.get("reason") == "play"), None)
    recs = []
    for s in sch:
        corr = s["corr"]
        if corr == first_play:
            continue  # the cell's first play (from the previous cell's picture) is not counted
        es = by_corr.get(corr, [])
        k = lambda name: next((e for e in es if e["kind"] == name), None)
        st, ho, dn, fl, cn = k("transition.started"), k("transition.handoff"), k("transition.done"), k("transition.failed"), k("transition.cancelled")
        pd = next((e for e in es if e["kind"] == "probe.dropout"), None)
        rep = (pd or {}).get("report")
        a = ((st or {}).get("a") or [{}])[0] if st else {}
        b = (st or {}).get("b") or {}
        d_pred = d_ended = None
        if st and ho and s.get("align") == "end" and a.get("duration"):
            speed = a.get("speed") or 1.0
            pred = st["start_ms"] + (a["duration"] - (a.get("position") or 0.0)) * 1000.0 / speed
            d_pred = ho["at_ms"] - pred
            en = [e for e in ended if e.get("id") == a.get("id") and st["_w"] - 1 <= e["_w"] <= ho["_w"] + 2]
            if en:
                d_ended = (ho["_w"] - en[0]["_w"]) * 1000.0
        recs.append({
            "cell": cell, "method": method, "corr": corr, "align": s.get("align"), "effect": s.get("effect_id"),
            "dir": f"{kind_of(a.get('path'))}→{kind_of(b.get('path') or s.get('path'))}",
            "outcome": "done" if dn else ("failed" if fl else ("cancelled:" + str(cn.get("reason")) if cn else "none")),
            "skipped": (pd or {}).get("skipped"),
            "analysed": rep is not None,
            "drops": len(rep["drops"]) if rep else None,
            "micro_gaps": len(rep["micro_gaps"]) if rep else None,
            "unmeasured": len(rep.get("unmeasured") or []) if rep else None,
            "fit": rep.get("fit") if rep else None, "fit_db": rep.get("fit_db") if rep else None,
            "lag_ms": rep.get("lag_ms") if rep else None,
            "drop_list": rep["drops"] if rep else [], "gap_list": rep["micro_gaps"] if rep else [],
            "handoff_vs_a_end_pred_ms": round(d_pred, 2) if d_pred is not None else None,
            "handoff_vs_a_ended_ms": round(d_ended, 2) if d_ended is not None else None,
            "a_path": a.get("path"), "b_path": b.get("path") or s.get("path"),
        })
    with open(recs_path, "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
    done = [r for r in recs if r["outcome"] == "done"]
    an = [r for r in done if r["analysed"]]
    fit_bad = [r for r in an if r["fit"] not in (None, "ok")]
    hist = lambda xs: {k: xs.count(k) for k in sorted(set(map(str, xs)))}
    dp = [abs(r["handoff_vs_a_end_pred_ms"]) for r in done if r["handoff_vs_a_end_pred_ms"] is not None]
    de = [abs(r["handoff_vs_a_ended_ms"]) for r in done if r["handoff_vs_a_ended_ms"] is not None]
    # F3: `source.ended` fires as A's last frame is presented; the handoff is due one clip frame
    # (30 fps) after it — this is the distance from that due instant (signed: + = held, − = cut).
    dl = [r["handoff_vs_a_ended_ms"] - 1000.0 / 30.0 for r in done if r["handoff_vs_a_ended_ms"] is not None]
    return {
        "cell": cell, "method": method, "scheduled": len(recs), "done": len(done), "commits": len(cur),
        "reasons": hist([e.get("reason") for e in cur]),
        "outcomes": hist([r["outcome"] for r in recs]),
        "dirs": hist([r["dir"] for r in done]),
        "aligns": hist([r["align"] for r in done]),
        "analysed": len(an),
        "skipped": hist([r["skipped"] for r in done if not r["analysed"]]),
        "drops": sum(r["drops"] for r in an), "micro_gaps": sum(r["micro_gaps"] for r in an),
        "unmeasured": sum(r["unmeasured"] for r in an),
        "fit_insufficient": len(fit_bad),
        "worst_fit_db": round(max([r["fit_db"] for r in an if r["fit_db"] is not None] or [0]), 2),
        "align_end_n": len(dp),
        "handoff_vs_a_end_pred_max_ms": round(max(dp), 2) if dp else None,
        "handoff_vs_a_end_pred_p95_ms": round(pctl(dp, 0.95), 2) if dp else None,
        "handoff_vs_a_ended_n": len(de),
        "handoff_vs_a_ended_max_ms": round(max(de), 2) if de else None,
        "handoff_vs_a_ended_p95_ms": round(pctl(de, 0.95), 2) if de else None,
        "handoff_vs_a_last_frame_min_ms": round(min(dl), 2) if dl else None,
        "handoff_vs_a_last_frame_max_ms": round(max(dl), 2) if dl else None,
    }


def main():
    cmd, d = sys.argv[1], sys.argv[2]
    t0, t1 = float(sys.argv[3]), float(sys.argv[4])
    if cmd == "events":
        ev = load(d, t0, t1, sys.argv[5] if len(sys.argv) > 5 else None)
        print(json.dumps(ev))
    elif cmd == "switches":
        print(json.dumps(switches(d, t0, t1)))
    elif cmd == "dropout":
        print(json.dumps(dropout(d, t0, t1, sys.argv[5], sys.argv[6], sys.argv[7])))
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
