/** Detail fields of clip.color.dev (LightCraft units). */
export interface DetailSettings {
  /** −100..100: local tone on the guided-filter base. */
  localHighlights?: number;
  localShadows?: number;
  /** −100..100. */
  clarity?: number;
  texture?: number;
  /** amount 0–150, radius 0.5–3 px, detail 0–100, masking 0–100. */
  sharpen?: { amount?: number; radius?: number; detail?: number; masking?: number };
  /** −100..100. */
  dehaze?: number;
  /** Airlight (linear 0.05–1), fixed per clip; measured from a frame when Dehaze is first moved. */
  dehazeAir?: number;
  /** amount 0–100, size 0–100, roughness 0–100. */
  grain?: { amount?: number; size?: number; roughness?: number };
}

export const L_MIN: number;
export const L_SPAN: number;
export const GREY: number;
export const AIR_DEFAULT: number;
export const SHARPEN_DEFAULT: Readonly<{ amount: number; radius: number; detail: number; masking: number }>;
export const GRAIN_DEFAULT: Readonly<{ amount: number; size: number; roughness: number }>;

export interface DetailClean {
  hl: number;
  sh: number;
  clarity: number;
  texture: number;
  sharpen: { amount: number; radius: number; detail: number; masking: number };
  dehaze: number;
  air: number;
  grain: { amount: number; size: number; roughness: number };
}
export function cleanDetail(dev: unknown): DetailClean;
/** Accepts a Grade ({ dev }) or the dev object itself. */
export function hasDetail(color: unknown): boolean;
export function hasGrain(color: unknown): boolean;
export function guidedSize(sigma: number): { sub: number; r: number };

export interface DetailParams {
  hl: number;
  sh: number;
  hs: { sub: number; r: number; eps: number };
  clar: number;
  clarG: { sub: number; r: number; eps: number };
  tex: number;
  texSigma: number;
  sharp: number;
  sharpSigma: number;
  sharpLimit: number;
  sharpMask: number;
  dehaze: number;
  air: number;
  darkSigma: number;
  grain: number;
  grainCell: number;
  grainRough: number;
}
export function detailParams(color: unknown, long: number): DetailParams;
export function estimateAirlight(rgba: ArrayLike<number>, w: number, h: number): number;

export function detailFilters(filters: string[], color: unknown, input: string, tag: string, ctx: { W: number; H: number }): string;
export function grainFilters(filters: string[], color: unknown, input: string, tag: string, ctx: { W: number; H: number; FPS: number; dur: number }): string;
export function detailFiltersFast(filters: string[], color: unknown, input: string, tag: string, ctx: { W: number; H: number }): string;
export const FAST: Record<string, unknown>;
