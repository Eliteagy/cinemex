import type { Emphasis, TextLayer } from '../types';

export type EmphasisRole = 'base' | 'kw' | 'rest';
export interface EmphasisLine {
  role: EmphasisRole;
  from: number;
  to: number;
}
export interface FontMetrics {
  upem: number;
  a: number;
  d: number;
}

export const STOP_WORDS: Set<string>;
export function cleanWord(w: string): string;
export function pickKeyword(words: string[]): number;
export function keywordOf(clip: { keyword?: number }, words: string[]): number;
export function emphasisLines(n: number, kw: number, em: Emphasis): EmphasisLine[];
export function linePositions(lines: EmphasisLine[], em: Emphasis): { dx: number; dy: number }[];
export type LineOffsets = Partial<Record<EmphasisRole, { x: number; y: number }>>;
export const LINE_ROLES: EmphasisRole[];
export function cleanLines(l: unknown): LineOffsets | undefined;
export function lineOffset(lines: LineOffsets | undefined, role: EmphasisRole): { x: number; y: number };
export function layerOf(em: Emphasis, role: EmphasisRole): TextLayer;
export function roleOrder(em: Emphasis, role: EmphasisRole): number;
export const FONT_METRICS: Record<string, FontMetrics>;
export function metricsOf(font: string): FontMetrics;
export const USER_FONTS: Record<string, { file: RegExp; fallback: string }>;
export const REVEAL_RATE: number;
export function revealDur(word: string): number;
export function riseAt(local: number, rise?: { dist?: number; dur?: number; blur?: number }): { dy: number; blur: number; alpha: number };
export function mixHex(a: string, b: string, t: number): string;
export function registerMetrics(font: string, m: FontMetrics | null | undefined): void;
