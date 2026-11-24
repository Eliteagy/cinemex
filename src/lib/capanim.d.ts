import type { CaptionAnim } from '../types';

export interface Intro {
  dur: number;
  sx?: number;
  sy?: number;
  dy?: number;
  fade?: number;
  blur?: number;
  bord?: boolean;
}
export interface IntroState {
  sx: number;
  sy: number;
  dy: number;
  alpha: number;
  blur: number;
  bord: number;
}
interface TimedWord {
  w: string;
  s: number;
  e: number;
}

export const ANIM_LABELS: Record<CaptionAnim, string>;
export const INTROS: Partial<Record<CaptionAnim, Intro>>;
export const STEPS: Partial<Record<CaptionAnim, { step: number; dx: number[]; dy: number[]; flash?: (string | null)[] }>>;
export const POPIN: { from: number; dur: number };
export const SCALEWORD: { to: number; dur: number };
export const TYPE: { rate: number; min: number; untimed: number };
export function hidesWords(anim: string): boolean;
export function introAt(anim: string, t: number): IntroState;
export function stepAt(anim: string, t: number): { dx: number; dy: number; flash: string | null };
export function stepTimes(anim: string): number[];
export function typeRate(words: TimedWord[], i: number): number;
export function typedChars(words: TimedWord[], i: number, t: number): number;
export function typeTimes(words: TimedWord[]): number[];
export function wordScaleAt(anim: string, a: number): number;
export function introAss(anim: string, o: number, opts: { x: number; y: number; H: number; size: number; bord: number; glowBlur?: number }): { pos: string; fade: string; scale: string; bord: string; blur: string };
export function wordScaleAss(anim: string, a: number): string;
