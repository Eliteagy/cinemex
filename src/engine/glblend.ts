// Blend modes in the preview on the GPU: the backdrop (the canvas so far) and the clip layer go through
// the same formulas as the export's ffmpeg `blend all_expr` (src/lib/blend.js, checked by
// test/blend.test.mjs). Result = mix(backdrop, blend(backdrop, clip), clip alpha), like the export's
// blend -> alphamerge -> overlay.

import { BLENDS } from '../lib/blend.js';
import { BLENDIF_GLSL, CTA_GLSL, cleanBlendIf, cleanColorToAlpha } from '../lib/pslayer.js';

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const fs = (expr: string) => `#version 300 es
precision highp float;
uniform sampler2D base;
uniform sampler2D top;
uniform bool bifOn;
uniform vec4 bifT;
uniform vec4 bifU;
in vec2 uv;
out vec4 o;
${BLENDIF_GLSL}
vec3 burn(vec3 a, vec3 b) { return mix(mix(1.0 - min(vec3(1.0), (1.0 - a) / max(b, vec3(1e-6))), vec3(0.0), step(b, vec3(0.0))), vec3(1.0), step(vec3(1.0), a)); }
vec3 dodge(vec3 a, vec3 b) { return mix(mix(min(vec3(1.0), a / max(1.0 - b, vec3(1e-6))), vec3(1.0), step(vec3(1.0), b)), vec3(0.0), step(a, vec3(0.0))); }
vec3 softD(vec3 a) { return mix(((16.0 * a - 12.0) * a + 4.0) * a, sqrt(a), step(0.2500001, a)); }
void main() {
  vec4 B4 = texture(base, uv);
  vec4 T4 = texture(top, uv);
  vec3 a = B4.a > 0.0 ? B4.rgb / B4.a : vec3(0.0);
  vec3 b = T4.a > 0.0 ? T4.rgb / T4.a : vec3(0.0);
  vec3 r = clamp(${expr}, 0.0, 1.0);
  // Blend If: the layer's alpha × the grey ranges of the layer (this) and the backdrop (under).
  float ta = T4.a * (bifOn ? bifW(bifT, bifLuma(b)) * bifW(bifU, bifLuma(a)) : 1.0);
  vec3 c = mix(a, r, ta);
  float al = max(B4.a, ta);
  o = vec4(c * al, al);
}`;

class BlendGL {
  canvas = document.createElement('canvas');
  gl: WebGL2RenderingContext | null;
  progs = new Map<string, WebGLProgram>();
  tex: WebGLTexture[] = [];
  /** 2D canvas the clip layer is drawn into (same transforms as a direct composite). */
  layer = document.createElement('canvas');
  failed = false;

  constructor() {
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!this.gl) {
      this.failed = true;
      return;
    }
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.push(t);
    }
  }

  prog(mode: string): WebGLProgram | null {
    const gl = this.gl!;
    const hit = this.progs.get(mode);
    if (hit) return hit;
    const m = mode === 'normal' ? { glsl: 'b' } : BLENDS[mode as keyof typeof BLENDS];
    if (!m) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${mode}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs(m.glsl)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    this.progs.set(mode, p);
    return p;
  }

  /** A cleared 2D context of the canvas size to draw the clip layer into. */
  target(w: number, h: number): CanvasRenderingContext2D {
    if (this.layer.width !== w || this.layer.height !== h) {
      this.layer.width = w;
      this.layer.height = h;
    }
    const x = this.layer.getContext('2d')!;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, w, h);
    return x;
  }

  /** Blends the layer drawn with target() over `dst` (in place). False when the GPU path is unavailable. */
  composite(dst: CanvasRenderingContext2D, mode: string, blendIf?: unknown): boolean {
    if (this.failed || !this.gl) return false;
    const gl = this.gl;
    try {
      const p = this.prog(mode);
      if (!p) return false;
      const W = dst.canvas.width;
      const H = dst.canvas.height;
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      gl.viewport(0, 0, W, H);
      gl.useProgram(p);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const srcs = [dst.canvas, this.layer];
      srcs.forEach((s, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[i] ?? null);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s);
      });
      gl.uniform1i(gl.getUniformLocation(p, 'base'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'top'), 1);
      const bif = cleanBlendIf(blendIf);
      gl.uniform1i(gl.getUniformLocation(p, 'bifOn'), bif ? 1 : 0);
      if (bif) {
        gl.uniform4f(gl.getUniformLocation(p, 'bifT'), ...bif.this);
        gl.uniform4f(gl.getUniformLocation(p, 'bifU'), ...bif.under);
      }
      const loc = gl.getAttribLocation(p, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      dst.save();
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.globalAlpha = 1;
      dst.globalCompositeOperation = 'copy';
      dst.drawImage(this.canvas, 0, 0);
      dst.restore();
      return true;
    } catch (e) {
      console.warn('[glblend]', e);
      this.failed = true;
      return false;
    }
  }
}

const CTA_FS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec3 key;
uniform float thr;
in vec2 uv;
out vec4 o;
${CTA_GLSL}
void main() {
  vec4 s = texture(src, uv);
  vec3 p = s.a > 0.0 ? clamp(s.rgb / s.a, 0.0, 1.0) : vec3(0.0);
  vec4 q = colorToAlpha(p, key, thr);
  float al = s.a * q.a;
  o = vec4(q.rgb * al, al);
}`;

/** Color to Alpha on a layer canvas, in place (src/lib/pslayer.js). False when WebGL is unavailable. */
export function colorToAlphaGL(layer: HTMLCanvasElement, cta: unknown): boolean {
  const c = cleanColorToAlpha(cta);
  const g = blendGL();
  if (!c || g.failed || !g.gl) return false;
  const gl = g.gl;
  try {
    let p = g.progs.get('__cta');
    if (!p) {
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`cta: ${gl.getShaderInfoLog(s)}`);
        return s;
      };
      p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, CTA_FS));
      gl.linkProgram(p);
      g.progs.set('__cta', p);
    }
    const W = layer.width;
    const H = layer.height;
    if (g.canvas.width !== W || g.canvas.height !== H) {
      g.canvas.width = W;
      g.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.useProgram(p);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.tex[0] ?? null);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer);
    gl.uniform1i(gl.getUniformLocation(p, 'src'), 0);
    gl.uniform3f(gl.getUniformLocation(p, 'key'), ...c.color);
    gl.uniform1f(gl.getUniformLocation(p, 'thr'), c.threshold);
    const loc = gl.getAttribLocation(p, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const x = layer.getContext('2d')!;
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'copy';
    x.drawImage(g.canvas, 0, 0);
    x.restore();
    return true;
  } catch (e) {
    console.warn('[glblend cta]', e);
    return false;
  }
}

let shared: BlendGL | null = null;
export function blendGL(): BlendGL {
  if (!shared) shared = new BlendGL();
  return shared;
}
