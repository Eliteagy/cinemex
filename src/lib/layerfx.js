// After Effects-style layer processing shared by the export (ffmpeg filters, layerFx) and the preview
// (src/engine/layerfx.ts uses the same geometry helpers). Order like AE: effects -> track matte; the
// blend mode is applied when the layer is composited (render.cjs / player.ts).
//
// Effects (lengths are fractions of the frame's shorter side, angles in degrees, colours #RRGGBB):
//   shadow   Drop Shadow: colour, opacity, distance, direction (AE: 0 = up, clockwise), softness
//   glow     Glow: blurred copy screened over the layer (radius, intensity)
//   sweep    CC Light Sweep: a bright band crossing the layer once (angle, width, intensity, start, duration)
//   gradient Gradient Ramp: linear gradient c0 -> c1 from (x0, y0) to (x1, y1) (fractions), over the layer at opacity
// Track matte: text (the layer shows inside the letters) or another media's alpha / brightness; invert.

export const EFFECT_TYPES = ['shadow', 'glow', 'sweep', 'gradient'];
export const EFFECT_LABELS = { shadow: 'Sombra (Drop Shadow)', glow: 'Glow', sweep: 'Light Sweep', gradient: 'Gradient Ramp' };
export const EFFECT_DEFAULTS = {
  shadow: { color: '#000000', opacity: 0.6, distance: 0.012, angle: 135, softness: 0.01 },
  glow: { radius: 0.02, intensity: 0.5 },
  sweep: { color: '#FFFFFF', angle: 20, width: 0.12, intensity: 0.55, start: 0, duration: 0.9 },
  gradient: { c0: '#D4AF37', c1: '#83163A', x0: 0.5, y0: 0, x1: 0.5, y1: 1, opacity: 0.35 },
};
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'lighten', 'darken', 'difference'];
export const BLEND_LABELS = { normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', add: 'Add', lighten: 'Lighten', darken: 'Darken', difference: 'Difference' };
/** ffmpeg blend modes (base is the first input, like the W3C backdrop) and canvas composite operations. */
export const BLEND_FFMPEG = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'addition', lighten: 'lighten', darken: 'darken', difference: 'difference' };
export const BLEND_CANVAS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter', lighten: 'lighten', darken: 'darken', difference: 'difference' };
export const MATTE_FONT = 'Inter Black';

const fx = (n) => String(Math.round(n * 10000) / 10000);
const rgb = (h) => [0, 2, 4].map((i) => parseInt(String(h || '#000000').replace('#', '').slice(i, i + 2), 16) || 0);
const hex0x = (h) => `0x${String(h || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));

/** Shadow offset in pixels for a frame whose shorter side is `short`. */
export function shadowOffset(e, short) {
  const a = ((Number(e.angle) || 0) * Math.PI) / 180;
  const d = clamp(e.distance, 0, 0.2) * short;
  return { dx: Math.sin(a) * d, dy: -Math.cos(a) * d };
}

/** Light sweep geometry: band centre along direction (cos, sin) at local time t, and half width, in pixels. */
export function sweepAt(e, t, W, H) {
  const a = ((Number(e.angle) || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ds = [0, W * c, H * s, W * c + H * s];
  const dmin = Math.min(...ds);
  const dmax = Math.max(...ds);
  const w = Math.max(1, clamp(e.width, 0.005, 1) * Math.min(W, H));
  const u = clamp((t - (Number(e.start) || 0)) / Math.max(0.05, Number(e.duration) || 1), 0, 1);
  return { c, s, w, pos: dmin - w + (dmax - dmin + 2 * w) * u, dmin, dmax, active: t >= (Number(e.start) || 0) && t <= (Number(e.start) || 0) + Math.max(0.05, Number(e.duration) || 1) };
}

/** Text matte geometry: em size and baseline (pixels), x centre. y is the vertical centre of the letters' line box. */
export function textMatteBox(m, W, H) {
  const size = clamp(m.size ?? 0.22, 0.02, 1) * H;
  return { px: size, cx: clamp(m.x ?? 0.5, 0, 1) * W, cy: clamp(m.y ?? 0.5, 0, 1) * H };
}

/**
 * Export: effect stack + track matte for the full-canvas RGBA layer labelled `input` (local time).
 * Appends filters, returns the label of the result.
 */
export function layerFx(filters, c, input, tag, { W, H, FPS, dur, media, addInput, files, fontFile }) {
  const short = Math.min(W, H);
  let cur = input;
  const canvas = (l) => filters.push(`color=c=black@0:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=rgba[${l}]`);
  (c.effects || []).forEach((e, i) => {
    const id = `${tag}_${i}`;
    if (e.type === 'shadow') {
      const [r, g, b] = rgb(e.color);
      const { dx, dy } = shadowOffset(e, short);
      const sigma = clamp(e.softness, 0, 0.1) * short;
      filters.push(`[${cur}]split=2[sa${id}][sb${id}]`);
      filters.push(`[sb${id}]colorchannelmixer=aa=${fx(clamp(e.opacity, 0, 1))},lutrgb=r=${r}:g=${g}:b=${b}${sigma > 0.5 ? `,gblur=sigma=${fx(sigma)}` : ''}[ss${id}]`);
      canvas(`sc${id}`);
      filters.push(`[sc${id}][ss${id}]overlay=x=${fx(dx)}:y=${fx(dy)}:format=rgb[sd${id}]`);
      filters.push(`[sd${id}][sa${id}]overlay=format=rgb[so${id}]`);
      cur = `so${id}`;
    } else if (e.type === 'glow') {
      const sigma = Math.max(0.5, clamp(e.radius, 0, 0.2) * short);
      filters.push(`[${cur}]format=gbrap,split=2[ga${id}][gb${id}]`);
      filters.push(`[gb${id}]gblur=sigma=${fx(sigma)}[gg${id}]`);
      filters.push(`[ga${id}][gg${id}]blend=all_mode=screen:all_opacity=${fx(clamp(e.intensity, 0, 1))},format=rgba[go${id}]`);
      cur = `go${id}`;
    } else if (e.type === 'sweep') {
      const [r, g, b] = rgb(e.color);
      const sw = sweepAt(e, 0, W, H);
      const start = Number(e.start) || 0;
      const d = Math.max(0.05, Number(e.duration) || 1);
      const pos = `(${fx(sw.dmin - sw.w)}+${fx(sw.dmax - sw.dmin + 2 * sw.w)}*clip((T-${fx(start)})/${fx(d)},0,1))`;
      const I = `${fx(clamp(e.intensity, 0, 2))}*max(0,1-abs(X*${fx(sw.c)}+Y*${fx(sw.s)}-${pos})/${fx(sw.w)})`;
      const ch = (n, v) => `min(255,${n}(X,Y)+${v}*${I})`;
      filters.push(`[${cur}]format=gbrap,geq=r='${ch('r', r)}':g='${ch('g', g)}':b='${ch('b', b)}':a='alpha(X,Y)':enable='between(t,${fx(start)},${fx(start + d)})',format=rgba[wo${id}]`);
      cur = `wo${id}`;
    } else if (e.type === 'gradient') {
      const P = (v, n) => Math.round(clamp(v, 0, 1) * n);
      filters.push(`gradients=s=${W}x${H}:r=${FPS}:d=${fx(dur)}:c0=${hex0x(e.c0)}:c1=${hex0x(e.c1)}:x0=${P(e.x0, W)}:y0=${P(e.y0, H)}:x1=${P(e.x1, W)}:y1=${P(e.y1, H)}:nb_colors=2:speed=0:type=linear,format=rgba,colorchannelmixer=aa=${fx(clamp(e.opacity, 0, 1))}[gr${id}]`);
      filters.push(`[${cur}]split=2[ra${id}][rb${id}]`, `[rb${id}]alphaextract[rl${id}]`);
      filters.push(`[ra${id}][gr${id}]overlay=format=rgb[ro${id}]`, `[ro${id}][rl${id}]alphamerge[rm${id}]`);
      cur = `rm${id}`;
    }
  });
  const m = c.matte;
  if (m) {
    const id = `${tag}_m`;
    let made = false;
    if (m.kind === 'text' && String(m.text || '').trim()) {
      const font = fontFile?.(m.font || MATTE_FONT);
      if (font) {
        const n = files.length;
        files.push({ name: `matte${n}.txt`, content: String(m.text) }, { name: `mattefont${n}${font.slice(font.lastIndexOf('.'))}`, from: font });
        const b = textMatteBox(m, W, H);
        // Vertical centre of the line box at cy, like the preview (ascent/descent of the font).
        filters.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${fx(dur)},format=gray,drawtext=fontfile=mattefont${n}${font.slice(font.lastIndexOf('.'))}:textfile=matte${n}.txt:fontsize=${fx(b.px)}:fontcolor=white:x=${fx(b.cx)}-text_w/2:y=${fx(b.cy)}-(ascent-descent)/2${m.invert ? ',negate' : ''}[mk${id}]`);
        made = true;
      }
    } else if (m.kind === 'media') {
      const mm = media.get(m.mediaId);
      if (mm && mm.kind !== 'audio') {
        const k = addInput(mm.path, mm.kind, dur);
        const pick = m.mode === 'alpha' ? 'format=rgba,alphaextract' : 'format=gray';
        filters.push(`[${k}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,setpts=PTS-STARTPTS,trim=duration=${fx(dur)},${pick}${m.invert ? ',negate' : ''}[mk${id}]`);
        made = true;
      }
    }
    if (made) {
      // Keep the layer's own alpha too: new alpha = layer alpha x matte.
      filters.push(`[${cur}]split=2[ma${id}][mb${id}]`, `[mb${id}]alphaextract[ml${id}]`);
      filters.push(`[ml${id}][mk${id}]blend=all_mode=multiply[mx${id}]`, `[ma${id}][mx${id}]alphamerge[mo${id}]`);
      cur = `mo${id}`;
    }
  }
  return cur;
}
