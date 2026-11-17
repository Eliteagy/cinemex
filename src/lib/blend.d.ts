import type { BlendMode } from '../types';

export interface BlendDef {
  label: string;
  js: (a: number, b: number) => number;
  glsl: string;
  ff: string;
}
export const BLENDS: Record<Exclude<BlendMode, 'normal'>, BlendDef>;
export const BLEND_ORDER: BlendMode[];
export const BLEND_GROUP_BREAKS: Set<BlendMode>;
export function blendFF(mode: string): string | null;
export function blendJS(mode: string, a255: number, b255: number): number;
