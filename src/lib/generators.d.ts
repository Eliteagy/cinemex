import type { Canvas, Clip, Fusion, GenKind, Media } from '../types';

export const GEN_KINDS: GenKind[];
export const GENERATORS: Record<GenKind, { label: string; hint: string }>;
/** Default length of a generator dropped on the timeline, seconds. */
export const GEN_DURATION: number;
/** A clip made by the app instead of a file: adjustment layer, solid colour or Fusion composition. */
export function isGen(c?: Clip | null): boolean;
/** Generators that draw a picture of their own (the adjustment layer only changes what is under it). */
export function hasPicture(c?: Clip | null): boolean;
export function genLabel(c?: Clip | null): string;
export function genColor(c?: Clip | null): string;
/** A solid or a Fusion composition as a picture the size of the canvas (null for anything else). */
export function genMedia(c: Clip, canvas: Canvas): (Media & { gen: GenKind; color: string }) | null;
export function genSource(c: Clip, W: number, H: number, FPS: number): string;
/** A new Fusion composition has only its output. */
export function newComp(): Fusion;
