#!/usr/bin/env python3
"""Generate CREDITS.md from UPSTREAM.md's "Adopted techniques" tables and any
patches/*/*.patch headers.

Sources (no network, no other inputs):
  - UPSTREAM.md: each `## <project>` section's `- **Project**:`/`- **License**:` metadata lines
    and the pipe-table immediately under its `### Adopted techniques` heading.
  - patches/<project>/<name>.patch: `git format-patch`-style headers — `From:`, `Subject:`,
    `Upstream-PR:` / `Upstream-Commit:`, `Origin:` (design spec §7). The `patches/` directory
    does not exist yet (nothing is vendored); glob() over a missing directory simply returns no
    matches, so that is not an error.

Determinism: project *sections* are emitted in the order they appear in UPSTREAM.md (itself a
fixed, version-controlled file, so this is already reproducible); within a section, technique
rows are `sorted()` by their first column, and patches are `sorted()` by (project, filename) —
both of those would otherwise depend on glob()/table-parse order, which this script does not
trust to be stable across filesystems.

Usage:
  python3 scripts/gen-credits.py            # (re)writes CREDITS.md
  python3 scripts/gen-credits.py --check    # exits 1 (with a diff) if CREDITS.md is stale/missing
"""
import difflib
import glob
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
UPSTREAM_MD = os.path.join(ROOT, "UPSTREAM.md")
CREDITS_MD = os.path.join(ROOT, "CREDITS.md")
PATCHES_GLOB = os.path.join(ROOT, "patches", "*", "*.patch")

SECTION_RE = re.compile(r"^## (?!#)(.+?)\s*$")
SUBSECTION_RE = re.compile(r"^### (.+?)\s*$")
META_RE = re.compile(r"^- \*\*(Project|License)\*\*:\s*(.+?)\s*$")
ROW_RE = re.compile(r"^\|(.+)\|\s*$")


def _strip_autolink(s):
    """`<https://example.com>` -> `https://example.com`; anything else unchanged."""
    s = s.strip()
    if s.startswith("<") and s.endswith(">"):
        return s[1:-1]
    return s


def _split_row(line):
    """'| a | b | c |' -> ['a', 'b', 'c'] (cells stripped). No escaped pipes are used here."""
    inner = ROW_RE.match(line).group(1)
    return [c.strip() for c in inner.split("|")]


def _is_separator_row(cells):
    return all(re.fullmatch(r":?-{2,}:?", c) for c in cells)


def _is_header_row(cells):
    return bool(cells) and cells[0].lower() in ("technique", "asset")


def parse_upstream(path):
    """-> [ {name, project, license, rows: [[c1,c2,c3,c4], ...]} , ... ] in file order."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    sections = []
    cur = None
    in_adopted = False

    i = 0
    while i < len(lines):
        line = lines[i]
        m = SECTION_RE.match(line)
        if m:
            cur = {"name": m.group(1), "project": None, "license": None, "rows": []}
            sections.append(cur)
            in_adopted = False
            i += 1
            continue
        if cur is None:
            i += 1
            continue
        m = SUBSECTION_RE.match(line)
        if m:
            in_adopted = m.group(1).strip().lower() == "adopted techniques"
            i += 1
            continue
        m = META_RE.match(line)
        if m:
            key, val = m.group(1), m.group(2)
            # a wrapped bullet (indented continuation) would be silently truncated — refuse it
            if i + 1 < len(lines) and re.match(r"^\s{2,}\S", lines[i + 1]):
                sys.exit(f"{path}:{i + 2}: the **{key}** bullet wraps onto a continuation line; "
                         "keep it on one line so CREDITS.md isn't truncated")
            if key == "Project":
                cur["project"] = _strip_autolink(val)
            else:
                cur["license"] = val.strip()
            i += 1
            continue
        if in_adopted and ROW_RE.match(line):
            cells = _split_row(line)
            if not _is_header_row(cells) and not _is_separator_row(cells):
                cur["rows"].append(cells)
            i += 1
            continue
        i += 1

    return sections


def parse_patch(path):
    """Minimal git-format-patch header reader: From/Subject + the Origin/Upstream-*/Adapted-by
    trailers (design spec §7). Returns {} for a patch missing even a Subject (malformed)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()

    # `git format-patch` folds a long Subject: onto indented continuation lines (RFC 2822);
    # unfold the header block (up to the first blank line) before matching
    head, _, body = text.partition("\n\n")
    text = re.sub(r"\n[ \t]+", " ", head) + "\n\n" + body

    info = {"path": path}
    for key, pat in (
        ("from", r"^From:\s*(.+?)\s*$"),
        ("subject", r"^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+?)\s*$"),
        ("upstream_pr", r"^Upstream-PR:\s*(.+?)\s*$"),
        ("upstream_commit", r"^Upstream-Commit:\s*(.+?)\s*$"),
        ("origin", r"^Origin:\s*(.+?)\s*$"),
        ("adapted_by", r"^Adapted-by:\s*(.+?)\s*$"),
    ):
        m = re.search(pat, text, re.MULTILINE)
        if m:
            info[key] = m.group(1).strip()
    if "subject" not in info:
        return {}
    return info


def collect_patches():
    """[{project, file, ...header fields}, ...], sorted by (project, filename). Missing
    patches/ (glob over a nonexistent dir) is simply zero matches, never an error."""
    out = []
    for p in glob.glob(PATCHES_GLOB):
        info = parse_patch(p)
        if not info:
            continue
        project = os.path.basename(os.path.dirname(p))
        info["project"] = project
        info["file"] = os.path.basename(p)
        out.append(info)
    out.sort(key=lambda r: (r["project"], r["file"]))
    return out


def render(sections, patches):
    out = []
    out.append("# Credits")
    out.append("")
    out.append(
        "Generated by `scripts/gen-credits.py` from `UPSTREAM.md` (and any `patches/*/*.patch` "
        "headers). Do not edit this file by hand: edit `UPSTREAM.md` or a patch header, then run"
    )
    out.append("`python3 scripts/gen-credits.py`. `--check` fails (exit 1) if this file is stale.")
    out.append("")

    for sec in sections:
        out.append(f"## {sec['name']}")
        out.append("")
        meta_bits = [b for b in (sec["project"], sec["license"]) if b]
        if meta_bits:
            out.append(" — ".join(meta_bits))
            out.append("")
        if sec["rows"]:
            out.append("| Technique | Where | Source | License |")
            out.append("|---|---|---|---|")
            for row in sorted(sec["rows"], key=lambda r: r[0]):
                out.append("| " + " | ".join(row) + " |")
            out.append("")
        else:
            out.append("*(no techniques adopted yet — see `UPSTREAM.md`)*")
            out.append("")

    out.append("## Patches")
    out.append("")
    if patches:
        out.append("| Project | Patch | Subject | Origin | Author |")
        out.append("|---|---|---|---|---|")
        for p in patches:
            origin = p.get("upstream_pr") or p.get("upstream_commit") or p.get("origin") or ""
            author = p.get("from", "")
            out.append(
                f"| {p['project']} | `{p['file']}` | {p['subject']} | {origin} | {author} |"
            )
        out.append("")
    else:
        out.append(
            "*(no patches yet — nothing is vendored; see `UPSTREAM.md` § \"How to resync\")*"
        )
        out.append("")

    return "\n".join(out).rstrip("\n") + "\n"


def main():
    check = "--check" in sys.argv[1:]

    sections = parse_upstream(UPSTREAM_MD)
    patches = collect_patches()
    generated = render(sections, patches)

    if not check:
        with open(CREDITS_MD, "w", encoding="utf-8") as f:
            f.write(generated)
        print(f"wrote {os.path.relpath(CREDITS_MD, ROOT)}")
        return 0

    if not os.path.exists(CREDITS_MD):
        print(f"{os.path.relpath(CREDITS_MD, ROOT)} does not exist — run without --check first.")
        return 1

    with open(CREDITS_MD, encoding="utf-8") as f:
        current = f.read()

    if current == generated:
        print(f"{os.path.relpath(CREDITS_MD, ROOT)} is up to date.")
        return 0

    diff = difflib.unified_diff(
        current.splitlines(keepends=True),
        generated.splitlines(keepends=True),
        fromfile="CREDITS.md (current)",
        tofile="CREDITS.md (generated)",
    )
    sys.stdout.writelines(diff)
    print(
        f"\n{os.path.relpath(CREDITS_MD, ROOT)} is stale — run "
        "`python3 scripts/gen-credits.py` and commit the result."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
