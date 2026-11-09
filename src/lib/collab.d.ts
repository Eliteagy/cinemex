import type { Project } from '../types';

export interface ListChange<T> {
  up: T[];
  del: string[];
  order: string[];
}

export interface ProjectOp {
  v: number;
  set?: Partial<Project>;
  unset?: string[];
  media?: ListChange<Project['media'][number]>;
  tracks?: ListChange<Omit<Project['tracks'][number], 'clips'>>;
  clips?: Record<string, ListChange<Project['tracks'][number]['clips'][number]>>;
}

export const OP_VERSION: number;
export const SHARED: string;
export function diffProject(prev: Project | null | undefined, next: Project): ProjectOp | null;
export function applyOp(project: Project, op: ProjectOp): Project;
export function mapPaths<T>(value: T, fn: (path: string) => string): T;
export function toShared(file: string, root: string | null | undefined): string;
export function fromShared(file: string, root: string | null | undefined, sep?: string): string;
