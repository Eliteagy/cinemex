// Blend modes (Photoshop set, formulas from PhotoCraft crates/color/src/blend.rs; see
// docs/engenharia-reversa/photocraft.md §3.1). One table, three forms that must stay equal:
//   js    reference (tests),  glsl  preview (src/engine/glblend.ts),  ff  export (ffmpeg blend all_expr).
// a = backdrop (what is under the clip), b = the clip, both 0..1 per channel.
// The export never uses ffmpeg's own all_mode: burn/dodge/vividlight/linearlight there take the
// backdrop as the second input and softlight is not the W3C/Photoshop formula.

const C = (x) => Math.max(0, Math.min(1, x));
const burn = (a, b) => (a >= 1 ? 1 : b <= 0 ? 0 : 1 - Math.min(1, (1 - a) / b));
const dodge = (a, b) => (a <= 0 ? 0 : b >= 1 ? 1 : Math.min(1, a / (1 - b)));
const softD = (a) => (a <= 0.25 ? ((16 * a - 12) * a + 4) * a : Math.sqrt(a));

// ffmpeg pieces: A, B are 0..255 in gbrp; the expression works on a = ld(0), b = ld(1).
const A = 'ld(0)';
const B = 'ld(1)';
const ffBurn = (a, b) => `if(gte(${a},1),1,if(lte(${b},0),0,1-min(1,(1-${a})/(${b}))))`;
const ffDodge = (a, b) => `if(lte(${a},0),0,if(gte(${b},1),1,min(1,${a}/(1-(${b})))))`;
// GLSL helpers live in the shader (glblend.ts): burn(), dodge(), softD().

/** id -> { label, js(a,b), glsl (expression of a, b), ff (expression of ld(0), ld(1)) }. */
export const BLENDS = {
  multiply: { label: 'Multiplicar', js: (a, b) => a * b, glsl: 'a*b', ff: `${A}*${B}` },
  colorburn: { label: 'Superexposição de cor (Color Burn)', js: burn, glsl: 'burn(a,b)', ff: ffBurn(A, B) },
  linearburn: { label: 'Superexposição linear (Linear Burn)', js: (a, b) => Math.max(0, a + b - 1), glsl: 'max(vec3(0.0),a+b-1.0)', ff: `max(0,${A}+${B}-1)` },
  darken: { label: 'Escurecer', js: Math.min, glsl: 'min(a,b)', ff: `min(${A},${B})` },
  screen: { label: 'Ecrã (Screen)', js: (a, b) => a + b - a * b, glsl: 'a+b-a*b', ff: `${A}+${B}-${A}*${B}` },
  colordodge: { label: 'Subexposição de cor (Color Dodge)', js: dodge, glsl: 'dodge(a,b)', ff: ffDodge(A, B) },
  add: { label: 'Adicionar (Linear Dodge)', js: (a, b) => Math.min(1, a + b), glsl: 'min(vec3(1.0),a+b)', ff: `min(1,${A}+${B})` },
  lighten: { label: 'Clarear', js: Math.max, glsl: 'max(a,b)', ff: `max(${A},${B})` },
  overlay: {
    label: 'Sobrepor (Overlay)',
    js: (a, b) => (a <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
    glsl: 'mix(2.0*a*b, 1.0-2.0*(1.0-a)*(1.0-b), step(0.5000001,a))',
    ff: `if(lte(${A},0.5),2*${A}*${B},1-2*(1-${A})*(1-${B}))`,
  },
  softlight: {
    label: 'Luz suave (Soft Light)',
    js: (a, b) => (b <= 0.5 ? a - (1 - 2 * b) * a * (1 - a) : a + (2 * b - 1) * (softD(a) - a)),
    glsl: 'mix(a-(1.0-2.0*b)*a*(1.0-a), a+(2.0*b-1.0)*(softD(a)-a), step(0.5000001,b))',
    ff: `if(lte(${B},0.5),${A}-(1-2*${B})*${A}*(1-${A}),${A}+(2*${B}-1)*(if(lte(${A},0.25),((16*${A}-12)*${A}+4)*${A},sqrt(${A}))-${A}))`,
  },
  hardlight: {
    label: 'Luz forte (Hard Light)',
    js: (a, b) => (b <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
    glsl: 'mix(2.0*a*b, 1.0-2.0*(1.0-a)*(1.0-b), step(0.5000001,b))',
    ff: `if(lte(${B},0.5),2*${A}*${B},1-2*(1-${A})*(1-${B}))`,
  },
  vividlight: {
    label: 'Luz intensa (Vivid Light)',
    js: (a, b) => (b <= 0.5 ? burn(a, 2 * b) : dodge(a, 2 * b - 1)),
    glsl: 'mix(burn(a,2.0*b), dodge(a,2.0*b-1.0), step(0.5000001,b))',
    ff: `if(lte(${B},0.5),${ffBurn(A, `2*${B}`)},${ffDodge(A, `(2*${B}-1)`)})`,
  },
  linearlight: { label: 'Luz linear (Linear Light)', js: (a, b) => C(a + 2 * b - 1), glsl: 'clamp(a+2.0*b-1.0,0.0,1.0)', ff: `${A}+2*${B}-1` },
  pinlight: {
    label: 'Luz pontual (Pin Light)',
    js: (a, b) => (b <= 0.5 ? Math.min(a, 2 * b) : Math.max(a, 2 * b - 1)),
    glsl: 'mix(min(a,2.0*b), max(a,2.0*b-1.0), step(0.5000001,b))',
    ff: `if(lte(${B},0.5),min(${A},2*${B}),max(${A},2*${B}-1))`,
  },
  hardmix: { label: 'Mistura sólida (Hard Mix)', js: (a, b) => (a + b >= 1 - 1e-6 ? 1 : 0), glsl: 'step(0.999999,a+b)', ff: `gte(${A}+${B},0.999999)` },
  difference: { label: 'Diferença', js: (a, b) => Math.abs(a - b), glsl: 'abs(a-b)', ff: `abs(${A}-${B})` },
  exclusion: { label: 'Exclusão', js: (a, b) => a + b - 2 * a * b, glsl: 'a+b-2.0*a*b', ff: `${A}+${B}-2*${A}*${B}` },
  subtract: { label: 'Subtrair', js: (a, b) => Math.max(0, a - b), glsl: 'max(vec3(0.0),a-b)', ff: `max(0,${A}-${B})` },
  divide: {
    label: 'Dividir',
    js: (a, b) => (b <= 0 ? (a <= 0 ? 0 : 1) : Math.min(1, a / b)),
    glsl: 'mix(step(0.000001,a), min(vec3(1.0),a/max(b,vec3(0.000001))), step(0.000001,b))',
    ff: `if(lte(${B},0),gt(${A},0),min(1,${A}/${B}))`,
  },
  reflect: { label: 'Refletir', js: (a, b) => (b >= 1 ? 1 : Math.min(1, (a * a) / (1 - b))), glsl: 'mix(min(vec3(1.0),a*a/max(1.0-b,vec3(0.000001))), vec3(1.0), step(0.999999,b))', ff: `if(gte(${B},1),1,min(1,${A}*${A}/(1-${B})))` },
  glow: { label: 'Brilho (Glow)', js: (a, b) => (a >= 1 ? 1 : Math.min(1, (b * b) / (1 - a))), glsl: 'mix(min(vec3(1.0),b*b/max(1.0-a,vec3(0.000001))), vec3(1.0), step(0.999999,a))', ff: `if(gte(${A},1),1,min(1,${B}*${B}/(1-${A})))` },
  negation: { label: 'Negação', js: (a, b) => 1 - Math.abs(1 - a - b), glsl: '1.0-abs(1.0-a-b)', ff: `1-abs(1-${A}-${B})` },
};

/** Menu order (Photoshop groups); 'normal' first. */
export const BLEND_ORDER = ['normal', 'darken', 'multiply', 'colorburn', 'linearburn', 'lighten', 'screen', 'colordodge', 'add', 'overlay', 'softlight', 'hardlight', 'vividlight', 'linearlight', 'pinlight', 'hardmix', 'difference', 'exclusion', 'subtract', 'divide', 'reflect', 'glow', 'negation'];
export const BLEND_GROUP_BREAKS = new Set(['darken', 'lighten', 'overlay', 'difference', 'reflect']);

/** ffmpeg `blend` option for a mode on 8-bit gbrp planes (backdrop = first input). */
export function blendFF(mode) {
  const m = BLENDS[mode];
  if (!m) return null;
  return `all_expr='st(0,A/255);st(1,B/255);255*clip(${m.ff},0,1)'`;
}

/** Reference result for one 0..255 channel pair (tests). */
export function blendJS(mode, a255, b255) {
  const m = BLENDS[mode];
  const a = a255 / 255;
  const b = b255 / 255;
  return m ? C(m.js(a, b)) * 255 : b255;
}
