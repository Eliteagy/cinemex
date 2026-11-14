import type { Frame, FrameBg } from '../types';

export interface GradientPreset {
  label: string;
  from: string;
  to: string;
  /** Degrees: 0 = left to right, 90 = top to bottom. */
  angle: number;
}
export const GRADIENTS: Record<string, GradientPreset>;
export const GRADIENT_IDS: string[];
export const BG_KINDS: FrameBg['kind'][];
export const FRAME_DEFAULT: Frame;
export const FRAME_LIMITS: Record<'padding' | 'radius' | 'shadow' | 'border', [number, number]>;

export function cleanFrame(f: unknown): Frame | null;
export function hasFrame(f: unknown): boolean;

export interface FrameGeo {
  ix: number;
  iy: number;
  iw: number;
  ih: number;
  r: number;
  bw: number;
  sigma: number;
  dy: number;
  alpha: number;
}
export function frameGeo(frame: unknown, W: number, H: number): FrameGeo;

export type FrameBgDraw = { kind: 'none' } | { kind: 'color'; color: string } | { kind: 'gradient'; from: string; to: string; x0: number; y0: number; x1: number; y1: number };
export function bgOf(frame: unknown, W: number, H: number): FrameBgDraw;

export function roundBoxExpr(cx: number, cy: number, hw: number, hh: number, r: number): string;
export function frameFilters(filters: string[], frame: unknown, input: string, tag: string, ctx: { W: number; H: number; FPS: number; dur: number }): string;
