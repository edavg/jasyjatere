import type { Quality } from './constants';

export interface Dbg {
  backend: string; dpr: number; quality: Quality; frame: number; gl: unknown;
  snap?: boolean; moonDir?: readonly number[]; gust?: number; flash?: number;
  tiles?: number; terrainTriangles?: number;
  grass?: Record<string, unknown>; scatter?: Record<string, unknown>;
  blockers?: unknown; weather?: Record<string, unknown>; post?: Record<string, unknown>;
}

export function createDbg(): Dbg {
  return { backend: '', dpr: 0, quality: 'high', frame: 0, gl: null };
}

export function installDbg(d: Dbg): void {
  (window as unknown as { __dbg: Dbg }).__dbg = d;
}
