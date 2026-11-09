"""Cinemex: word-level transcription on this PC (faster-whisper; GPU when available).

Usage: python -E -P engine/transcribe.py <media file> [language|auto] [--model NAME] [--translate] [--prompt TEXT]
Prints one JSON object: {"language": "pt", "model": "...", "task": "transcribe", "words": [{"w": "olá", "s": 0.12, "e": 0.40}, ...]}
Options follow AutoSubs: model choice, language auto-detect, translate to English, custom prompt.
"""
import argparse
import glob
import json
import os
import site
import sys

for base in [*site.getsitepackages(), site.getusersitepackages()]:
    for bin_dir in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
        try:
            os.add_dll_directory(bin_dir)
        except (OSError, AttributeError):
            pass
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel  # noqa: E402

HUB = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
CANDIDATES = [
    "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
    "models--Systran--faster-whisper-large-v3",
    "models--Systran--faster-whisper-medium",
    "models--Systran--faster-whisper-small",
]


def cached(name):
    """Path of a model already downloaded to the Hugging Face cache, or None."""
    snaps = os.path.join(HUB, name, "snapshots")
    if os.path.isdir(snaps):
        for snap in sorted(os.listdir(snaps), reverse=True):
            path = os.path.join(snaps, snap)
            if os.path.isfile(os.path.join(path, "model.bin")):
                return path
    return None


def local_model(wanted=None):
    """The requested model (cached copy first, else faster-whisper downloads it), or the best cached one."""
    if wanted:
        for name in CANDIDATES + ["models--Systran--faster-whisper-base", "models--Systran--faster-whisper-tiny"]:
            if name.split("faster-whisper-")[-1] == wanted:
                return cached(name) or wanted, wanted
        return wanted, wanted
    for name in CANDIDATES:
        path = cached(name)
        if path:
            return path, name.split("--")[-1]
    return "small", "small"


def transcribe(model, media, language, task, prompt):
    if prompt is None and language == "pt":
        prompt = "Português de Portugal."
    segments, info = model.transcribe(media, language=language, task=task, vad_filter=True, beam_size=5,
                                      word_timestamps=True, initial_prompt=prompt or None)
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "s": round(w.start, 3), "e": round(w.end, 3)})
    return words, info.language


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("language", nargs="?", default="pt")
    ap.add_argument("--model", default=None)
    ap.add_argument("--translate", action="store_true")
    ap.add_argument("--prompt", default=None)
    a = ap.parse_args()
    language = None if a.language in ("", "auto") else a.language
    task = "translate" if a.translate else "transcribe"
    wanted = a.model
    if a.translate and not wanted:
        # large-v3-turbo was not trained to translate: use the full model when it is on the PC.
        wanted = "large-v3" if cached("models--Systran--faster-whisper-large-v3") else "medium"
    path, name = local_model(wanted)
    try:
        model = WhisperModel(path, device="cuda", compute_type="float16")
        words, lang = transcribe(model, a.media, language, task, a.prompt)
        name += " (GPU)"
    except Exception:
        model = WhisperModel(path, device="cpu", compute_type="int8")
        words, lang = transcribe(model, a.media, language, task, a.prompt)
        name += " (CPU)"
    # UTF-8 bytes: the Windows console encoding (cp1252) would break accents for Node.
    sys.stdout.buffer.write(json.dumps({"language": lang, "model": name, "task": task, "words": words}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
