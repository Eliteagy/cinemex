import type { Graphic, GraphicKind } from '../types';

export const GRAPHICS: Record<GraphicKind, { label: string; title: string; subtitle: string }>;
export const GRAPHIC_KINDS: GraphicKind[];
export const GFX_FONT: string;
export type FullGraphic = Required<Omit<Graphic, 'kind'>> & { kind: GraphicKind };
export function graphicOf(g: Partial<Graphic> | undefined): FullGraphic;
export interface GfxEvent {
  kind: 'rect' | 'text';
  layer: number;
  t0: number;
  t1: number;
  an: 4 | 5 | 7;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  moveMs: number;
  fadeIn: number;
  fadeOut: number;
  scale: { x0: number; y0: number; x1: number; y1: number; ms: number } | null;
  color: string;
  alpha: number;
  w?: number;
  h?: number;
  text?: string;
  font?: string;
  size?: number;
  box?: { color: string; alpha: number; pad: number };
  shadow?: { color: string; alpha: number; x: number; y: number };
}
export function graphicEvents(g: Partial<Graphic>, dur: number, W: number, H: number): GfxEvent[];
export function eventAt(e: GfxEvent, local: number): { x: number; y: number; sx: number; sy: number; alpha: number } | null;
