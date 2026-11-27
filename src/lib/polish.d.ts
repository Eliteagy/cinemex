export function beatsFromCaptions(back: { start: number; text?: string; override?: { color?: string } }[], opts?: { minGap?: number; skip?: number; tail?: number; duration?: number }): number[];
export function punchKeyframes(beats: number[], clip: { start: number; in: number; out: number; speed?: number }, opts?: { amount?: number; up?: number; hold?: number; down?: number; base?: number }): import('../types').Keyframe[];
export function sfxPlan(beats: number[], opts?: { every?: number; first?: string; rest?: string; volume?: number }): { id: string; at: number; volume: number }[];
export function progressClip(duration: number, opts?: { color?: string; y?: number }): Omit<import('../types').Clip, 'id'>;
export function ctaClip(text: string, duration: number, opts?: { len?: number; y?: number; kind?: string }): Omit<import('../types').Clip, 'id'> | null;
export function musicClips(track: { duration: number }, len: number, opts?: { volume?: number; fade?: number; mediaId?: string }): Omit<import('../types').Clip, 'id'>[];
export function moodFromText(text: string): 'calma' | 'media' | 'forte';
