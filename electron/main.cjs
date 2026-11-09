// Cinemex — main process: window, media protocol (with byte ranges for seeking),
// import/transcribe/export through IPC, and the MCP server bridged to the editor UI.
const { app, BrowserWindow, dialog, ipcMain, protocol, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { importFile, kindOf, peaks, freezeFrame } = require('./media.cjs');
const { ensureSfx } = require('./sfx.cjs');
const { listDrafts, convertDraft, DRAFTS } = require('./capcut.cjs');
const { transcribe, captionClipsFor } = require('./captions.cjs');
const { createMatteEngine } = require('./matte.cjs');
const { findUserFont, listInstalledFonts, findFamily } = require('./fonts.cjs');
const { createStyleStore } = require('./styles.cjs');
const { USER_FONTS } = require('../src/lib/emphasis.js');
const { runExport, setFontCache } = require('./render.cjs');
const { createMcpServer } = require('./mcp.cjs');
const { createClaudeChat } = require('./claude-chat.cjs');
const { createGptChat, createGeminiChat } = require('./ai-providers.cjs');

const ROOT = path.join(__dirname, '..');
const allowed = new Set(); // media files the renderer may stream (imported or from opened projects)
let win = null;
let mcp = null;
let mcpUrl = '';
let mcpToken = '';
let chat = null;
let aiChats = null; // GPT and Gemini chats (cleaned up on quit)
let exportAbort = null;

protocol.registerSchemesAsPrivileged([{ scheme: 'ec-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.setName('Cinemex');
// Test mode runs beside the real app: its own profile (lock, token) and discovery file.
if (process.env.ELITE_HIDDEN) app.setPath('userData', path.join(os.tmpdir(), 'cinemex-test-profile'));
else migrateFromEliteCinema();
if (!app.requestSingleInstanceLock()) app.quit();

/**
 * The app was called Elite Cinema until 09/11/2026. On the first start as Cinemex, copy the old
 * data folder (saved caption styles, MCP token, font cache, models, window state, preferences) and
 * the old discovery folder (~/.elite-cinema, with the Mac's Python venv) to the new names. Copies,
 * never moves: the old folders stay as a backup. Runs once, before anything opens the new folder.
 */
function migrateFromEliteCinema() {
  const copyOnce = (from, to) => {
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) return;
      fs.cpSync(from, to, {
        recursive: true,
        // Chromium lock and cache files are recreated; skipping them avoids copying a live lock.
        filter: (src) => !/[\\/](SingletonLock|SingletonCookie|SingletonSocket|lockfile|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache)$/i.test(src),
      });
    } catch (err) {
      console.error('Cinemex: could not copy the old Elite Cinema data', from, err);
    }
  };
  copyOnce(path.join(app.getPath('appData'), 'Elite Cinema'), app.getPath('userData'));
  copyOnce(path.join(os.homedir(), '.elite-cinema'), path.join(os.homedir(), '.cinemex'));
}

const norm = (p) => path.resolve(p).toLowerCase();
const allow = (p) => allowed.add(norm(p));

function mediaResponse(request) {
  const url = new URL(request.url);
  const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!allowed.has(norm(file)) || !fs.existsSync(file)) return new Response('not allowed', { status: 403 });
  const size = fs.statSync(file).size;
  const type = /\.(mp3)$/i.test(file) ? 'audio/mpeg' : /\.(wav)$/i.test(file) ? 'audio/wav' : /\.(m4a|aac)$/i.test(file) ? 'audio/mp4' : /\.(png)$/i.test(file) ? 'image/png' : /\.(jpe?g)$/i.test(file) ? 'image/jpeg' : /\.(webp)$/i.test(file) ? 'image/webp' : /\.(webm)$/i.test(file) ? 'video/webm' : 'video/mp4';
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}

async function importPaths(paths) {
  const out = [];
  const errors = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p) || !kindOf(p)) throw new Error(`Não existe ou formato não suportado: ${p}`);
      const m = await importFile(p);
      allow(p);
      out.push(m);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { media: out, errors };
}

function defaultExportPath(name) {
  const dir = app.getPath('videos');
  const base = String(name || 'Cinemex').replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'Cinemex';
  let file = path.join(dir, `${base}.mp4`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).mp4`);
  return file;
}

// ------------------------------------------------------------------ MCP bridge to the editor UI
const pending = new Map();
function callEditor(name, args) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('O Cinemex não tem janela aberta'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('O editor demorou demasiado a responder'));
    }, 45 * 60_000);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send('mcp:call', { id, name, args });
  });
}
ipcMain.on('mcp:result', (_e, { id, ok, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  ok ? p.resolve(result) : p.reject(new Error(error || 'falhou'));
});

async function startMcp() {
  const dataDir = app.getPath('userData');
  const tokenFile = path.join(dataDir, 'mcp-token.txt');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  mcpToken = token;
  mcp = createMcpServer({ token, call: callEditor, version: app.getVersion() });
  const port = await mcp.listen(Number(process.env.ELITE_MCP_PORT) || 4545);
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  // Discovery file for clients (no token inside; the token stays in its own file).
  const disc = process.env.ELITE_DISCOVERY_DIR || path.join(os.homedir(), '.cinemex');
  fs.mkdirSync(disc, { recursive: true });
  fs.writeFileSync(path.join(disc, 'mcp.json'), JSON.stringify({ url: mcpUrl, tokenFile }, null, 2));
}

// ------------------------------------------------------------------ IPC
function handlers() {
  ipcMain.handle('media:import-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importar media',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Média', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp'] }],
    });
    return r.canceled ? { media: [], errors: [] } : importPaths(r.filePaths);
  });
  ipcMain.handle('media:import', (_e, paths) => importPaths((Array.isArray(paths) ? paths : []).map(String).slice(0, 200)));
  ipcMain.handle('media:allow', (_e, paths) => {
    for (const p of Array.isArray(paths) ? paths : []) if (kindOf(String(p))) allow(String(p));
    return true;
  });
  ipcMain.handle('captions:transcribe', (_e, file, opts = {}) => {
    if (!allowed.has(norm(file))) throw new Error('Media não importada');
    const o = opts && typeof opts === 'object' ? opts : {};
    return transcribe(file, { language: String(o.language || 'pt').slice(0, 8), model: o.model ? String(o.model) : undefined, translate: Boolean(o.translate), prompt: o.prompt ? String(o.prompt) : undefined });
  });
  // User fonts (installed on this PC, personal licences): bytes for the preview's FontFace.
  const fontCache = path.join(app.getPath('userData'), 'font-cache.json');
  setFontCache(fontCache);
  ipcMain.handle('fonts:list', () => listInstalledFonts(fontCache).map((f) => ({ family: f.family, user: f.user, upem: f.upem, a: f.a, d: f.d })));
  ipcMain.handle('fonts:file', (_e, family) => {
    const f = findFamily(String(family), fontCache);
    return f?.regular ? fs.readFileSync(f.regular) : null;
  });
  const styleStore = createStyleStore(path.join(app.getPath('userData'), 'caption-styles.json'));
  ipcMain.handle('styles:list', () => styleStore.list());
  ipcMain.handle('styles:save', (_e, id, style) => styleStore.save(id ?? null, style));
  ipcMain.handle('styles:delete', (_e, id) => styleStore.delete(String(id)));
  ipcMain.handle('fonts:user', (_e, name) => {
    const u = USER_FONTS[String(name)];
    const f = u && findUserFont(u.file);
    return f ? fs.readFileSync(f.file) : null;
  });
  ipcMain.handle('captions:clips', (_e, clip, words, opts) => captionClipsFor(clip, words, opts));
  // Person matte for a "Pessoa" mask (captions behind the person). Progress and status go to the UI.
  const matteEngine = createMatteEngine(app.getPath('userData'));
  ipcMain.handle('matte:run', async (e, req = {}) => {
    const file = String(req.file || '');
    if (!allowed.has(norm(file))) throw new Error('Media não importada');
    const tin = Math.max(0, Number(req.tin) || 0);
    const tout = Number(req.tout);
    if (!(tout > tin)) throw new Error('Intervalo do clip inválido');
    const pt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
    const send = (msg) => !e.sender.isDestroyed() && e.sender.send('matte:progress', msg);
    const out = await matteEngine.matte(
      { file, tin, tout, x: pt(req.x), y: pt(req.y) },
      { onProgress: (p) => send({ id: req.id, progress: p }), onStatus: (status) => send({ id: req.id, status }) },
    );
    allow(out);
    return out;
  });
  ipcMain.handle('export:run', async (_e, project, opts = {}) => {
    let out = opts.path;
    if (!out && opts.ask !== false) {
      const r = await dialog.showSaveDialog(win, { title: 'Exportar vídeo', defaultPath: defaultExportPath(project.name), filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }] });
      if (r.canceled) return null;
      out = r.filePath;
    }
    out = out || defaultExportPath(project.name);
    if (!/\.mp4$/i.test(out)) out += '.mp4';
    exportAbort = new AbortController();
    try {
      return await runExport(project, out, {
        encoder: opts.gpu ? (process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc') : 'libx264',
        quality: ['alta', 'media', 'leve'].includes(opts.quality) ? opts.quality : 'alta',
        signal: exportAbort.signal,
        onProgress: (p) => win?.webContents.send('export:progress', p),
      });
    } finally {
      exportAbort = null;
    }
  });
  ipcMain.handle('export:cancel', () => exportAbort?.abort());
  ipcMain.handle('project:save', async (_e, project, file) => {
    let out = file;
    if (!out) {
      const r = await dialog.showSaveDialog(win, { title: 'Guardar projeto', defaultPath: path.join(app.getPath('documents'), `${project.name || 'Projeto'}.ecproj`), filters: [{ name: 'Projeto Cinemex', extensions: ['ecproj'] }] });
      if (r.canceled) return null;
      out = r.filePath;
    }
    fs.writeFileSync(out, JSON.stringify(project, null, 2), 'utf8');
    return out;
  });
  ipcMain.handle('project:open', async (_e, given) => {
    let file = null;
    if (given !== undefined && given !== null) {
      // Opened by path (MCP open_project): only existing .ecproj files.
      if (typeof given !== 'string' || !/\.ecproj$/i.test(given) || !fs.existsSync(given)) throw new Error('Projeto .ecproj não encontrado');
      if (fs.statSync(given).size > 50 * 1024 * 1024) throw new Error('Projeto grande demais');
      file = given;
    } else {
      const r = await dialog.showOpenDialog(win, { title: 'Abrir projeto', properties: ['openFile'], filters: [{ name: 'Projeto Cinemex', extensions: ['ecproj'] }] });
      if (r.canceled) return null;
      file = r.filePaths[0];
    }
    const project = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const m of project.media || []) if (m?.path && kindOf(m.path)) allow(m.path);
    // Person mattes of "Pessoa" masks: only files the matte engine made (userData/mattes).
    for (const t of project.tracks || [])
      for (const c of t?.clips || [])
        for (const mk of c?.masks || []) {
          const f = mk?.matte?.file;
          if (typeof f === 'string' && path.dirname(path.resolve(f)).toLowerCase() === path.resolve(matteEngine.dir).toLowerCase() && fs.existsSync(f)) allow(f);
        }
    return { project, path: file };
  });
  ipcMain.handle('shell:reveal', (_e, file) => {
    if (typeof file === 'string' && fs.existsSync(file)) shell.showItemInFolder(file);
  });
  ipcMain.handle('mcp:info', () => ({ url: mcpUrl }));
  ipcMain.handle('media:peaks', (_e, file) => (allowed.has(norm(file)) ? peaks(file) : null));
  // Built-in sound effects (synthesised once into the data folder) and freeze-frame stills.
  ipcMain.handle('sfx:list', () => {
    const list = ensureSfx(path.join(app.getPath('userData'), 'sfx'));
    list.forEach((x) => allow(x.path));
    return list;
  });
  ipcMain.handle('media:freeze', async (_e, file, time) => {
    if (!allowed.has(norm(file))) throw new Error('Media não importada');
    const out = await freezeFrame(file, Number(time) || 0, path.join(app.getPath('userData'), 'frames'));
    allow(out);
    return out;
  });
  ipcMain.handle('capcut:list', () => listDrafts());
  ipcMain.handle('capcut:import', async (_e, file) => {
    let target = typeof file === 'string' && file ? file : null;
    if (!target) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Importar projeto do CapCut (draft_content.json)',
        defaultPath: fs.existsSync(DRAFTS) ? DRAFTS : app.getPath('documents'),
        properties: ['openFile'],
        filters: [{ name: 'Projeto CapCut', extensions: ['json'] }],
      });
      if (r.canceled) return null;
      target = r.filePaths[0];
    }
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'draft_content.json');
    if (!fs.existsSync(target)) throw new Error('Não encontrei o draft_content.json');
    const res = await convertDraft(target, async (p) => {
      const m = await importFile(p);
      allow(p);
      return m;
    });
    return res;
  });
  ipcMain.handle('text:save', async (_e, name, content, ext) => {
    const e = ['srt', 'txt'].includes(ext) ? ext : 'txt';
    const r = await dialog.showSaveDialog(win, { title: 'Guardar', defaultPath: path.join(app.getPath('documents'), `${String(name || 'legendas').replace(/[\\/:*?"<>|]/g, '')}.${e}`), filters: [{ name: e.toUpperCase(), extensions: [e] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, String(content), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('text:open', async (_e, ext) => {
    const e = ['srt', 'txt'].includes(ext) ? ext : 'txt';
    const r = await dialog.showOpenDialog(win, { title: 'Abrir', properties: ['openFile'], filters: [{ name: e.toUpperCase(), extensions: [e] }] });
    if (r.canceled) return null;
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 5 * 1024 * 1024) throw new Error('Ficheiro grande demais');
    return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
  });
  ipcMain.handle('srt:write', (_e, file, content) => {
    if (typeof file !== 'string' || !/\.srt$/i.test(file) || !path.isAbsolute(file)) throw new Error('Indica um caminho completo terminado em .srt');
    fs.writeFileSync(file, String(content), 'utf8');
    return file;
  });
  ipcMain.handle('srt:read', (_e, file) => {
    if (typeof file !== 'string' || !/\.srt$/i.test(file) || !fs.existsSync(file)) throw new Error('Ficheiro .srt não encontrado');
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Ficheiro grande demais');
    return fs.readFileSync(file, 'utf8');
  });
  ipcMain.handle('lut:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Escolher LUT', properties: ['openFile'], filters: [{ name: 'LUT 3D', extensions: ['cube'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  // Claude chat panel: narrow handlers, the renderer never sees the CLI, its args or the token.
  chat = createClaudeChat({
    userData: app.getPath('userData'),
    getMcp: () => (mcpUrl ? { url: mcpUrl, token: mcpToken } : null),
    send: (ev) => win && !win.isDestroyed() && win.webContents.send('claude:event', ev),
  });
  // GPT (Codex CLI) and Gemini (OmniRoute) in the same panel, with the same editor tools.
  const aiSend = (ev) => win && !win.isDestroyed() && win.webContents.send('claude:event', ev);
  const chats = (aiChats = {
    claude: chat,
    gpt: createGptChat({ userData: app.getPath('userData'), getMcp: () => (mcpUrl ? { url: mcpUrl, token: mcpToken } : null), send: aiSend }),
    gemini: createGeminiChat({ userData: app.getPath('userData'), callTool: (name, args) => callEditor(name, args), send: aiSend }),
  });
  const pick = (who) => chats[who] || chat;
  ipcMain.handle('claude:status', (_e, who) => pick(who).status());
  ipcMain.handle('claude:send', (_e, projectKey, text, who) => pick(who).sendMessage(typeof projectKey === 'string' ? projectKey : '', typeof text === 'string' ? text : ''));
  ipcMain.handle('claude:cancel', (_e, who) => pick(who).cancel());
  ipcMain.handle('claude:reset', (_e, projectKey, who) => pick(who).reset(typeof projectKey === 'string' ? projectKey : ''));
  ipcMain.handle('app:paths', () => ({ videos: app.getPath('videos'), documents: app.getPath('documents') }));
}

const ICON = path.join(ROOT, 'build', 'icon.ico');
const SPLASH_MS = 2950; // matches the fade-out at the end of electron/splash/splash.html

/** Animated logo shown while the editor loads. Skipped in test mode. Resolves when it may close. */
function showSplash() {
  if (process.env.ELITE_HIDDEN) return null;
  const splash = new BrowserWindow({
    width: 560,
    height: 420,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: false,
    icon: ICON,
    title: 'Cinemex',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.once('ready-to-show', () => splash.show());
  splash.loadFile(path.join(__dirname, 'splash', 'splash.html'));
  const minTime = new Promise((r) => setTimeout(r, SPLASH_MS));
  return { splash, minTime };
}

function createWindow() {
  const intro = showSplash();
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    title: 'Cinemex',
    icon: ICON,
    show: !intro,
    // Test mode: a real, painting window placed off-screen (hidden windows stop repainting).
    ...(process.env.ELITE_HIDDEN ? { x: -5000, y: 0, skipTaskbar: true, focusable: false } : {}),
    backgroundColor: '#08080a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#08080a', symbolColor: '#a8a8b3', height: 44 },
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !process.env.ELITE_HIDDEN },
  });
  nativeTheme.themeSource = 'dark';
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5199')) e.preventDefault();
  });
  if (process.env.ELITE_DEV) win.loadURL('http://localhost:5199');
  else win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  win.on('closed', () => (win = null));
  if (intro) {
    const ready = new Promise((r) => win.once('ready-to-show', r));
    const fallback = new Promise((r) => setTimeout(r, 12000)); // never leave the user stuck on the splash
    Promise.race([Promise.all([ready, intro.minTime]), fallback]).then(() => {
      if (win) {
        win.show();
        win.focus();
      }
      if (!intro.splash.isDestroyed()) intro.splash.close();
    });
  }
  // Test hook: with ELITE_SHOT=<file.png>, creating <file.png>.req saves a screenshot (works hidden).
  if (process.env.ELITE_SHOT) {
    const shot = process.env.ELITE_SHOT;
    setInterval(async () => {
      if (!win || !fs.existsSync(shot + '.req')) return;
      fs.rmSync(shot + '.req', { force: true });
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    }, 400);
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('will-quit', () => {
  chat?.cleanup();
  aiChats?.gpt?.cleanup();
  aiChats?.gemini?.cleanup();
});

if (process.platform === 'win32') app.setAppUserModelId('com.eliteagency.cinema');

app.whenReady().then(async () => {
  protocol.handle('ec-media', mediaResponse);
  handlers();
  createWindow();
  try {
    await startMcp();
  } catch (e) {
    console.error('MCP não arrancou:', e.message);
  }
});
app.on('window-all-closed', () => {
  chat?.cleanup();
  mcp?.close();
  app.quit();
});
