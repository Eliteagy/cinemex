// Fusion in the preview: evaluates a clip's node graph on canvases. Every node uses the same
// numbers as the export (electron/render.cjs fusionChain). Sizes are fractions of the frame's
// shorter side, positions fractions of the frame.
import nodesJson from '../lib/fusion-nodes.json';
import { gradeMath } from '../lib/project';
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
    const x = c.getContext('2d', { willReadFrequently: key.endsWith(':chroma') })!;
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
