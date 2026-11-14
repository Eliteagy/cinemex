// Export: turns an Cinemex project into one ffmpeg command.
// Video clips are trimmed at the input (-ss/-t), scaled to the canvas (fit or fill), shifted to
// their timeline start and overlaid on a black base in track order (track 0 at the bottom).
// Audio of every audible clip is delayed to its start and mixed. Text clips become an ASS file
// rendered by libass (same styles as the preview, src/lib/styles.json).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { USER_FONTS, emphasisLines, keywordOf, layerOf, lineOffset, linePositions, metricsOf, mixHex, registerMetrics, revealDur, roleOrder } = require('../src/lib/emphasis.js');
const { applyOverride, cleanOverride, isStyleId, validateStyle } = require('../src/lib/capstyle.js');
const { findUserFont, findFamily, familyName } = require('./fonts.cjs');
const { TRANSITIONS, BLUR_STEPS, BFLASH, blurWindow, stageSigma } = require('../src/lib/fx.js');
const { graphicEvents, roundRectPath } = require('../src/lib/graphics.js');
const anim = require('../src/lib/anim.js');
const { layerFx, BLEND_FFMPEG } = require('../src/lib/layerfx.js');
const xform = require('../src/lib/xform.js');
const { frameFilters, hasFrame } = require('../src/lib/frame.js');
const STYLES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'styles.json'), 'utf8'));
const { FFMPEG } = require('./bin.cjs');

const r3 = (n) => Math.round(n * 1000) / 1000;

const speedOf = (c) => Math.max(0.25, Math.min(4, c.speed ?? 1));

/** Length on the timeline (speed applied; a time remap sets its own length). */
function clipDuration(c) {
  return xform.remapDur(c) ?? Math.max(0, (c.out - c.in) / speedOf(c));
}

const fx = (n) => String(Math.round(n * 10000) / 10000);

/** Keyframes as an ffmpeg expression of local time T (eases and modifiers: src/lib/anim.js, same as the preview). */
const kfExpr = anim.kfExpr;

const clampN = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));

/** Grade -> numbers (same formulas as src/lib/project.ts gradeMath, used by the preview). */
function gradeMath(g) {
  const e = clampN(g?.exposure, -1, 1);
  const c = clampN(g?.contrast, -1, 1);
  const s = clampN(g?.saturation, -1, 1);
  const t = clampN(g?.temperature, -1, 1);
  const warm = t > 0 ? [1, 1 - 0.08 * t, 1 - 0.24 * t] : [1 + 0.24 * t, 1 + 0.08 * t, 1];
  return { bright: 1 + e * 0.6, contrast: 1 + c * 0.8, saturation: 1 + s, warm, vignette: clampN(g?.vignette, 0, 1) };
}

/** ffmpeg filters for a clip's grade. lutName is the LUT file name in the working folder. */
function gradeFilters(g, lutName) {
  if (!g) return [];
  const m = gradeMath(g);
  const out = [];
  const [r, gr, b] = m.warm.map((w) => w * m.bright);
  if (Math.abs(r - 1) + Math.abs(gr - 1) + Math.abs(b - 1) > 1e-3) out.push(`colorchannelmixer=rr=${fx(r)}:gg=${fx(gr)}:bb=${fx(b)}`);
  if (Math.abs(m.contrast - 1) > 1e-3 || Math.abs(m.saturation - 1) > 1e-3) out.push(`eq=contrast=${fx(m.contrast)}:saturation=${fx(m.saturation)}`);
  if (lutName) out.push(`lut3d=file=${lutName}`);
  if (m.vignette > 1e-3) out.push(`vignette=angle=${fx(0.25 + m.vignette * 0.75)}`);
  return out;
}

/**
 * Mask filters (same geometry and strengths as src/engine/mask.ts). Appends to `filters`, reads
 * the stream labelled `input`, returns the label of the masked stream. Effects first, then cuts.
 */
/** Mask shapes the export can draw: still or moving ellipse/rect/pen, and person mattes when their file is there. */
const maskReady = (m) => m.shape !== 'person' ? m.shape !== 'pen' || (Array.isArray(m.points) && m.points.length >= 3) : Boolean(m.matte?.file && fs.existsSync(m.matte.file));

/**
 * Grey mask stream (white = inside, gaussian soft edge) for one mask, as a filter label.
 * pen: crossing-number point-in-polygon in geq; person: the matte video, framed like the clip
 * (`ctx.matteInput(m)` adds it as an input and returns the framed label).
 */
function maskLum(filters, m, id, { W, H, FPS, dur, matteInput }) {
  const short = Math.min(W, H);
  const sigma = m.feather * short;
  const soft = sigma > 0.5 ? `,gblur=sigma=${fx(sigma)}` : '';
  if (m.shape === 'person') {
    const framed = matteInput(m);
    filters.push(`[${framed}]${m.invert ? 'negate' : 'null'}${soft}[mk${id}]`);
    return `mk${id}`;
  }
  const u = `min(T/${fx(Math.max(dur, 0.001))},1)`;
  const moves = (m.toX !== undefined && m.toX !== m.x) || (m.toY !== undefined && m.toY !== m.y);
  const cx = moves ? `(${fx(m.x)}+(${fx((m.toX ?? m.x) - m.x)})*${u})*W` : fx(m.x * W);
  const cy = moves ? `(${fx(m.y)}+(${fx((m.toY ?? m.y) - m.y)})*${u})*H` : fx(m.y * H);
  let inside;
  if (m.shape === 'pen') {
    // Point in polygon: count the edges a ray to the right crosses (odd = inside). The shape
    // moves with the mask centre (dx, dy).
    const dx = moves ? `(${cx}-${fx(m.x * W)})` : '0';
    const dy = moves ? `(${cy}-${fx(m.y * H)})` : '0';
    const px = `(X-${dx})`;
    const py = `(Y-${dy})`;
    const pts = m.points.map(([x, y]) => [x * W, y * H]);
    const terms = [];
    pts.forEach(([xi, yi], i) => {
      const [xj, yj] = pts[(i + 1) % pts.length];
      if (Math.abs(yj - yi) < 1e-6) return;
      terms.push(`abs(gt(${fx(yi)},${py})-gt(${fx(yj)},${py}))*lt(${px},${fx((xj - xi) / (yj - yi))}*(${py}-${fx(yi)})+${fx(xi)})`);
    });
    inside = terms.length ? `mod(${terms.join('+')},2)` : '0';
  } else {
    const rx = fx(Math.max(1, (m.w * W) / 2));
    const ry = fx(Math.max(1, (m.h * H) / 2));
    inside = m.shape === 'ellipse' ? `lte(pow((X-${cx})/${rx},2)+pow((Y-${cy})/${ry},2),1)` : `lte(abs(X-${cx}),${rx})*lte(abs(Y-${cy}),${ry})`;
  }
  const lum = m.invert ? `255-255*${inside}` : `255*${inside}`;
  // A still mask is drawn once and repeated; a moving one is drawn every frame (geq uses T).
  const src = moves
    ? `color=c=black:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=gray,geq=lum='${lum}'`
    : `color=c=black:s=${W}x${H}:r=${FPS}:d=${fx(1 / FPS)},format=gray,geq=lum='${lum}',loop=loop=-1:size=1,trim=duration=${fx(dur)},setpts=N/(${FPS}*TB)`;
  filters.push(`${src}${soft}[mk${id}]`);
  return `mk${id}`;
}

function maskChain(filters, masks, input, tag, ctx) {
  const { W, H } = ctx;
  const short = Math.min(W, H);
  const live = masks.filter((m) => m.mode !== 'front' && maskReady(m));
  const ordered = [...live.filter((m) => m.mode !== 'cut'), ...live.filter((m) => m.mode === 'cut')];
  let cur = input;
  ordered.forEach((m, i) => {
    const id = `${tag}_${i}`;
    maskLum(filters, m, id, ctx);
    if (m.mode === 'cut') {
      filters.push(`[${cur}][mk${id}]alphamerge[mo${id}]`);
    } else {
      const a = Math.max(0, Math.min(1, m.amount));
      const fxf =
        m.mode === 'blur' ? `gblur=sigma=${fx(Math.max(0.5, a * 0.03 * short))}`
        : m.mode === 'pixelate' ? `pixelize=width=${Math.max(2, Math.round(a * 0.08 * short))}:height=${Math.max(2, Math.round(a * 0.08 * short))}`
        : `colorchannelmixer=rr=${fx(1 - a * 0.85)}:gg=${fx(1 - a * 0.85)}:bb=${fx(1 - a * 0.85)}`;
      filters.push(`[${cur}]split=2[mb${id}][me${id}]`);
      filters.push(`[me${id}]${fxf}[mf${id}]`);
      filters.push(`[mf${id}][mk${id}]alphamerge[ma${id}]`);
      filters.push(`[mb${id}][ma${id}]overlay=format=auto:shortest=1[mo${id}]`);
    }
    cur = `mo${id}`;
  });
  return cur;
}

const FNODES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'fusion-nodes.json'), 'utf8'));
const hasFusion = (f) => Boolean(f && Array.isArray(f.nodes) && f.nodes.some((n) => n.type !== 'mediaIn' && n.type !== 'mediaOut'));
const hexColor = (h) => `0x${String(h || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6)}`;

/**
 * Fusion node graph -> ffmpeg filters (same numbers as src/engine/fusion.ts). `input` is the label
 * of the framed clip (MediaIn). addInput(path, kind, seconds) adds a file input and returns its
 * index. Returns the label of the MediaOut stream.
 */
function fusionChain(filters, fusion, input, tag, { W, H, FPS, dur, media, addInput }) {
  const short = Math.min(W, H);
  const nodes = new Map(fusion.nodes.map((n) => [n.id, n]));
  const val = (n, k) => (n.p && n.p[k] !== undefined ? n.p[k] : FNODES[n.type]?.params?.[k]?.default);
  const num = (n, k) => Number(val(n, k));
  const from = (id, port) => fusion.links.find((l) => l.to === id && l.port === port)?.from ?? null;
  const out = fusion.nodes.find((n) => n.type === 'mediaOut');
  if (!out) return input;
  // How many times each node's output is read (ffmpeg needs a split for more than one).
  const uses = new Map();
  const seen = new Set();
  const walk = (id, depth = 0) => {
    if (!id || depth > 64 || !nodes.has(id)) return;
    const n = nodes.get(id);
    (FNODES[n.type]?.inputs || []).forEach((_, port) => {
      const src = from(id, port);
      if (src && nodes.has(src)) {
        uses.set(src, (uses.get(src) || 0) + 1);
        if (!seen.has(src)) {
          seen.add(src);
          walk(src, depth + 1);
        }
      }
    });
  };
  walk(out.id);
  const made = new Map(); // node id -> output labels not used yet
  let blanks = 0;
  const blank = () => {
    const l = `fz${tag}_e${blanks++}`;
    filters.push(`color=c=black@0:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=rgba[${l}]`);
    return l;
  };
  let inputUsed = false;
  const take = (id, depth = 0) => {
    if (!id || !nodes.has(id) || depth > 64) return blank();
    if (!made.has(id)) {
      const n = nodes.get(id);
      const l = `fz${tag}_${String(n.id).replace(/[^a-zA-Z0-9]/g, '')}`;
      const inp = (port) => take(from(id, port), depth + 1);
      switch (n.type) {
        case 'mediaIn':
          if (inputUsed) return blank();
          inputUsed = true;
          filters.push(`[${input}]null[${l}]`);
          break;
        case 'mediaOut':
          filters.push(`[${inp(0)}]null[${l}]`);
          break;
        case 'background':
          filters.push(`color=c=${hexColor(val(n, 'color'))}:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=rgba[${l}]`);
          break;
        case 'media': {
          const m = media.get(String(val(n, 'mediaId')));
          if (!m || m.kind === 'audio') {
            filters.push(`color=c=black@0:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=rgba[${l}]`);
            break;
          }
          const k = addInput(m.path, m.kind, dur);
          filters.push(`[${k}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,setpts=PTS-STARTPTS,trim=duration=${fx(dur)}[${l}]`);
          break;
        }
        case 'merge': {
          const bg = inp(0);
          const fg = inp(1);
          const mode = String(val(n, 'mode'));
          const op = Math.max(0, Math.min(1, num(n, 'opacity')));
          if (mode === 'normal') {
            filters.push(`[${fg}]format=rgba,colorchannelmixer=aa=${fx(op)}[${l}f]`);
            filters.push(`[${bg}][${l}f]overlay=format=auto:eof_action=pass[${l}]`);
          } else {
            const bm = mode === 'add' ? 'addition' : mode;
            filters.push(`[${bg}]format=gbrp[${l}b]`, `[${fg}]format=gbrp[${l}f]`);
            filters.push(`[${l}b][${l}f]blend=all_mode=${bm}:all_opacity=${fx(op)}[${l}]`);
          }
          break;
        }
        case 'transform': {
          const s = Math.max(0.01, num(n, 'scale'));
          const a = fx((num(n, 'rotate') * Math.PI) / 180);
          const flip = val(n, 'flip') === true ? ',hflip' : '';
          filters.push(`[${inp(0)}]format=rgba,scale=w=trunc(iw*${fx(s)}):h=trunc(ih*${fx(s)})${flip},rotate=a=${a}:c=black@0:ow=rotw(${a}):oh=roth(${a})[${l}t]`);
          filters.push(`color=c=black@0:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=rgba[${l}c]`);
          filters.push(`[${l}c][${l}t]overlay=x=(main_w-overlay_w)/2+${fx(num(n, 'x'))}*main_w:y=(main_h-overlay_h)/2+${fx(num(n, 'y'))}*main_h:format=auto:eof_action=pass[${l}]`);
          break;
        }
        case 'chroma':
          filters.push(`[${inp(0)}]format=yuva444p,chromakey=color=${hexColor(val(n, 'key'))}:similarity=${fx(num(n, 'similarity'))}:blend=${fx(num(n, 'blend'))}[${l}]`);
          break;
        case 'blur':
          filters.push(`[${inp(0)}]gblur=sigma=${fx(Math.max(0.01, num(n, 'size') * 0.03 * short))}[${l}]`);
          break;
        case 'glow':
          filters.push(`[${inp(0)}]format=gbrp,split=2[${l}a][${l}b]`);
          filters.push(`[${l}b]gblur=sigma=${fx(Math.max(0.01, num(n, 'size') * 0.05 * short))}[${l}g]`);
          filters.push(`[${l}a][${l}g]blend=all_mode=screen:all_opacity=${fx(Math.max(0, Math.min(1, num(n, 'amount'))))}[${l}]`);
          break;
        case 'color': {
          const g = gradeFilters({ exposure: num(n, 'exposure'), contrast: num(n, 'contrast'), saturation: num(n, 'saturation'), temperature: num(n, 'temperature') });
          filters.push(`[${inp(0)}]${g.length ? g.join(',') : 'null'}[${l}]`);
          break;
        }
        case 'grain': {
          const a = Math.round(Math.max(0, Math.min(1, num(n, 'amount'))) * 40);
          filters.push(`[${inp(0)}]${a > 0 ? `noise=alls=${a}:allf=t` : 'null'}[${l}]`);
          break;
        }
        case 'letterbox': {
          const bar = Math.round(Math.max(0, (H - W / Math.max(1, num(n, 'ratio'))) / 2));
          filters.push(`[${inp(0)}]${bar > 0 ? `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill` : 'null'}[${l}]`);
          break;
        }
        default:
          return blank();
      }
      const count = uses.get(id) || 1;
      if (count > 1) {
        const outs = Array.from({ length: count }, (_, i) => `${l}s${i}`);
        filters.push(`[${l}]split=${count}${outs.map((o) => `[${o}]`).join('')}`);
        made.set(id, outs);
      } else made.set(id, [l]);
    }
    const free = made.get(id);
    return free.length ? free.shift() : blank();
  };
  return take(out.id);
}

const hasKeys = (c) => Boolean(c.keyframes && Object.values(c.keyframes).some((l) => l && l.length));
const keyList = (c, k) => (c.keyframes && Array.isArray(c.keyframes[k]) && c.keyframes[k].length ? c.keyframes[k] : null);

/** smooth(u) of src/lib/fx.js as an ffmpeg expression. */
const smoothE = (u) => `(${u})*(${u})*(3-2*(${u}))`;
/** Progress (0 = transition start, 1 = clip fully shown) of a side, in local time `T`. */
const progE = (side, tr, dur, T) => (side === 'in' ? `clip(${T}/${fx(tr.d)},0,1)` : `clip((${fx(dur)}-${T})/${fx(tr.d)},0,1)`);

/** Extra zoom of zoom/spin transitions as a factor expression (1 when none). */
function transitionZoomExpr(sides, dur, T) {
  const parts = [];
  for (const [side, tr] of sides) {
    const Z = TRANSITIONS[tr.type]?.zoom;
    if (!Z) continue;
    parts.push(`(1+${fx(Z)}*(1-${smoothE(progE(side, tr, dur, T))}))`);
  }
  return parts.length ? parts.join('*') : null;
}

/** Rotation (degrees) of spin transitions plus rotate keyframes, as an expression of `t`. */
function rotationExpr(c, sides, dur, parentRot) {
  const parts = [];
  if (parentRot && parentRot !== '0') parts.push(`(${parentRot})`);
  if (anim.animates(c, 'rotate')) parts.push(anim.propExpr(c, 'rotate', 0, 't'));
  for (const [side, tr] of sides) {
    const spin = TRANSITIONS[tr.type]?.spin;
    if (!spin) continue;
    parts.push(`${side === 'in' ? '' : '-'}${fx(spin)}*(1-${smoothE(progE(side, tr, dur, 't'))})`);
  }
  return parts.length ? parts.join('+') : null;
}

/**
 * Filters that run on the framed clip in local time (before it is shifted to its start):
 * rotation, opacity keyframes, stepped transition blur, flash / dip / fade.
 */
function transitionFilters(c, sides, dur, short, parentRot) {
  const out = [];
  const rot = rotationExpr(c, sides, dur, parentRot);
  if (rot) out.push('format=rgba', `rotate=a='(${rot})*PI/180':c=black@0`);
  if (anim.animates(c, 'opacity')) out.push('format=yuva420p', `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${anim.propExpr(c, 'opacity', 1, 'T')},0,1)'`);
  for (const [side, tr] of sides) {
    const T = TRANSITIONS[tr.type];
    if (!T || !T.blur) continue;
    const sigma = Math.max(0.5, stageSigma(tr.type, short));
    for (let k = 0; k < BLUR_STEPS; k++) {
      const [a, b] = blurWindow(side, tr.d, dur, k);
      if (b - a < 1e-3) continue;
      out.push(`gblur=sigma=${fx(sigma)}${T.dir ? ':sigmaV=0.01' : ''}:enable='between(t,${fx(a)},${fx(b)})'`);
    }
  }
  // Brightness Flash: out = img * (1 + gain s) + lift s, s = 0.5 - 0.5 cos(pi m), m = 1 at the cut.
  // geq only runs on the flash frames (enable=); the rest of the clip passes through.
  for (const [side, tr] of sides) {
    if (tr.type !== 'bflash') continue;
    const m = side === 'in' ? `(1-clip(T/${fx(tr.d)},0,1))` : `(1-clip((${fx(dur)}-T)/${fx(tr.d)},0,1))`;
    const S = `(0.5-0.5*cos(PI*${m}))`;
    const ch = (c) => `clip(${c}(X,Y)*(1+${fx(BFLASH.gain)}*${S})+${fx(BFLASH.lift * 255)}*${S},0,255)`;
    const win = side === 'in' ? `between(t,0,${fx(tr.d)})` : `between(t,${fx(dur - tr.d)},${fx(dur + 1)})`;
    out.push('format=gbrap', `geq=r='${ch('r')}':g='${ch('g')}':b='${ch('b')}':a='alpha(X,Y)':enable='${win}'`);
  }
  out.push('format=yuva420p');
  for (const [side, tr] of sides) {
    const st = side === 'in' ? 0 : dur - tr.d;
    if (tr.type === 'fade') out.push(`fade=t=${side}:st=${fx(st)}:d=${fx(tr.d)}:alpha=1`);
    else if (tr.type === 'flash' || tr.type === 'dip') out.push(`fade=t=${side}:st=${fx(st)}:d=${fx(tr.d)}:color=${tr.type === 'flash' ? 'white' : 'black'}`);
  }
  return out;
}

/** atempo only accepts 0.5..2 per stage: chain stages for other speeds. */
function atempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${fx(s)}`);
  return out;
}

/** Last moment anything is on the timeline. */
function projectDuration(project) {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + clipDuration(c));
  return r3(end);
}

// ------------------------------------------------------------------ ASS captions

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** #RRGGBB -> &H00BBGGRR (ASS colour, opaque). */
function assColor(hex, alpha = 0) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F');
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assText(s) {
  return String(s).replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\r?\n/g, '\\N');
}

/** Base style of a caption: the old project style, a saved style embedded in the project, or a preset. */
function styleName(clip, project) {
  const n = clip.style;
  if (n === 'custom' && project.captionStyle) return 'custom';
  if (isStyleId(n) && project.styles?.[n] && !STYLES[n] && validateStyle(project.styles[n])) return n;
  return STYLES[n] && n !== '_comment' ? n : 'elite';
}
const styleByName = (n, project) => (n === 'custom' ? project.captionStyle : !STYLES[n] && project.styles?.[n] ? validateStyle(project.styles[n]) : STYLES[n]);

/** Fonts shipped with the app (public/fonts); copied next to the ASS file for libass. */
const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts');
let BUNDLED = null;
/** Family names of the bundled fonts (read from the files). */
function bundledFamilies() {
  if (BUNDLED) return BUNDLED;
  BUNDLED = new Set();
  try {
    for (const f of fs.readdirSync(FONTS_DIR)) if (/\.(ttf|otf)$/i.test(f)) BUNDLED.add(String(familyName(fs.readFileSync(path.join(FONTS_DIR, f))) || '').toLowerCase());
  } catch {
    /* no bundled fonts */
  }
  return BUNDLED;
}
let fontCacheFile = null;
/** Where the installed-fonts index is cached (set by main.cjs to userData/font-cache.json). */
function setFontCache(file) {
  fontCacheFile = file;
}
/**
 * A font installed on this PC (picked in the font picker): every file of its family goes into
 * `files`, so it is copied next to caps.ass (only into the temporary export folder), and its
 * metrics are registered so keyword captions are placed like in the preview.
 */
function addInstalledFont(name, files, userFonts) {
  if (!userFonts || !name || bundledFamilies().has(String(name).toLowerCase()) || USER_FONTS[name]) return;
  const fam = findFamily(name, fontCacheFile);
  if (!fam) return;
  fam.files.forEach((f) => files?.add(f));
  if (fam.a) registerMetrics(name, { upem: fam.upem, a: fam.a, d: fam.d });
}

/**
 * Font for the ASS file: a user font (personal licence, never shipped) is used when installed -
 * its file is added to `files` so it gets copied next to caps.ass - otherwise its bundled fallback.
 * `logical` is the name the shared metrics table knows.
 */
function assFont(name, files, userFonts = true) {
  const u = USER_FONTS[name];
  if (!u) {
    addInstalledFont(name, files, userFonts);
    return { logical: name, family: name };
  }
  const f = userFonts ? findUserFont(u.file) : null;
  if (!f) return { logical: u.fallback, family: u.fallback };
  files?.add(f.file);
  return { logical: name, family: f.family };
}

const a255 = (a) => `&H${Math.round(Math.max(0, Math.min(1, 1 - a)) * 255).toString(16).padStart(2, '0').toUpperCase()}&`;
const f1 = (n) => String(Math.round(n * 10) / 10);
const f2 = (n) => String(Math.round(n * 100) / 100);
/** libass \blur is not a standard deviation: sigma = blur * 2 / sqrt(ln 256). */
const assBlur = (sigma) => String(Math.round(sigma * 1.1774 * 100) / 100);

/**
 * Keyword captions (Felipe, Marta) -> ASS events. Mirrors drawEmphasis in src/engine/caption.ts:
 * every line is drawn as shadow, glow and fill passes (separate layers), the fill gradient as
 * horizontal bands (\clip), the reveal as a karaoke sweep with an invisible secondary colour, and
 * the rise as \move + \fad + \t(\blur).
 */
function emphasisEvents(c, st, name, W, H, end, events, files, userFonts) {
  const em = st.emphasis;
  const timed = Array.isArray(c.words) && c.words.length > 0;
  const words = timed ? c.words : String(c.text).split(/\s+/).filter(Boolean).map((w) => ({ w, s: 0, e: end - c.start }));
  if (!words.length) return;
  const kw = keywordOf(c, words.map((w) => w.w));
  const lines = emphasisLines(words.length, kw, em);
  const pos = linePositions(lines, em);
  const k = c.size ? c.size / st.size : 1;
  const unit = H * k;
  const ax = (c.x ?? 0.5) * W;
  const ay = (c.y ?? st.y) * H;
  const cs = (t) => Math.max(1, Math.round(t * 100));
  if (em.oneLine) return oneLineEvents({ c, st, em, name, W, H, end, events, files, userFonts, words, timed, lines, unit, ax, ay, cs });
  lines.forEach((line, i) => {
    const L = layerOf(em, line.role);
    const ws = words.slice(line.from, line.to);
    const raw = (w) => (L.uppercase ? String(w).toUpperCase() : String(w));
    const up = (w) => assText(raw(w));
    const font = assFont(L.font, files, userFonts);
    const m = metricsOf(font.logical);
    const S = L.size * unit;
    // A line moved on its own (clip.lines), in fractions of the frame, same as the preview.
    const off = lineOffset(c.lines, line.role);
    const x = ax + pos[i].dx * unit + off.x * W;
    const yc = ay + pos[i].dy * unit + off.y * H - (S * m.a) / (m.a + m.d) + S / 2;
    const top = yc - S / 2;
    const layer0 = roleOrder(em, line.role) * 3;
    // Event intervals: one per spoken word for the reveal, one for the whole line otherwise.
    const marks = [];
    if (L.anim === 'reveal' && timed) {
      ws.forEach((w, j) => {
        const t = c.start + Math.max(0, w.s);
        if (marks.length && t <= marks[marks.length - 1].t + 0.005) marks[marks.length - 1].j = j;
        else marks.push({ t, j });
      });
    } else marks.push({ t: c.start + (timed ? Math.max(0, ws[0].s) : 0), j: -1 });
    const body = (j) => {
      if (j < 0) return ws.map((w) => up(w.w)).join(' ');
      let out = '';
      ws.forEach((w, q) => {
        const sp = q ? ' ' : '';
        if (q < j) out += sp + up(w.w);
        else if (q === j) out += `${sp}{\\2a&HFF&\\kf${cs(revealDur(raw(w.w)))}}${up(w.w)}`;
        else out += q === j + 1 ? `{\\k0\\alpha&HFF&}${sp}${up(w.w)}` : `${sp}${up(w.w)}`;
      });
      return out;
    };
    const rise = L.anim === 'rise' ? L.rise || { dist: 0, dur: 0.15, blur: 0 } : null;
    const ms = rise ? Math.round(rise.dur * 1000) : 0;
    // One pass = one look of the text (shadow, glow or a fill band) on its own layer.
    const pass = (layer, colour, alpha, sigma, ox, oy, clip) => {
      const px = x + ox;
      const py = yc + oy;
      const place = rise ? `\\move(${f1(px)},${f1(py + rise.dist * unit)},${f1(px)},${f1(py)},0,${ms})\\fad(${ms},0)` : `\\pos(${f1(px)},${f1(py)})`;
      const riseBlur = rise ? rise.blur * unit : 0;
      const blur = sigma + riseBlur > 0.05 ? `\\blur${assBlur(sigma + riseBlur)}${riseBlur ? `\\t(0,${ms},\\blur${assBlur(sigma)})` : ''}` : '';
      const head = `{\\an5${place}\\fn${String(font.family).replace(/[{}\\,]/g, ' ')}\\fs${f1(S)}\\fsp${f1((L.tracking || 0) * unit)}\\fscx${Math.round((L.squeezeX ?? 1) * 100)}\\fscy100\\bord0\\shad0\\1c${assColor(colour)}\\1a${a255(alpha)}${blur}${clip || ''}}`;
      marks.forEach((mk, mi) => {
        const e = Math.min(end, mi + 1 < marks.length ? marks[mi + 1].t : end);
        if (e - mk.t > 0.005) events.push(`Dialogue: ${layer},${assTime(mk.t)},${assTime(e)},${name},,0,0,0,,${head}${body(mk.j)}`);
      });
    };
    if (L.shadow) pass(layer0, L.shadow.color, L.shadow.alpha, L.shadow.blur * unit, L.shadow.x * unit, L.shadow.y * unit);
    if (L.glow) pass(layer0 + 1, L.glow.color, L.glow.alpha, L.glow.blur * unit, 0, 0);
    const alpha = L.alpha ?? 1;
    if (L.color2 && L.grad) {
      const N = 8;
      const edge = (b) => Math.round(top + (L.grad[0] + ((L.grad[1] - L.grad[0]) * b) / N) * S);
      pass(layer0 + 2, L.color, alpha, 0, 0, 0, `\\clip(0,0,${W},${edge(0)})`);
      for (let b = 0; b < N; b++) pass(layer0 + 2, mixHex(L.color, L.color2, (b + 0.5) / N), alpha, 0, 0, 0, `\\clip(0,${edge(b)},${W},${edge(b + 1)})`);
      pass(layer0 + 2, L.color2, alpha, 0, 0, 0, `\\clip(0,${edge(N)},${W},${H})`);
    } else pass(layer0 + 2, L.color, alpha, 0, 0, 0);
  });
}

/**
 * Felipe/Marta with every word on one line: one ASS event per pass (shadow, glow, fill) with each
 * segment's font, size and colour inline, so libass lays the line out and centres it. Mirrors
 * drawOneLine in src/engine/caption.ts: shared baseline at the anchor (+ the base line's offset),
 * solid colours, and the base layer's animation for the whole line (reveal / rise / none).
 */
function oneLineEvents({ c, em, name, W, H, end, events, files, userFonts, words, timed, lines, unit, ax, ay, cs }) {
  const segs = lines.map((line) => {
    const L = layerOf(em, line.role);
    const font = assFont(L.font, files, userFonts);
    const m = metricsOf(font.logical);
    const S = L.size * unit;
    return { ...line, L, font, S, asc: (S * m.a) / (m.a + m.d), desc: (S * m.d) / (m.a + m.d) };
  });
  const segOf = (i) => segs.find((s) => i >= s.from && i < s.to);
  const maxAsc = Math.max(...segs.map((s) => s.asc));
  const maxDesc = Math.max(...segs.map((s) => s.desc));
  const off = lineOffset(c.lines, 'base');
  const baseline = ay + off.y * H;
  const x = ax + off.x * W;
  const yc = baseline - maxAsc + (maxAsc + maxDesc) / 2;
  const B = layerOf(em, 'base');
  const anim = B.anim || 'none';
  const up = (L, w) => assText(L.uppercase ? String(w).toUpperCase() : String(w));
  const marks = [];
  if (anim === 'reveal' && timed) {
    words.forEach((w, j) => {
      const t = c.start + Math.max(0, w.s);
      if (marks.length && t <= marks[marks.length - 1].t + 0.005) marks[marks.length - 1].j = j;
      else marks.push({ t, j });
    });
  } else marks.push({ t: c.start + (timed ? Math.max(0, words[0].s) : 0), j: -1 });
  const rise = anim === 'rise' ? B.rise || { dist: 0.015, dur: 0.15, blur: 0 } : null;
  const ms = rise ? Math.round(rise.dur * 1000) : 0;
  const head = (s, colour, alpha, sigma) =>
    `\\fn${String(s.font.family).replace(/[{}\\,]/g, ' ')}\\fs${f1(s.S)}\\fsp${f1((s.L.tracking || 0) * unit)}\\fscx${Math.round((s.L.squeezeX ?? 1) * 100)}\\1c${assColor(colour)}\\1a${a255(alpha)}${sigma > 0.05 ? `\\blur${assBlur(sigma)}` : '\\blur0'}`;
  const pass = (layer, look, ox, oy) => {
    const px = x + ox;
    const py = yc + oy;
    const place = rise ? `\\move(${f1(px)},${f1(py + rise.dist * unit)},${f1(px)},${f1(py)},0,${ms})\\fad(${ms},0)` : `\\pos(${f1(px)},${f1(py)})`;
    const body = (j) =>
      words
        .map((w, q) => {
          const s = segOf(q);
          const { colour, alpha, sigma } = look(s.L);
          const hidden = j >= 0 && q > j;
          const kar = j >= 0 && q === j ? `\\2a&HFF&\\kf${cs(revealDur(s.L.uppercase ? String(w.w).toUpperCase() : w.w))}` : j >= 0 && q > j ? '\\k0' : '';
          return `${q ? ' ' : ''}{${head(s, colour, hidden ? 0 : alpha, sigma)}${kar}}${up(s.L, w.w)}`;
        })
        .join('');
    marks.forEach((mk, mi) => {
      const e = Math.min(end, mi + 1 < marks.length ? marks[mi + 1].t : end);
      if (e - mk.t > 0.005) events.push(`Dialogue: ${layer},${assTime(mk.t)},${assTime(e)},${name},,0,0,0,,{\\an5${place}\\bord0\\shad0\\fscy100}${body(mk.j)}`);
    });
  };
  const sh = B.shadow;
  if (segs.some((s) => s.L.shadow)) pass(0, (L) => (L.shadow ? { colour: L.shadow.color, alpha: L.shadow.alpha, sigma: L.shadow.blur * unit } : { colour: '#000000', alpha: 0, sigma: 0 }), (sh?.x ?? 0) * unit, (sh?.y ?? 0) * unit);
  if (segs.some((s) => s.L.glow)) pass(1, (L) => (L.glow ? { colour: L.glow.color, alpha: L.glow.alpha, sigma: L.glow.blur * unit } : { colour: '#000000', alpha: 0, sigma: 0 }), 0, 0);
  pass(2, (L) => ({ colour: L.color, alpha: L.alpha ?? 1, sigma: 0 }), 0, 0);
}

const anyAlpha = (a) => `&H${a.toString(16).padStart(2, '0').toUpperCase()}&`;

/**
 * Graphic clip (lower third, title, label, progress bar) -> ASS events. Same events as the
 * preview (src/lib/graphics.js): \move, \fad and \t(\fscx\fscy) are all linear in libass.
 */
function graphicAss(c, W, H, events, styles, files, userFonts) {
  const len = clipDuration(c);
  const i0 = (n) => String(Math.round(n));
  for (const e of graphicEvents(c.graphic, len, W, H)) {
    const s = c.start + e.t0;
    const t = c.start + e.t1;
    if (t - s < 0.01) continue;
    const place = e.moveMs > 0 ? `\\move(${f1(e.x0)},${f1(e.y0)},${f1(e.x1)},${f1(e.y1)},0,${Math.round(e.moveMs)})` : `\\pos(${f1(e.x1)},${f1(e.y1)})`;
    const fade = e.fadeIn || e.fadeOut ? `\\fad(${Math.round(e.fadeIn)},${Math.round(e.fadeOut)})` : '';
    const acc = e.scaleAccel && e.scaleAccel !== 1 ? `${f2(e.scaleAccel)},` : '';
    const scale = e.scale ? `\\fscx${f1(e.scale.x0)}\\fscy${f1(e.scale.y0)}\\t(0,${Math.round(e.scale.ms)},${acc}\\fscx${f1(e.scale.x1)}\\fscy${f1(e.scale.y1)})` : '';
    // Fill colour keys (gradient sweep): first colour, then one \t per key.
    let fill = `\\1c${assColor(e.colors ? e.colors[0][1] : e.color)}\\1a${a255(e.alpha ?? 1)}`;
    if (e.colors) for (let i = 1; i < e.colors.length; i++) fill += `\\t(${Math.round(e.colors[i - 1][0])},${Math.round(e.colors[i][0])},\\1c${assColor(e.colors[i][1])})`;
    // Moving mask (clip-path reveal): \clip, animated with \t and its accel.
    let clip = '';
    if (e.clip) {
      const r = (b) => b.map((v) => String(Math.round(v))).join(',');
      clip = `\\clip(${r(e.clip.from)})`;
      if (e.clip.ms > 0) clip += `\\t(0,${Math.round(e.clip.ms)},${f2(e.clip.accel ?? 1)},\\clip(${r(e.clip.to)}))`;
    }
    if (e.kind === 'glass') {
      // The blur itself is in the filter graph (glassFilters); here the tint and the light border.
      styles.add('Gfx');
      const w = Math.round(e.w);
      const h = Math.round(e.h);
      const at = `\\an7\\pos(${f1(e.x1 - w / 2)},${f1(e.y1 - h / 2)})${fade}`;
      const path = roundRectPath(w, h, e.radius ?? 0);
      if (e.tint) events.push(`Dialogue: ${e.layer},${assTime(s)},${assTime(t)},Gfx,,0,0,0,,{${at}\\bord0\\shad0\\1c${assColor(e.tint.color)}\\1a${a255(e.tint.alpha)}\\p1}${path}{\\p0}`);
      if (e.border) events.push(`Dialogue: ${e.layer},${assTime(s)},${assTime(t)},Gfx,,0,0,0,,{${at}\\bord${f1(e.border.width)}\\shad0\\1a&HFF&\\3c${assColor(e.border.color)}\\3a${a255(e.border.alpha)}\\p1}${path}{\\p0}`);
      continue;
    }
    if (e.kind === 'rect') {
      styles.add('Gfx');
      const w = i0(e.w);
      const h = i0(e.h);
      events.push(`Dialogue: ${e.layer},${assTime(s)},${assTime(t)},Gfx,,0,0,0,,{\\an${e.an}${place}${fade}${scale}\\bord0\\shad0${fill}\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`);
      continue;
    }
    const font = assFont(e.font, files, userFonts);
    const fam = String(font.family).replace(/[{}\\,]/g, ' ');
    let look = `\\bord0\\shad0`;
    let style = 'Gfx';
    if (e.box) {
      style = 'GfxBox';
      look = `\\bord${f1(e.box.pad)}\\shad0\\3c${assColor(e.box.color)}\\3a${a255(e.box.alpha)}`;
    } else if (e.shadow) look = `\\bord0\\xshad${f1(e.shadow.x)}\\yshad${f1(e.shadow.y)}\\4c${assColor(e.shadow.color)}\\4a${a255(e.shadow.alpha)}`;
    styles.add(style);
    events.push(`Dialogue: ${e.layer},${assTime(s)},${assTime(t)},${style},,0,0,0,,{\\an${e.an}${place}${fade}${scale}${clip}\\fn${fam}\\fs${f1(e.size)}${look}${fill}}${assText(e.text)}`);
  }
}

/**
 * Captions -> ASS. Mirrors src/engine/caption.ts: same effects (pop, fade, slide, words,
 * bounce, karaoke, marker), highlight, glow, shadow and spacing.
 */
function buildAss(project, { files, userFonts = true } = {}) {
  const { w: W, h: H } = project.canvas;
  // Style lines by name; a caption with its own override gets its own style line (name_oN).
  const used = new Map();
  const overrides = new Map();
  const events = [];
  const gfxStyles = new Set();
  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const c of track.clips) {
      if (c.graphic) {
        graphicAss(c, W, H, events, gfxStyles, files, userFonts);
        continue;
      }
      if (!c.text) continue;
      const baseName = styleName(c, project);
      const o = cleanOverride(c.override);
      let name = baseName;
      let st = styleByName(baseName, project);
      if (o) {
        const key = `${baseName}|${JSON.stringify(o)}`;
        if (!overrides.has(key)) overrides.set(key, `${baseName}_o${overrides.size + 1}`);
        name = overrides.get(key);
        st = applyOverride(st, o);
      }
      used.set(name, st);
      if (st.emphasis) {
        emphasisEvents(c, st, name, W, H, c.start + clipDuration(c), events, files, userFonts);
        continue;
      }
      const anim = st.anim || 'pop';
      const size = Math.round((c.size || st.size) * H);
      const x = Math.round((c.x ?? 0.5) * W);
      const y = Math.round((c.y ?? st.y) * H);
      const up = (s) => (st.uppercase ? s.toUpperCase() : s);
      const end = c.start + clipDuration(c);
      const shadowA = st.shadowColor ? 0 : 0x80;
      const glow = st.glow ? `\\blur${Math.max(1, Math.round(size * 0.12))}` : '';
      // Whole-caption intro, only on the event that starts with the caption.
      const intro = (first) => {
        if (!first) return `\\pos(${x},${y})`;
        if (anim === 'pop') return `\\pos(${x},${y})\\fscx86\\fscy86\\t(0,120,\\fscx100\\fscy100)`;
        if (anim === 'fade') return `\\pos(${x},${y})\\fad(150,0)`;
        if (anim === 'slide') return `\\move(${x},${y + Math.round(0.04 * H)},${x},${y},0,180)\\fad(180,0)`;
        return `\\pos(${x},${y})`;
      };
      const head = (first) => `{\\an5${intro(first)}\\fs${size}${glow}}`;
      const words = Array.isArray(c.words) && c.words.length ? c.words : null;
      const push = (s, e, text) => {
        if (e - s > 0.005) events.push(`Dialogue: 0,${assTime(s)},${assTime(Math.min(e, end))},${name},,0,0,0,,${text}`);
      };

      if (!words) {
        push(c.start, end, `${head(true)}${assText(up(c.text))}`);
        continue;
      }
      if (anim === 'karaoke') {
        // One event; \kf fills each word with PrimaryColour (the highlight) while it is spoken.
        const cs = (t) => Math.max(0, Math.round(t * 100));
        let text = words[0].s > 0 ? `{\\k${cs(words[0].s)}}` : '';
        words.forEach((w, i) => {
          const next = i + 1 < words.length ? words[i + 1].s : w.e;
          text += `{\\kf${cs(next - w.s)}}${assText(up(w.w))}${i + 1 < words.length ? ' ' : ''}`;
        });
        push(c.start, end, `${head(true)}${text}`);
        continue;
      }
      const hides = anim === 'words' || anim === 'bounce';
      // Tags that bring a word back to the style after an override (same values as the style line).
      const boxA = st.boxColor ? 0 : 0x40;
      const outC = st.box ? (st.boxColor ? assColor(st.boxColor) : assColor('#000000', 0x40)) : assColor(st.outlineColor);
      const base = `\\c${assColor(st.color)}\\3c${outC}\\bord${Math.round(st.outline * H)}\\fscx100\\fscy100\\1a&H00&\\3a${anyAlpha(st.box ? boxA : 0)}\\4a${anyAlpha(st.box ? boxA : shadowA)}`;
      // One event per interval: before the first word (nothing spoken yet), then one per word.
      // Words that start together keep the last one (same as the preview's "current word").
      const marks = [];
      if (words[0].s > 0.005) marks.push({ t: c.start, k: -1 });
      words.forEach((w, i) => {
        const t = c.start + Math.max(0, w.s);
        if (marks.length && t <= marks[marks.length - 1].t + 0.005) marks[marks.length - 1].k = i;
        else marks.push({ t, k: i });
      });
      marks[0].t = c.start;
      marks.forEach((m, mi) => {
        const ws = m.t;
        const we = mi + 1 < marks.length ? marks[mi + 1].t : end;
        const k = m.k;
        const parts = words.map((w, j) => {
          const t = assText(up(w.w));
          if (hides && j > k) return `{\\1a&HFF&\\3a&HFF&\\4a&HFF&}${t}{${base}}`;
          if (j !== k) return t;
          if (anim === 'marker') return `{\\bord${Math.round(size * 0.18)}\\3c${assColor(st.marker || st.highlight)}}${t}{${base}}`;
          const colour = st.highlight && st.highlight !== st.color ? `\\c${assColor(st.highlight)}` : '';
          const bounce = anim === 'bounce' ? '\\t(0,80,\\fscx125\\fscy125)\\t(80,160,\\fscx115\\fscy115)' : '';
          return colour || bounce ? `{${colour}${bounce}}${t}{${base}}` : t;
        });
        push(ws, we, `${head(ws <= c.start + 0.005)}${parts.join(' ')}`);
      });
    }
  }
  if (!events.length) return null;
  const styleLines = [...used].map(([n, st]) => {
    if (!st.emphasis) addInstalledFont(st.font, files, userFonts);
    const anim = st.anim || 'pop';
    const size = Math.round(st.size * H);
    const outline = Math.max(0, Math.round(st.outline * H));
    const border = st.box ? 3 : 1;
    // Box captions: libass draws the box with the outline colour (opaque when a box colour is chosen).
    const boxColour = st.boxColor ? assColor(st.boxColor) : assColor('#000000', 0x40);
    const shadowColour = assColor(st.shadowColor || '#000000', st.shadowColor ? 0 : 0x80);
    const back = st.box ? boxColour : shadowColour;
    const outlineColour = st.box ? boxColour : assColor(st.outlineColor);
    const shadow = st.box || st.glow ? 0 : Math.round((st.shadow ?? st.outline / 2) * H);
    // Karaoke: PrimaryColour is the sung (filled) colour, SecondaryColour the colour before it.
    const primary = anim === 'karaoke' ? assColor(st.highlight) : assColor(st.color);
    const secondary = anim === 'karaoke' ? assColor(st.color) : assColor(st.highlight);
    const bold = /Bold|Semibold/.test(st.font) ? -1 : 0;
    const spacing = Math.round((st.spacing || 0) * H);
    return `Style: ${n},${String(st.font).replace(/,/g, ' ')},${size},${primary},${secondary},${outlineColour},${back},${bold},0,0,0,100,100,${spacing},0,${border},${outline},${shadow},5,40,40,40,1`;
  });
  // Graphics: plain text/shape style, and the opaque-box style (BorderStyle 3) for boxed texts.
  if (gfxStyles.has('Gfx')) styleLines.push('Style: Gfx,Arial,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1');
  if (gfxStyles.has('GfxBox')) styleLines.push('Style: GfxBox,Arial,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ ffmpeg command

/**
 * Build the ffmpeg arguments. Returns { args, duration, ass } — `ass` is the subtitle file
 * content to write as caps.ass in the working directory (or null).
 */
function buildExport(project, outPath, { encoder = 'libx264', quality = 'alta' } = {}) {
  const crf = { alta: 18, media: 21, leve: 25 }[quality] ?? 18;
  const { w: W, h: H, fps: FPS } = project.canvas;
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('A timeline está vazia');
  const media = new Map(project.media.map((m) => [m.id, m]));
  const args = ['-hide_banner', '-y'];
  const filters = [`color=c=black:s=${W}x${H}:r=${FPS}:d=${duration}[base0]`];
  const audio = [];
  const voice = [];
  const music = [];
  const luts = [];
  let input = 0;
  /** Extra file input for Fusion Media nodes (looped for the clip's length). */
  const addInput = (file, kind, len) => {
    if (kind === 'image') args.push('-loop', '1', '-t', String(r3(len)), '-i', file);
    else args.push('-stream_loop', '-1', '-t', String(r3(len)), '-i', file);
    return input++;
  };
  let base = 'base0';
  let layer = 0;
  // Parts of clips drawn again over the captions ("front" masks): { label, x, start, end }.
  const fronts = [];
  /** Every clip by id (parents and null objects). */
  const byId = new Map(project.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
  /** Files the command needs next to it (track-matte texts, fonts): { name, content } or { name, from }. */
  const extraFiles = [];
  const matteFont = (family) => {
    const want = String(family || 'Inter Black').toLowerCase();
    try {
      for (const f of fs.readdirSync(FONTS_DIR)) if (/\.(ttf|otf)$/i.test(f) && String(familyName(fs.readFileSync(path.join(FONTS_DIR, f))) || '').toLowerCase() === want) return path.join(FONTS_DIR, f);
    } catch {
      /* no bundled fonts */
    }
    const fam = findFamily(family, fontCacheFile);
    return fam?.files?.[0] || null;
  };

  for (const track of project.tracks) {
    if (track.kind === 'text' || track.hidden) continue;
    for (const c of track.clips) {
      const m = media.get(c.mediaId);
      if (!m) continue;
      const dur = clipDuration(c);
      if (dur <= 0) continue;
      const speed = speedOf(c);
      const srcLen = c.out - c.in;
      const remap = m.kind !== 'image' ? xform.remapRange(c) : null;
      if (m.kind === 'image') args.push('-loop', '1', '-t', String(r3(dur)), '-i', m.path);
      else if (remap) args.push('-ss', String(r3(remap.lo)), '-t', String(r3(remap.hi - remap.lo + 0.1)), '-i', m.path);
      else args.push('-ss', String(r3(c.in)), '-t', String(r3(srcLen)), '-i', m.path);
      const k = input++;
      // Motion blur renders the clip N times faster and averages K sub-frames (shutter angle).
      const mb = c.motionBlur && Number(c.motionBlur.shutter) > 0 ? xform.blurSamples(c.motionBlur) : null;
      const FPSc = mb ? FPS * mb.N : FPS;
      const moved = xform.transformed(c, byId);
      const XL = moved || c.parent ? xform.xformExpr(c, 't', byId, W, H) : null;
      // Clip edges snapped to the output frame grid: with r3 times a clip could start half a frame
      // after the previous one ended (29.97 fps), which left one black frame at the cut.
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      const start = r6(Math.round(c.start * FPS) / FPS);
      const end = r6(Math.round((c.start + dur) * FPS) / FPS);
      const half = r6(0.5 / FPS);
      const tin = c.transitionIn && c.transitionIn.d > 0 ? { type: c.transitionIn.type, d: Math.min(c.transitionIn.d, dur) } : null;
      const tout = c.transitionOut && c.transitionOut.d > 0 ? { type: c.transitionOut.type, d: Math.min(c.transitionOut.d, dur) } : null;
      const sides = [];
      if (tin) sides.push(['in', tin]);
      if (tout) sides.push(['out', tout]);
      if (track.kind === 'video' && (m.kind === 'video' || m.kind === 'image')) {
        const tzoom = transitionZoomExpr(sides, dur, `(on/${FPSc})`);
        const keyed = Boolean(anim.animates(c, 'zoom') || anim.animates(c, 'x') || anim.animates(c, 'y') || tzoom);
        const chain = [remap ? `setpts='${xform.remapSetpts(c)}'` : `setpts=(PTS-STARTPTS)/${fx(m.kind === 'image' ? 1 : speed)}`, `fps=${FPSc}`];
        // Sideways footage (Resolve-style rotation, counter-clockwise) is turned before framing.
        const orient = { 90: 'transpose=2', 180: 'hflip,vflip', 270: 'transpose=1' }[c.orient];
        if (orient) chain.push(orient);
        if (c.fit === 'fit') {
          chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
          if (keyed) chain.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
        } else chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
        chain.push('setsar=1');
        // Framing only (no grade): person mattes go through the same scale/crop/zoom as the clip.
        const geo = [...chain];
        let zoomF = null;
        let lutName = null;
        if (c.color?.lut && /\.cube$/i.test(c.color.lut) && fs.existsSync(c.color.lut)) {
          lutName = `lut${luts.length}.cube`;
          luts.push({ name: lutName, path: c.color.lut });
        }
        chain.push(...gradeFilters(c.color, lutName));
        if (keyed) {
          // Zoom/pan keyframes: crop window that follows the animation, rendered at canvas size.
          const T = `(on/${FPSc})`;
          const z = `max(1,${anim.propExpr(c, 'zoom', 1, T)})${tzoom ? `*${tzoom}` : ''}`;
          const x = `max(0,min(iw-iw/zoom,(iw-iw/zoom)/2+(${anim.propExpr(c, 'x', 0, T)})*iw))`;
          const y = `max(0,min(ih-ih/zoom,(ih-ih/zoom)/2+(${anim.propExpr(c, 'y', 0, T)})*ih))`;
          zoomF = `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPSc}`;
          chain.push(zoomF);
        }
        let mattes = 0;
        const matteInput = (mk) => {
          // The matte covers source [matte.in, matte.out]; read the clip's part of it.
          args.push('-ss', String(r3(Math.max(0, c.in - mk.matte.in))), '-t', String(r3(srcLen)), '-i', mk.matte.file);
          const idx = input++;
          const label = `mt${layer}_${mattes++}`;
          filters.push(`[${idx}:v]${geo.join(',')}${zoomF ? `,${zoomF}` : ''},format=gray[${label}]`);
          return label;
        };
        const maskCtx = { W, H, FPS, dur, matteInput };
        let src = `[${k}:v]`;
        if (hasFusion(c.fusion)) {
          const pre = `pf${layer}`;
          filters.push(`${src}${chain.join(',')}[${pre}]`);
          src = `[${fusionChain(filters, c.fusion, pre, `${layer}`, { W, H, FPS, dur, media, addInput })}]`;
          chain.length = 0;
        }
        if (Array.isArray(c.masks) && c.masks.length) {
          // Masks work on the framed clip (after scale/zoom), before the fades and the overlay.
          const pre = `pm${layer}`;
          filters.push(`${src}${chain.length ? chain.join(',') : 'null'}[${pre}]`);
          src = `[${maskChain(filters, c.masks, pre, `${layer}`, maskCtx)}]`;
          chain.length = 0;
        }
        // After Effects-style layer: effect stack, track matte and blend mode work on a full-canvas
        // RGBA layer in local time (src/lib/layerfx.js builds the same steps the preview draws).
        const blend = c.blend && c.blend !== 'normal' && BLEND_FFMPEG[c.blend] ? c.blend : null;
        if ((c.effects && c.effects.length) || c.matte || blend) {
          chain.push('format=rgba');
          if (c.fit === 'fit' && !keyed) chain.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
          const pre = `pl${layer}`;
          filters.push(`${src}${chain.join(',')}[${pre}]`);
          src = `[${layerFx(filters, c, pre, `${layer}`, { W, H, FPS, dur, media, addInput, files: extraFiles, fontFile: matteFont })}]`;
          chain.length = 0;
        }
        // Moldura e fundo (src/lib/frame.js): the finished picture goes into its rounded box over a
        // background; the result is a full-canvas RGBA layer, as the preview draws it.
        if (hasFrame(c.frame)) {
          chain.push('format=rgba');
          if (c.fit === 'fit' && !keyed) chain.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
          const pre = `pq${layer}`;
          filters.push(`${src}${chain.join(',')}[${pre}]`);
          src = `[${frameFilters(filters, c.frame, pre, `${layer}`, { W, H, FPS: FPSc, dur })}]`;
          chain.length = 0;
        }
        const frontMasks = (c.masks || []).filter((m) => m.mode === 'front' && maskReady(m));
        let front = null;
        if (frontMasks.length) {
          // Split the finished clip: one copy goes on the timeline as usual, the other keeps only
          // the front masks' area and is laid over the captions at the end.
          const pre = `pfr${layer}`;
          filters.push(`${src}${chain.length ? chain.join(',') : 'null'},split=2[${pre}a][${pre}b]`);
          chain.length = 0;
          src = `[${pre}a]`;
          const lums = frontMasks.map((m, i) => maskLum(filters, m, `f${layer}_${i}`, maskCtx));
          let union = lums[0];
          for (let i = 1; i < lums.length; i++) {
            filters.push(`[${union}][${lums[i]}]blend=all_mode=lighten[fu${layer}_${i}]`);
            union = `fu${layer}_${i}`;
          }
          const fc = ['format=yuva420p'];
          if (tin?.type === 'fade') fc.push(`fade=t=in:st=0:d=${fx(tin.d)}:alpha=1`);
          if (tout?.type === 'fade') fc.push(`fade=t=out:st=${fx(dur - tout.d)}:d=${fx(tout.d)}:alpha=1`);
          fc.push(`setpts=PTS+${start}/TB`);
          filters.push(`[${pre}b][${union}]alphamerge,${fc.join(',')}[fr${layer}]`);
          front = `fr${layer}`;
        }
        // Hold the last frame a little: frame-rate conversion can end the stream one frame early,
        // which showed the black base for one frame at the cut. The overlay is only enabled until `end`.
        if (m.kind !== 'image') chain.push(`tpad=stop_mode=clone:stop_duration=${fx(3 / FPS)}`);
        chain.push(...transitionFilters(c, sides, dur, Math.min(W, H), XL?.pr));
        // Free transform / PiP (AE Transform + Parent): scale around the centre, per frame.
        if (moved) chain.push('format=rgba', `scale=w='max(2,trunc(iw*(${XL.s})/2)*2)':h='max(2,trunc(ih*(${XL.s})/2)*2)':eval=frame`);
        if (mb) {
          // Position the layer inside its own stream so the movement is blurred too, then average K
          // sub-frames and keep one frame in N.
          const pre = `mb${layer}`;
          filters.push(`${src}${chain.join(',')}[${pre}]`);
          filters.push(`color=c=black@0:s=${W}x${H}:r=${FPSc}:d=${fx(dur + 0.2)},format=rgba[mc${layer}]`);
          const px = moved ? `+(${XL.x})` : '';
          const py = moved ? `+(${XL.y})` : '';
          filters.push(`[mc${layer}][${pre}]overlay=x='(W-w)/2${px}':y='(H-h)/2${py}':format=auto:eof_action=pass,tmix=frames=${mb.K},fps=${FPS}[mo${layer}]`);
          src = `[mo${layer}]`;
          chain.length = 0;
          chain.push('null');
        }
        // Blend modes need a frame at every moment of the base: pad the start instead of shifting it.
        chain.push(blend ? `tpad=start_duration=${start}:color=black@0,format=rgba` : `setpts=PTS+${start}/TB`);
        const v = `v${layer}`;
        filters.push(`${src}${chain.join(',')}[${v}]`);
        let composed = false;
        if (blend) {
          // base (top) <mode> layer, kept only where the layer is opaque, during the clip.
          const L = layer;
          const next = `base${++layer}`;
          filters.push(`[${base}]split=2[bb${L}][bk${L}]`, `[${v}]split=2[vl${L}][va${L}]`);
          filters.push(`[bb${L}]format=gbrp[bg${L}]`, `[vl${L}]format=gbrp[vg${L}]`);
          filters.push(`[bg${L}][vg${L}]blend=all_mode=${BLEND_FFMPEG[blend]}[bl${L}]`);
          filters.push(`[va${L}]alphaextract[vx${L}]`, `[bl${L}][vx${L}]alphamerge[bm${L}]`);
          filters.push(`[bk${L}][bm${L}]overlay=format=auto:eof_action=pass:enable='between(t,${r6(start - half)},${r6(end - half)})'[${next}]`);
          base = next;
          composed = true;
        }
        // Slide / whip transitions push the clip in from the right and out to the left (smooth, as the preview).
        let xExpr = '(main_w-overlay_w)/2';
        let yExpr = '(main_h-overlay_h)/2';
        if (moved && !mb) {
          // Position of a transformed clip, in timeline time.
          const XG = xform.xformExpr(c, `(t-${start})`, byId, W, H);
          xExpr = `(main_w-overlay_w)/2+(${XG.x})`;
          yExpr = `'(main_h-overlay_h)/2+(${XG.y})'`;
        }
        const pushes = (tr) => tr && (tr.type === 'slide' || tr.type === 'whip');
        const slideIn = pushes(tin) ? `+main_w*(1-${smoothE(`clip((t-${start})/${fx(tin.d)},0,1)`)})` : '';
        const slideOut = pushes(tout) ? `-main_w*(1-${smoothE(`clip((${end}-t)/${fx(tout.d)},0,1)`)})` : '';
        if (slideIn || slideOut || (moved && !mb)) xExpr = `'${xExpr}${slideIn}${slideOut}'`;
        if (!composed) {
        const next = `base${++layer}`;
        filters.push(`[${base}][${v}]overlay=x=${xExpr}:y=${yExpr}:eof_action=pass:enable='between(t,${r6(start - half)},${r6(end - half)})'[${next}]`);
        base = next;
        }
        if (front) fronts.push({ label: front, x: xExpr, start, end });
      }
      const vol = track.muted || remap ? 0 : (c.volume ?? 1);
      if (m.hasAudio && vol > 0) {
        const ms = Math.round(start * 1000);
        const a = `a${audio.length}`;
        const achain = ['asetpts=PTS-STARTPTS', ...atempo(speed), 'aresample=48000', `volume=${vol}`];
        if (tin) achain.push(`afade=t=in:st=0:d=${fx(tin.d)}`);
        if (tout) achain.push(`afade=t=out:st=${fx(dur - tout.d)}:d=${fx(tout.d)}`);
        achain.push(`adelay=${ms}:all=1`);
        filters.push(`[${k}:a]${achain.join(',')}[${a}]`);
        audio.push(a);
        (track.kind === 'audio' ? music : voice).push(a);
      }
    }
  }

  // Glass cards (Apple template): the picture under the card is blurred, with rounded corners and the
  // card's fades, before the captions and graphics are drawn over it (preview: src/engine/graphics.ts).
  let gi = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const c of track.clips) {
      if (!c.graphic) continue;
      for (const e of graphicEvents(c.graphic, clipDuration(c), W, H)) {
        if (e.kind !== 'glass') continue;
        const w = Math.max(2, Math.round(e.w / 2) * 2);
        const h = Math.max(2, Math.round(e.h / 2) * 2);
        const x = Math.max(0, Math.min(W - w, Math.round((e.x1 - w / 2) / 2) * 2));
        const y = Math.max(0, Math.min(H - h, Math.round((e.y1 - h / 2) / 2) * 2));
        const s0 = r3(c.start + e.t0);
        const s1 = r3(c.start + e.t1);
        const R = Math.max(0, Math.min(e.radius ?? 0, w / 2, h / 2));
        const inside = `lte(hypot(max(abs(X-${w / 2})-${r3(w / 2 - R)},0),max(abs(Y-${h / 2})-${r3(h / 2 - R)},0)),${r3(R)})`;
        const fades = [];
        if (e.fadeIn > 0) fades.push(`fade=t=in:st=${s0}:d=${r3(e.fadeIn / 1000)}:alpha=1`);
        if (e.fadeOut > 0) fades.push(`fade=t=out:st=${r3(s1 - e.fadeOut / 1000)}:d=${r3(e.fadeOut / 1000)}:alpha=1`);
        const g = `gl${gi++}`;
        filters.push(`[${base}]split=2[${g}a][${g}b]`);
        filters.push(`[${g}b]crop=${w}:${h}:${x}:${y},gblur=sigma=${r3(e.blur ?? 20)},format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='255*${inside}'${fades.length ? ',' + fades.join(',') : ''}[${g}c]`);
        filters.push(`[${g}a][${g}c]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${s0},${s1})'[${g}d]`);
        base = `${g}d`;
      }
    }
  }

  const fonts = new Set();
  const ass = buildAss(project, { files: fonts });
  // Captions, then the front layers over them (the captions pass behind the person).
  let top = base;
  if (ass) {
    filters.push(`[${base}]subtitles=caps.ass:fontsdir=fonts[${fronts.length ? 'subs' : 'vout'}]`);
    top = 'subs';
  }
  fronts.forEach((f, i) => {
    const next = i === fronts.length - 1 ? 'vout' : `top${i}`;
    filters.push(`[${top}][${f.label}]overlay=x=${f.x}:y=(main_h-overlay_h)/2:eof_action=pass:enable='between(t,${f.start},${f.end})'[${next}]`);
    top = next;
  });
  if (!ass && !fronts.length) filters.push(`[${base}]null[vout]`);
  const settings = project.audio || {};
  const mix = (list, out) => filters.push(list.length === 1 ? `[${list[0]}]anull[${out}]` : `${list.map((a) => `[${a}]`).join('')}amix=inputs=${list.length}:normalize=0:dropout_transition=0[${out}]`);
  const tail = `${settings.normalize ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,' : ''}atrim=0:${duration}`;
  if (settings.duck && voice.length && music.length) {
    // Music ducking: the voice drives a compressor on the music (sidechain), then both are mixed.
    mix(voice, 'vmix');
    mix(music, 'mmix');
    filters.push('[vmix]asplit=2[vkey][vout0]');
    filters.push('[mmix][vkey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[mduck]');
    filters.push(`[vout0][mduck]amix=inputs=2:normalize=0:dropout_transition=0,${tail}[aout]`);
  } else if (audio.length) filters.push(`${audio.map((a) => `[${a}]`).join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,${tail}[aout]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration}[aout]`);

  // GPU: NVIDIA (nvenc) on Windows, VideoToolbox on macOS (constant quality 1-100: 65 / 59 / 51).
  const video =
    encoder === 'h264_nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(crf + 1)]
    : encoder === 'h264_videotoolbox' ? ['-c:v', 'h264_videotoolbox', '-q:v', String(101 - 2 * crf)]
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf)];
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...video, '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-t', String(duration), outPath,
  );
  return { args, duration, ass, luts, fonts: [...fonts], extraFiles };
}

/** Run the export; onProgress(0..1). Resolves with the output path. */
function runExport(project, outPath, { onProgress = () => {}, encoder, quality, signal } = {}) {
  const { args, duration, ass, luts, fonts, extraFiles } = buildExport(project, outPath, { encoder, quality });
  const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cinemex-'));
  if (ass) {
    fs.writeFileSync(path.join(work, 'caps.ass'), ass, 'utf8');
    // Bundled caption fonts, so libass draws the same letters as the preview.
    fs.mkdirSync(path.join(work, 'fonts'));
    // Copies are made writable: fonts from the Windows font folders are often read-only, and a
    // read-only file makes the clean-up below fail (EPERM).
    const copyFont = (from, to) => {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o644);
    };
    if (fs.existsSync(FONTS_DIR)) for (const f of fs.readdirSync(FONTS_DIR)) if (/\.(ttf|otf)$/i.test(f)) copyFont(path.join(FONTS_DIR, f), path.join(work, 'fonts', f));
    // User fonts (installed on this PC, personal licences) used by the captions: copied only into
    // this temporary folder, never into the project or the repo.
    fonts.forEach((f, i) => copyFont(f, path.join(work, 'fonts', `user${i}${path.extname(f)}`)));
  }
  // LUTs are copied next to the command so the filter graph never has to escape Windows paths.
  for (const l of luts) fs.copyFileSync(l.path, path.join(work, l.name));
  for (const f of extraFiles || []) {
    if (f.from) {
      fs.copyFileSync(f.from, path.join(work, f.name));
      fs.chmodSync(path.join(work, f.name), 0o644);
    } else fs.writeFileSync(path.join(work, f.name), f.content, 'utf8');
  }
  // The filter graph goes in a file: with many clips it passes the 32 767-character Windows
  // command-line limit (spawn ENAMETOOLONG). `-/option file` reads the value from a file (ffmpeg 7+).
  const fcAt = args.indexOf('-filter_complex');
  if (fcAt >= 0) {
    fs.writeFileSync(path.join(work, 'graph.txt'), args[fcAt + 1], 'utf8');
    args.splice(fcAt, 2, '-/filter_complex', 'graph.txt');
  }
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd: work, windowsHide: true });
    let tail = '';
    const abort = () => p.kill();
    signal?.addEventListener('abort', abort);
    p.stderr.on('data', (d) => {
      const s = String(d);
      tail = (tail + s).slice(-3000);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
      if (m) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
    });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg não encontrado' : e.message)));
    p.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        /* a leftover temp folder must never lose the export */
      }
      if (code === 0) {
        onProgress(1);
        resolve(outPath);
      } else reject(new Error(signal?.aborted ? 'Exportação cancelada' : `ffmpeg falhou: ${tail.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

module.exports = { setFontCache, fusionChain, maskChain, buildExport, buildAss, runExport, projectDuration, assTime, assColor, kfExpr, atempo, gradeMath, gradeFilters, STYLES };
