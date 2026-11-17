type P = Record<string, unknown>;
export function galleryMaxSigma(blur: unknown, short: number): number;
export function tiltWeight(x: number, y: number, W: number, H: number, p: P): number;
export function tiltFF(W: number, H: number, p: P): string;
export function irisWeight(x: number, y: number, W: number, H: number, p: P): number;
export function irisFF(W: number, H: number, p: P): string;
export function levelWeights(w: number): [number, number];
export function flareRGB(x: number, y: number, W: number, H: number, p: P): [number, number, number];
export function flareGeq(W: number, H: number, p: P): { r: string; g: string; b: string };
export const LUMA709: number[];
export interface RelightParams {
  sigma: number;
  k: number;
  L: [number, number, number];
  ambient: number;
  intensity: number;
  amount: number;
  warm: [number, number, number];
}
export function relightParams(p: P, short: number): RelightParams;
export function relightFactor(S: number, sxm: number, sxp: number, sym: number, syp: number, q: RelightParams): number;
export function relightJS(c: number, F: number, i: number, q: RelightParams): number;
export const F_MAX: number;
export function relightGeq(q: RelightParams): string;
