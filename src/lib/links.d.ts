import type { Clip, Project, Track } from '../types';

/** The audio track that holds the sound of a video track (made when missing): V1 -> A1, V2 -> A2… */
export function audioTrackFor(p: Project, videoTrack: Track): Track;
/** Old captions tracks (kind 'text') become video tracks on top. Returns how many. */
export function textToVideo(p: Project): number;
/** Every video clip with sound gets its sound as a linked clip on an audio track. Returns how many. */
export function separateAudio(p: Project): number;
/** Run after every edit: keeps linked picture and sound clips in step (linked=false: edited on their own). */
export function syncLinks(before: Project | null, after: Project, opts?: { linked?: boolean }): Project;
/** The other half (or halves) of a linked clip. */
export function partnersOf(p: Project, clipId: string): Clip[];
/** Break the link: picture and sound become two independent clips. Returns how many were linked. */
export function unlink(p: Project, clipId: string): number;
