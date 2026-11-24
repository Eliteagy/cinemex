import type { Project } from '../types';

export type Seg = { in: number; out: number };
export const CUT_PACES: Record<'suave' | 'normal' | 'rapido', { label: string; minPause: number; padding: number }>;
export function refineEdges(segs: Seg[], peaks: ArrayLike<number> | null | undefined, opts?: { rate?: number; thr?: number; maxExtend?: number; mergeGap?: number; min?: number; max?: number }): Seg[];

export type SafeZoneId = 'reels' | 'tiktok' | 'shorts';
export const SAFE_ZONES: Record<SafeZoneId, { label: string; top: number; bottom: number; left: number; right: number }>;

export type SplitLayout = 'top-bottom' | 'left-right';
type Side = { crop: { left: number; right: number; top: number; bottom: number }; px: number; py: number };
export function splitLayout(layout?: SplitLayout, ratio?: number): { a: Side; b: Side };
export function applySplit(p: Project, aId: string, bId: string, layout?: SplitLayout, ratio?: number): { a: string; b: string };
export function partnerForSplit(p: Project, id: string): import('../types').Clip | null;

export type TWord = { w: string; s: number; e: number; clip: string };
export function timelineWords(p: Project): TWord[];
export function wordLines(words: TWord[], size?: number): string;

export type SuggestKind = 'punch' | 'zoom_in' | 'title';
export type Suggestion = { t: number; kind: SuggestKind; why: string; text?: string };
export const SUGGEST_KINDS: SuggestKind[];
export function suggestPrompt(lines: string, count?: number): string;
export function parseSuggestions(raw: unknown, duration: number): Suggestion[];
export function zoomKeys(kind: SuggestKind, local: number, clipLen: number): { t: number; v: number }[];

export const VOICE_TOOLS: Record<string, string>;
export function voicePrompt(said: string, ctx: { playhead: number; selected: string | null; under: string | null; clips: string }): string;
export function parseVoice(raw: unknown): { actions: { tool: string; args: Record<string, unknown> }[]; say: string };
