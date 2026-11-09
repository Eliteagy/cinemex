// Where the external programs are (ffmpeg, ffprobe, Python), on Windows and on macOS.
//
// Windows: on the PATH, as before. macOS: an app opened from the Finder does not get the shell's
// PATH, so the Homebrew folders are looked at too. ffmpeg-full comes first there because the plain
// Homebrew ffmpeg is built without libass/freetype (no `subtitles` and `drawtext` filters, which
// burned-in captions and text mattes need). Python on macOS is `python3`, and the system one does
// not take pip installs, so a venv in ~/.elite-cinema/venv (faster-whisper) wins when it exists.
// ELITE_FFMPEG, ELITE_FFPROBE and ELITE_PYTHON always win.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const BREW = ['/opt/homebrew', '/usr/local'];

function firstFile(list) {
  for (const f of list) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** An ffmpeg-family program: env override, then (macOS) Homebrew's ffmpeg-full and bin, then the PATH. */
function ffTool(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  if (!MAC) return name;
  return firstFile([...BREW.map((b) => path.join(b, 'opt', 'ffmpeg-full', 'bin', name)), ...BREW.map((b) => path.join(b, 'bin', name))]) || name;
}

/** The Python of a venv folder (Scripts\python.exe on Windows, bin/python elsewhere). */
const venvPython = (venv) => (WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));

function python() {
  if (process.env.ELITE_PYTHON) return process.env.ELITE_PYTHON;
  if (WIN) return 'python';
  return firstFile([venvPython(path.join(os.homedir(), '.elite-cinema', 'venv')), ...BREW.map((b) => path.join(b, 'bin', 'python3'))]) || 'python3';
}

module.exports = { WIN, MAC, FFMPEG: ffTool('ffmpeg', 'ELITE_FFMPEG'), FFPROBE: ffTool('ffprobe', 'ELITE_FFPROBE'), PYTHON: python(), venvPython };
