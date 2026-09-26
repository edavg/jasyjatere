import * as THREE from 'three/webgpu';

/**
 * Assets procedurales de F2b (T2.2.4). **No hay texturas de fichero**: este
 * módulo ofrece un generador fbm reutilizable (DataTexture R8 con mipmaps, para
 * props/rocas de fases futuras) y la tabla de capas del suelo (rampas de 3
 * stops + parámetros de splat). El material del terreno (`terrainMaterial.ts`)
 * consume la tabla y evalúa el fbm en TSL; así no se sube ninguna textura por
 * capa ni hace falta un triplete diff/nor/arm por capa.
 *
 * Paleta nocturna: verdes/marrones muy oscuros y desaturados, coherentes con
 * `SKY.horizon` y `FOG.color` (el suelo nunca compite con la niebla).
 */

/** Color lineal (working space) de 3 componentes. */
export type RGB = readonly [number, number, number];

/** Una capa del splat de suelo. Todo el mapeo es en coordenadas de mundo. */
export interface TerrainLayerDef {
  /** Nombre de referencia del material original de Rainy Worlds. */
  readonly name: string;
  /** UV de mundo: `uv = coords / scale + offset` (escala en metros). */
  readonly scale: number;
  readonly offset: readonly [number, number];
  /** Si es `true`, las coords se usan como (z, x) en vez de (x, z). */
  readonly swap: boolean;
  /** Máscara: `smoothstep(lo, hi, remap(mx_noise(xz * maskFreq + maskOffset)))`. */
  readonly maskFreq: number;
  readonly maskOffset: readonly [number, number];
  /** Rampa de color de 3 stops (espacio lineal). */
  readonly ramp: readonly [RGB, RGB, RGB];
}

/** Color bajo todas las capas (tierra desnuda). */
export const TERRAIN_SOIL: RGB = [0.35, 0.28, 0.182];

/**
 * Tabla de capas (T2.2.4). Escalas, offsets, frecuencias y offsets de máscara
 * son los del doc; las rampas (3 stops) las elige esta fase para la paleta
 * nocturna. Albedo efectivo ~0.2–0.5: con la luna (0.14), AgX 0.8 y la niebla
 * de 0.02 el suelo queda oscuro pero con el relieve legible; con albedo ~0.03
 * (bosque nocturno "físico") el frame sale negro y no se ve nada.
 */
export const TERRAIN_LAYERS: readonly TerrainLayerDef[] = [
  {
    name: 'forrest_ground_03',
    scale: 2.4,
    offset: [0, 0],
    swap: false,
    maskFreq: 0.043,
    maskOffset: [3.1, 7.7],
    ramp: [
      [0.28, 0.406, 0.182],
      [0.406, 0.588, 0.252],
      [0.21, 0.308, 0.154],
    ],
  },
  {
    name: 'brown_mud_leaves_01',
    scale: 3.1,
    offset: [0.31, 0.77],
    swap: false,
    maskFreq: 0.19,
    maskOffset: [9.2, 1.4],
    ramp: [
      [0.406, 0.308, 0.168],
      [0.588, 0.434, 0.238],
      [0.28, 0.182, 0.098],
    ],
  },
  {
    name: 'aerial_grass_rock',
    scale: 4.2,
    offset: [0.5, 0.1],
    swap: false,
    maskFreq: 0.075,
    maskOffset: [41.3, 15.2],
    ramp: [
      [0.238, 0.308, 0.154],
      [0.364, 0.462, 0.252],
      [0.588, 0.588, 0.364],
    ],
  },
  {
    name: 'forest_leaves_04',
    scale: 2.8,
    offset: [0.13, 0.62],
    swap: true,
    maskFreq: 0.11,
    maskOffset: [23.3, 61.2],
    ramp: [
      [0.406, 0.308, 0.14],
      [0.56, 0.434, 0.182],
      [0.294, 0.392, 0.154],
    ],
  },
] as const;

const FBM_FADE = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Hash espacial de 32 bits → [0, 1). */
function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Ruido de valor bilineal que **tile a la perfección** en una lattice de
 * `period` celdas (wrap de índices). Base del fbm horneado.
 */
function tileValueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = FBM_FADE(x - ix);
  const uy = FBM_FADE(y - iy);
  const x0 = ((ix % period) + period) % period;
  const x1 = ((ix + 1) % period + period) % period;
  const y0 = ((iy % period) + period) % period;
  const y1 = ((iy + 1) % period + period) % period;
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed);
  const d = hash2i(x1, y1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

/**
 * Generador procedural reutilizable: hornea un fbm de ruido de valor (4 octavas,
 * frecuencias 4/8/16/32 ciclos por textura) en una `DataTexture` R8 (RedFormat,
 * UnsignedByteType, 8 bits normalizados) con `RepeatWrapping` y mipmaps. Tile a
 * la perfección, así que se puede repetir sin costuras. El material del suelo no
 * lo usa (evalúa el fbm en TSL, sin subir texturas), pero queda disponible para
 * props/rocas de fases posteriores.
 */
export function createFbmTexture(size = 256, seed = 1337, octaves = 4): THREE.DataTexture {
  const data = new Uint8Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    total += amp;
    amp *= 0.5;
  }
  const inv = 1 / total;

  let freq = 4;
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const row = j * size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      let sum = 0;
      let a = 1;
      let f = freq;
      for (let o = 0; o < octaves; o++) {
        sum += a * tileValueNoise(u * f, v * f, f, seed + o * 7);
        a *= 0.5;
        f *= 2;
      }
      data[row + i] = Math.round(Math.min(Math.max(sum * inv, 0), 1) * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
