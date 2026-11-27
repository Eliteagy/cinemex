import type { Hotclip, Word } from '../types';

export function hms(t: number): string;
export function parseHms(v: unknown): number;
export function sentences(words: Word[], o?: { gap?: number; comma?: number; cap?: number }): { text: string; s: number; e: number; from: number; to: number }[];
export function transcriptLines(words: Word[], from?: number, to?: number): string;
export function textBetween(words: Word[], s: number, e: number): string;
export const HOTCLIP_DEFAULTS: { count: number; min: number; max: number };
export function hotclipsPrompt(lines: string, o?: { count?: number; min?: number; max?: number; language?: string; context?: string }): string;
export function hotclipWindows(words: Word[], o?: { chapters?: { start: number }[] | null; count?: number; block?: number }): { s: number; e: number; count: number }[];
export function parseHotclips(json: unknown, words: Word[], o?: { min?: number; max?: number; count?: number }): Hotclip[];
export function publishText(c: Hotclip): string;
export function slug(s: string): string;
export function chaptersPrompt(lines: string, o?: { language?: string }): string;
export interface Chapter {
  start: number;
  title: string;
  summary: string;
  points: string[];
}
export function parseChapters(json: unknown, duration?: number): { titles: string[]; chapters: Chapter[] };
export function youtubeChapters(chapters: Chapter[]): string;
export const TRANSLATE_BATCH: number;
export function translatePrompt(items: { i: number; text: string }[], language: string): string;
export function parseTranslation(json: unknown, items: { i: number; text: string }[]): (string | null)[];
export function cleanResidue(t: string): string;
export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
}
export function checkCaptions(cues: Cue[]): { id: string; kind: 'empty' | 'timing' | 'overlap' | 'residue' | 'duplicate' | 'long'; fix: boolean; msg: string }[];
export function fixCaptions(cues: Cue[]): Cue[];

export function snapToSentence(ws: { w: string; s: number; e: number }[], from: number, to: number, opts?: { back?: number; fwd?: number }): { from: number; to: number };
export function spellPrompt(lines: string, opts?: { context?: string; learned?: { from: string; to: string }[] }): string;
export function parseSpellFixes(json: unknown): { wrong: string; right: string }[];
export function applySpellFixes<W extends { w: string; s: number; e: number }>(words: W[], fixes: { wrong: string; right: string }[]): { words: W[]; applied: { wrong: string; right: string; s: number }[] };
export function keywordPrompt(blocks: string[][], opts?: { learned?: { block: string; word: string }[] }): string;
export function parseKeywordPicks(json: unknown, blocks: string[][]): (number | null)[];
