"""Words of each chosen clip, re-timed to the clip, clitics glued, spelling fixes applied.

Usage: python -I prep_words.py <words.json> <clips.json> <outdir>
Writes <outdir>/clipNN.words.json ({"words": [...]}, times relative to the clip start).
"""
import json
import os
import re
import sys

words_all = json.load(open(sys.argv[1], encoding="utf-8"))["words"]
clips = json.load(open(sys.argv[2], encoding="utf-8"))
outdir = sys.argv[3]
os.makedirs(outdir, exist_ok=True)
norm = lambda t: re.sub(r"[^\w-]", "", t.lower())


def glue(ws):
    out = []
    for w in ws:
        if re.match(r"^-\w", w["w"]) and out:
            out[-1]["w"] = re.sub(r"[.,;:…]+$", "", out[-1]["w"]) + w["w"]
            out[-1]["e"] = w["e"]
        else:
            out.append(dict(w))
    return out


def apply_fix(ws, wrong, right):
    a = [norm(t) for t in glue([{"w": t, "s": 0, "e": 0} for t in wrong.split()]) for t in [t["w"]]]
    b = right.split()
    n, hits, i = len(a), 0, 0
    while i + n <= len(ws):
        if [norm(w["w"]) for w in ws[i:i + n]] == a:
            s, e = ws[i]["s"], ws[i + n - 1]["e"]
            step = (e - s) / max(1, len(b))
            new = [{"w": t, "s": round(s + k * step, 3), "e": round(s + (k + 1) * step, 3)} for k, t in enumerate(b)]
            if new:
                new[-1]["e"] = e
            ws[i:i + n] = new
            i += len(new)
            hits += 1
        else:
            i += 1
    return hits


for c in clips:
    s0, s1 = c["start"], c["end"]
    ws = [{"w": w["w"], "s": round(max(0, w["s"] - s0), 3), "e": round(min(s1 - s0, w["e"] - s0), 3)}
          for w in words_all if w["s"] >= s0 - 0.05 and w["e"] <= s1 + 0.05]
    ws = glue(ws)
    report = []
    for f in c.get("fixes", []):
        if "incerto" in f or "->" not in f:
            report.append(f"SKIP {f}")
            continue
        wrong, right = [x.strip() for x in f.split("->", 1)]
        right = re.sub(r"\s*\(\d+x\)\s*$", "", right)
        wrong = re.sub(r"\s*\(\d+x\)\s*$", "", wrong)
        h = apply_fix(ws, wrong, right)
        report.append(f"{'OK ' if h else 'MISS'} x{h} {wrong} -> {right}")
    json.dump({"words": ws}, open(os.path.join(outdir, f"clip{c['rank']:02d}.words.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"clip {c['rank']}: {len(ws)} words", *report, sep="\n  ")
