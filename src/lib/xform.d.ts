import type { Clip, Keyframe } from '../types';

export const XF_PROPS: ('scale' | 'px' | 'py')[];
export interface Xform { s: number; x: number; y: number; r: number; pr: number }
export function xformAt(clip: Clip, t: number, byId: Map<string, Clip>, W: number, H: number): Xform;
export function transformed(clip: Clip | undefined, byId: Map<string, Clip>): boolean;
export function xformExpr(clip: Clip, T: string, byId: Map<string, Clip>, W: number, H: number): { s: string; x: string; y: string; r: string; pr: string };
export function remapOf(c: Pick<Clip, 'remap'> | undefined): Keyframe[] | null;
export function remapDur(c: Pick<Clip, 'remap'> | undefined): number | null;
export function remapAt(c: Clip, t: number): number;
export function remapRate(c: Clip, t: number): number;
export function remapRange(c: Clip): { lo: number; hi: number } | null;
export function remapSetpts(c: Clip): string;
export function remapPreset(name: string, a: number, S: number, D: number): Keyframe[];
export function blurSamples(mb: { shutter?: number; samples?: number } | undefined): { N: number; K: number };
