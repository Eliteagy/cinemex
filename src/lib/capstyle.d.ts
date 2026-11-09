import type { CaptionOverride, CaptionStyle, Clip, Project } from '../types';

export const ANIMS: string[];
export const OVERRIDE_KEYS: (keyof CaptionOverride)[];
export const MY_STYLE_ID: string;
export function isStyleId(id: unknown): id is string;
export function cleanOverride(o: unknown): CaptionOverride | undefined;
export function applyOverride(st: CaptionStyle, o: CaptionOverride | undefined | null): CaptionStyle;
export function baseStyleOf(clip: Pick<Clip, 'style'> | null | undefined, project: Pick<Project, 'styles' | 'captionStyle'> | null | undefined, presets: Record<string, CaptionStyle>, userStyles?: Record<string, CaptionStyle>): CaptionStyle;
export function resolveCaptionStyle(clip: Pick<Clip, 'style' | 'override'> | null | undefined, project: Pick<Project, 'styles' | 'captionStyle'> | null | undefined, presets: Record<string, CaptionStyle>, userStyles?: Record<string, CaptionStyle>): CaptionStyle;
export function fontsOf(st: CaptionStyle | null | undefined): string[];
export function validateStyle(raw: unknown): CaptionStyle | null;
export function validateStore(json: unknown): { version: 1; styles: Record<string, CaptionStyle> };
export function styleIdFor(label: string, taken: Set<string>): string;
