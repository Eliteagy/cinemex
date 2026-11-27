import type { EditPack } from '../types';
export const MUSIC: EditPack['music'][];
export const BUILTIN_PACKS: Record<string, EditPack>;
export function validatePack(raw: unknown): EditPack | null;
export function isPackId(id: unknown): boolean;
export function validatePackStore(raw: unknown): { version: 1; packs: Record<string, EditPack> };
export function packIdFor(label: string, taken?: Set<string>): string;
export function packShortOptions(pack: EditPack): Record<string, unknown>;
