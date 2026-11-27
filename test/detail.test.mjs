// Detalhe (src/lib/detail.js): the ffmpeg expressions equal the reference formulas, and a real
// export moves the picture in the expected direction for every tool (zero = no filter added).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FFMPEG } = require('../electron/bin.cjs');
const { buildExport, runExport } = require('../electron/render.cjs');
const D = await import('../src/lib/detail.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-detail-'));

/** Runs `blend all_expr` on two grey rows (values 0..1, 16-bit or 8-bit planes) and returns the result 0..1. */
function ffBlend(expr, A, B, bits = 16) {
  const dir = tmp();
  try {
    const n = A.length;
    const S = bits === 16 ? 65535 : 255;
    const raw = (v) => {
      const b = Buffer.alloc(n * (bits / 8));
      v.forEach((x, i) => (bits === 16 ? b.writeUInt16LE(Math.round(x * S), i * 2) : b.writeUInt8(Math.round(x * S), i)));
      return b;
    };
    const fmt = bits === 16 ? 'gray16le' : 'gray';
    fs.writeFileSync(path.join(dir, 'a.raw'), raw(A));
    fs.writeFileSync(path.join(dir, 'b.raw'), raw(B));
    const inp = (f) => ['-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${n}x1`, '-i', f];
    const r = spawnSync(FFMPEG, ['-v', 'error', ...inp('a.raw'), ...inp('b.raw'), '-filter_complex', `[0][1]blend=all_expr='${expr}'`, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { cwd: dir, maxBuffer: 1 << 20 });
    assert.equal(r.status, 0, String(r.stderr));
    return Array.from({ length: n }, (_, i) => (bits === 16 ? r.stdout.readUInt16LE(i * 2) : r.stdout[i]) / S);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const close = (got, exp, tol, what) => got.forEach((g, i) => assert.ok(Math.abs(g - exp[i]) <= tol, `${what} #${i}: ffmpeg ${g} vs ${exp[i]}`));
const q16 = (v) => Math.round(v * 65535) / 65535;
const grid = (n, lo, hi) => Array.from({ length: n }, (_, i) => q16(lo + ((hi - lo) * i) / (n - 1)));
const T = 3 / 65535;

test('ffmpeg expressions equal the reference formulas', () => {
  const x16 = (body, A, B) => ffBlend(D.wrap16(body), A, B);
  const c = grid(41, 0, 1);
  const c2 = c.map((v) => q16((v * 7.3) % 1));
  close(x16(D.FF.logLum, c, c), c.map((y) => D.encL(Math.log2(Math.max(D.lin(y), 1e-7) / D.GREY))), T, 'logLum');
  close(x16(D.FF.clarityDetail, c, c2), c.map((v, i) => D.encCD((v - c2[i]) * D.L_SPAN)), T, 'clarityDetail');
  const cd = grid(41, 0, 1).reverse();
  close(x16(D.FF.hsClar(-0.6, 0.7, 0.4), c, cd), c.map((v, i) => D.encD(D.hsDelta(D.decL(v), -0.6, 0.7) + D.clarityDelta(D.decCD(cd[i]), D.decL(v), 0.4))), T, 'hsClar');
  close(x16(D.FF.texture(0.7), c, c2), c.map((v, i) => D.encD(D.textureDelta((v - c2[i]) * D.L_SPAN, 0.7))), T, 'texture');
  for (const mask of [0, 0.4]) close(x16(D.FF.sharpen(0.8, 0.2, mask), c, c2), c.map((v, i) => D.encD(D.sharpenDelta((v - c2[i]) * D.L_SPAN, 0.8, 0.2, mask))), T, `sharpen m=${mask}`);
  const dl = grid(41, D.encD(-2), D.encD(2));
  close(x16(D.FF.add, c.map((v) => q16(0.4 + v * 0.2)), dl), c.map((v, i) => D.encD(D.decD(q16(0.4 + v * 0.2)) + D.decD(dl[i]))), T, 'add');
  close(x16(D.FF.gain, c, dl), c.map((v, i) => D.applyGain(v, D.decD(dl[i]))), T, 'gain');
  close(x16(D.FF.linMin, c, c2), c.map((v, i) => D.lin(Math.min(v, c2[i]))), T, 'linMin');
  close(x16(D.FF.veil(0.8), c, c2), c.map((v, i) => D.veilOf(v, c2[i], 0.8)), T, 'veil');
  for (const d of [0.7, -0.5]) close(x16(D.FF.dehaze(d, 0.8), c, c2), c.map((v, i) => D.dehazeJS(v, c2[i], d, 0.8)), T, `dehaze ${d}`);
  // grain: 8-bit planes
  const g = Array.from({ length: 41 }, (_, i) => Math.round((i / 40) * 255) / 255);
  const n = g.map((v) => Math.round(D.encN((v - 0.5) * 2) * 255) / 255);
  close(ffBlend(D.wrap8(D.FF.grain(0.08)), g, n, 8), g.map((v, i) => D.grainJS(v, D.decN(n[i]), 0.08)), 1.5 / 255, 'grain');
  close(ffBlend(D.wrap8(D.FF.octaves(0.5)), g, g.slice().reverse(), 8), g.map((v, i) => D.encN(((v * 255 - 128) / 50) * 0.75 + ((g[40 - i] * 255 - 128) / 50) * 0.35)), 1.5 / 255, 'octaves');
});

test('sizes scale with the long edge; zero settings are off', () => {
  const a = D.detailParams({ clarity: 50 }, 1920);
  const b = D.detailParams({ clarity: 50 }, 960);
  assert.ok(Math.abs(a.texSigma / b.texSigma - 2) < 1e-9);
  assert.ok(a.hs.r * a.hs.sub > b.hs.r * b.hs.sub);
  assert.ok(a.hs.r <= 20 && a.hs.sub >= 2);
  assert.equal(D.hasDetail({ dev: { clarity: 0, sharpen: { amount: 0, radius: 2 }, grain: { amount: 50 } } }), false);
  assert.equal(D.hasGrain({ dev: { grain: { amount: 50 } } }), true);
  assert.equal(D.hasDetail({ dev: { localShadows: 10 } }), true);
  const px = new Uint8ClampedArray(64 * 36 * 4).fill(200);
  assert.ok(Math.abs(D.estimateAirlight(px, 64, 36) - D.lin(200 / 255)) < 0.01);
});

// ---- real export ---------------------------------------------------------------------------
const W = 640;
const H = 360;
let dir;
let src;
const frames = new Map();

function makeSource() {
  dir = tmp();
  src = path.join(dir, 'src.mp4');
  // A hazy, detailed picture: test pattern with lowered contrast, dark and bright regions.
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=25:d=1`, '-vf', 'eq=contrast=0.6:brightness=0.08', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-y', src]);
  assert.equal(r.status, 0, String(r.stderr));
}

async function exportFrame(dev, t = 0.48) {
  const key = JSON.stringify(dev) + t;
  if (frames.has(key)) return frames.get(key);
  const p = {
    name: 'd',
    canvas: { w: W, h: H, fps: 25, preset: '16:9' },
    media: [{ id: 'm', path: src, kind: 'video', duration: 1, width: W, height: H, hasAudio: false }],
    tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 1, fit: 'fill', ...(dev ? { color: { dev } } : {}) }] }],
  };
  const out = path.join(dir, `o${frames.size}.mp4`);
  await runExport(p, out);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (0.2126 * r.stdout[i * 3] + 0.7152 * r.stdout[i * 3 + 1] + 0.0722 * r.stdout[i * 3 + 2]) / 255;
  frames.set(key, lum);
  return lum;
}

const mean = (a, f = () => true) => {
  let s = 0;
  let n = 0;
  a.forEach((v, i) => {
    if (f(i)) {
      s += v;
      n++;
    }
  });
  return s / Math.max(1, n);
};
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
/** Fine detail energy: mean |pixel − right neighbour|. */
const fine = (a) => {
  let s = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) s += Math.abs(a[y * W + x + 1] - a[y * W + x]);
  return s / (H * (W - 1));
};
/** Local contrast: std of the picture minus its 15x15 box blur. */
const local = (a) => {
  const r = 7;
  let s = 0;
  let n = 0;
  for (let y = r; y < H - r; y += 2) for (let x = r; x < W - r; x += 2) {
    let m = 0;
    for (let j = -r; j <= r; j += 1) for (let i = -r; i <= r; i += 1) m += a[(y + j) * W + x + i];
    m /= (2 * r + 1) ** 2;
    s += (a[y * W + x] - m) ** 2;
    n++;
  }
  return Math.sqrt(s / n);
};

test('export: each detail tool moves the picture the expected way', async (t) => {
  makeSource();
  try {
    const ref = await exportFrame(null);
    const darkPx = (i) => ref[i] < 0.3;
    const brightPx = (i) => ref[i] > 0.7;
    await t.test('zero settings add no filter and change nothing', async () => {
      const zero = { localHighlights: 0, localShadows: 0, clarity: 0, texture: 0, sharpen: { amount: 0, radius: 2 }, dehaze: 0, grain: { amount: 0 } };
      const p = { name: 'z', canvas: { w: W, h: H, fps: 25 }, media: [{ id: 'm', path: src, kind: 'video', duration: 1, hasAudio: false }], tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 1, fit: 'fill', color: { dev: zero } }] }] };
      const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('[base0]'));
      assert.ok(!/dt0_|gr0_|guided|noise=/.test(fc), fc);
      const z = await exportFrame(zero);
      assert.ok(mean(z.map((v, i) => Math.abs(v - ref[i]))) < 0.002);
    });
    await t.test('shadows lift dark areas, highlights pull bright areas', async () => {
      const sh = await exportFrame({ localShadows: 80 });
      assert.ok(mean(sh, darkPx) > mean(ref, darkPx) + 0.01, `${mean(sh, darkPx)} vs ${mean(ref, darkPx)}`);
      const hl = await exportFrame({ localHighlights: -80 });
      assert.ok(mean(hl, brightPx) < mean(ref, brightPx) - 0.02, `${mean(hl, brightPx)} vs ${mean(ref, brightPx)}`);
    });
    await t.test('clarity raises local contrast, negative lowers it', async () => {
      const up = await exportFrame({ clarity: 80 });
      const down = await exportFrame({ clarity: -80 });
      assert.ok(local(up) > local(ref) * 1.05, `${local(up)} vs ${local(ref)}`);
      assert.ok(local(down) < local(ref) * 0.95, `${local(down)} vs ${local(ref)}`);
    });
    await t.test('texture and sharpening raise fine detail', async () => {
      const tx = await exportFrame({ texture: 80 });
      const sm = await exportFrame({ texture: -80 });
      const sp = await exportFrame({ sharpen: { amount: 140, radius: 1, detail: 60 } });
      assert.ok(fine(tx) > fine(ref) * 1.05, `texture ${fine(tx)} vs ${fine(ref)}`);
      // Measured on an encoded frame: the fast export graph (native filters) lands ~1.9 % below the
      // reference here, the exact one a little lower; both clearly smooth. 1.5 % keeps x264 noise out.
      assert.ok(fine(sm) < fine(ref) * 0.985, `texture- ${fine(sm)} vs ${fine(ref)}`);
      assert.ok(fine(sp) > fine(ref) * 1.05, `sharpen ${fine(sp)} vs ${fine(ref)}`);
    });
    await t.test('dehaze adds contrast and darkens the veil; negative adds haze', async () => {
      const dh = await exportFrame({ dehaze: 80, dehazeAir: 0.9 });
      const hz = await exportFrame({ dehaze: -80, dehazeAir: 0.9 });
      assert.ok(std(dh) > std(ref) * 1.05, `${std(dh)} vs ${std(ref)}`);
      assert.ok(mean(dh) < mean(ref));
      assert.ok(std(hz) < std(ref) * 0.95, `${std(hz)} vs ${std(ref)}`);
    });
    await t.test('grain adds noise that changes from frame to frame', async () => {
      const g1 = await exportFrame({ grain: { amount: 80, size: 20 } }, 0.48);
      const g2 = await exportFrame({ grain: { amount: 80, size: 20 } }, 0.52);
      const r2 = await exportFrame(null, 0.52);
      assert.ok(fine(g1) > fine(ref) * 1.1, `${fine(g1)} vs ${fine(ref)}`);
      // the test pattern moves a little too: compare against the clean frames' own change
      const dg = mean(g1.map((v, i) => Math.abs(v - g2[i])));
      const dr = mean(ref.map((v, i) => Math.abs(v - r2[i])));
      assert.ok(dg > dr + 0.005, `${dg} vs ${dr}`);
      assert.ok(Math.abs(mean(g1) - mean(ref)) < 0.02, 'grain keeps the average');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fast Detalhe graph: native filters only (no per-pixel expressions), dehaze keeps the exact path', async () => {
  const d = await import('../src/lib/detail.js');
  const graph = (dev) => {
    const f = [];
    d.detailFiltersFast(f, { dev }, 'in', '0', { W: 1080, H: 1920 });
    return f.join(';');
  };
  const g = graph({ clarity: 40, texture: -30, sharpen: { amount: 30 }, highlights: 30, shadows: -20 });
  assert.doesNotMatch(g, /all_expr/);
  assert.match(g, /blend=all_mode=grainextract/);
  assert.match(g, /blend=all_mode=multiply/);
  assert.doesNotMatch(g, /--/, 'no double minus in expressions');
  assert.match(graph({ dehaze: 30 }), /all_expr/);
  // Same labels in and out as the exact graph, so render.cjs can swap them.
  const exact = [];
  assert.equal(d.detailFilters(exact, { dev: { clarity: 10 } }, 'in', '0', { W: 1080, H: 1920 }), d.detailFiltersFast([], { dev: { clarity: 10 } }, 'in', '0', { W: 1080, H: 1920 }));
});

test('fast Detalhe export matches the exact graph (SSIM, average brightness)', async () => {
  const d = await import('../src/lib/detail.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtfast-'));
  const srcF = path.join(dir, 's.mp4');
  spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=0.2', '-pix_fmt', 'yuv420p', '-y', srcF]);
  const render = (fn, dev, out) => {
    const f = [];
    const lab = fn(f, { dev }, 'in', '0', { W: 640, H: 360 });
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', srcF, '-filter_complex', `[0:v]format=gbrp16le[in];${f.join(';')};[${lab}]format=gbrp[o]`, '-map', '[o]', '-frames:v', '1', '-y', out]);
    assert.equal(r.status, 0, String(r.stderr));
  };
  for (const dev of [{ clarity: 60 }, { texture: -80 }, { localShadows: 60, localHighlights: -40, clarity: -30 }, { sharpen: { amount: 80 } }]) {
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    render(d.detailFilters, dev, a);
    render(d.detailFiltersFast, dev, b);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
    const ssim = Number((r.stderr.match(/All:([\d.]+)/) || [])[1]);
    assert.ok(ssim > 0.99, `${JSON.stringify(dev)} SSIM ${ssim}`);
  }
});
