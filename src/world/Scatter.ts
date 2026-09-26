import * as THREE from 'three/webgpu';
import { QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { hash3 } from '../core/rng';
import type { Shared } from '../core/shared';
import type { HeightfieldEx } from './Heightfield';

declare module '../core/dbg' {
  interface Dbg {
    scatterStats?: Record<string, number>;
    scatterChecksum?: number;
  }
}

/**
 * ============================================================================
 * Scatter — motor de streaming con pool de slots sin GC (F4a, T4.2.2).
 *
 * Fuente: §7.2 (cadena de aceptación), §7.3 (pool de slots) y §8 (props y
 * landmarks) de `docs/00-referencia-tecnica.md`.
 *
 * USO (S4b árboles / S4c props):
 * ```ts
 * const scatter = createScatter(heightfield, quality, scene, shared);
 * scatter.addLayer({
 *   id: 0, field: 0, cellSize: 8.5, prob: 0.64, variants: 3,
 *   lodDist: [22.5, 60, 175], cap: [30, 90, 300],
 *   scale: [0.85, 1.2], sink: 0.08, trunkRadius: 0.34,
 *   primitives: (v, lod) => [
 *     // Misma longitud en todas las variantes para el mismo LOD.
 *     { key: 0, geometry: trunks[v][lod], material: bark, shadow: lod < 2, layer: lod < 2 ? 2 : 0 },
 *     { key: 1, geometry: crowns[v][lod], material: leaf, shadow: lod < 2, layer: lod < 2 ? 2 : 0 },
 *   ],
 * });
 * // por frame (barato: early-out si la cámara no se movió ≥3 m):
 * scatter.update(camera.position.x, camera.position.z);
 * // colisión (futura fase de jugador):
 * for (const t of scatter.trunks()) { … }   // {x,z,r}
 * for (const b of scatter.blockers()) { … } // {x,z,r} (props solid)
 * ```
 *
 * QUÉ GARANTIZA (invariantes):
 * - `update(camX, camZ)` hace early-out determinista si la cámara no se movió
 *   `SCATTER_STEP = 3` m desde el último escaneo. No depende de `dt`.
 * - **Cero asignaciones por escaneo** tras el calentamiento: no hay `new`,
 *   `.clone()`, `Object3D`/`Matrix4` temporales, strings de clave,
 *   `indexOf(null)` ni `filter/map/sort`. Las matrices se componen inline en
 *   `mesh.instanceMatrix.array` (Float32).
 * - Nada se crea en `update`: todas las `InstancedMesh` (una por variante ×
 *   LOD × primitiva, capacidad `cap[lod]`) nacen en `addLayer`.
 * - Reconciliación de slots sin arrays de pendientes: la propia tabla
 *   `slots[]` (SoA preasignada, longitud ≤ `cap[lod]`) + un `Uint32Array` de
 *   sellos por escaneo identifican los huecos; la free-list los reutiliza en
 *   O(1). Los colisionadores se rellenan desde pools de objetos (high-water
 *   mark): `length = 0` + reuso de entradas, sin basura nueva.
 * - Determinismo total: hash `hash3` de `rng.ts`, orden de celdas y de capas
 *   fijo; `stats().checksum` resume posiciones/variante/LOD del último
 *   escaneo (lo usa `tools/mem-probe.ts --cpu`).
 *
 * CADENA DE ACEPTACIÓN POR CELDA (§7.2, exacta; `field 0` = árboles):
 *   1. `hash(1) > prob · probScale · density(x,z,field)` → saltar
 *   2. `EB(x,z, field===0 ? 'tree' : 'low')` → saltar (landmarks §8)
 *   3. `land(x,z) < 0.6` → saltar (hook; default 1)
 *   4. `roadDist < (field===0 ? 6.2 + hash(2)·2.5 : 4.4)` → saltar (hook; default ∞)
 *   5. `normal.y < 0.82` → saltar (SIEMPRE; el terreno de woods es suave)
 *   6. `field===0 && speciesPick(x,z) != speciesId` → saltar
 *   7. `acceptExtra(x,z,h)` → saltar si devuelve false (hooks de props)
 * Después: LOD por distancia (`lodDist[i] · lodScale`, tiers con `cap<=0`
 * deshabilitados) → cap por LOD (`cap[i]`, aceptados de la capa en ese tier
 * antes de la variante, §7.2) → `variant = floor(hash(5)·variants)` → cap del
 * pool concreto (seguro adicional).
 *
 * POSICIÓN: `(cell + inset + hash·span) · cellSize` con `inset/span` por capa
 * (árboles por defecto `.12/.76`, props `.1/.8`). `y = height(x,z) - sink·escala`.
 * ============================================================================
 */

/** Paso mínimo de cámara (m) para reescanear (§7.2). Expuesto para tests. */
export const SCATTER_STEP = 3;

/**
 * Sales de `hash3(cellX, cellZ, salt)` usadas por el motor. Las capas pueden
 * llamar a `h(salt)` desde `acceptExtra`; los sellos 1..5 están tomados por el
 * motor (mismos valores que RW donde el doc los fija) y ≥6 quedan libres.
 */
export const SALT = {
  /** §7.2, paso 1: `hash(1) > prob·treeScale·density`. */
  prob: 1,
  /** §7.2, paso 4: bonus aleatorio de distancia a camino. */
  road: 2,
  /** Escala `mix(scale0, scale1, hash)`. */
  scale: 3,
  /** Rotación Y `hash·2π`. */
  rot: 4,
  /** `floor(hash·variants)`. */
  variant: 5,
  /** Offset X dentro de la celda (§7.2: `+0.12+hash·0.76`). */
  posX: 11,
  /** Offset Z dentro de la celda. */
  posZ: 12,
} as const;

/** Radios de bloqueo de landmarks §8 (m): tipo → {tree, low, grass}. */
export const LANDMARK_VB = {
  cabin: { tree: 14, low: 8, grass: 4.5 },
  stones: { tree: 22, low: 12, grass: 0 },
} as const;
export type LandmarkKind = keyof typeof LANDMARK_VB;

/** Retícula de landmarks: 320 m, 20 % de ocupación determinista (§8). */
export const LANDMARK_GRID = 320;
export const LANDMARK_CHANCE = 0.2;
/** Sitio por defecto de RW en woods (tipo `stones`, grass 0 → sin claro). */
export const DEFAULT_SITE = { x: -35, z: -54, kind: 'stones' } as const;

const DEFAULT_CELL_X = Math.floor(DEFAULT_SITE.x / LANDMARK_GRID);
const DEFAULT_CELL_Z = Math.floor(DEFAULT_SITE.z / LANDMARK_GRID);
const SALT_LANDMARK = 101;
const SALT_LANDMARK_TYPE = 102;
const SALT_LANDMARK_X = 103;
const SALT_LANDMARK_Z = 104;

const CELL_OFF = 1 << 20;
const CELL_STRIDE = 1 << 21;
const STEP2 = SCATTER_STEP * SCATTER_STEP;
/** Distancias máximas de colisionador (m): tronco §7.3, prop solid §8. */
const TRUNK_RANGE2 = 40 * 40;
const SOLID_RANGE2 = 36 * 36;

export interface ScatterPrimitive {
  /** Id numérico estable de la primitiva (0 = tronco, 1 = follaje, …). Sirve
   *  para instrumentación; las mallas NO se comparten aunque el `key` coincida. */
  key: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** `castShadow` de la malla (T4.2.3: LOD0/1 sí, LOD2 no). */
  shadow: boolean;
  /** Capa de render: 2 = solo árboles con sombra; 0 = normal (§2.3). */
  layer?: number;
}

/**
 * Una capa de scatter. Tanto árboles (`field 0`) como props (`field 1`) usan
 * la misma cadena de aceptación; los hooks (`density`, `land`, `roadDist`,
 * `speciesPick`, `acceptExtra`, `orient`) permiten ajustarla por capa.
 */
export interface ScatterLayer {
  /**
   * Id determinista y estable. En capas `field 0` (árboles) es la especie que
   * vota `speciesPick` (fir 0 / pine 1) salvo que se fije `speciesId`.
   */
  id: number;
  /** 0 = árboles grandes (sombrean/colisionan); 1 = sotobosque/props (§7.1). */
  field: 0 | 1;
  cellSize: number;
  prob: number;
  variants: number;
  /** Distancias de LOD (m) antes de multiplicar por `lodScale`. */
  lodDist: readonly [number, number, number];
  /** Capacidad de cada pool por LOD. `cap[lod] <= 0` deshabilita ese tier. */
  cap: readonly [number, number, number];
  scale: readonly [number, number];
  sink: number;
  /** Misma longitud en todas las variantes para un mismo `lod`. */
  primitives(variant: number, lod: number): ScatterPrimitive[];
  /** Árbol: radio de tronco base. `>0` → colisionador si dist < 40 m (§7.3). */
  trunkRadius?: number;
  /**
   * Prop `solid`: semi-ejes (radios, m) de la elipse en el plano local XZ.
   * Se convierte en cadena de círculos (§8); ver `pushBlockerChain`.
   */
  solidRadius?: readonly [number, number];
  /** Offset dentro de la celda (default árboles `.12`; props usan `.1`). */
  inset?: number;
  /** Ancho del jitter dentro de la celda (default árboles `.76`; props `.8`). */
  span?: number;
  /** Escala de distancias de LOD (default `QUALITY[quality].trees`). */
  lodScale?: number;
  /** Escala de la probabilidad (default `QUALITY[quality].trees`). */
  probScale?: number;
  /** Especie que vota esta capa en `field 0` (default `id`). */
  speciesId?: number;
  /** Densidad de aceptación (default §7.2 por `field`). Sin allocs. */
  density?(x: number, z: number, field: 0 | 1): number;
  /** Máscara de terreno (default 1). Acepta si `land >= 0.6`. Sin allocs. */
  land?(x: number, z: number): number;
  /** Distancia a camino (default `Infinity`). Sin allocs. */
  roadDist?(x: number, z: number): number;
  /** Reparto fir/pine (default §7.2). Solo se consulta si `field === 0`. */
  speciesPick?(x: number, z: number): number;
  /**
   * Rechazo extra al final de la cadena (p. ej. `patch` de props). `h(salt)` es
   * `hash3(cellX, cellZ, salt)` de la celda actual; salt 1 = roll de
   * probabilidad, 2 = camino, 3..5 = escala/rot/variante, ≥6 libres.
   */
  acceptExtra?(x: number, z: number, h: (salt: number) => number): boolean;
  /**
   * Alineación opcional (props). Si devuelve `true` se usa `out` (quaternion
   * unitario) tal cual; si `false` se aplica la rotación Y de `hash(4)·2π`.
   * La capa es responsable de componer yaw + inclinación en `out`.
   */
  orient?(x: number, z: number, out: THREE.Quaternion): boolean;
}

export interface TrunkCollider {
  x: number;
  z: number;
  r: number;
}

export interface ScatterSystem {
  readonly group: THREE.Group;
  addLayer(layer: ScatterLayer): void;
  update(camX: number, camZ: number): void;
  trunks(): readonly TrunkCollider[];
  blockers(): readonly TrunkCollider[];
  stats(): Record<string, number>;
  dispose(): void;
}

// --- Estado interno ---------------------------------------------------------

interface PrimitiveMesh {
  readonly mesh: THREE.InstancedMesh;
  /** `mesh.instanceMatrix.array` cacheado: compose inline sin indirecciones. */
  readonly array: Float32Array;
}

/** Pool de slots de un (capa, variante, LOD): tabla + free-list + sellos. */
interface PoolGroup {
  readonly lod: number;
  readonly variant: number;
  readonly capacity: number;
  readonly meshes: PrimitiveMesh[];
  readonly slots: (number | null)[];
  readonly slotOf: Map<number, number>;
  readonly free: number[];
  /** `stamps[slot] === gen` ⇒ el slot fue aceptado en el escaneo actual. */
  readonly stamps: Uint32Array;
}

interface SkipCounts {
  prob: number;
  eb: number;
  land: number;
  road: number;
  slope: number;
  species: number;
  extra: number;
  lod: number;
  cap: number;
}

interface LayerDbg {
  id: number;
  field: number;
  cellSize: number;
  pools: number;
  placed: number;
  lod: number[];
  variants: number[];
  skipped: SkipCounts;
}

interface LayerState {
  readonly def: ScatterLayer;
  readonly field: 0 | 1;
  readonly lodEnabled: boolean[];
  readonly inset: number;
  readonly span: number;
  readonly lodScale: number;
  readonly probScale: number;
  readonly densityFn: ((x: number, z: number, field: 0 | 1) => number) | null;
  readonly landFn: ((x: number, z: number) => number) | null;
  readonly roadFn: ((x: number, z: number) => number) | null;
  readonly speciesPickFn: ((x: number, z: number) => number) | null;
  readonly extraFn: ((x: number, z: number, h: (salt: number) => number) => boolean) | null;
  readonly orientFn: ((x: number, z: number, out: THREE.Quaternion) => boolean) | null;
  readonly speciesId: number;
  readonly groups: (PoolGroup | null)[];
  readonly dbg: LayerDbg;
  readonly cell: { x: number; z: number };
  readonly hSalt: (salt: number) => number;
  placed: number;
  readonly lodCount: [number, number, number];
  readonly variantCount: number[];
  readonly skip: SkipCounts;
}

function dbgRef(): Dbg | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

/** `smoothstep(e0, e1, x)` de la GPU: clamp + polinomio 3t²-2t³. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Clave numérica de celda (sin strings): única para |cell| < 2²⁰. */
function cellKey(cx: number, cz: number): number {
  return (cx + CELL_OFF) * CELL_STRIDE + (cz + CELL_OFF);
}

function resetSkip(s: SkipCounts): void {
  s.prob = 0;
  s.eb = 0;
  s.land = 0;
  s.road = 0;
  s.slope = 0;
  s.species = 0;
  s.extra = 0;
  s.lod = 0;
  s.cap = 0;
}

/**
 * Compose inline (sin `Matrix4`): columna-mayor como `Matrix4.toArray`, con
 * escala uniforme `s`, quaternion (qx,qy,qz,qw) y traslación (px,py,pz).
 */
function writeMatrix(
  m: Float32Array,
  slot: number,
  px: number,
  py: number,
  pz: number,
  s: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): void {
  const o = slot * 16;
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  m[o] = (1 - (yy + zz)) * s;
  m[o + 1] = (xy + wz) * s;
  m[o + 2] = (xz - wy) * s;
  m[o + 3] = 0;
  m[o + 4] = (xy - wz) * s;
  m[o + 5] = (1 - (xx + zz)) * s;
  m[o + 6] = (yz + wx) * s;
  m[o + 7] = 0;
  m[o + 8] = (xz + wy) * s;
  m[o + 9] = (yz - wx) * s;
  m[o + 10] = (1 - (xx + yy)) * s;
  m[o + 11] = 0;
  m[o + 12] = px;
  m[o + 13] = py;
  m[o + 14] = pz;
  m[o + 15] = 1;
}

/** Hueco: `scale(.001) pos(0,-500,0)` (§7.3), fuera de cámara y de la niebla. */
function writeDegenerate(m: Float32Array, slot: number): void {
  const o = slot * 16;
  for (let i = 0; i < 16; i++) m[o + i] = 0;
  m[o] = 0.001;
  m[o + 5] = 0.001;
  m[o + 10] = 0.001;
  m[o + 13] = -500;
  m[o + 15] = 1;
}

function createScatter(
  heightfield: HeightfieldEx,
  quality: Quality,
  scene: THREE.Scene,
  shared: Shared,
): ScatterSystem {
  const group = new THREE.Group();
  group.name = 'scatter';
  scene.add(group);

  const dbg = dbgRef();
  const layers: LayerState[] = [];

  // Scratch de por vida del sistema: nada de esto se asigna por escaneo.
  const normalOut = new THREE.Vector3();
  const orientOut = new THREE.Quaternion();
  const trunkPool: TrunkCollider[] = [];
  const trunkList: TrunkCollider[] = [];
  const blockerPool: TrunkCollider[] = [];
  const blockerList: TrunkCollider[] = [];

  // Landmarks del escaneo (máx. 3×3 celdas de 320 m): SoA fija.
  const EB_SITES = 9;
  const ebX = new Float64Array(EB_SITES);
  const ebZ = new Float64Array(EB_SITES);
  const ebTree = new Float64Array(EB_SITES);
  const ebLow = new Float64Array(EB_SITES);
  const ebGrass = new Float64Array(EB_SITES);
  let ebCount = 0;
  let clearX = 0;
  let clearZ = 0;
  let clearR = 0;

  const lodTotals: [number, number, number] = [0, 0, 0];
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let dirty = true;
  let gen = 0;
  let scans = 0;
  let lastScanMs = 0;
  let lastAccepted = 0;
  let checksum = 0;
  let pools = 0;

  const dbgLayers: LayerDbg[] = [];
  const dbgSkipped: SkipCounts = {
    prob: 0, eb: 0, land: 0, road: 0, slope: 0, species: 0, extra: 0, lod: 0, cap: 0,
  };
  const dbgLod: [number, number, number] = [0, 0, 0];
  const dbgScatter: Record<string, unknown> = {
    layers: dbgLayers,
    pools: 0,
    slots: 0,
    total: 0,
    lod: dbgLod,
    skipped: dbgSkipped,
    landmarks: 0,
    checksum: 0,
  };
  const dbgStats: Record<string, number> = {
    layers: 0, pools: 0, slots: 0, live: 0, accepted: 0, trunks: 0, blockers: 0,
    landmarks: 0, scans: 0, lastScanMs: 0, checksum: 0,
  };
  if (dbg) {
    dbg.scatter = dbgScatter;
    dbg.scatterStats = dbgStats;
    dbg.blockers = 0;
  }

  // Hooks globales por defecto (§7.2 / §5.1).
  const defaultDensity = (x: number, z: number, field: 0 | 1): number => {
    if (field === 0) {
      return smoothstep(heightfield.noise(x * 0.55 + 311, z * 0.55 + 97), 0.3, 0.55);
    }
    return smoothstep(heightfield.noise(x * 1.1 + 311, z * 1.1 + 97), 0.38, 0.7);
  };
  const defaultSpeciesPick = (x: number, z: number): number =>
    heightfield.noise(x * 0.35 + 47, z * 0.35 + 5) > 0.5 ? 1 : 0;

  function pushTrunk(x: number, z: number, r: number): void {
    const i = trunkList.length;
    let t = trunkPool[i];
    if (t === undefined) {
      t = { x, z, r };
      trunkPool[i] = t;
    } else {
      t.x = x;
      t.z = z;
      t.r = r;
    }
    trunkList.push(t);
  }

  function pushBlocker(x: number, z: number, r: number): void {
    const i = blockerList.length;
    let b = blockerPool[i];
    if (b === undefined) {
      b = { x, z, r };
      blockerPool[i] = b;
    } else {
      b.x = x;
      b.z = z;
      b.r = r;
    }
    blockerList.push(b);
  }

  /**
   * Elipse `solidRadius` (semi-ejes locales XZ) → cadena de círculos (§8).
   * Fórmula exacta (decisión documentada):
   *   r   = max(0.25, min(rX,rZ) · escala · 0.85)     (radio de cada círculo)
   *   A   = max(rX,rZ) · escala                       (semieje mayor)
   *   span= max(0, A - r)                             (recorrido de los centros)
   *   k   = 1 si span = 0; si no ceil(span/(0.75·r)) + 1
   *   t_i = (i/(k-1))·2·span - span                   (centros, paso ≤ 1.5·r)
   * El eje mayor se lleva al mundo con la rotación del placement y se proyecta
   * a XZ; si queda degenerado (eje casi vertical) se usa (1,0).
   */
  function pushBlockerChain(
    x: number,
    z: number,
    escala: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    rX: number,
    rZ: number,
  ): void {
    const majorX = rX >= rZ;
    let ax: number;
    let az: number;
    if (majorX) {
      // Columna 0 de la matriz (eje X local) proyectada a XZ.
      ax = 1 - 2 * (qy * qy + qz * qz);
      az = 2 * (qx * qz - qw * qy);
    } else {
      // Columna 2 (eje Z local) proyectada a XZ.
      ax = 2 * (qx * qz + qw * qy);
      az = 1 - 2 * (qx * qx + qy * qy);
    }
    const alen = Math.sqrt(ax * ax + az * az);
    if (alen < 1e-3) {
      ax = 1;
      az = 0;
    } else {
      ax /= alen;
      az /= alen;
    }
    const A = (majorX ? rX : rZ) * escala;
    const B = (majorX ? rZ : rX) * escala;
    const r = Math.max(0.25, B * 0.85);
    const span = Math.max(0, A - r);
    const k = span <= 0 ? 1 : Math.ceil(span / (0.75 * r)) + 1;
    for (let i = 0; i < k; i++) {
      const t = k === 1 ? 0 : (i / (k - 1)) * 2 * span - span;
      pushBlocker(x + ax * t, z + az * t, r);
    }
  }

  /** Landmarks visibles desde la cámara (3×3 celdas de 320 m) + uClear. */
  function buildLandmarks(camX: number, camZ: number): void {
    ebCount = 0;
    let bestD2 = Number.POSITIVE_INFINITY;
    let bestX = 0;
    let bestZ = 0;
    let bestGrass = 0;
    const baseI = Math.floor(camX / LANDMARK_GRID);
    const baseJ = Math.floor(camZ / LANDMARK_GRID);
    for (let j = baseJ - 1; j <= baseJ + 1; j++) {
      for (let i = baseI - 1; i <= baseI + 1; i++) {
        let sx: number;
        let sz: number;
        let kind: LandmarkKind;
        if (i === DEFAULT_CELL_X && j === DEFAULT_CELL_Z) {
          // La celda del sitio por defecto hospeda siempre el lugar de RW.
          sx = DEFAULT_SITE.x;
          sz = DEFAULT_SITE.z;
          kind = DEFAULT_SITE.kind;
        } else {
          if (hash3(i, j, SALT_LANDMARK) >= LANDMARK_CHANCE) continue;
          sx = (i + 0.15 + hash3(i, j, SALT_LANDMARK_X) * 0.7) * LANDMARK_GRID;
          sz = (j + 0.15 + hash3(i, j, SALT_LANDMARK_Z) * 0.7) * LANDMARK_GRID;
          kind = hash3(i, j, SALT_LANDMARK_TYPE) < 0.5 ? 'cabin' : 'stones';
        }
        const vb = LANDMARK_VB[kind];
        ebX[ebCount] = sx;
        ebZ[ebCount] = sz;
        ebTree[ebCount] = vb.tree;
        ebLow[ebCount] = vb.low;
        ebGrass[ebCount] = vb.grass;
        ebCount++;
        const ddx = sx - camX;
        const ddz = sz - camZ;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestX = sx;
          bestZ = sz;
          bestGrass = vb.grass;
        }
      }
    }
    if (bestD2 === Number.POSITIVE_INFINITY) {
      clearX = 0;
      clearZ = 0;
      clearR = 0;
    } else {
      clearX = bestX;
      clearZ = bestZ;
      clearR = bestGrass;
    }
  }

  /** `EB(x,z,kind)`: 0 = tree, 1 = low (los dos que usa la cadena). */
  function ebHit(x: number, z: number, kind: 0 | 1): boolean {
    for (let i = 0; i < ebCount; i++) {
      const dx = x - ebX[i];
      const dz = z - ebZ[i];
      const r = kind === 0 ? ebTree[i] : ebLow[i];
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  function checksumAdd(sum: number, x: number, z: number, variant: number, lod: number): number {
    let c = sum;
    c = (c + Math.imul(Math.round(x * 100) | 0, 73856093)) | 0;
    c = (c + Math.imul(Math.round(z * 100) | 0, 19349663)) | 0;
    c = (c + Math.imul(variant + 1, 83492791)) | 0;
    c = (c + Math.imul(lod + 1, 2654435761 | 0)) | 0;
    return c;
  }

  function addLayer(def: ScatterLayer): void {
    if (!(def.variants >= 1)) throw new Error('Scatter: variants debe ser >= 1');
    if (!(def.cellSize > 0)) throw new Error('Scatter: cellSize debe ser > 0');
    const fallbackScale = QUALITY[quality].trees;
    const lodScale = def.lodScale ?? fallbackScale;
    const probScale = def.probScale ?? fallbackScale;
    const inset = def.inset ?? 0.12;
    const span = def.span ?? 0.76;

    const lodEnabled = [false, false, false];
    const groups: (PoolGroup | null)[] = [];
    for (let i = 0; i < 3 * def.variants; i++) groups.push(null);
    let layerPools = 0;
    for (let lod = 0; lod < 3; lod++) {
      const capLod = def.cap[lod];
      if (!(capLod > 0)) continue;
      for (let v = 0; v < def.variants; v++) {
        const prims = def.primitives(v, lod);
        if (prims.length === 0) continue;
        const meshes: PrimitiveMesh[] = [];
        for (let p = 0; p < prims.length; p++) {
          const prim = prims[p];
          const mesh = new THREE.InstancedMesh(prim.geometry, prim.material, capLod);
          mesh.count = 0;
          mesh.name = `scatter:${def.id}:lod${lod}:v${v}:p${prim.key}`;
          mesh.frustumCulled = false;
          mesh.castShadow = prim.shadow;
          mesh.receiveShadow = true;
          mesh.userData.perfGroup = 'Scatter';
          mesh.layers.set(prim.layer ?? 0);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          group.add(mesh);
          meshes.push({ mesh, array: mesh.instanceMatrix.array as Float32Array });
          layerPools++;
        }
        groups[lod * def.variants + v] = {
          lod,
          variant: v,
          capacity: capLod,
          meshes,
          slots: [],
          slotOf: new Map<number, number>(),
          free: [],
          stamps: new Uint32Array(capLod),
        };
        lodEnabled[lod] = true;
      }
    }

    const skip: SkipCounts = {
      prob: 0, eb: 0, land: 0, road: 0, slope: 0, species: 0, extra: 0, lod: 0, cap: 0,
    };
    const layerDbg: LayerDbg = {
      id: def.id,
      field: def.field,
      cellSize: def.cellSize,
      pools: layerPools,
      placed: 0,
      lod: [0, 0, 0],
      variants: new Array<number>(def.variants).fill(0),
      skipped: skip,
    };
    const cell = { x: 0, z: 0 };
    const state: LayerState = {
      def,
      field: def.field,
      lodEnabled,
      inset,
      span,
      lodScale,
      probScale,
      densityFn: def.density ?? null,
      landFn: def.land ?? null,
      roadFn: def.roadDist ?? null,
      speciesPickFn: def.speciesPick ?? null,
      extraFn: def.acceptExtra ?? null,
      orientFn: def.orient ?? null,
      speciesId: def.speciesId ?? def.id,
      groups,
      dbg: layerDbg,
      cell,
      hSalt: (salt: number): number => hash3(cell.x, cell.z, salt),
      placed: 0,
      lodCount: [0, 0, 0],
      variantCount: new Array<number>(def.variants).fill(0),
      skip,
    };
    layers.push(state);
    dbgLayers.push(layerDbg);
    pools += layerPools;
    dbgScatter.pools = pools;
    dbgStats.pools = pools;
    dbgStats.layers = layers.length;
    dirty = true;
  }

  function resetLayerScan(L: LayerState): void {
    L.placed = 0;
    L.lodCount[0] = 0;
    L.lodCount[1] = 0;
    L.lodCount[2] = 0;
    for (let i = 0; i < L.variantCount.length; i++) L.variantCount[i] = 0;
    resetSkip(L.skip);
  }

  function scan(camX: number, camZ: number): void {
    buildLandmarks(camX, camZ);
    const t0 = performance.now();
    checksum = 0;
    lastAccepted = 0;
    lodTotals[0] = 0;
    lodTotals[1] = 0;
    lodTotals[2] = 0;

    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      resetLayerScan(L);
      const def = L.def;
      const cell = def.cellSize;
      const R = def.lodDist[2] * L.lodScale;
      const R2 = R * R;
      const n = Math.ceil(R / cell);
      const baseX = Math.floor(camX / cell);
      const baseZ = Math.floor(camZ / cell);
      const prob = def.prob * L.probScale;
      const s0 = def.scale[0];
      const s1 = def.scale[1];
      const sink = def.sink;
      const isTree = def.field === 0;
      const variants = def.variants;
      const skip = L.skip;

      for (let iz = -n; iz <= n; iz++) {
        const cz = baseZ + iz;
        for (let ix = -n; ix <= n; ix++) {
          const cx = baseX + ix;
          const x = (cx + L.inset + hash3(cx, cz, SALT.posX) * L.span) * cell;
          const z = (cz + L.inset + hash3(cx, cz, SALT.posZ) * L.span) * cell;
          const ddx = x - camX;
          const ddz = z - camZ;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= R2) continue;

          // 1) probabilidad × densidad.
          const dens = L.densityFn === null
            ? defaultDensity(x, z, def.field)
            : L.densityFn(x, z, def.field);
          if (hash3(cx, cz, SALT.prob) > prob * dens) {
            skip.prob++;
            continue;
          }

          // 2) bloqueo de landmarks.
          if (ebHit(x, z, isTree ? 0 : 1)) {
            skip.eb++;
            continue;
          }

          // 3) máscara de terreno.
          const land = L.landFn === null ? 1 : L.landFn(x, z);
          if (land < 0.6) {
            skip.land++;
            continue;
          }

          // 4) distancia a camino.
          if (L.roadFn !== null) {
            const minRoad = isTree ? 6.2 + hash3(cx, cz, SALT.road) * 2.5 : 4.4;
            if (L.roadFn(x, z) < minRoad) {
              skip.road++;
              continue;
            }
          }

          // 5) pendiente (siempre; el terreno de woods es suave).
          heightfield.normal(x, z, normalOut);
          if (normalOut.y < 0.82) {
            skip.slope++;
            continue;
          }

          // 6) voto de especie (solo árboles grandes).
          if (isTree) {
            const pick = L.speciesPickFn === null ? defaultSpeciesPick(x, z) : L.speciesPickFn(x, z);
            if (pick !== L.speciesId) {
              skip.species++;
              continue;
            }
          }

          // 7) rechazo extra de la capa (patch de props, …).
          if (L.extraFn !== null) {
            L.cell.x = cx;
            L.cell.z = cz;
            if (!L.extraFn(x, z, L.hSalt)) {
              skip.extra++;
              continue;
            }
          }

          // LOD por distancia; tiers con cap 0 quedan deshabilitados.
          let lod = -1;
          for (let i = 0; i < 3; i++) {
            if (!L.lodEnabled[i]) continue;
            const dl = def.lodDist[i] * L.lodScale;
            if (d2 < dl * dl) {
              lod = i;
              break;
            }
          }
          if (lod < 0) {
            skip.lod++;
            continue;
          }
          // Cap por LOD ANTES de la variante (§7.2: "LOD, luego cap, luego
          // variante"). `lodCount` ya cuenta lo aceptado en este escaneo.
          if (L.lodCount[lod] >= def.cap[lod]) {
            skip.cap++;
            continue;
          }

          const variant = Math.min(
            variants - 1,
            Math.floor(hash3(cx, cz, SALT.variant) * variants),
          );
          const g = L.groups[lod * variants + variant];
          if (g === null || (g.free.length === 0 && g.slots.length >= g.capacity)) {
            skip.cap++;
            continue;
          }

          const scale = s0 + (s1 - s0) * hash3(cx, cz, SALT.scale);
          const y = heightfield.height(x, z) - sink * scale;

          let qx = 0;
          let qy = 0;
          let qz = 0;
          let qw = 1;
          let aligned = false;
          if (L.orientFn !== null && L.orientFn(x, z, orientOut)) {
            qx = orientOut.x;
            qy = orientOut.y;
            qz = orientOut.z;
            qw = orientOut.w;
            aligned = true;
          }
          if (!aligned) {
            const half = hash3(cx, cz, SALT.rot) * Math.PI;
            qy = Math.sin(half);
            qw = Math.cos(half);
          }

          const key = cellKey(cx, cz);
          const existing = g.slotOf.get(key);
          let slot: number;
          if (existing !== undefined) {
            slot = existing;
          } else if (g.free.length > 0) {
            slot = g.free[g.free.length - 1];
            g.free.length--;
            g.slots[slot] = key;
            g.slotOf.set(key, slot);
          } else {
            slot = g.slots.length;
            g.slots.push(key);
            g.slotOf.set(key, slot);
          }
          g.stamps[slot] = gen;
          const meshes = g.meshes;
          for (let m = 0; m < meshes.length; m++) {
            writeMatrix(meshes[m].array, slot, x, y, z, scale, qx, qy, qz, qw);
          }

          L.placed++;
          L.lodCount[lod]++;
          L.variantCount[variant]++;
          lastAccepted++;
          lodTotals[lod]++;
          checksum = checksumAdd(checksum, x, z, variant, lod);

          if (def.trunkRadius !== undefined && def.trunkRadius > 0 && d2 < TRUNK_RANGE2) {
            pushTrunk(x, z, def.trunkRadius * scale);
          }
          if (def.solidRadius !== undefined && d2 < SOLID_RANGE2) {
            pushBlockerChain(x, z, scale, qx, qy, qz, qw, def.solidRadius[0], def.solidRadius[1]);
          }
        }
      }

      // Volcado de instrumentación de la capa (sin allocs: muta in-place).
      const ld = L.dbg;
      ld.placed = L.placed;
      ld.lod[0] = L.lodCount[0];
      ld.lod[1] = L.lodCount[1];
      ld.lod[2] = L.lodCount[2];
      for (let vi = 0; vi < ld.variants.length; vi++) ld.variants[vi] = L.variantCount[vi];
      const ls = ld.skipped;
      ls.prob = skip.prob;
      ls.eb = skip.eb;
      ls.land = skip.land;
      ls.road = skip.road;
      ls.slope = skip.slope;
      ls.species = skip.species;
      ls.extra = skip.extra;
      ls.lod = skip.lod;
      ls.cap = skip.cap;
    }

    reconcile();
    shared.uClear.value.set(clearX, clearZ, clearR);

    scans++;
    lastScanMs = performance.now() - t0;
    if (dbg) {
      dbgSkipped.prob = 0;
      dbgSkipped.eb = 0;
      dbgSkipped.land = 0;
      dbgSkipped.road = 0;
      dbgSkipped.slope = 0;
      dbgSkipped.species = 0;
      dbgSkipped.extra = 0;
      dbgSkipped.lod = 0;
      dbgSkipped.cap = 0;
      let slots = 0;
      let live = 0;
      let trunks = trunkList.length;
      let blockers = blockerList.length;
      for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        const ls = L.skip;
        dbgSkipped.prob += ls.prob;
        dbgSkipped.eb += ls.eb;
        dbgSkipped.land += ls.land;
        dbgSkipped.road += ls.road;
        dbgSkipped.slope += ls.slope;
        dbgSkipped.species += ls.species;
        dbgSkipped.extra += ls.extra;
        dbgSkipped.lod += ls.lod;
        dbgSkipped.cap += ls.cap;
        for (let gi = 0; gi < L.groups.length; gi++) {
          const g = L.groups[gi];
          if (g === null) continue;
          slots += g.slots.length;
          for (let si = 0; si < g.slots.length; si++) {
            if (g.slots[si] !== null) live++;
          }
        }
      }
      dbgLod[0] = lodTotals[0];
      dbgLod[1] = lodTotals[1];
      dbgLod[2] = lodTotals[2];
      dbgScatter.total = lastAccepted;
      dbgScatter.slots = slots;
      dbgScatter.live = live;
      dbgScatter.landmarks = ebCount;
      dbgScatter.checksum = checksum >>> 0;
      dbg.scatterChecksum = checksum >>> 0;
      dbg.blockers = trunks + blockers;
      dbgStats.slots = slots;
      dbgStats.live = live;
      dbgStats.accepted = lastAccepted;
      dbgStats.trunks = trunks;
      dbgStats.blockers = blockers;
      dbgStats.landmarks = ebCount;
      dbgStats.scans = scans;
      dbgStats.lastScanMs = Math.round(lastScanMs * 100) / 100;
      dbgStats.checksum = checksum >>> 0;
    }
  }

  /** Libera los slots no aceptados en el escaneo, poda colas y publica `count`. */
  function reconcile(): void {
    for (let li = 0; li < layers.length; li++) {
      const groups = layers[li].groups;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g === null) continue;
        const slots = g.slots;
        for (let i = 0; i < slots.length; i++) {
          const key = slots[i];
          if (key !== null && g.stamps[i] !== gen) {
            slots[i] = null;
            g.slotOf.delete(key);
            g.free.push(i);
            const meshes = g.meshes;
            for (let m = 0; m < meshes.length; m++) writeDegenerate(meshes[m].array, i);
          }
        }
        let end = slots.length;
        while (end > 0 && slots[end - 1] === null) end--;
        if (end !== slots.length) {
          slots.length = end;
          let w = 0;
          for (let i = 0; i < g.free.length; i++) {
            const f = g.free[i];
            if (f < end) g.free[w++] = f;
          }
          g.free.length = w;
        }
        const meshes = g.meshes;
        for (let m = 0; m < meshes.length; m++) {
          meshes[m].mesh.count = slots.length;
          meshes[m].mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  function update(camX: number, camZ: number): void {
    const dx = camX - lastX;
    const dz = camZ - lastZ;
    if (!dirty && dx * dx + dz * dz < STEP2) return;
    lastX = camX;
    lastZ = camZ;
    dirty = false;
    gen = (gen + 1) >>> 0;
    if (gen === 0) {
      // El contador uint32 se agotaría tras ~4e9 escaneos: reinicia los sellos.
      for (let li = 0; li < layers.length; li++) {
        const groups = layers[li].groups;
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          if (g !== null) g.stamps.fill(0);
        }
      }
      gen = 1;
    }
    trunkList.length = 0;
    blockerList.length = 0;
    scan(camX, camZ);
  }

  function stats(): Record<string, number> {
    let slots = 0;
    let live = 0;
    for (let li = 0; li < layers.length; li++) {
      const groups = layers[li].groups;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g === null) continue;
        slots += g.slots.length;
        for (let si = 0; si < g.slots.length; si++) {
          if (g.slots[si] !== null) live++;
        }
      }
    }
    return {
      layers: layers.length,
      pools,
      slots,
      live,
      accepted: lastAccepted,
      trunks: trunkList.length,
      blockers: blockerList.length,
      landmarks: ebCount,
      scans,
      lastScanMs: Math.round(lastScanMs * 100) / 100,
      checksum: checksum >>> 0,
    };
  }

  function dispose(): void {
    scene.remove(group);
    for (let li = 0; li < layers.length; li++) {
      const groups = layers[li].groups;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g === null) continue;
        for (let m = 0; m < g.meshes.length; m++) {
          g.meshes[m].mesh.removeFromParent();
          g.meshes[m].mesh.dispose();
        }
        g.slots.length = 0;
        g.slotOf.clear();
        g.free.length = 0;
      }
    }
    layers.length = 0;
    dbgLayers.length = 0;
    // Geometrías y materiales son del llamante (S4b/S4c): no se disponen aquí.
  }

  return {
    group,
    addLayer,
    update,
    trunks(): readonly TrunkCollider[] {
      return trunkList;
    },
    blockers(): readonly TrunkCollider[] {
      return blockerList;
    },
    stats,
    dispose,
  };
}

export { createScatter };
