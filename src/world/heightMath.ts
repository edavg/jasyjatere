/**
 * Matemática pura del campo de altura (§5.1). SIN imports: la comparten el
 * heightfield JS (`src/world/Heightfield.ts`), el horneado (`src/assets/noise.ts`)
 * y el test `tools/verify-height.ts` (Node 22 type-stripping).
 *
 * Dos convenios clave, ambos espejo del muestreo de la GPU:
 * - El texel (i, j) vive en `data[j*res + i]` y contiene el ruido en el CENTRO del
 *   texel: (u, v) = ((i + 0.5)/res, (j + 0.5)/res).
 * - `sampleBilinear` emula `LinearFilter` + `RepeatWrapping`: `x = u*res - 0.5`,
 *   interpolación bilineal entre centros de texel e índices con wrap. Así
 *   `rawHeight` (JS) coincide con `texture(lut, uv)` (TSL) a LOD 0.
 *
 * Ruido de valor, 5 octavas: frecuencias 3,6,12,24,48 ciclos por textura,
 * amplitudes 1,.5,.25,.125,.0625, fade quíntico y semilla por octava 11+i*7.
 */

export const RES = 512;

/**
 * Semilla global por defecto (`?seed=`). Con LUT_SEED (o seed 0, que se
 * normaliza a LUT_SEED) las octavas usan las semillas LITERALES de §5.1
 * (`11 + i*7`); cualquier otro `?seed=N` desplaza todas las octavas por N-1337.
 */
export const LUT_SEED = 1337;

/** Constantes de forma (§5.1); el TSL de Heightfield las espeja. */
export const SHAPE = {
  /** octava A: ±6.5 m a periodo 384 m */
  periodA: 384,
  ampA: 6.5,
  /** octava B: ±0.55 m a periodo 47 m, rotada 0.62 rad */
  periodB: 47,
  ampB: 0.55,
  rot: 0.62,
  offBx: 0.37,
  offBy: 0.11,
  /** escala del muestreo auxiliar `noise()` (densidad de props, §5.1) */
  noisePeriod: 64,
} as const;

const OCTAVES = 5;
const OCT_FREQ0 = 3;
const OCT_FREQ_MUL = 2;
const OCT_AMP0 = 1;
const OCT_AMP_MUL = 0.5;
const OCT_SEED0 = 11;
const OCT_SEED_STEP = 7;

const OV = Math.cos(SHAPE.rot);
const KV = Math.sin(SHAPE.rot);

export interface NormalOut {
  x: number;
  y: number;
  z: number;
}

function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * Hash espacial int32 de §5.1: `jV(x,y,n) = imul(374761393*x + 668265263*y +
 * 1274126177*n)`. La notación del doc omite el 2º argumento de `imul`; se
 * implementa como la suma de los tres productos 32-bit (`Math.imul`), que
 * conserva el wrap de 32 bits término a término.
 */
function jV(x: number, y: number, n: number): number {
  return (
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(n | 0, 1274126177)) |
    0
  );
}

/** Valor del lattice en [0,1): `(jV >>> 0) / 4294967296` (§5.1). */
function latticeValue(x: number, y: number, n: number): number {
  return (jV(x, y, n) >>> 0) / 4294967296;
}

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Ruido de valor 2D en una lattice de `n×n` celdas con wrap (periodo 1 en u,v). */
function valueNoise(x: number, y: number, n: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = quintic(x - ix);
  const uy = quintic(y - iy);
  const x0 = wrapIndex(ix, n);
  const x1 = wrapIndex(ix + 1, n);
  const y0 = wrapIndex(iy, n);
  const y1 = wrapIndex(iy + 1, n);
  const a = latticeValue(x0, y0, seed);
  const b = latticeValue(x1, y0, seed);
  const c = latticeValue(x0, y1, seed);
  const d = latticeValue(x1, y1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

/**
 * Hornea el LUT de altura `res×res` normalizado a [0,1] (§5.1). El texel
 * (i,j) se evalúa en el centro `((i+.5)/res, (j+.5)/res)`. `seed` es la semilla
 * global: 0 se normaliza a LUT_SEED y el resto desplaza las octavas.
 */
export function bakeHeightMap(res: number = RES, seed: number = LUT_SEED): Float32Array {
  const s = seed | 0;
  const seedOffset = (s === 0 ? LUT_SEED : s) - LUT_SEED;
  const data = new Float32Array(res * res);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < res; j++) {
    const v = (j + 0.5) / res;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const u = (i + 0.5) / res;
      let sum = 0;
      let amp = OCT_AMP0;
      let freq = OCT_FREQ0;
      for (let o = 0; o < OCTAVES; o++) {
        sum += amp * valueNoise(u * freq, v * freq, freq, OCT_SEED0 + o * OCT_SEED_STEP + seedOffset);
        amp *= OCT_AMP_MUL;
        freq *= OCT_FREQ_MUL;
      }
      data[row + i] = sum;
      if (sum < min) min = sum;
      if (sum > max) max = sum;
    }
  }
  const inv = 1 / (max - min);
  for (let k = 0; k < data.length; k++) data[k] = (data[k] - min) * inv;
  return data;
}

/** Bilineal con wrap que emula `LinearFilter` + `RepeatWrapping` de la GPU. */
export function sampleBilinear(data: Float32Array, res: number, u: number, v: number): number {
  const x = u * res - 0.5;
  const y = v * res - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = wrapIndex(ix, res);
  const x1 = wrapIndex(ix + 1, res);
  const row0 = wrapIndex(iy, res) * res;
  const row1 = wrapIndex(iy + 1, res) * res;
  const a = data[row0 + x0];
  const b = data[row0 + x1];
  const c = data[row1 + x0];
  const d = data[row1 + x1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** Forma del terreno (§5.1), dos octavas: ±6.5 m/384 m + ±0.55 m/47 m rotada. */
export function rawHeight(data: Float32Array, res: number, x: number, z: number): number {
  const a =
    (sampleBilinear(data, res, x / SHAPE.periodA, z / SHAPE.periodA) - 0.5) * (2 * SHAPE.ampA);
  const rx = x * OV - z * KV;
  const rz = x * KV + z * OV;
  const b =
    (sampleBilinear(data, res, rx / SHAPE.periodB + SHAPE.offBx, rz / SHAPE.periodB + SHAPE.offBy) -
      0.5) *
    (2 * SHAPE.ampB);
  return a + b;
}

/** `height(x,z) = raw(x,z)` (§5.1: en woods no hay shape subclass). */
export function heightFrom(data: Float32Array, res: number, x: number, z: number): number {
  return rawHeight(data, res, x, z);
}

/** Muestreo auxiliar `N(x/64, z/64)` para densidad de árboles/props. */
export function noiseFrom(data: Float32Array, res: number, x: number, z: number): number {
  return sampleBilinear(data, res, x / SHAPE.noisePeriod, z / SHAPE.noisePeriod);
}

/**
 * Normal por diferencias finitas centradas: `normalize(vec3(h(x-e)-h(x+e), 2e,
 * h(z-e)-h(z+e)))` (§5.1). Escribe en `out` sin allocar.
 */
export function normalFrom(
  data: Float32Array,
  res: number,
  x: number,
  z: number,
  out: NormalOut,
  eps = 0.4,
): NormalOut {
  const gx = rawHeight(data, res, x - eps, z) - rawHeight(data, res, x + eps, z);
  const gz = rawHeight(data, res, x, z - eps) - rawHeight(data, res, x, z + eps);
  const gy = 2 * eps;
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
  const inv = len > 0 ? 1 / len : 0;
  out.x = gx * inv;
  out.y = gy * inv;
  out.z = gz * inv;
  return out;
}
