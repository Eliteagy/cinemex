// User fonts: fonts installed on this PC that the app may use but never ships (personal-use
// licences such as Birds of Paradise). Found in the Windows font folders, read for the preview and
// copied next to the ASS file on export. A missing font falls back to a bundled one (USER_FONTS).
const fs = require('node:fs');
const path = require('node:path');

function fontDirs() {
  const dirs = [];
  if (process.env.ELITE_USER_FONTS_DIR) dirs.push(process.env.ELITE_USER_FONTS_DIR);
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
  return dirs;
}

/** Family name (name ID 1) of a TrueType/OpenType font file. */
function familyName(buf) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) !== 'name') continue;
    const off = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(off + 2);
    const strings = off + buf.readUInt16BE(off + 4);
    let mac = null;
    for (let j = 0; j < count; j++) {
      const r = off + 6 + j * 12;
      const platform = buf.readUInt16BE(r);
      const id = buf.readUInt16BE(r + 6);
      if (id !== 1) continue;
      const len = buf.readUInt16BE(r + 8);
      const at = strings + buf.readUInt16BE(r + 10);
      if (platform === 3 || platform === 0) {
        const b = Buffer.from(buf.subarray(at, at + len));
        b.swap16();
        return b.toString('utf16le');
      }
      if (platform === 1) mac = buf.toString('latin1', at, at + len);
    }
    return mac;
  }
  return null;
}

const cache = new Map();
/** { file, family } of an installed user font, or null. `pattern` matches the file name. */
function findUserFont(pattern) {
  const key = String(pattern);
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const dir of fontDirs()) {
    let list = [];
    try {
      list = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const f = list.find((n) => pattern.test(n));
    if (!f) continue;
    try {
      const file = path.join(dir, f);
      const family = familyName(fs.readFileSync(file));
      if (family) {
        found = { file, family };
        break;
      }
    } catch {
      /* unreadable font: keep looking */
    }
  }
  cache.set(key, found);
  return found;
}

// ------------------------------------------------------------------ installed fonts (font picker)

/** Read `len` bytes at `pos` of an open file. */
function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

/**
 * Family, subfamily and vertical metrics of every face in a font file, reading only the headers
 * and the name/head/OS2 tables (system fonts can be large). TTC collections give one entry per face.
 */
function readFaces(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readAt(fd, 0, 12);
    if (head.length < 12) return [];
    const tag = head.toString('latin1', 0, 4);
    let offsets = [0];
    if (tag === 'ttcf') {
      const n = Math.min(head.readUInt32BE(8), 64);
      const list = readAt(fd, 12, n * 4);
      offsets = [];
      for (let i = 0; i < n; i++) offsets.push(list.readUInt32BE(i * 4));
    } else if (!['\u0000\u0001\u0000\u0000', 'OTTO', 'true'].includes(tag)) return [];
    const faces = [];
    for (const off of offsets) {
      const dir = readAt(fd, off, 12);
      const numTables = dir.readUInt16BE(4);
      const recs = readAt(fd, off + 12, numTables * 16);
      const tables = {};
      for (let i = 0; i < numTables; i++) tables[recs.toString('latin1', i * 16, i * 16 + 4)] = { at: recs.readUInt32BE(i * 16 + 8), len: recs.readUInt32BE(i * 16 + 12) };
      if (!tables.name) continue;
      const nb = readAt(fd, tables.name.at, Math.min(tables.name.len, 256 * 1024));
      const names = {};
      const count = nb.readUInt16BE(2);
      const strings = nb.readUInt16BE(4);
      for (let j = 0; j < count; j++) {
        const r = 6 + j * 12;
        if (r + 12 > nb.length) break;
        const platform = nb.readUInt16BE(r);
        const lang = nb.readUInt16BE(r + 4);
        const id = nb.readUInt16BE(r + 6);
        if (id !== 1 && id !== 2) continue;
        const len = nb.readUInt16BE(r + 8);
        const at = strings + nb.readUInt16BE(r + 10);
        if (at + len > nb.length) continue;
        let v = null;
        if (platform === 3 || platform === 0) {
          // Prefer English (0x409) names, the ones libass and Chromium match.
          if (names[id] && lang !== 0x409) continue;
          const b = Buffer.from(nb.subarray(at, at + len));
          b.swap16();
          v = b.toString('utf16le');
        } else if (platform === 1 && !names[id]) v = nb.toString('latin1', at, at + len);
        if (v) names[id] = v.replace(/\u0000/g, '').trim();
      }
      if (!names[1]) continue;
      let upem = 1000;
      let a = 0;
      let d = 0;
      if (tables.head) upem = readAt(fd, tables.head.at + 18, 2).readUInt16BE(0) || 1000;
      if (tables['OS/2'] && tables['OS/2'].len >= 78) {
        const os2 = readAt(fd, tables['OS/2'].at + 74, 4);
        a = os2.readUInt16BE(0);
        d = os2.readUInt16BE(2);
      }
      faces.push({ family: names[1], sub: names[2] || 'Regular', upem, a, d });
    }
    return faces;
  } finally {
    fs.closeSync(fd);
  }
}

let fontList = null;
/**
 * Every font family installed on this PC: [{ family, user, files, regular, upem, a, d }].
 * Parsed headers are cached in `cacheFile` (keyed by path, size and date) so later starts are fast.
 */
function listInstalledFonts(cacheFile) {
  if (fontList) return fontList;
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
  } catch {
    /* no cache yet */
  }
  const next = {};
  const families = new Map();
  const dirs = fontDirs();
  for (const dir of dirs) {
    let list = [];
    try {
      list = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const user = !dir.toLowerCase().startsWith(String(process.env.WINDIR || 'C:\Windows').toLowerCase());
    for (const name of list) {
      if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
      const file = path.join(dir, name);
      let faces;
      try {
        const st = fs.statSync(file);
        const key = `${st.size}:${Math.round(st.mtimeMs)}`;
        faces = cache[file]?.key === key ? cache[file].faces : readFaces(file);
        next[file] = { key, faces };
      } catch {
        continue;
      }
      for (const f of faces) {
        if (f.family.startsWith('@')) continue; // vertical CJK variants
        let fam = families.get(f.family);
        if (!fam) families.set(f.family, (fam = { family: f.family, user, files: [], regular: null, upem: f.upem, a: f.a, d: f.d }));
        if (!fam.files.includes(file)) fam.files.push(file);
        if (/^(regular|normal|book|roman)$/i.test(f.sub) || !fam.regular) {
          if (!fam.regular || /^(regular|normal|book|roman)$/i.test(f.sub)) Object.assign(fam, { regular: file, upem: f.upem, a: f.a, d: f.d });
        }
      }
    }
  }
  try {
    if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(next));
  } catch {
    /* cache is optional */
  }
  fontList = [...families.values()].sort((x, y) => x.family.localeCompare(y.family, 'pt'));
  return fontList;
}

/** Installed family by name (case-insensitive), or null. */
function findFamily(family, cacheFile) {
  const want = String(family).toLowerCase();
  return listInstalledFonts(cacheFile).find((f) => f.family.toLowerCase() === want) || null;
}

module.exports = { findUserFont, familyName, readFaces, listInstalledFonts, findFamily };
