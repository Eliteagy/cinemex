"""Cut one segment of a 16:9 talk into a 1080x1920 clip whose crop follows the speaker's face.

Usage: python -I reframe.py <src.mp4> <start> <end> <out.mp4> <yunet.onnx>
Tracking: YuNet faces on 4 fps proxy frames; camera cuts reset the path; a dead zone + smoothing keep the
crop calm (it only moves when the speaker leaves the middle of the window), and it jumps on cuts.
"""
import subprocess
import sys

import cv2
import numpy as np

src, start, end, out, model = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4], sys.argv[5]
dur = end - start
PW, PH, FPS_S = 1280, 720, 4  # proxy size / sample rate (wide shots have ~20 px faces at this size)
SW, SH = 1920, 1080
CW = round(SH * 9 / 16 / 2) * 2  # crop width in source pixels (608)

cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src,
       "-vf", f"fps={FPS_S},scale={PW}:{PH}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
raw = subprocess.run(cmd, capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, PH, PW, 3)

det = cv2.FaceDetectorYN.create(model, "", (PW, PH), 0.6, 0.3, 5000)
cx_raw, cuts = [], [0]
prev_hist = None
prev_cx = None
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
hog_hits = 0
for i, f in enumerate(frames):
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
        # Speaker = confident face standing high in the frame (audience heads sit low, often from behind),
        # bigger is better, and close to where the speaker was a moment ago.
        def score(fc):
            cy = (fc[1] + fc[3] / 2) / PH
            cxn = (fc[0] + fc[2] / 2) / PW
            s = fc[14] + 0.9 * (1 - cy) + 2.0 * fc[3] / PH
            if prev_cx is not None:
                s -= 0.8 * abs(cxn - prev_cx)
            return s
        # Audience faces sit in the lower part of the frame; a standing speaker's face never does
        # (unless it is a close-up, where the face is big).
        cand = [fc for fc in faces if fc[14] > 0.7 and fc[1] > -2
                and ((fc[1] + fc[3] / 2) / PH < 0.6 or fc[3] / PH > 0.14)]
        if cand:
            best = max(cand, key=score)
            prev_cx = (best[0] + best[2] / 2) / PW
    cx = None if best is None else (best[0] + best[2] / 2) * SW / PW
    if cx is None:
        # Speaker in profile / turned away: look for a standing person instead (HOG, half size).
        small = cv2.resize(f, (PW // 2, PH // 2))
        rects, weights = hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.06)
        people = [(r, w) for r, w in zip(rects, weights) if w > 0.5 and r[1] < PH // 2 * 0.45 and r[3] > PH // 2 * 0.35]
        if people:
            def pscore(rw):
                r, w = rw
                cxn = (r[0] + r[2] / 2) / (PW // 2)
                return float(w) + r[3] / (PH // 2) - (0.8 * abs(cxn - prev_cx) if prev_cx is not None else 0)
            r, _ = max(people, key=pscore)
            cx = (r[0] + r[2] / 2) * SW / (PW // 2)
            prev_cx = cx / SW
            hog_hits += 1
    cx_raw.append(cx)

n = len(cx_raw)
cuts.append(n)
path = np.full(n, SW / 2)
for a, b in zip(cuts[:-1], cuts[1:]):
    seg = cx_raw[a:b]
    known = [i for i, v in enumerate(seg) if v is not None]
    if not known:
        continue  # no face in this shot: keep it centred
    # fill gaps with nearest known value, then median filter
    filled = np.array([seg[min(known, key=lambda k: abs(k - i))] for i in range(len(seg))], float)
    k = 3
    med = np.array([np.median(filled[max(0, i - k): i + k + 1]) for i in range(len(filled))])
    # dead zone: hold position until the face drifts > 12% of the crop width from centre
    pos = med[0]
    dz = CW * 0.12
    for i, v in enumerate(med):
        if abs(v - pos) > dz:
            pos += (v - pos) - np.sign(v - pos) * dz
        path[a + i] = pos
    # ease the moves (EMA forward/backward) inside the shot
    for _ in range(2):
        for i in range(a + 1, b):
            path[i] = 0.6 * path[i - 1] + 0.4 * path[i]
        for i in range(b - 2, a - 1, -1):
            path[i] = 0.6 * path[i + 1] + 0.4 * path[i]
    # hard rule: the detected face always stays inside the middle 60% of the crop
    lim = CW * 0.30
    for i in range(a, b):
        f = filled[i - a]
        path[i] = min(max(path[i], f - lim), f + lim)

x = np.clip(path - CW / 2, 0, SW - CW)
# sendcmd: update crop x at each sample time
with open(out + ".cmd", "w", encoding="utf-8") as fh:
    for i, v in enumerate(x):
        fh.write(f"{i / FPS_S:.3f} crop x {int(round(v / 2) * 2)};\n")

cmdfile = (out + ".cmd").replace("\\", "/").replace(":", "\\:")
vf = f"sendcmd=f='{cmdfile}',crop={CW}:{SH}:{int(x[0])}:0,scale=1080:1920:flags=lanczos,setsar=1"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src, "-vf", vf,
                "-r", "30", "-c:v", "h264_nvenc", "-preset", "p5", "-cq", "17", "-c:a", "aac", "-b:a", "192k", out],
               check=True)
faces_found = sum(v is not None for v in cx_raw)
print(f"ok samples={n} found={faces_found} (hog {hog_hits}) cuts={len(cuts) - 2}")
