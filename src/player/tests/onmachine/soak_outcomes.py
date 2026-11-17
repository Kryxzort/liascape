#!/usr/bin/env python3
"""Outcome bookkeeping for scenes.sh's soak step (one record per switch, keyed by its corr).

  live <corr>                      stdin: a `ctl logs {"corr":..}` reply -> one outcome record on stdout
  reread <events.jsonl> <outcomes> re-reads every non-terminal record from the player's own event log, in place;
                                   prints {"reread": n, "resolved": n}
  summary <outcomes>               prints {"counts", "bad", "late", "reread", "total", "text"}

A record: {corr, outcome, latency_ms, reason?, source: "live"|"reread"}. `outcome` is a transition.* kind, or
"unknown" (the ctl call failed/was empty, `reason` says why), or "none" (the log held no transition event).
Terminal kinds are the ones src/player/src/recipes/transition.rs ends a switch with: done, failed, cancelled.
Only `transition.done` passes; `late` (done, but > LATE_MS after scheduling) is information, not a failure.
"""
import json
import sys

TERMINAL = {"transition.done", "transition.failed", "transition.cancelled"}
LATE_MS = 30_000


def judge(events):
    """The outcome fields for one corr's transition.* events (any order)."""
    sched = next((e["at_ms"] for e in events if e.get("kind") == "transition.scheduled" and "at_ms" in e), None)
    term = [e for e in events if e.get("kind") in TERMINAL]
    if term:
        t = term[-1]
        lat = round(t["at_ms"] - sched, 1) if sched is not None and "at_ms" in t else None
        return {"outcome": t["kind"], "latency_ms": lat}
    last = events[-1].get("kind") if events else None
    return {"outcome": last or "none", "latency_ms": None}


def read_jsonl(path):
    with open(path) as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                pass  # a half-written last line


def cmd_live(corr):
    evs = json.load(sys.stdin).get("events", [])
    print(json.dumps({"corr": corr, **judge(evs), "source": "live"}))


def cmd_reread(events_path, outcomes_path):
    recs = list(read_jsonl(outcomes_path))
    need = {r["corr"] for r in recs if r["outcome"] not in TERMINAL}
    by = {c: [] for c in need}
    if need:
        for e in read_jsonl(events_path):
            if e.get("corr") in by and str(e.get("kind", "")).startswith("transition."):
                by[e["corr"]].append(e)
    resolved = 0
    for r in recs:
        if r["corr"] in need:
            j = judge(by[r["corr"]])
            r.pop("reason", None)
            r.update(j, source="reread")
            if j["outcome"] in TERMINAL:
                resolved += 1
            else:
                r["reason"] = "no terminal event in the player's event log"
    with open(outcomes_path, "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
    print(json.dumps({"reread": len(need), "resolved": resolved}))


def cmd_summary(outcomes_path):
    recs = list(read_jsonl(outcomes_path))
    counts = {}
    for r in recs:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    bad = sum(1 for r in recs if r["outcome"] != "transition.done")
    late = sum(1 for r in recs if r["outcome"] == "transition.done" and (r.get("latency_ms") or 0) > LATE_MS)
    reread = sum(1 for r in recs if r.get("source") == "reread")
    lats = [r["latency_ms"] for r in recs if r.get("latency_ms") is not None]
    cs = " ".join(f"{n} {k}" for k, n in sorted(counts.items()))
    text = f"{bad} of {len(recs)} not transition.done ({cs}); {late} late (> {LATE_MS // 1000} s)"
    if lats:
        text += f"; max latency {max(lats) / 1000:.1f} s"
    print(json.dumps({"counts": counts, "bad": bad, "late": late, "reread": reread, "total": len(recs), "text": text}))


if __name__ == "__main__":
    cmds = {"live": cmd_live, "reread": cmd_reread, "summary": cmd_summary}
    cmds[sys.argv[1]](*sys.argv[2:])
