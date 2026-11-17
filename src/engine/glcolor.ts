// Colour grade on the GPU for the preview: the clip's frame goes through the same 3D LUT the export
// writes as a .cube (src/lib/develop.js bakeLut), so preview and export match by construction.
// One shared WebGL2 canvas: each graded clip is drawn into it and copied out at once with drawImage.

import { bakeLut, isIdentityDev, parseCube } from '../lib/develop.js';
import { mediaUrl } from '../lib/project';
import type { Grade } from '../types';

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D img;
uniform sampler3D lut;
uniform float n;
in vec2 uv;
out vec4 o;
void main() {
  vec4 c = texture(img, uv);
  vec3 rgb = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  // Texel centres: 0 -> 0.5/n, 1 -> 1 - 0.5/n (hardware trilinear, like lut3d=interp=trilinear).
  vec3 g = texture(lut, rgb * ((n - 1.0) / n) + 0.5 / n).rgb;
  o = vec4(g * c.a, c.a);
}`;

/** LUT size for the preview (the export bakes 65³ from the same function). */
export const PREVIEW_N = 33;

type Baked = { key: string; tex: WebGLTexture };

/** The colour settings that go into the LUT (vignette is drawn separately, lut is the user's .cube). */
export function lutKey(color: Grade | undefined, cube: string | null): string {
  if (!color) return '';
  const { vignette: _v, ...rest } = color as Grade & Record<string, unknown>;
  return JSON.stringify(rest) + (cube ? `|${cube.length}:${cube.slice(0, 64)}` : '');
}

/** True when the clip's colour changes pixels (develop settings, legacy sliders or a .cube). */
export function needsLut(color: Grade | undefined): boolean {
  if (!color) return false;
  return !isIdentityDev(color as never) || Boolean(color.lut && /\.cube$/i.test(color.lut));
}

class ColorGL {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null;
  prog: WebGLProgram | null = null;
  img: WebGLTexture | null = null;
  luts = new Map<string, Baked>();
  cubes = new Map<string, string | null | 'loading'>();
  failed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!this.gl) {
      this.failed = true;
      return;
    }
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    this.prog = p;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.img = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** The user's .cube text (fetched once through ec-media; null while loading or when it fails). */
  cube(path: string | undefined, onReady: () => void): string | null | undefined {
    if (!path || !/\.cube$/i.test(path)) return undefined;
    const c = this.cubes.get(path);
    if (c === 'loading') return null;
    if (c !== undefined) return c;
    this.cubes.set(path, 'loading');
    fetch(mediaUrl(path))
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null)
      .then((t) => {
        this.cubes.set(path, t);
        onReady();
      });
    return null;
  }

  lut(color: Grade, cubeText: string | null | undefined): Baked | null {
    const gl = this.gl!;
    const key = lutKey(color, cubeText ?? null);
    const hit = this.luts.get(key);
    if (hit) return hit;
    let user = null;
    if (cubeText) {
      try {
        user = parseCube(cubeText);
      } catch {
        user = null;
      }
    }
    const N = PREVIEW_N;
    const data = bakeLut(color as never, N, user ?? undefined);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // RGB16F is filterable in WebGL2 core (32-bit float filtering needs an extension).
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, N, N, N, 0, gl.RGB, gl.FLOAT, data);
    for (const [k, v] of <[number, number][]>[[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    // Keep a handful: sliders being dragged bake many LUTs, old ones are freed.
    if (this.luts.size > 24) {
      const first = this.luts.keys().next().value as string;
      gl.deleteTexture(this.luts.get(first)!.tex);
      this.luts.delete(first);
    }
    const b = { key, tex };
    this.luts.set(key, b);
    return b;
  }

  /** Graded copy of `src` at w × h, or null when WebGL is unavailable (the caller draws the plain frame). */
  apply(src: TexImageSource, w: number, h: number, color: Grade, onReady: () => void): HTMLCanvasElement | null {
    if (this.failed || !this.gl) return null;
    const gl = this.gl;
    try {
      const cubeText = this.cube(color.lut, onReady);
      if (cubeText === null) return null;
      const lut = this.lut(color, cubeText);
      if (!lut) return null;
      const W = Math.max(1, Math.round(w));
      const H = Math.max(1, Math.round(h));
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lut.tex);
      gl.uniform1i(gl.getUniformLocation(this.prog!, 'img'), 0);
      gl.uniform1i(gl.getUniformLocation(this.prog!, 'lut'), 1);
      gl.uniform1f(gl.getUniformLocation(this.prog!, 'n'), PREVIEW_N);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.canvas;
    } catch (e) {
      console.warn('[glcolor]', e);
      this.failed = true;
      return null;
    }
  }
}

let shared: ColorGL | null = null;
/** The shared GPU grader (created on first use). */
export function colorGL(): ColorGL {
  if (!shared) shared = new ColorGL();
  return shared;
}
