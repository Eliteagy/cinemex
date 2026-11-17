// Fusion in the preview: evaluates a clip's node graph on canvases. Every node uses the same
// numbers as the export (electron/render.cjs fusionChain). Sizes are fractions of the frame's
// shorter side, positions fractions of the frame.
import nodesJson from '../lib/fusion-nodes.json';
import { gradeMath } from '../lib/project';
import { flareRGB, galleryMaxSigma, irisWeight, levelWeights, relightFactor, relightJS, relightParams, tiltWeight, LUMA709 } from '../lib/fusionfx.js';
import type { FNode, FNodeType, Fusion } from '../types';

export interface ParamSpec {
  label: string;
  type: 'number' | 'color' | 'select' | 'bool' | 'media';
  min?: number;
  max?: number;
  step?: number;
  default: number | string | boolean;
  options?: Record<string, string>;
}
export interface NodeSpec {
  label: string;
  group: 'io' | 'gerar' | 'compor' | 'efeitos';
  inputs: string[];
  params: Record<string, ParamSpec>;
}
export const NODES = Object.fromEntries(Object.entries(nodesJson).filter(([k]) => k !== '_comment')) as unknown as Record<FNodeType, NodeSpec>;

export const param = (n: FNode, k: string) => n.p[k] ?? NODES[n.type].params[k]?.default;
const num = (n: FNode, k: string) => Number(param(n, k));

/** A graph only matters when it does more than In -> Out. */
export function hasFusion(f?: Fusion) {
  return Boolean(f && f.nodes.some((n) => n.type !== 'mediaIn' && n.type !== 'mediaOut'));
}

/** Input of `node` at `port` (node id or null). */
export const inputOf = (f: Fusion, node: string, port: number) => f.links.find((l) => l.to === node && l.port === port)?.from ?? null;

function rgbOf(hex: string): [number, number, number] {
  const h = String(hex).replace('#', '').padEnd(6, '0');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export interface FusionEnv {
  w: number;
  h: number;
  /** Seconds from the clip start. */
  local: number;
  /** The clip's framed image (MediaIn). */
  input: HTMLCanvasElement;
  /** Frame of another media for a Media node (null while loading). */
  media(node: FNode, mediaId: string): CanvasImageSource | null;
  mediaSize(node: FNode, mediaId: string): { w: number; h: number } | null;
}

/** Static pictures (blur masks, flares) kept by their parameters and size. */
const statics = new Map<string, HTMLCanvasElement>();
function staticCanvas(key: string, w: number, h: number, paint: (img: ImageData) => void): HTMLCanvasElement {
  const hit = statics.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  const img = x.createImageData(w, h);
  paint(img);
  x.putImageData(img, 0, 0);
  if (statics.size > 16) statics.delete(statics.keys().next().value as string);
  statics.set(key, c);
  return c;
}

/** Gaussian-like blur (three box passes, edges clamped like ffmpeg's gblur) of a w × h plane, in place. */
function boxBlur3(a: Float32Array, w: number, h: number, sigma: number) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const tmp = new Float32Array(Math.max(w, h));
  const pass = (n: number, count: number, idx: (line: number, i: number) => number) => {
    for (let line = 0; line < count; line++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += a[idx(line, Math.max(0, Math.min(n - 1, i)))]!;
      for (let i = 0; i < n; i++) {
        tmp[i] = acc / (2 * r + 1);
        acc += a[idx(line, Math.min(n - 1, i + r + 1))]! - a[idx(line, Math.max(0, i - r))]!;
      }
      for (let i = 0; i < n; i++) a[idx(line, i)] = tmp[i]!;
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(w, h, (y, x) => y * w + x);
    pass(h, w, (x, y) => y * w + x);
  }
}

/** Evaluate the graph; returns the MediaOut image (or null if there is no Out). */
export function evalFusion(f: Fusion, env: FusionEnv, pool: Map<string, HTMLCanvasElement>): HTMLCanvasElement | null {
  const { w, h } = env;
  const short = Math.min(w, h);
  const memo = new Map<string, HTMLCanvasElement>();
  const surface = (key: string) => {
    let c = pool.get(key);
    if (!c) pool.set(key, (c = document.createElement('canvas')));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const x = c.getContext('2d', { willReadFrequently: key.endsWith(':chroma') || f.nodes.some((nn) => nn.id === key && nn.type === 'relight') })!;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
    x.filter = 'none';
    x.clearRect(0, 0, w, h);
    return { c, x };
  };
  const empty = () => surface('__empty').c;

  const run = (id: string | null, depth = 0): HTMLCanvasElement => {
    if (!id || depth > 64) return empty();
    const hit = memo.get(id);
    if (hit) return hit;
    const n = f.nodes.find((x) => x.id === id);
    if (!n) return empty();
    const inp = (port: number) => run(inputOf(f, n.id, port), depth + 1);
    const { c, x } = surface(n.id);
    switch (n.type) {
      case 'mediaIn':
        x.drawImage(env.input, 0, 0);
        break;
      case 'mediaOut':
        x.drawImage(inp(0), 0, 0);
        break;
      case 'background':
        x.fillStyle = String(param(n, 'color'));
        x.fillRect(0, 0, w, h);
        break;
      case 'media': {
        const id2 = String(param(n, 'mediaId'));
        const src = id2 ? env.media(n, id2) : null;
        const size = id2 ? env.mediaSize(n, id2) : null;
        if (src && size && size.w && size.h) {
          const k = Math.max(w / size.w, h / size.h);
          x.drawImage(src, (w - size.w * k) / 2, (h - size.h * k) / 2, size.w * k, size.h * k);
        }
        break;
      }
      case 'merge': {
        x.drawImage(inp(0), 0, 0);
        const mode = String(param(n, 'mode'));
        x.globalCompositeOperation = mode === 'screen' ? 'screen' : mode === 'multiply' ? 'multiply' : mode === 'add' ? 'lighter' : 'source-over';
        x.globalAlpha = Math.max(0, Math.min(1, num(n, 'opacity')));
        x.drawImage(inp(1), 0, 0);
        break;
      }
      case 'transform': {
        const s = num(n, 'scale');
        x.translate(w / 2 + num(n, 'x') * w, h / 2 + num(n, 'y') * h);
        x.rotate((num(n, 'rotate') * Math.PI) / 180);
        x.scale(param(n, 'flip') === true ? -s : s, s);
        x.drawImage(inp(0), -w / 2, -h / 2);
        break;
      }
      case 'chroma': {
        x.drawImage(inp(0), 0, 0);
        const img = x.getImageData(0, 0, w, h);
        const d = img.data;
        const [kr, kg, kb] = rgbOf(String(param(n, 'key')));
        const ku = -0.169 * kr - 0.331 * kg + 0.5 * kb + 128;
        const kv = 0.5 * kr - 0.419 * kg - 0.081 * kb + 128;
        const sim = num(n, 'similarity');
        const blend = num(n, 'blend');
        for (let i = 0; i < d.length; i += 4) {
          const u = -0.169 * d[i]! - 0.331 * d[i + 1]! + 0.5 * d[i + 2]! + 128;
          const v = 0.5 * d[i]! - 0.419 * d[i + 1]! - 0.081 * d[i + 2]! + 128;
          const diff = Math.sqrt(((u - ku) ** 2 + (v - kv) ** 2) / (255 * 255 * 2));
          const a = blend > 0.0001 ? Math.max(0, Math.min(1, (diff - sim) / blend)) : diff > sim ? 1 : 0;
          d[i + 3] = Math.round(d[i + 3]! * a);
        }
        x.putImageData(img, 0, 0);
        break;
      }
      case 'blur':
        x.filter = `blur(${Math.max(0, num(n, 'size') * 0.03 * short)}px)`;
        x.drawImage(inp(0), 0, 0);
        break;
      case 'glow': {
        const src = inp(0);
        x.drawImage(src, 0, 0);
        x.globalCompositeOperation = 'screen';
        x.globalAlpha = Math.max(0, Math.min(1, num(n, 'amount')));
        x.filter = `blur(${num(n, 'size') * 0.05 * short}px)`;
        x.drawImage(src, 0, 0);
        break;
      }
      case 'color': {
        const g = gradeMath({ exposure: num(n, 'exposure'), contrast: num(n, 'contrast'), saturation: num(n, 'saturation'), temperature: num(n, 'temperature') });
        x.filter = `brightness(${g.bright}) contrast(${g.contrast}) saturate(${g.saturation})`;
        x.drawImage(inp(0), 0, 0);
        x.filter = 'none';
        if (g.warm.some((v) => Math.abs(v - 1) > 1e-3)) {
          x.globalCompositeOperation = 'multiply';
          x.fillStyle = `rgb(${g.warm.map((v) => Math.round(v * 255)).join(',')})`;
          x.fillRect(0, 0, w, h);
          x.globalCompositeOperation = 'destination-in';
          x.drawImage(inp(0), 0, 0);
        }
        break;
      }
      case 'grain': {
        x.drawImage(inp(0), 0, 0);
        const a = num(n, 'amount');
        if (a > 0) {
          const { c: nc, x: nx } = surface(`${n.id}:noise`);
          const img = nx.createImageData(w, h);
          const d = img.data;
          const amp = a * 40;
          for (let i = 0; i < d.length; i += 4) {
            const v = 128 + (Math.random() * 2 - 1) * amp * 2;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
          }
          nx.putImageData(img, 0, 0);
          x.globalCompositeOperation = 'overlay';
          x.drawImage(nc, 0, 0);
          x.globalCompositeOperation = 'destination-in';
          x.drawImage(inp(0), 0, 0);
        }
        break;
      }
      case 'tiltshift':
      case 'irisblur': {
        // Three levels (sharp, σmax/2, σmax) mixed by the weight masks, like the export's maskedmerge.
        const src = inp(0);
        x.drawImage(src, 0, 0);
        const p = Object.fromEntries(Object.keys(NODES[n.type].params).map((k) => [k, param(n, k)]));
        const smax = galleryMaxSigma(p.blur as number, short);
        if (smax < 0.3) break;
        const weight = n.type === 'tiltshift' ? tiltWeight : irisWeight;
        [smax / 2, smax].forEach((sigma, lvl) => {
          const mask = staticCanvas(`${n.type}:${lvl}:${w}x${h}:${JSON.stringify(p)}`, w, h, (img) => {
            const d = img.data;
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
              const m = levelWeights(weight(xx + 0.5, yy + 0.5, w, h, p))[lvl]!;
              d[(yy * w + xx) * 4 + 3] = Math.round(m * 255);
            }
          });
          const { c: bc, x: bx } = surface(`${n.id}:l${lvl}`);
          bx.filter = `blur(${Math.max(0.3, sigma)}px)`;
          bx.drawImage(src, 0, 0);
          bx.filter = 'none';
          bx.globalCompositeOperation = 'destination-in';
          bx.drawImage(mask, 0, 0);
          x.drawImage(bc, 0, 0);
        });
        break;
      }
      case 'lensflare': {
        const src = inp(0);
        x.drawImage(src, 0, 0);
        const p = Object.fromEntries(Object.keys(NODES[n.type].params).map((k) => [k, param(n, k)]));
        // The flare is drawn at half size and scaled up (it is smooth); same function as the export.
        const fw = Math.max(2, Math.round(w / 2));
        const fh = Math.max(2, Math.round(h / 2));
        const flare = staticCanvas(`flare:${fw}x${fh}:${JSON.stringify(p)}`, fw, fh, (img) => {
          const d = img.data;
          for (let yy = 0; yy < fh; yy++) for (let xx = 0; xx < fw; xx++) {
            const v = flareRGB(xx + 0.5, yy + 0.5, fw, fh, p);
            const o = (yy * fw + xx) * 4;
            d[o] = v[0]! * 255;
            d[o + 1] = v[1]! * 255;
            d[o + 2] = v[2]! * 255;
            d[o + 3] = 255;
          }
        });
        x.globalCompositeOperation = 'screen';
        x.drawImage(flare, 0, 0, w, h);
        // keep the input's transparency (export: alpha plane taken from the input)
        x.globalCompositeOperation = 'destination-in';
        x.drawImage(src, 0, 0);
        break;
      }
      case 'relight': {
        const src = inp(0);
        x.drawImage(src, 0, 0);
        const p = Object.fromEntries(Object.keys(NODES[n.type].params).map((k) => [k, param(n, k)]));
        const q = relightParams(p, short);
        const img = x.getImageData(0, 0, w, h);
        const d = img.data;
        const S = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) S[i] = (LUMA709[0]! * d[i * 4]! + LUMA709[1]! * d[i * 4 + 1]! + LUMA709[2]! * d[i * 4 + 2]!) / 255;
        boxBlur3(S, w, h, q.sigma);
        const at = (xx: number, yy: number) => S[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))]!;
        const k = q.k;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
          const F = relightFactor(at(xx, yy), at(xx - k, yy), at(xx + k, yy), at(xx, yy - k), at(xx, yy + k), q);
          const o = (yy * w + xx) * 4;
          for (let ch = 0; ch < 3; ch++) d[o + ch] = Math.round(255 * relightJS(d[o + ch]! / 255, F, ch, q));
        }
        x.putImageData(img, 0, 0);
        break;
      }
      case 'letterbox': {
        x.drawImage(inp(0), 0, 0);
        const bar = Math.round(Math.max(0, (h - w / Math.max(1, num(n, 'ratio'))) / 2));
        if (bar > 0) {
          x.fillStyle = '#000';
          x.fillRect(0, 0, w, bar);
          x.fillRect(0, h - bar, w, bar);
        }
        break;
      }
    }
    memo.set(id, c);
    return c;
  };
  const out = f.nodes.find((n) => n.type === 'mediaOut');
  return out ? run(out.id) : null;
}
