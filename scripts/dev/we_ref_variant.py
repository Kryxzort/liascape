"""we_ref_variant.py <workshop item dir> <out project dir> [op …] — a private copy of a scene for WE-vs-ours
experiments: WE's scene clock as the capture builds it (we_ref_tool.py clock-inject), every scene script's
Math.random () replaced by a seeded generator (one per script, seeded by its position: WE and ours then start from
the same random state), then the ops: hide:<id>,<id>… (visible false), nobloom (general.bloom false),
general:<key>=<json>. Capture it in WE with `we-ref-capture.sh <out dir> --tag <t> --docs -` (out dir under
~/.cache/liascape/we-ref/), render ours with `liascape-scene-worker --lwe-smoke <out dir>`. Never point <out> into
the Workshop folder (3509243656's planets: gap audit "3D scenes against WE, part 3")."""
import sys, os, json, shutil, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import we_ref_tool as T
item, out = sys.argv[1:3]
ops = sys.argv[3:]
tmp = out + '.clk'
for p in (out, tmp):
    if os.path.exists(p): shutil.rmtree(p)
T.cmd_clock_inject(item, tmp)  # prints tmp
shutil.copytree(tmp, out, symlinks=False)
shutil.rmtree(tmp)
v, files = T.read_pkg(os.path.join(out, 'scene.pkg'))
d = dict(files); names = [n for n, _ in files]
s = json.loads(d['scene.json'].decode('utf-8-sig'))
n = [0]
PRNG = "let __ls = %d;\nfunction __lr() { __ls = (__ls * 16807) %% 2147483647; return (__ls - 1) / 2147483646; }\n"
def fix(o):
    if isinstance(o, dict):
        for k, val in o.items():
            if k == 'script' and isinstance(val, str) and 'Math.random' in val:
                n[0] += 1
                body = val.replace('Math.random()', '__lr()')
                # after 'use strict'; if present
                m = re.match(r"\s*'use strict';\s*\n", body)
                pre = PRNG % (1000 + 7919 * n[0])
                o[k] = (body[:m.end()] + pre + body[m.end():]) if m else pre + body
            else:
                fix(val)
    elif isinstance(o, list):
        for x in o: fix(x)
fix(s)
for op in ops:
    if op.startswith('hide:'):
        ids = {int(x) for x in op[5:].split(',')}
        for o in s['objects']:
            if o.get('id') in ids: o['visible'] = False
    elif op == 'nobloom':
        s['general']['bloom'] = False
    elif op.startswith('general:'):
        k, v = op[8:].split('=', 1); s['general'][k] = json.loads(v)
    print('op', op, file=sys.stderr)
print('scripts seeded:', n[0], file=sys.stderr)
d['scene.json'] = json.dumps(s, ensure_ascii=False, indent='\t').encode()
T.write_pkg(os.path.join(out, 'scene.pkg'), v, [(nm, d[nm]) for nm in names])
print(out)
