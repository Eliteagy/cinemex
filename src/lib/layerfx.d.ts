import type { BlendMode, Clip, Effect, Matte } from '../types';

export const EFFECT_TYPES: Effect['type'][];
export const EFFECT_LABELS: Record<Effect['type'], string>;
export const EFFECT_DEFAULTS: { [K in Effect['type']]: Omit<Extract<Effect, { type: K }>, 'id' | 'type'> };
export const BLEND_MODES: BlendMode[];
export const BLEND_LABELS: Record<BlendMode, string>;
export const BLEND_FFMPEG: Partial<Record<BlendMode, string>>;
export const BLEND_CANVAS: Record<BlendMode, GlobalCompositeOperation>;
export const MATTE_FONT: string;
export function shadowOffset(e: { angle: number; distance: number }, short: number): { dx: number; dy: number };
export function sweepAt(e: Extract<Effect, { type: 'sweep' }>, t: number, W: number, H: number): { c: number; s: number; w: number; pos: number; dmin: number; dmax: number; active: boolean };
export function textMatteBox(m: Extract<Matte, { kind: 'text' }>, W: number, H: number): { px: number; cx: number; cy: number };
export function layerFx(filters: string[], c: Clip, input: string, tag: string, ctx: unknown): string;
