import type { Clip, Project, Track } from '../types';

export type Splitter = (track: Track, clip: Clip, time: number) => Clip | null;
export interface EditSource {
  mediaId: string;
  in?: number;
  out?: number;
  /** Timeline length wanted (three-point edit with In and Out on the timeline). */
  length?: number;
}
export interface EditOpts {
  trackId?: string;
  split?: Splitter;
}
export type EditMode = 'insert' | 'overwrite' | 'replace' | 'fit' | 'top' | 'append';

export const MIN_LEN: number;
export const EDIT_MODES: EditMode[];
export function clipDur(c: Clip): number;
export function clipEnd(c: Clip): number;
export function simpleSplit(track: Track, c: Clip, time: number): Clip | null;
export function rippleTrim(p: Project, id: string, edge: 'left' | 'right', delta: number): number;
export function roll(p: Project, leftId: string, rightId: string, delta: number): number;
export function slip(p: Project, id: string, delta: number): number;
export function slide(p: Project, id: string, delta: number): number;
export function insertEdit(p: Project, src: EditSource, at: number, opts?: EditOpts): string;
export function overwriteEdit(p: Project, src: EditSource, at: number, opts?: EditOpts): string;
export function replaceEdit(p: Project, src: EditSource, at: number, opts?: EditOpts): string;
export function fitToFillEdit(p: Project, src: EditSource, from: number, to: number, opts?: EditOpts): string;
export function placeOnTopEdit(p: Project, src: EditSource, at: number, opts?: EditOpts): string;
export function appendEdit(p: Project, src: EditSource, opts?: EditOpts): string;
export function rippleDeleteRange(p: Project, from: number, to: number, opts?: EditOpts): number;
export function cutAt(track: Track, t: number, tolerance?: number): [Clip, Clip] | null;
