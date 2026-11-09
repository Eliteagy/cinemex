import type { Clip, Keyframes, TransitionType } from '../types';

export interface TransitionInfo {
  label: string;
  blur: number;
  dir?: boolean;
  zoom?: number;
  spin?: number;
}
export const TRANSITIONS: Record<TransitionType, TransitionInfo>;
export const TRANSITION_TYPES: TransitionType[];
export const BLUR_STEPS: number;
export function smooth(u: number): number;
export function smoothInv(y: number): number;
export function transitionAmount(clip: Pick<Clip, 'transitionIn' | 'transitionOut'>, local: number, dur: number): { side: 'in' | 'out'; type: TransitionType; d: number; u: number }[];
export function blurStages(u: number): number;
export function blurWindow(side: 'in' | 'out', d: number, dur: number, k: number): [number, number];
export interface TransitionFx {
  alpha: number;
  slide: number;
  zoom: number;
  rotate: number;
  white: number;
  black: number;
  blur: number;
  blurDir: boolean;
  /** Brightness Flash strength 0..1: out = img * (1 + 0.83 s) + 0.67 s. */
  bright: number;
}
export const BFLASH: { lift: number; gain: number };
export function bflashS(u: number): number;
export function transitionState(clip: Pick<Clip, 'transitionIn' | 'transitionOut'>, local: number, dur: number): TransitionFx;
export function stageSigma(type: TransitionType, short: number): number;
export type MotionPreset = 'zoom_in' | 'zoom_out' | 'ken_burns' | 'punch' | 'shake' | 'pulse' | 'spin_in' | 'fade_in_out';
export const MOTION_PRESETS: MotionPreset[];
export function motionPreset(preset: string, d: number, seed?: string, opts?: { amount?: number; every?: number }): Keyframes | null;
export function pulseKeys(beats: number[], d: number, amount?: number, base?: number): { t: number; v: number }[];
export function detectBeats(peaks: ArrayLike<number>, opts?: { rate?: number; minGap?: number; sensitivity?: number }): number[];
