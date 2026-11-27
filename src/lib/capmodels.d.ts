import type { CaptionModel, Clip } from '../types';

export const MODEL_KINDS: CaptionModel['kind'][];
export const BACK_STYLE: string;
export const FRONT_STYLE: string;
export const BUILTIN_MODELS: Record<string, CaptionModel>;
export function validateModel(raw: unknown): CaptionModel | null;
export function validateModelStore(raw: unknown): { version: 1; models: Record<string, CaptionModel> };
export function isModelId(id: unknown): boolean;
export function modelIdFor(label: string, taken?: Set<string>): string;
export function isAccent(word: string, accent: CaptionModel['accent']): boolean;
export function fitSize(text: string, font: string, width: number, maxSize: number, W: number, H: number): number;
export function modelCaptions(
  model: CaptionModel,
  groups: Omit<Clip, 'id'>[],
  W: number,
  H: number,
  face: { y: number; h: number } | null,
): { back: Omit<Clip, 'id'>[]; front: Omit<Clip, 'id'>[] };
export function groupingFor(model: CaptionModel): { style: string; stripPunct: boolean; maxWords: number };
