import type { Dbg } from './dbg';
import { pnum } from './params';

/**
 * F9: benchmark in-app para verificación en hardware real (sin DevTools):
 *
 *   http://127.0.0.1:5173/?q=high&perf=30
 *
 * Muestrea el `dt` real de cada frame durante `N` segundos (tras 1.5 s de
 * calentamiento), calcula p50/p95/p99/max y fps efectivos, y lo publica en
 * `console.log('[perf] …')`, en `window.__dbg.perf` y en el HUD (`#hudPerf`).
 * El array de muestras se preasigna; no hay allocs por frame (el orden final
 * sí asigna una vez: Array.from + sort).
 */
export interface PerfResult {
  seconds: number;
  frames: number;
  fps: number;
  /** Percentiles de frame en ms (muestras de rAF sin capar). */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  draws: number;
  tris: number;
  scanMs: number;
  quality: string;
  backend: string;
  dpr: number;
}

declare module './dbg' {
  interface Dbg {
    perf?: PerfResult;
  }
}

export interface PerfStats {
  draws: number;
  tris: number;
  scanMs: number;
}

export interface PerfEx {
  /** Llamar cada frame con el dt real (los dt 0 se ignoran). */
  update(dt: number, stats: PerfStats): void;
  readonly enabled: boolean;
  readonly done: boolean;
}

const WARMUP = 1.5;
const MAX_CAP = 240;

export function createPerf(dbg: Dbg): PerfEx {
  const seconds = pnum('perf', 0);
  const enabled = seconds > 0;
  const capacity = Math.max(1, Math.ceil(seconds * MAX_CAP) + 60);
  const samples = new Float32Array(capacity);
  const stats: PerfStats = { draws: 0, tris: 0, scanMs: 0 };

  let warmup = 0;
  let count = 0;
  let elapsed = 0;
  let done = false;

  function finish(): void {
    done = true;
    const n = count;
    const sorted = Array.from(samples.subarray(0, n)).sort((a, b) => a - b);
    /** Percentil en ms (las muestras están en segundos). */
    const at = (q: number): number => Math.round(sorted[Math.min(n - 1, Math.floor(q * n))] * 100000) / 100;
    const result: PerfResult = {
      seconds: Math.round(elapsed * 100) / 100,
      frames: n,
      fps: Math.round((n / Math.max(elapsed, 1e-3)) * 10) / 10,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: at(1),
      draws: stats.draws,
      tris: stats.tris,
      scanMs: stats.scanMs,
      quality: dbg.quality,
      backend: dbg.backend,
      dpr: dbg.dpr,
    };
    dbg.perf = result;
    console.log(`[perf] ${JSON.stringify(result)}`);
  }

  function update(dt: number, s: PerfStats): void {
    if (!enabled || done || dt <= 0) return;
    stats.draws = s.draws;
    stats.tris = s.tris;
    stats.scanMs = s.scanMs;
    warmup += dt;
    if (warmup < WARMUP) return;
    elapsed += dt;
    if (count < capacity) samples[count++] = dt;
    if (elapsed >= seconds) finish();
  }

  return {
    update,
    get enabled(): boolean {
      return enabled;
    },
    get done(): boolean {
      return done;
    },
  };
}
