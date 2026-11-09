// "Atualizar" in the Ligação panel: which version of Cinemex this computer runs, whether GitHub has
// a newer one, and getting it (git pull, install if the dependencies changed, build the interface).
// Only works when the app folder is a git clone of the repository (the way both computers run it).
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

function run(cmd, args, { timeout = 60000, shell = false, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout, shell, env: env || process.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout.toString().trim());
    });
  });
}

const isGit = () => fs.existsSync(path.join(APP_DIR, '.git'));

function parseCommit(line) {
  const [hash, subject, author, date] = String(line || '').split('\x1f');
  return hash ? { hash, subject, author, date } : null;
}
const FMT = '--format=%h%x1f%s%x1f%an%x1f%cI';

/** This computer's version, and the newest one on GitHub (fetches when `fetch` is true). */
async function info({ fetch = true } = {}) {
  if (!isGit()) return { git: false };
  const local = parseCommit(await run('git', ['log', '-1', FMT]));
  let fetched = false;
  let fetchError = null;
  if (fetch) {
    try {
      await run('git', ['fetch', '--quiet', 'origin', 'main'], { timeout: 30000 });
      fetched = true;
    } catch (err) {
      fetchError = err.message;
    }
  }
  let remote = null;
  let behind = 0;
  let ahead = 0;
  try {
    remote = parseCommit(await run('git', ['log', '-1', FMT, 'origin/main']));
    const counts = (await run('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])).split(/\s+/).map(Number);
    ahead = counts[0] || 0;
    behind = counts[1] || 0;
  } catch {
    /* no origin/main yet */
  }
  const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).length > 0;
  return { git: true, local, remote, behind, ahead, dirty, fetched, fetchError };
}

/** Gets the newest version from GitHub and builds it. The app restarts afterwards. */
async function apply({ onStep = () => {} } = {}) {
  if (!isGit()) throw new Error('Esta pasta não é uma cópia do GitHub: não dá para atualizar daqui');
  const before = await run('git', ['rev-parse', 'HEAD']);
  onStep('A buscar a versão nova ao GitHub…');
  await run('git', ['pull', '--ff-only', 'origin', 'main'], { timeout: 120000 });
  const after = await run('git', ['rev-parse', 'HEAD']);
  if (before === after) return { changed: false };
  const changed = (await run('git', ['diff', '--name-only', before, after])).split('\n');
  if (changed.some((f) => f === 'package.json' || f === 'pnpm-lock.yaml')) {
    onStep('A instalar dependências novas…');
    await run('pnpm', ['install', '--frozen-lockfile'], { timeout: 600000, shell: true });
  }
  onStep('A preparar a interface…');
  // Vite runs with this app's own Node (Electron as Node), so no separate Node is needed.
  await new Promise((resolve, reject) => {
    const vite = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    const p = spawn(process.execPath, [vite, 'build'], { cwd: APP_DIR, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`A preparação da interface falhou (código ${code})`))));
  });
  return { changed: true, from: before.slice(0, 7), to: after.slice(0, 7) };
}

module.exports = { info, apply, isGit };
