"""Cut one segment of a wide video into a vertical (or square) clip whose crop follows the speaker.

Usage:
  python -I reframe.py <src> <start> <end> <out.mp4> --model <yunet.onnx> --size WxH --out-size WxH
                       [--ffmpeg ffmpeg] [--encoder libx264|h264_nvenc|...]

Tracking: YuNet faces on 4 fps proxy frames (HOG people as a fallback when the speaker turns away);
camera cuts reset the path; a dead zone + smoothing keep the crop calm (it only moves when the speaker
leaves the middle of the window) and it jumps on cuts. Progress goes to stdout as JSON lines
({"progress": 0..1}); the last line is {"done": true, "samples": n, "found": n, "cuts": n}.
Ported from tools/clips/reframe.py (any source size, any target aspect).
"""
import argparse
import json
import subprocess
import sys

import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("start", type=float)
ap.add_argument("end", type=float)
ap.add_argument("out")
ap.add_argument("--model", required=True)
ap.add_argument("--size", required=True, help="source WxH")
ap.add_argument("--out-size", required=True, help="output WxH")
ap.add_argument("--ffmpeg", default="ffmpeg")
ap.add_argument("--encoder", default="libx264")
ap.add_argument("--detect-only", action="store_true", help="only report where the face is (faceY/faceH of the source), no video")
a = ap.parse_args()


def say(**m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


start, dur = a.start, a.end - a.start
SW, SH = (int(v) for v in a.size.lower().split("x"))
OW, OH = (int(v) for v in a.out_size.lower().split("x"))
# Crop window in source pixels: full height, width set by the target aspect (even numbers for x264).
CW = min(SW, int(round(SH * OW / OH / 2)) * 2)
CH = SH if CW < SW else min(SH, int(round(SW * OH / OW / 2)) * 2)
PW = 1280  # proxy width (wide shots still give ~20 px faces at this size)
PH = int(round(PW * SH / SW / 2)) * 2
FPS_S = 4
n_expected = max(1, int(dur * FPS_S))

det = cv2.FaceDetectorYN.create(a.model, "", (PW, PH), 0.6, 0.3, 5000)
# HOG people (fallback when the speaker turns away) is gone in OpenCV 5: then faces only.
hog = None
if hasattr(cv2, "HOGDescriptor"):
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

cmd = [a.ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", a.src,
       "-vf", f"fps={FPS_S},scale={PW}:{PH}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
fsize = PW * PH * 3
cx_raw, cuts = [], [0]
face_y, face_h = [], []  # face centre / height in source pixels (for placing captions)
prev_hist, prev_cx = None, None
hog_hits = 0
i = 0
while True:
    buf = proc.stdout.read(fsize)
    if len(buf) < fsize:
        break
    f = np.frombuffer(buf, np.uint8).reshape(PH, PW, 3)
    hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    if prev_hist is not None and cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA) > 0.35:
        cuts.append(i)
    prev_hist = hist
    if cuts[-1] == i:
        prev_cx = None
    _, faces = det.detect(f)
    best = None
    if faces is not None:
        # Speaker = confident face standing high in the frame (audience heads sit low, often from
        # behind), bigger is better, and close to where the speaker was a moment ago.
        def score(fc):
            cy = (fc[1] + fc[3] / 2) / PH
            cxn = (fc[0] + fc[2] / 2) / PW
            s = fc[14] + 0.9 * (1 - cy) + 2.0 * fc[3] / PH
            if prev_cx is not None:
                s -= 0.8 * abs(cxn - prev_cx)
            return s

        cand = [fc for fc in faces if fc[14] > 0.7 and fc[1] > -2
                and ((fc[1] + fc[3] / 2) / PH < 0.6 or fc[3] / PH > 0.14)]
        if cand:
            best = max(cand, key=score)
            prev_cx = (best[0] + best[2] / 2) / PW
            face_y.append((best[1] + best[3] / 2) * SH / PH)
            face_h.append(best[3] * SH / PH)
    cx = None if best is None else (best[0] + best[2] / 2) * SW / PW
    if cx is None and hog is not None:
        # Speaker in profile / turned away: look for a standing person instead (HOG, half size).
        hw, hh = PW // 2, PH // 2
        small = cv2.resize(f, (hw, hh))
        rects, weights = hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.06)
        people = [(r, w) for r, w in zip(rects, np.ravel(weights)) if w > 0.5 and r[1] < hh * 0.45 and r[3] > hh * 0.35]
        if people:
            def pscore(rw):
                r, w = rw
                cxn = (r[0] + r[2] / 2) / hw
                return float(w) + r[3] / hh - (0.8 * abs(cxn - prev_cx) if prev_cx is not None else 0)

            r, _ = max(people, key=pscore)
            cx = (r[0] + r[2] / 2) * SW / hw
            prev_cx = cx / SW
            hog_hits += 1
    cx_raw.append(cx)
    i += 1
    if i % 8 == 0:
        say(progress=round(min(0.5, 0.5 * i / n_expected), 3))
proc.wait()

n = len(cx_raw)
if n == 0:
    sys.stderr.write("Não consegui ler o vídeo\n")
    sys.exit(2)
cuts.append(n)
path = np.full(n, SW / 2)
for s0, s1 in zip(cuts[:-1], cuts[1:]):
    seg = cx_raw[s0:s1]
    known = [k for k, v in enumerate(seg) if v is not None]
    if not known:
        continue  # no face in this shot: keep it centred
    filled = np.array([seg[min(known, key=lambda k: abs(k - j))] for j in range(len(seg))], float)
    k = 3
    med = np.array([np.median(filled[max(0, j - k): j + k + 1]) for j in range(len(filled))])
    # dead zone: hold position until the face drifts > 12% of the crop width from centre
    pos = med[0]
    dz = CW * 0.12
    for j, v in enumerate(med):
        if abs(v - pos) > dz:
            pos += (v - pos) - np.sign(v - pos) * dz
        path[s0 + j] = pos
    # ease the moves (EMA forward/backward) inside the shot
    for _ in range(2):
        for j in range(s0 + 1, s1):
            path[j] = 0.6 * path[j - 1] + 0.4 * path[j]
        for j in range(s1 - 2, s0 - 1, -1):
            path[j] = 0.6 * path[j + 1] + 0.4 * path[j]
    # hard rule: the detected face always stays inside the middle 60% of the crop
    lim = CW * 0.30
    for j in range(s0, s1):
        fx = filled[j - s0]
        path[j] = min(max(path[j], fx - lim), fx + lim)

if a.detect_only:
    fy = round(float(np.median(face_y) / SH), 3) if face_y else None
    fh = round(float(np.median(face_h) / SH), 3) if face_h else None
    fx = [v for v in cx_raw if v is not None]
    say(done=True, samples=n, found=len(fx), faceY=fy, faceH=fh, faceX=round(float(np.median(fx) / SW), 3) if fx else None)
    sys.exit(0)

x = np.clip(path - CW / 2, 0, SW - CW)
y0 = (SH - CH) // 2
cmdfile = a.out + ".cmd"
with open(cmdfile, "w", encoding="utf-8") as fh:
    for j, v in enumerate(x):
        fh.write(f"{j / FPS_S:.3f} crop x {int(round(v / 2) * 2)};\n")

esc = cmdfile.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
vf = f"sendcmd=f='{esc}',crop={CW}:{CH}:{int(x[0]) // 2 * 2}:{y0},scale={OW}:{OH}:flags=lanczos,setsar=1"
quality = ["-preset", "p5", "-cq", "17"] if "nvenc" in a.encoder else (
    ["-q:v", "60"] if "videotoolbox" in a.encoder else ["-preset", "medium", "-crf", "16"])
enc = [a.ffmpeg, "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", a.src, "-vf", vf,
       "-r", "30", "-c:v", a.encoder, *quality, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
       "-progress", "pipe:1", "-nostats", a.out]
p = subprocess.Popen(enc, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
for line in p.stdout:
    if line.startswith("out_time_us="):
        try:
            t = int(line.split("=")[1]) / 1e6
            say(progress=round(0.5 + 0.5 * min(1.0, t / dur), 3))
        except ValueError:
            pass
err = p.stderr.read()
if p.wait() != 0:
    sys.stderr.write(err[-1500:])
    sys.exit(3)
# Where the face sits in the output (fractions of its height): captions go behind the head / on the chest.
fy = round(float((np.median(face_y) - y0) / CH), 3) if face_y else None
fh = round(float(np.median(face_h) / CH), 3) if face_h else None
say(done=True, samples=n, found=sum(v is not None for v in cx_raw), hog=hog_hits, cuts=len(cuts) - 2, faceY=fy, faceH=fh)
