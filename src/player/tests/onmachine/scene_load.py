#!/usr/bin/env python3
"""Scene load time, apply to first frame, split into phases, on a PRIVATE headless player.

    bash scripts/test-lock.sh python3 src/player/tests/onmachine/scene_load.py \
        --scene ~/.local/share/Steam/steamapps/workshop/content/431960/3042492564 [--scene …] \
        [--rounds 3] [--warm 3] [--bin src/player/target/release] [--out DIR]

Per round and scene, against one `serve --headless` started with fresh private cache dirs:
  cold    the first apply ever: empty NVIDIA shader disk cache and toGlsl cache, and the scene's files, WE's
          assets, the worker and its LWE core dropped from the page cache (posix_fadvise DONTNEED: clean pages
          only, no root; pages another process maps stay, as after a boot);
  warm    the same scene applied again (--warm times), a new worker each time, every cache full;
  boot    the files dropped again with the shader caches kept: the first apply after a reboot.
Each apply creates the source and shows it on the output (a cut) at t0, then times on the client's clock the
events the player streams: `worker.spawned`, `worker.ready` (the worker's Hello: exec, link, EGL), and
`source.ready` (the first latched frame). The worker's log tail adds its own split: `lwe: loaded … in` (context
+ project) and `built in`, and, with a core built with phase timers, their JSON lines. A load the hang detector
killed counts its `restarts` instead of a split. One JSON line per apply goes to <out>/records.jsonl, a summary
(medians per scene and mode) to stdout.

Isolation: own XDG_RUNTIME_DIR / STATE / CACHE / CONFIG and socket under --out, no WAYLAND_DISPLAY / DISPLAY,
PipeWire and Pulse pointed at nothing, LIASCAPE_PLAYER_VRAM_PROBE=none. HOME stays real (WE's assets are found
through Steam). It kills only the serve it started.
"""

import argparse
import json
import os
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent.parent


class Client:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(path))
        self.buf = b""
        self.n = 0

    def lines(self, timeout):
        """Yields (client time, parsed line) until `timeout` seconds pass with nothing."""
        self.sock.settimeout(timeout)
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                yield time.monotonic(), json.loads(line)
            try:
                chunk = self.sock.recv(1 << 20)
            except socket.timeout:
                return
            if not chunk:
                return
            self.buf += chunk

    def call(self, cmd, args=None, timeout=10.0):
        self.n += 1
        req = {"id": self.n, "cmd": cmd}
        if args is not None:
            req["args"] = args
        self.sock.sendall((json.dumps(req) + "\n").encode())
        for _, msg in self.lines(timeout):
            if msg.get("id") == self.n:
                if not msg.get("ok"):
                    raise RuntimeError(f"{cmd}: {msg.get('error')}")
                return msg.get("result")
        raise RuntimeError(f"{cmd}: no reply")


def evict(paths):
    """Drops each file's clean pages from the page cache; returns the bytes it asked about."""
    total = 0
    for root in paths:
        root = Path(root)
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for f in files:
            try:
                fd = os.open(f, os.O_RDONLY)
            except OSError:
                continue
            try:
                total += os.fstat(fd).st_size
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            finally:
                os.close(fd)
    return total


def core_of(worker):
    out = subprocess.run(["ldd", str(worker)], capture_output=True, text=True).stdout
    m = re.search(r"(\S*liblinux-wallpaperengine-core\.so\S*) => (\S+)", out)
    return Path(m.group(2)).resolve() if m else None


class Player:
    def __init__(self, bindir, priv, outputs):
        self.bin = bindir / "liascape-player"
        self.priv = priv
        for d in ("state", "cache", "config"):
            (priv / d).mkdir(parents=True, exist_ok=True)
        # a unix socket path must stay under 108 bytes: the runtime dir is a short one of its own
        self.run = Path(tempfile.mkdtemp(prefix="lsl-"))
        self.sock = self.run / "lp.sock"
        env = dict(os.environ)
        for k in ("LD_LIBRARY_PATH", "WAYLAND_DISPLAY", "DISPLAY", "LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES"):
            env.pop(k, None)
        env.update(
            LIASCAPE_PLAYER_SOCKET=str(self.sock),
            XDG_RUNTIME_DIR=str(self.run),
            XDG_STATE_HOME=str(priv / "state"),
            XDG_CACHE_HOME=str(priv / "cache"),
            XDG_CONFIG_HOME=str(priv / "config"),
            __GL_SHADER_DISK_CACHE_PATH=str(priv / "cache" / "nv"),
            PIPEWIRE_RUNTIME_DIR=str(self.run),
            PIPEWIRE_REMOTE="liascape-scene-load-none",
            PULSE_SERVER=f"unix:{self.run / 'no-pulse'}",
            DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent",
            LIASCAPE_PLAYER_VRAM_PROBE="none",
            LIASCAPE_SCENE_WORKER_BIN=str(bindir / "liascape-scene-worker"),
            WPENGINE_TIMING="1",
        )
        self.env = env
        check = subprocess.run([str(self.bin), "scene-check"], env=env, capture_output=True, text=True)
        self.check = json.loads(check.stdout)
        if not self.check.get("ok"):
            raise SystemExit(f"scene-check: {check.stdout}{check.stderr}")
        self.log = open(priv / "serve.log", "w")
        self.proc = subprocess.Popen(
            ["prlimit", "--core=1:1", str(self.bin), "serve", "--no-supervise", "--headless", "--outputs", outputs,
             "--clock", "real", "--ao", "null", "--log-level", "info"],
            env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        for _ in range(150):
            try:
                self.ctl = Client(self.sock)
                self.ctl.call("hello", timeout=1.0)
                break
            except (OSError, RuntimeError):
                if self.proc.poll() is not None:
                    shutil.rmtree(self.run, ignore_errors=True)
                    raise SystemExit(f"serve exited: {(priv / 'serve.log').read_text()[-800:]}")
                time.sleep(0.1)
        else:
            raise SystemExit("serve never answered")
        self.sub = Client(self.sock)
        self.sub.call("subscribe", {"topics": ["source.", "worker."]})

    def apply(self, path, timeout, capture=None):
        """Shows `path` (a scene) on the output; returns the record of its load. `capture`: a PNG path for the
        source's picture 1 s after its first frame."""
        for _ in self.sub.lines(0.05):  # drop whatever came before
            pass
        t0 = time.monotonic()
        src = self.ctl.call("create", {"kind": "source", "props": {"kind": "scene", "path": str(path)}})["id"]
        self.ctl.call("set", {"path": "lay:*:main.content", "value": src})
        rec = {"scene": Path(path).name, "src": src}
        deadline = t0 + timeout
        while time.monotonic() < deadline and "ready_ms" not in rec:
            for t, ev in self.sub.lines(0.2):
                kind, same = ev.get("event"), ev.get("id") == src
                ms = (t - t0) * 1e3
                if kind == "worker.spawned" and same:
                    # a restart (a hung or crashed load) spawns again: the phases are the first worker's
                    rec.setdefault("spawned_ms", ms)
                    rec["pid"] = ev.get("pid")
                elif kind == "worker.ready" and same:
                    rec.setdefault("hello_ms", ms)
                elif kind == "worker.restart" and same:
                    rec["restarts"] = rec.get("restarts", 0) + 1
                elif kind == "source.ready" and same:
                    rec["ready_ms"] = ms
                    break
                elif kind in ("source.error", "source.broken") and same:
                    rec["error"] = ev
                    return rec
                if time.monotonic() > deadline:
                    break
        if capture and "ready_ms" in rec:
            time.sleep(1.0)
            rec["capture"] = self.ctl.call("capture", {"target": src, "path": str(capture)}, timeout=20.0).get("path")
        workers = self.ctl.call("probe", {"name": "workers", "args": {"log_tail": True}})
        for w in workers.get("workers", []):
            if w.get("id") != src:
                continue
            if "ready_ms" not in rec:
                # what a load that never finished was doing
                rec["state"], rec["log_tail"] = w.get("state"), w.get("log_tail", [])[-15:]
                if rec.get("pid"):
                    status = Path(f"/proc/{rec['pid']}/status")
                    rec["proc"] = status.read_text().splitlines()[1:3] if status.exists() else None
            for line in w.get("log_tail", []):
                m = re.search(r"lwe: loaded .* in ([\d.]+) ms, built in ([\d.]+) ms", line)
                if m:
                    rec["load_ms"], rec["build_ms"] = float(m.group(1)), float(m.group(2))
                m = re.search(r'(\{"timing":.*\})', line)
                if m:
                    t = json.loads(m.group(1))
                    rec["lwe_" + t.pop("timing")] = t
        return rec

    def destroy(self, rec):
        self.ctl.call("destroy", {"id": rec["src"]})
        pid = rec.get("pid")
        for _ in range(100):
            if not pid or not Path(f"/proc/{pid}").exists():
                break
            time.sleep(0.05)

    def quit(self):
        try:
            self.ctl.call("quit", timeout=5.0)
        except (OSError, RuntimeError):
            pass
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        self.log.close()
        shutil.rmtree(self.run, ignore_errors=True)


def phases(rec):
    """The record's split: every phase in ms (None where the record lacks it)."""
    g = rec.get
    out = {
        "total": g("ready_ms"),
        "spawn": g("spawned_ms"),
        "exec_egl": (g("hello_ms") - g("spawned_ms")) if g("hello_ms") and g("spawned_ms") else None,
        "load": g("load_ms"),
        "build": g("build_ms"),
    }
    if g("restarts"):
        out["restarts"] = g("restarts")
    elif all(out[k] is not None for k in ("total", "spawn", "exec_egl", "load", "build")):
        out["after_build"] = out["total"] - out["spawn"] - out["exec_egl"] - out["load"] - out["build"]
    b = g("lwe_first_frame")
    if b:
        out["b_io"] = b["io"]
        out["b_shader_text"] = b["shader_text"]
        out["b_glsl"] = b["glsl"]
        out["b_gl_compile"] = b["gl_compile"]
        out["b_texture"] = b["texture"] + b["texture_finish"]
        out["b_first_draw"] = b["first_draw"]
        out["b_other"] = b["build_total"] - sum(b[k] for k in ("io", "shader_text", "glsl", "gl_compile", "texture",
                                                               "texture_finish"))
    lo = g("lwe_load")
    if lo:
        out["l_project"] = lo["project_load"]
        out["l_io"] = lo["io"]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", action="append", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--warm", type=int, default=3)
    ap.add_argument("--bin", default=str(CRATE / "target" / "release"))
    ap.add_argument("--out", default=f"/tmp/liascape-scene-load-{time.strftime('%Y%m%d-%H%M%S')}")
    ap.add_argument("--outputs", default="1920x1080@60")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--capture", action="store_true", help="a PNG of each load 1 s after its first frame, in <out>/captures")
    a = ap.parse_args()
    if any("steamcmd_workshop" in str(Path(s).resolve()) for s in a.scene):
        raise SystemExit("refusing the steamcmd cache: it is never test media")
    bindir = Path(a.bin).resolve()
    out = Path(a.out)
    if str(out.resolve()).startswith(str(CRATE.parent.parent.resolve()) + "/"):
        raise SystemExit("--out must be outside the repo")
    out.mkdir(parents=True, exist_ok=True)
    records = open(out / "records.jsonl", "a")
    core = core_of(bindir / "liascape-scene-worker")
    for r in range(a.rounds):
        priv = out / f"round{r}"
        if priv.exists():
            raise SystemExit(f"{priv} exists: give a fresh --out")
        p = Player(bindir, priv, a.outputs)
        files = [bindir / "liascape-scene-worker", Path(p.check["assets_dir"])] + ([core] if core else [])
        try:
            for scene in a.scene:
                scene = Path(scene).resolve()
                plan = [("cold", True)] + [("warm", False)] * a.warm + [("boot", True)]
                for mode, cold in plan:
                    if cold:
                        evict(files + [scene])
                    cap = None
                    if a.capture:
                        (out / "captures").mkdir(exist_ok=True)
                        cap = out / "captures" / f"{scene.name}-{mode}-{r}-{len(list((out / 'captures').iterdir()))}.png"
                    rec = p.apply(scene, a.timeout, cap)
                    rec.update(round=r, mode=mode, phases=phases(rec))
                    records.write(json.dumps(rec) + "\n")
                    records.flush()
                    print(f"round {r} {scene.name} {mode}: " + " ".join(
                        f"{k}={v:.0f}" for k, v in rec["phases"].items() if v is not None), file=sys.stderr)
                    p.destroy(rec)
        finally:
            p.quit()
    records.close()
    # medians per scene and mode
    recs = [json.loads(l) for l in open(out / "records.jsonl")]
    summary = {}
    for rec in recs:
        key = f"{rec['scene']} {rec['mode']}"
        for k, v in rec["phases"].items():
            if v is not None:
                summary.setdefault(key, {}).setdefault(k, []).append(v)
    print(json.dumps({k: {p: round(statistics.median(v), 1) for p, v in d.items()} | {"n": len(d["total"])}
                      for k, d in summary.items() if "total" in d}, indent=1))


if __name__ == "__main__":
    main()
