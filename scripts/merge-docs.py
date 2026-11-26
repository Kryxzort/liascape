#!/usr/bin/env python3
"""Git merge driver for docs/TODO.md and docs/decisions.md (`.gitattributes`; set up once per clone with
`bash scripts/setup-clone.sh`).

Both files are lists of blocks: a heading (`## …`, `### …`) or a list item (`12. [ ] …`, `- [ ] …`) with its
continuation lines. Two branches nearly always touch different blocks (one adds an item, the other deletes the one it
built), yet git's line merge conflicts as soon as their hunks are neighbours. This merges block by block instead:

- the result keeps the current side's (%A) blocks and order;
- a block the other side (%B) added is inserted after the block it follows there;
- a block the other side deleted or changed is deleted or changed here too, unless this side changed it as well;
- a block both sides changed differently gets conflict markers (exit 1, git stops as usual);
- an added numbered item whose number this side already uses takes the next free number of its section.

A block is identified by its first line without the item number, so a renumbering on either side is no change.
Usage (git fills it in): merge-docs.py %O %A %B — writes the result to %A.
"""
import difflib
import re
import sys

START = re.compile(r"^(#{2,3} |\d+\. \[[ x]\] |- \[[ x]\] )")
NUM = re.compile(r"^(\d+)\. ")


def blocks(text):
    lines = text.splitlines(keepends=True)
    out, cur = [], []
    for ln in lines:
        if START.match(ln) and cur:
            out.append("".join(cur))
            cur = []
        cur.append(ln)
    if cur:
        out.append("".join(cur))
    return out


def key(block):
    first = block.split("\n", 1)[0]
    return NUM.sub("", first).strip()


def keyed(bs):
    seen, out = {}, []
    for b in bs:
        k = key(b)
        seen[k] = seen.get(k, 0) + 1
        out.append(((k, seen[k]), b))
    return out


def match_edits(O, X):
    """Give a block that one side edited (its first line too) the key of the base block it came from: the most similar
    base block that side no longer has, when similar enough."""
    xd = dict(X)
    gone = [k for k in O if k not in xd]
    out = []
    for k, b in X:
        if k not in O and gone:
            best = max(gone, key=lambda g: difflib.SequenceMatcher(None, O[g], b).ratio())
            if difflib.SequenceMatcher(None, O[best], b).ratio() >= 0.6:
                gone.remove(best)
                k = best
        out.append((k, b))
    return out


def renumber_added(final, added):
    """An added numbered item whose number its section already uses (on this side) takes the section's next free one."""
    out, used, top, sec = [], set(), 0, []
    def flush():
        nonlocal used, top
        for k, b in sec:
            m = NUM.match(b)
            if m and k in added:
                n = int(m.group(1))
                if n in used:
                    top += 1
                    n = top
                    b = NUM.sub(f"{n}. ", b, count=1)
                used.add(n)
                top = max(top, n)
            out.append(b)
        sec.clear()
    for k, b in final:
        if b.startswith("## "):
            flush()
            used, top = set(), 0
            out.append(b)
            continue
        m = NUM.match(b)
        if m and k not in added:
            used.add(int(m.group(1)))
            top = max(top, int(m.group(1)))
        sec.append((k, b))
    flush()
    return out


def merge(o_text, a_text, b_text):
    O = dict(keyed(blocks(o_text)))
    A, B = match_edits(O, keyed(blocks(a_text))), match_edits(O, keyed(blocks(b_text)))
    Ad, Bd = dict(A), dict(B)
    conflict = False
    result = []  # list of (key, text)
    for k, a in A:
        if k in O and k not in Bd:  # the other side deleted it
            if a == O[k]:
                continue
            result.append((k, a))  # this side changed what the other deleted: keep this side's
            continue
        if k in O and k in Bd and Bd[k] != O[k]:  # the other side changed it
            if a == O[k] or a == Bd[k]:
                result.append((k, Bd[k]))
            else:
                conflict = True
                result.append((k, f"<<<<<<< ours\n{a}=======\n{Bd[k]}>>>>>>> theirs\n"))
            continue
        result.append((k, a))
    # Blocks the other side added: after the nearest preceding block (in its order) that the result has.
    pos = {k: i for i, (k, _) in enumerate(result)}
    prev = None
    inserts = {}
    for k, b in B:
        if k not in O and k not in Ad:
            inserts.setdefault(prev, []).append((k, b))
        if k in pos or (k not in O and k not in Ad):
            prev = k
    final = list(inserts.get(None, []))
    for k, t in result:
        final.append((k, t))
        final.extend(inserts.get(k, []))
    placed = {k for k, _ in final}
    for lst in inserts.values():  # anchored on a block this side deleted: append at the end
        final.extend((k, t) for k, t in lst if k not in placed and not placed.add(k))
    final = [(k, t if t.endswith("\n") or i == len(final) - 1 else t + "\n") for i, (k, t) in enumerate(final)]
    added = {k for lst in inserts.values() for k, _ in lst}
    return "".join(renumber_added(final, added)), conflict


def main():
    o, a, b = sys.argv[1:4]
    read = lambda p: open(p, encoding="utf-8").read()
    text, conflict = merge(read(o), read(a), read(b))
    with open(a, "w", encoding="utf-8") as fh:
        fh.write(text)
    sys.exit(1 if conflict else 0)


if __name__ == "__main__":
    main()
