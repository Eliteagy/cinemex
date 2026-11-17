/** Colour-mixer / B&W bands, in LightCraft's order. */
export type Band = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';
export type WheelName = 'shadows' | 'midtones' | 'highlights' | 'global';
export const BANDS: Band[];
export const WHEELS: WheelName[];

/** A point curve: [x, y] pairs in 0..1 (empty = identity). */
export type CurvePoints = [number, number][];

/** Develop settings (clip.color.dev), LightCraft UI units. Every field optional. */
export interface DevSettings {
  /** Kelvin 2000–50000 (6500 = as shot). Higher = warmer picture. */
  temp?: number;
  /** −150..150, positive = magenta. */
  tint?: number;
  /** EV −5..5. */
  exposure?: number;
  /** −100..100 (display tone map). */
  contrast?: number;
  /** −100..100; global part only (per-pixel weights of LightCraft's spatial Highlights/Shadows). */
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  vibrance?: number;
  saturation?: number;
  hsl?: Partial<Record<Band, { h?: number; s?: number; l?: number }>>;
  /** hue 0–360, sat 0–100, lum −100..100. */
  wheels?: Partial<Record<WheelName, { hue?: number; sat?: number; lum?: number }>>;
  /** 0–100 (50). */
  blending?: number;
  /** −100..100. */
  balance?: number;
  curve?: {
    shadows?: number;
    darks?: number;
    lights?: number;
    highlights?: number;
    /** Region splits in % (25, 50, 75). */
    split?: [number, number, number];
    master?: CurvePoints;
    r?: CurvePoints;
    g?: CurvePoints;
    b?: CurvePoints;
  };
  /** 0–100 (100 = the curves' own saturation). */
  refineSat?: number;
  bw?: boolean;
  bwMix?: Partial<Record<Band, number>> | number[];
  /** A LOOKS id and its amount 0–200 (%). */
  look?: { id?: string; amount?: number };
  calibration?: { shadowsTint?: number; redHue?: number; redSat?: number; greenHue?: number; greenSat?: number; blueHue?: number; blueSat?: number };
}

/** All fields present (what cleanDev / resolveLook return). */
export interface DevFull {
  temp: number;
  tint: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  hsl: Record<Band, { h: number; s: number; l: number }>;
  wheels: Record<WheelName, { hue: number; sat: number; lum: number }>;
  blending: number;
  balance: number;
  curve: { shadows: number; darks: number; lights: number; highlights: number; split: [number, number, number]; master: CurvePoints; r: CurvePoints; g: CurvePoints; b: CurvePoints };
  refineSat: number;
  bw: boolean;
  bwMix: Record<Band, number>;
  look: { id: string; amount: number };
  calibration: { shadowsTint: number; redHue: number; redSat: number; greenHue: number; greenSat: number; blueHue: number; blueSat: number };
}

export const DEV_DEFAULT: Readonly<DevFull>;
export function cleanDev(dev: unknown): DevFull;

export interface Look {
  id: string;
  /** Portuguese label. */
  label: string;
  group: string;
  /** Slider deltas at 100 % (clarity / texture: data only, not rendered). */
  d: Partial<Record<'contrast' | 'saturation' | 'vibrance' | 'highlights' | 'shadows' | 'blacks' | 'clarity' | 'texture', number>>;
  hsl?: Partial<Record<Band, { h?: number; s?: number; l?: number }>>;
  curve?: Partial<Record<'shadows' | 'darks' | 'lights' | 'highlights', number>>;
  bwMix?: Partial<Record<Band, number>>;
  /** Point-curve output [black, white] levels composed after the user's curve. */
  fade?: Partial<Record<'master' | 'r' | 'g' | 'b', [number, number]>>;
  /** [hue, sat, lum] added to the user's wheel as a colour vector. */
  wheels?: Partial<Record<WheelName, [number, number, number]>>;
  bw?: boolean;
}
export const LOOKS: Look[];
export function resolveLook(dev: unknown): DevFull;

/** Grade-like input: legacy sliders (−1..1) plus dev. */
export interface ColorInput {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  dev?: DevSettings;
  [k: string]: unknown;
}
/** sRGB-encoded 0..1 in and out. */
export function makePixelFn(color: ColorInput | undefined | null): (r: number, g: number, b: number) => [number, number, number];
export function isIdentityDev(color: ColorInput | undefined | null): boolean;

export interface CubeLut {
  N: number;
  data: Float32Array;
  domainMin?: number[];
  domainMax?: number[];
}
/** N³·3 floats, .cube order (red fastest). */
export function bakeLut(color: ColorInput | undefined | null, N?: number, userLut?: CubeLut): Float32Array;
export function toCube(data: ArrayLike<number>, N: number, title?: string): string;
export function parseCube(text: string): Required<CubeLut>;

export function tempTintToXy(temp: number, tint: number): [number, number];
export function xyToTempTint(xy: [number, number]): [number, number];

export function autoTone(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  dev?: DevSettings,
): { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number; vibrance: number; saturation: number };
export function autoWhiteBalance(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): { temp: number; tint: number };
