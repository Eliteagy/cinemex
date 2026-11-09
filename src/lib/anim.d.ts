import type { Clip, Ease, Keyframe, KeyProp, Modifier } from '../types';

export const EASES: Ease[];
export const EASE_LABELS: Record<Ease, string>;
export const NEWTON: number;
export function curveOf(k: Keyframe | undefined): [number, number, number, number] | null;
export function bezierAt(c: number[], u: number): number;
export function easeAt(k: Keyframe | undefined, u: number): number;
export function kfAt(list: Keyframe[] | undefined, t: number, def: number): number;
export function loopTime(list: Keyframe[] | undefined, t: number, mod: Modifier | undefined): number;
export function propAt(clip: Pick<Clip, 'id' | 'keyframes' | 'mods'> | undefined, prop: KeyProp, t: number, def: number): number;
export function kfExpr(list: Keyframe[] | undefined, def: number, T?: string): string;
export function propExpr(clip: Pick<Clip, 'id' | 'keyframes' | 'mods'> | undefined, prop: KeyProp, def: number, T?: string): string;
export function animates(clip: Pick<Clip, 'keyframes' | 'mods'> | undefined, prop: KeyProp): boolean;
