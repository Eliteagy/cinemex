"""Cinemex: person matte for one clip (captions behind the person, "Pessoa" mask).

Robust Video Matting (ONNX, CPU) cuts every person out of the clip, frame by frame, with memory
between frames so the edge does not flicker. With a click point only the person under the click is
kept (the connected region that holds it, followed from frame to frame).

Writes a grey video (white = person) the export reads with alphamerge, and prints JSON progress
lines on stdout: {"progress": 0.42} ... {"done": "<path>", "frames": n, "fps": f}.

usage: matte.py <media> <in> <out> <matte.mp4> [--x 0.5 --y 0.6] [--width 960] [--model path]
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

FFMPEG = os.environ.get("ELITE_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("ELITE_FFPROBE", "ffprobe")


def say(obj):
    sys.stdout.buffer.write((json.dumps(obj) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def probe(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", path],
        capture_output=True, check=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(num) / float(den)


def pick_region(alpha, seed, prev):
    """Keep only the region of `alpha` that holds the seed point (or overlaps the previous region)."""
    import cv2

    solid = (alpha > 0.35).astype(np.uint8)
    n, labels = cv2.connectedComponents(solid, connectivity=8)
    if n <= 2:
        return alpha, solid.astype(bool)
    keep = 0
    if prev is not None:
        # The region that overlaps most with where the person was in the previous frame.
        counts = np.bincount(labels[prev], minlength=n)
        counts[0] = 0
        keep = int(counts.argmax()) if counts.max() > 0 else 0
    if not keep and seed is not None:
        sx, sy = seed
        keep = int(labels[sy, sx])
        if not keep:
            # Click just outside the edge: nearest region.
            ys, xs = np.nonzero(labels)
            if len(xs):
                i = int(np.argmin((xs - sx) ** 2 + (ys - sy) ** 2))
                keep = int(labels[ys[i], xs[i]])
    if not keep:
        return alpha, solid.astype(bool)
    region = labels == keep
    # Keep the soft edge around the region (dilated), drop the other people.
    grown = cv2.dilate(region.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    return np.where(grown, alpha, 0.0), region


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("tin", type=float)
    ap.add_argument("tout", type=float)
    ap.add_argument("dest")
    ap.add_argument("--x", type=float, default=None)
    ap.add_argument("--y", type=float, default=None)
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--model", default=None)
    a = ap.parse_args()

    import onnxruntime as ort

    model = a.model or os.path.join(os.environ.get("APPDATA", ""), "Cinemex", "models", "rvm_mobilenetv3_fp32.onnx")
    if not os.path.exists(model):
        raise SystemExit(f"Falta o modelo de recorte: {model}")
    sess = ort.InferenceSession(model, providers=[p for p in ("DmlExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()])

    sw, sh, fps = probe(a.media)
    w = min(a.width, sw) // 2 * 2
    h = round(sh * w / sw) // 2 * 2
    dur = max(0.04, a.tout - a.tin)
    total = max(1, round(dur * fps))
    seed = None if a.x is None or a.y is None else (min(w - 1, max(0, round(a.x * w))), min(h - 1, max(0, round(a.y * h))))

    dec = subprocess.Popen(
        [FFMPEG, "-v", "error", "-ss", f"{a.tin:.3f}", "-i", a.media, "-t", f"{dur:.3f}", "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    enc = subprocess.Popen(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", a.dest],
        stdin=subprocess.PIPE,
    )
    rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
    ratio = np.array([min(1.0, 512 / max(w, h))], dtype=np.float32)
    prev = None
    n = 0
    frame_bytes = w * h * 3
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            src = np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.float32).transpose(2, 0, 1)[None] / 255.0
            fgr, pha, *rec = sess.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
            alpha = pha[0, 0]
            if seed is not None:
                alpha, prev = pick_region(alpha, seed if prev is None else None, prev)
            enc.stdin.write((np.clip(alpha, 0, 1) * 255).astype(np.uint8).tobytes())
            n += 1
            if n % 15 == 0:
                say({"progress": round(min(1.0, n / total), 3)})
    finally:
        enc.stdin.close()
        enc.wait()
        dec.stdout.close()
        dec.wait()
    if not n:
        raise SystemExit("Não consegui ler frames deste clip")
    say({"done": a.dest, "frames": n, "fps": fps, "w": w, "h": h})


if __name__ == "__main__":
    main()
