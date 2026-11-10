import type { Clip } from '../types';

export interface Crop {
  /** Fractions of the frame, 0..1. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Soft edges, 0..1. */
  soft: number;
}
export const CROP_ID: string;
export function cropOf(clip: Pick<Clip, 'masks'> | null | undefined): Crop;
export function hasCrop(clip: Pick<Clip, 'masks'> | null | undefined): boolean;
export function setCrop(clip: Pick<Clip, 'masks'>, patch?: Partial<Record<keyof Crop, number | null>>): Crop;
