// "Detalhe" in the preview on the GPU (WebGL2 passes on the clip's frame, before the colour LUT):
// dehaze, local highlights/shadows, clarity, texture and sharpening, with the same formulas and the
// same spatial sizes (fractions of the long edge) as the export's ffmpeg graph (src/lib/detail.js).
// Grain is drawn after the LUT, in glcolor.ts (GRAIN_GLSL below).
//
// Textures here keep the image's top row at t = 0 (like the uploaded frame): the passes use a
// vertex shader without the flip, only the final draw to the canvas (glcolor.ts) flips.

import { detailParams, hasDetail, L_MIN, L_SPAN, GREY } from '../lib/detail.js';

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
float lin(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
vec3 lin3(vec3 v) { return vec3(lin(v.r), lin(v.g), lin(v.b)); }
float enc(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(max(v, 0.0), 1.0 / 2.4) - 0.055; }
vec3 enc3(vec3 v) { return vec3(enc(v.r), enc(v.g), enc(v.b)); }
float smooth1(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// Straight RGB of a texel (pm = the texture holds premultiplied colour).
vec4 straight(sampler2D t, vec2 c, bool pm) { vec4 v = texture(t, c); if (pm) v.rgb = v.a > 0.0 ? clamp(v.rgb / v.a, 0.0, 1.0) : vec3(0.0); return v; }
`;

const FS = {
  /** Linear minimum channel (the dark channel before its blur). */
  minc: `${COMMON}
uniform sampler2D src; uniform bool pm;
void main() { vec3 c = straight(src, uv, pm).rgb; o = vec4(lin(min(c.r, min(c.g, c.b))), 0.0, 0.0, 1.0); }`,
  /** Dehaze with the blurred dark channel; writes straight RGB. */
  dehaze: `${COMMON}
uniform sampler2D src; uniform sampler2D dark; uniform bool pm; uniform float d; uniform float air;
void main() {
  vec4 c = straight(src, uv, pm);
  vec3 v = lin3(c.rgb);
  float veil = clamp(min(texture(dark, uv).r, min(v.r, min(v.g, v.b))) / air, 0.0, 1.0);
  if (d > 0.0) {
    float t = max(1.0 - 0.95 * min(d, 1.0) * veil, 0.12);
    v = max((v - air * (1.0 - t)) / t, 0.0);
  } else {
    float k = min(-d, 1.0) * 0.7 * (0.35 + 0.65 * veil);
    v = v + (air * 0.9 - v) * k;
  }
  o = vec4(clamp(enc3(v), 0.0, 1.0), c.a);
}`,
  /** Encoded log luminance. */
  luma: `${COMMON}
uniform sampler2D src; uniform bool pm;
void main() {
  vec3 c = straight(src, uv, pm).rgb;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float L = log2(max(lin(y), 1e-7) / ${GREY.toFixed(2)});
  o = vec4(clamp((L - (${L_MIN.toFixed(1)})) / ${L_SPAN.toFixed(1)}, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,
  /** Guided filter input at the subsampled size: (I, I²). */
  down2: `${COMMON}
uniform sampler2D src;
void main() { float i = texture(src, uv).r; o = vec4(i, i * i, 0.0, 1.0); }`,
  /** Copy (downsampling with the linear filter). */
  copy: `${COMMON}
uniform sampler2D src;
void main() { o = texture(src, uv); }`,
  /** Box mean of radius r along dir (r ≤ 20, like ffmpeg's guided). */
  box: `${COMMON}
uniform sampler2D src; uniform vec2 step; uniform int r;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -20; i <= 20; i++) { if (i < -r || i > r) continue; s += texture(src, uv + step * float(i)); }
  o = s / float(2 * r + 1);
}`,
  /** Gaussian along dir (σ in texels of src, radius ≤ 3σ ≤ 32). */
  gauss: `${COMMON}
uniform sampler2D src; uniform vec2 step; uniform float sigma;
void main() {
  int r = int(min(32.0, ceil(3.0 * sigma)));
  vec4 s = vec4(0.0); float w = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (i < -r || i > r) continue;
    float k = exp(-float(i * i) / (2.0 * sigma * sigma));
    s += k * texture(src, uv + step * float(i)); w += k;
  }
  o = s / w;
}`,
  /** Guided filter coefficients from the box means (mI, mII). */
  ab: `${COMMON}
uniform sampler2D src; uniform float eps;
void main() { vec2 m = texture(src, uv).rg; float v = max(m.y - m.x * m.x, 0.0); float a = v / (v + eps); o = vec4(a, m.x - a * m.x, 0.0, 1.0); }`,
  /** Local tone + clarity + texture + sharpening as one luminance gain; writes premultiplied RGB for the LUT. */
  combine: `${COMMON}
uniform sampler2D src; uniform bool pm;
uniform sampler2D lum; uniform sampler2D ghs; uniform sampler2D gcl; uniform sampler2D btx; uniform sampler2D bsh;
uniform float hl; uniform float sh; uniform float clar; uniform float tex; uniform float sharp; uniform float slimit; uniform float smask;
const float SPAN = ${L_SPAN.toFixed(1)};
void main() {
  vec4 c = straight(src, uv, pm);
  float Le = texture(lum, uv).r;
  float delta = 0.0;
  if (hl != 0.0 || sh != 0.0 || clar != 0.0) {
    vec2 g = texture(ghs, uv).rg;
    float base = (g.x * Le + g.y) * SPAN + (${L_MIN.toFixed(1)});
    float sw = 1.0 - smooth1(-4.8, 0.3, base);
    float hw = smooth1(-1.0, 2.8, base);
    delta += sh * 1.7 * sw * sqrt(sw) + hl * 1.7 * hw;
    if (clar != 0.0) {
      vec2 gc = texture(gcl, uv).rg;
      float d = clamp((Le - (gc.x * Le + gc.y)) * SPAN, -2.5, 2.5);
      delta += clar * 0.85 * d * (0.35 + 0.65 * exp(-pow(base / 3.2, 2.0)));
    }
  }
  if (tex != 0.0) {
    float d = (Le - texture(btx, uv).r) * SPAN;
    delta += tex * 1.1 * clamp(d, -1.0, 1.0) * (1.0 - 0.6 * smooth1(0.4, 1.6, abs(d)));
  }
  if (sharp != 0.0) {
    float d = (Le - texture(bsh, uv).r) * SPAN;
    float m = smask > 0.0 ? smooth1(smask * 0.1, smask * 0.1 + 0.06, abs(d)) : 1.0;
    delta += sharp * 7.0 * m * d / (1.0 + abs(d) / slimit);
  }
  vec3 rgb = clamp(enc3(lin3(c.rgb) * exp2(delta)), 0.0, 1.0);
  o = vec4(rgb * c.a, c.a);
}`,
};

/** Film grain after the LUT (value noise with LightCraft's hash, finish.rs grain_noise). Used in glcolor.ts. */
export const GRAIN_GLSL = `
uniform float gAmt; uniform float gCell; uniform float gRough; uniform uint gSeed;
float gHash(int i, int j, uint seed) {
  uint v = (uint(i) * 0x8da6b343u) ^ (uint(j) * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  v ^= v >> 13u; v *= 0x5bd1e995u; v ^= v >> 15u;
  return float(v & 0xffffu) / 32768.0 - 1.0;
}
float gNoise(vec2 p, uint seed) {
  vec2 f0 = floor(p); vec2 f = p - f0; ivec2 i = ivec2(f0);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mix(gHash(i.x, i.y, seed), gHash(i.x + 1, i.y, seed), u.x);
  float b = mix(gHash(i.x, i.y + 1, seed), gHash(i.x + 1, i.y + 1, seed), u.x);
  return mix(a, b, u.y);
}
vec3 grain(vec3 c, vec2 px) {
  if (gAmt <= 0.0) return c;
  float v = gNoise(px / gCell, gSeed) * (1.0 - 0.5 * gRough) + gNoise(2.3 * px / gCell, gSeed ^ 0x55u) * 0.7 * gRough;
  return clamp(c + gAmt * v * (0.35 + 2.6 * c * (1.0 - c)), 0.0, 1.0);
}`;

type RT = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };

export class DetailGL {
  private progs = new Map<string, WebGLProgram>();
  private rts = new Map<string, RT>();
  private buf: WebGLBuffer;
  private float: boolean;

  constructor(private gl: WebGL2RenderingContext) {
    this.float = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }

  private prog(name: keyof typeof FS): WebGLProgram {
    const hit = this.progs.get(name);
    if (hit) return hit;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS[name]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    this.progs.set(name, p);
    return p;
  }

  /** A render target kept between frames (re-created when the size changes). */
  private rt(name: string, w: number, h: number): RT {
    const gl = this.gl;
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    const hit = this.rts.get(name);
    if (hit && hit.w === W && hit.h === H) return hit;
    if (hit) {
      gl.deleteTexture(hit.tex);
      gl.deleteFramebuffer(hit.fb);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of <[number, number][]>[[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const r = { tex, fb, w: W, h: H };
    this.rts.set(name, r);
    return r;
  }

  /** Runs one pass into `out`. tex: sampler name -> texture (units in order); u: uniforms. */
  private pass(name: keyof typeof FS, out: RT, tex: Record<string, WebGLTexture>, u: Record<string, number | boolean | [number, number]> = {}) {
    const gl = this.gl;
    const p = this.prog(name);
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, out.w, out.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const loc = gl.getAttribLocation(p, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    Object.entries(tex).forEach(([k, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, k), i);
    });
    for (const [k, v] of Object.entries(u)) {
      const l = gl.getUniformLocation(p, k);
      if (Array.isArray(v)) gl.uniform2f(l, v[0], v[1]);
      else if (typeof v === 'boolean') gl.uniform1i(l, v ? 1 : 0);
      else if (k === 'r') gl.uniform1i(l, v);
      else gl.uniform1f(l, v);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Separable Gaussian of `src` (W×H) with σ px; large σ runs on a smaller copy. */
  private gauss(name: string, src: WebGLTexture, W: number, H: number, sigma: number): WebGLTexture {
    const f = Math.max(1, Math.ceil(sigma / 8));
    const w = W / f;
    const h = H / f;
    let input = src;
    if (f > 1) {
      const d = this.rt(`${name}.d`, w, h);
      this.pass('copy', d, { src });
      input = d.tex;
    }
    const s = Math.max(0.3, sigma / f);
    const a = this.rt(`${name}.x`, w, h);
    this.pass('gauss', a, { src: input }, { step: [1 / Math.round(w), 0], sigma: s });
    const b = this.rt(`${name}.y`, w, h);
    this.pass('gauss', b, { src: a.tex }, { step: [0, 1 / Math.round(h)], sigma: s });
    return b.tex;
  }

  /** Fast guided filter of the encoded luminance: texture of (mean a, mean b) at the subsampled size. */
  private guided(name: string, lum: WebGLTexture, W: number, H: number, g: { sub: number; r: number; eps: number }): WebGLTexture {
    const w = W / g.sub;
    const h = H / g.sub;
    const sx: [number, number] = [1 / Math.round(w), 0];
    const sy: [number, number] = [0, 1 / Math.round(h)];
    const i2 = this.rt(`${name}.i`, w, h);
    this.pass('down2', i2, { src: lum });
    const t1 = this.rt(`${name}.t1`, w, h);
    const t2 = this.rt(`${name}.t2`, w, h);
    this.pass('box', t1, { src: i2.tex }, { step: sx, r: g.r });
    this.pass('box', t2, { src: t1.tex }, { step: sy, r: g.r });
    this.pass('ab', i2, { src: t2.tex }, { eps: g.eps });
    this.pass('box', t1, { src: i2.tex }, { step: sx, r: g.r });
    this.pass('box', t2, { src: t1.tex }, { step: sy, r: g.r });
    return t2.tex;
  }

  /**
   * Runs the detail passes on `src` (the uploaded frame, premultiplied, W×H). `long` = the canvas's
   * long edge in this texture's pixels (the export's long edge). Returns the processed texture
   * (premultiplied), or null when nothing is on.
   */
  run(src: WebGLTexture, W: number, H: number, color: unknown, long: number): WebGLTexture | null {
    if (!hasDetail(color as never)) return null;
    const gl = this.gl;
    const p = detailParams(color as never, long);
    let rgb = src;
    let pm = true;
    if (p.dehaze !== 0) {
      const m = this.rt('minc', W, H);
      this.pass('minc', m, { src }, { pm: true });
      const dark = this.gauss('dark', m.tex, W, H, p.darkSigma);
      const out = this.rt('dehaze', W, H);
      this.pass('dehaze', out, { src, dark }, { pm: true, d: p.dehaze, air: p.air });
      rgb = out.tex;
      pm = false;
    }
    const lum = this.rt('lum', W, H);
    this.pass('luma', lum, { src: rgb }, { pm });
    const hsOn = p.hl !== 0 || p.sh !== 0 || p.clar !== 0;
    const ghs = hsOn ? this.guided('ghs', lum.tex, W, H, p.hs) : lum.tex;
    const gcl = p.clar !== 0 ? this.guided('gcl', lum.tex, W, H, p.clarG) : lum.tex;
    const btx = p.tex !== 0 ? this.gauss('btx', lum.tex, W, H, p.texSigma) : lum.tex;
    const bsh = p.sharp !== 0 ? this.gauss('bsh', lum.tex, W, H, p.sharpSigma) : lum.tex;
    const out = this.rt('out', W, H);
    this.pass('combine', out, { src: rgb, lum: lum.tex, ghs, gcl, btx, bsh }, { pm, hl: p.hl, sh: p.sh, clar: p.clar, tex: p.tex, sharp: p.sharp, slimit: p.sharpLimit, smask: p.sharpMask });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out.tex;
  }
}
