import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildExport, buildAss, projectDuration, assTime, assColor, runExport } = require('../electron/render.cjs');
const { groupWords, captionClipsFor } = require('../electron/captions.cjs');
const { createMcpServer, TOOLS } = require('../electron/mcp.cjs');

const media = [
  { id: 'm1', path: 'C:/v/a.mp4', kind: 'video', duration: 10, hasAudio: true },
  { id: 'm2', path: 'C:/v/b.png', kind: 'image', duration: 5, hasAudio: false },
];
const project = (extra = {}) => ({
  name: 't',
  canvas: { w: 1080, h: 1920, fps: 30, preset: '9:16' },
  media,
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', mediaId: 'm1', start: 0, in: 2, out: 6, volume: 1, fit: 'fill' }] },
    { id: 'v2', kind: 'video', clips: [{ id: 'c2', mediaId: 'm2', start: 1, in: 0, out: 2, fit: 'fit' }] },
    { id: 't1', kind: 'text', clips: [{ id: 'c3', start: 0.5, in: 0, out: 1, text: 'olá {mundo}', style: 'elite', words: [{ w: 'olá', s: 0, e: 0.4 }, { w: 'mundo', s: 0.5, e: 0.9 }] }] },
    ...(extra.tracks || []),
  ],
});

test('times and colours in ASS format', () => {
  assert.equal(assTime(3661.5), '1:01:01.50');
  assert.equal(assColor('#FFD60A'), '&H000AD6FF');
});

test('export command trims inputs, overlays in order, mixes audio and burns captions', () => {
  const { args, duration, ass } = buildExport(project(), 'out.mp4');
  assert.equal(duration, 4);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), ['-ss', '2', '-t', '4', '-i', 'C:/v/a.mp4']);
  assert.ok(args.includes('-loop'), 'images loop');
  assert.match(fc, /color=c=black:s=1080x1920:r=30:d=4\[base0\]/);
  assert.match(fc, /\[0:v\].*crop=1080:1920.*setpts=PTS\+0\/TB\[v0\]/);
  assert.match(fc, /\[base0\]\[v0\]overlay=.*enable='between\(t,-0\.016667,3\.983333\)'\[base1\]/, 'edges on the frame grid, half a frame early');
  assert.match(fc, /\[1:v\].*force_original_aspect_ratio=decrease.*setpts=PTS\+1\/TB\[v1\]/);
  assert.match(fc, /\[0:a\].*adelay=0:all=1\[a0\]/);
  assert.match(fc, /amix=inputs=1/);
  assert.match(fc, /\[base2\]subtitles=caps\.ass:fontsdir=fonts\[vout\]/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /OLÁ/, 'elite style is uppercase');
  assert.ok(!/\{mundo\}/.test(ass), 'braces are stripped from text');
  assert.equal((ass.match(/^Dialogue:/gm) || []).length, 2, 'one event per highlighted word');
});

test('muted tracks and empty timelines', () => {
  const p = project();
  p.tracks[0].muted = true;
  const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('anullsrc'));
  assert.ok(fc, 'no audio -> silent track');
  assert.throws(() => buildExport({ ...p, tracks: [] }, 'o.mp4'), /vazia/);
  assert.equal(projectDuration(p), 4);
  assert.equal(buildAss({ ...p, tracks: [] }), null);
});

test('words are grouped into short captions and mapped onto the timeline', () => {
  const words = [
    { w: 'Olá', s: 0, e: 0.3 }, { w: 'a', s: 0.35, e: 0.4 }, { w: 'todos,', s: 0.45, e: 0.8 },
    { w: 'hoje', s: 0.9, e: 1.1 }, { w: 'vamos', s: 1.15, e: 1.4 }, { w: 'ver', s: 1.45, e: 1.6 }, { w: 'casas', s: 1.65, e: 2 },
    { w: 'longe', s: 4, e: 4.3 },
  ];
  const g = groupWords(words, { maxWords: 3 });
  assert.deepEqual(g.map((c) => c.text), ['Olá a todos,', 'hoje vamos ver', 'casas', 'longe']);
  const clips = captionClipsFor({ start: 10, in: 1, out: 5 }, words, { style: 'clean' });
  assert.equal(clips[0].text, 'vamos ver casas', 'words cut by the in point stay out');
  assert.equal(clips[0].start, 10.15);
  assert.equal(clips[0].words[0].s, 0);
  assert.ok(clips.every((c) => c.style === 'clean' && c.out > 0));
});

test('MCP server: token, origin and JSON-RPC', async () => {
  const calls = [];
  const srv = createMcpServer({ token: 'segredo123', call: async (name, args) => (calls.push([name, args]), { ok: true }) });
  const port = await srv.listen(46000);
  const url = `http://127.0.0.1:${port}/mcp`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer segredo123', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer errado00000' })).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status, 403);
    const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(init.result.serverInfo.name, 'elite-cinema');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.equal(list.result.tools.length, TOOLS.length);
    const call = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'seek', arguments: { time: 3 } } })).json();
    assert.match(call.result.content[0].text, /"ok": true/);
    assert.deepEqual(calls, [['seek', { time: 3 }]]);
    const bad = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } })).json();
    assert.equal(bad.error.code, -32602);
  } finally {
    await srv.close();
  }
});

test('real ffmpeg export of a generated clip with captions', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-test-'));
  try {
    const src = join(dir, 'src.mp4');
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    assert.equal(gen.status, 0, String(gen.stderr));
    const p = {
      name: 'teste', canvas: { w: 540, h: 960, fps: 30, preset: '9:16' },
      media: [{ id: 'm1', path: src, kind: 'video', duration: 4, hasAudio: true }],
      tracks: [
        { id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'm1', start: 0, in: 0.5, out: 2.5, volume: 1, fit: 'fill' }, { id: 'b', mediaId: 'm1', start: 2, in: 3, out: 4, volume: 1, fit: 'fit' }] },
        { id: 't1', kind: 'text', clips: [{ id: 't', start: 0.2, in: 0, out: 1.5, text: 'Elite Cinema', style: 'elite', words: [{ w: 'Elite', s: 0, e: 0.6 }, { w: 'Cinema', s: 0.7, e: 1.2 }] }] },
      ],
    };
    const out = join(dir, 'out.mp4');
    let last = 0;
    await runExport(p, out, { onProgress: (x) => (last = x) });
    assert.ok(existsSync(out));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', out], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout);
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.15, `duração ${info.format.duration}`);
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.width, 540);
    assert.equal(v.height, 960);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
    assert.equal(last, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('speed, transitions and keyframes reach the ffmpeg command', () => {
  const { kfExpr, atempo } = require('../electron/render.cjs');
  const p = project();
  Object.assign(p.tracks[0].clips[0], { speed: 2, transitionIn: { type: 'fade', d: 0.5 }, transitionOut: { type: 'slide', d: 0.4 }, keyframes: { zoom: [{ t: 0, v: 1 }, { t: 1, v: 1.5 }] } });
  const { args, duration } = buildExport(p, 'o.mp4');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.equal(duration, 3, 'clip c1: 4 s of source at 2x = 2 s; image clip ends at 3 s');
  assert.match(fc, /setpts=\(PTS-STARTPTS\)\/2/);
  assert.match(fc, /zoompan=z='max\(1,/);
  assert.match(fc, /fade=t=in:st=0:d=0\.5:alpha=1/);
  assert.match(fc, /overlay=x='\(main_w-overlay_w\)\/2-main_w\*\(1-/);
  assert.match(fc, /\[0:a\]asetpts=PTS-STARTPTS,atempo=2,/);
  assert.match(fc, /afade=t=in:st=0:d=0\.5/);
  assert.deepEqual(atempo(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.equal(kfExpr([], 1), '1');
});

test('CapCut drafts become Elite Cinema projects', async () => {
  const { convertDraft, textOf } = require('../electron/capcut.cjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  try {
    const vid = join(dir, 'v.mp4');
    writeFileSync(vid, 'x');
    const draft = {
      canvas_config: { width: 1080, height: 1920 }, fps: 30,
      materials: {
        videos: [{ id: 'V', path: vid, type: 'video' }, { id: 'GONE', path: join(dir, 'nao-existe-123.mp4'), type: 'video' }],
        audios: [], speeds: [{ id: 'SP', speed: 2 }],
        texts: [{ id: 'T', content: JSON.stringify({ text: 'Olá Cascais', styles: [] }) }],
      },
      tracks: [
        { type: 'video', segments: [{ material_id: 'V', target_timerange: { start: 0, duration: 2e6 }, source_timerange: { start: 1e6, duration: 4e6 }, speed: 2, volume: 0.5, extra_material_refs: ['SP'], clip: { scale: { x: 1.2 } } }, { material_id: 'GONE', target_timerange: { start: 2e6, duration: 1e6 } }] },
        { type: 'text', segments: [{ material_id: 'T', target_timerange: { start: 5e5, duration: 15e5 }, clip: { transform: { x: 0, y: -0.8 } } }] },
        { type: 'effect', segments: [{}] },
      ],
    };
    mkdirSync(join(dir, 'draft'));
    writeFileSync(join(dir, 'draft', 'draft_content.json'), JSON.stringify(draft));
    writeFileSync(join(dir, 'draft', 'draft_meta_info.json'), JSON.stringify({ draft_name: 'Teste' }));
    const fake = async (p) => ({ id: 'm1', path: p, name: 'v.mp4', kind: 'video', duration: 10, hasAudio: true });
    const { project: pr, warnings } = await convertDraft(join(dir, 'draft', 'draft_content.json'), fake);
    assert.equal(pr.name, 'Teste (CapCut)');
    assert.equal(pr.canvas.preset, '9:16');
    const v = pr.tracks.find((t) => t.kind === 'video').clips;
    assert.equal(v.length, 1);
    assert.deepEqual([v[0].start, v[0].in, v[0].out, v[0].speed, v[0].volume], [0, 1, 5, 2, 0.5]);
    assert.equal(v[0].keyframes.zoom[0].v, 1.2);
    const tx = pr.tracks.find((t) => t.kind === 'text').clips[0];
    assert.deepEqual([tx.text, tx.start, tx.out, tx.y], ['Olá Cascais', 0.5, 1.5, 0.9]);
    assert.ok(warnings.some((w) => /em falta/.test(w)));
    assert.ok(warnings.some((w) => /não têm equivalente/.test(w)));
    assert.equal(textOf({ content: 'texto <b>simples</b>' }), 'texto simples');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('colour grade, LUT, caption style and sound settings reach the ffmpeg command', () => {
  const { gradeFilters, gradeMath } = require('../electron/render.cjs');
  assert.deepEqual(gradeFilters(undefined), []);
  assert.deepEqual(gradeFilters({ exposure: 0, contrast: 0 }), [], 'neutral grade adds nothing');
  const f = gradeFilters({ exposure: 0.5, contrast: 0.25, saturation: -1, temperature: 1, vignette: 1 }, 'lut0.cube');
  assert.match(f[0], /^colorchannelmixer=rr=1\.3:gg=1\.196:bb=0\.988$/);
  assert.equal(f[1], 'eq=contrast=1.2:saturation=0');
  assert.equal(f[2], 'lut3d=file=lut0.cube');
  assert.match(f[3], /^vignette=angle=1$/);
  assert.deepEqual(gradeMath({ temperature: -1 }).warm, [0.76, 0.92, 1]);

  const p = project();
  p.tracks[0].clips[0].color = { saturation: 0.3, lut: 'C:/nao/existe.cube' };
  p.tracks.push({ id: 'a1', kind: 'audio', clips: [{ id: 'mu', mediaId: 'm1', start: 0, in: 0, out: 4, volume: 0.6 }] });
  p.audio = { duck: true, normalize: true };
  p.captionStyle = { label: 'Meu', font: 'Impact, X', size: 0.05, color: '#00FF00', highlight: '#FF0000', outline: 0.004, outlineColor: '#000000', box: false, uppercase: false, y: 0.6 };
  p.tracks[2].clips[0].style = 'custom';
  const { args, ass, luts } = buildExport(p, 'o.mp4');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\][^;]*eq=contrast=1:saturation=1\.3/);
  assert.equal(luts.length, 0, 'a LUT file that does not exist is skipped');
  assert.match(fc, /\[vmix\]asplit=2\[vkey\]\[vout0\]/);
  assert.match(fc, /\[mmix\]\[vkey\]sidechaincompress/);
  assert.match(fc, /loudnorm=I=-14/);
  assert.match(ass, /^Style: custom,Impact  X,96,&H0000FF00/m);
  assert.match(ass, /,custom,,/);
  p.captionStyle.box = true;
  p.captionStyle.boxColor = '#D4AF37';
  assert.match(buildAss(p), /^Style: custom,[^\n]*,&H0037AFD4,&H0037AFD4,0,/m, 'box colour reaches libass');
});

test('real ffmpeg export with colour grade, LUT and music ducking', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ec-test-'));
  try {
    const src = join(dir, 'src.mp4');
    const mus = join(dir, 'm.wav');
    const lut = join(dir, 'blue.cube');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]).status, 0);
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=900:d=2', mus]).status, 0);
    // 2x2x2 LUT that removes red and green: everything turns blue.
    const rows = [];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`0 0 ${b ? 1 : 0.5}`);
    writeFileSync(lut, `LUT_3D_SIZE 2\n${rows.join('\n')}\n`);
    const p = {
      name: 'cor', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' }, audio: { duck: true, normalize: true },
      media: [{ id: 'v', path: src, kind: 'video', duration: 2, hasAudio: true }, { id: 'm', path: mus, kind: 'audio', duration: 2, hasAudio: true }],
      tracks: [
        { id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 2, volume: 1, fit: 'fill', color: { exposure: 0.2, lut } }] },
        { id: 'a1', kind: 'audio', clips: [{ id: 'b', mediaId: 'm', start: 0, in: 0, out: 2, volume: 1 }] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const px = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 });
    const [r, g, b] = px.stdout;
    assert.ok(b > 100 && r < 40 && g < 40, `the LUT made the frame blue (rgb ${r},${g},${b})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('caption blocks: every effect becomes the matching ASS tags', () => {
  const words = [{ w: 'um', s: 0, e: 0.3 }, { w: 'dois', s: 0.4, e: 0.8 }];
  const ass = (style) => {
    const p = project();
    p.tracks[2].clips[0] = { id: 'c3', start: 1, in: 0, out: 1, text: 'um dois', style, words };
    return buildAss(p);
  };
  assert.match(ass('karaoke'), /\{\\kf40\}um \{\\kf40\}dois/, 'karaoke fills each word for its spoken time');
  assert.match(ass('karaoke'), /^Style: karaoke,Poppins Black,\d+,&H000AD6FF,&H00FFFFFF/m, 'karaoke: primary = highlight');
  const bounce = ass('impacto');
  assert.match(bounce, /\\t\(0,80,\\fscx125\\fscy125\)/, 'bounce scales the spoken word');
  assert.match(bounce, /\{\\1a&HFF&\\3a&HFF&\\4a&HFF&\}DOIS/, 'words not spoken yet are hidden');
  assert.match(ass('marcador'), /\{\\bord\d+\\3c&H00F72F7B\}UM/, 'marker outline on the spoken word');
  assert.match(ass('deslizar'), /\\move\(540,\d+,540,\d+,0,180\)/, 'slide moves up');
  assert.match(ass('neon'), /\\blur\d+/, 'glow');
  assert.match(ass('cinema'), /^Style: cinema,Bebas Neue,\d+,[^,]+,[^,]+,[^,]+,[^,]+,0,0,0,0,100,100,12,/m, 'letter spacing');
});

test('real ffmpeg export with masks (darken, blur, pixelate, cut)', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-test-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const base = { id: 'mk', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false, amount: 1 };
    const run = async (masks) => {
      const p = {
        name: 'm', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' },
        media: [{ id: 'v', path: src, kind: 'video', duration: 1, hasAudio: false }],
        tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 1, fit: 'fill', masks }] }],
      };
      const out = join(dir, `o${Math.random().toString(36).slice(2)}.mp4`);
      await runExport(p, out);
      const px = (x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 }).stdout];
      return { centre: px(158, 118), corner: px(4, 4) };
    };
    const dark = await run([{ ...base, mode: 'darken' }]);
    assert.ok(dark.centre[0] < 80 && dark.corner[0] > 200, `darken inside only: ${dark.centre} / ${dark.corner}`);
    const inv = await run([{ ...base, mode: 'darken', invert: true }]);
    assert.ok(inv.centre[0] > 200 && inv.corner[0] < 80, `inverted: ${inv.centre} / ${inv.corner}`);
    const cut = await run([{ ...base, mode: 'cut', feather: 0.05 }]);
    assert.ok(cut.centre[0] > 200 && cut.corner[0] < 30, `cut shows black outside: ${cut.centre} / ${cut.corner}`);
    const both = await run([{ ...base, mode: 'blur', shape: 'rect' }, { ...base, id: 'p', mode: 'pixelate', x: 0.2, toX: 0.8 }]);
    assert.ok(both.centre[0] > 200, 'blur/pixelate keep the colour of a flat frame');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
