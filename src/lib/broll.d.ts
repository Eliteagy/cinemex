export function tokens(text: string): string[];
export function brollPrompt(lines: string, opts?: { max?: number; library?: string[] }): string;
export function parseInserts(json: unknown, opts?: { from?: number; to?: number; max?: number; gap?: number }): { at: number; len: number; pt: string; en: string }[];
export function matchLibrary<T extends { name: string; desc?: string; path: string }>(insert: { pt: string; en: string }, library: T[], opts?: { min?: number; used?: Set<string> }): T | null;
export function splitAround<C extends import('../types').Clip>(clip: C, ranges: { start: number; end: number }[]): Omit<C, 'id'>[];
