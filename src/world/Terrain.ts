import * as THREE from 'three/webgpu';
import { WORLD, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import type { HeightfieldEx } from './Heightfield';

/**
 * Pool en anillo de tiles de terreno (T2.2.3, §5.2). Reutiliza `GRID²` mallas
 * (`WORLD.grid = 11` → 121 en woods) y **una sola** `PlaneGeometry`/malla por
 * tile con un material compartido. `update(cx, cz)` solo reconstruye al cruzar
 * la frontera de un tile de 32 m: calcula deseadas/faltantes/liberadas, las
 * empareja 1:1 y reescribe posición y normal desde el `Heightfield`.
 *
 * El material es world-space, así que no hay costuras entre tiles; las alturas
 * de los vértices compartidos coinciden al muestrear el mismo heightfield en
 * las mismas coordenadas de mundo.
 */
export interface TerrainEx {
  group: THREE.Group;
  /** Early-out por tile de 32 m. Se llama cada frame, sin allocs. */
  update(cx: number, cz: number): void;
  dispose(): void;
  readonly tileCount: number;
}

// Campos que F2b añade a `__dbg`; dbg.ts (F0) no se toca, se aumenta aquí.
declare module '../core/dbg' {
  interface Dbg {
    terrainUpdateMs?: number;
    terrainTier?: Quality;
  }
}

interface Tile {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.PlaneGeometry;
  readonly position: THREE.BufferAttribute;
  readonly normal: THREE.BufferAttribute;
  tx: number;
  tz: number;
  wanted: boolean;
}

/** Tiles a cada lado del tile central (GRID impar). */
const HALF = (WORLD.grid - 1) / 2;
/** Radio mínimo de la bounding sphere: parche de RW que evita culling de tiles hundidos. */
const MIN_RADIUS = 31.04;
/** Claves numéricas de tile (tx/tz caben de sobra en ±2²⁰). */
const KEY_OFF = 1 << 20;
const KEY_STRIDE = 1 << 21;

function keyOf(tx: number, tz: number): number {
  return (tx + KEY_OFF) * KEY_STRIDE + (tz + KEY_OFF);
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createTerrain(
  heightfield: HeightfieldEx,
  material: THREE.Material,
  quality: Quality,
): TerrainEx {
  const group = new THREE.Group();
  group.name = 'terrain';

  const slots: Tile[] = [];
  const byKey = new Map<number, Tile>();
  // Scratch de módulo reutilizado en cada update: cero allocs por frame.
  const missing: number[] = [];
  const freed: Tile[] = [];
  const scratchNormal = new THREE.Vector3();

  let lastTx = Number.NaN;
  let lastTz = Number.NaN;

  const dbg = dbgRef();
  // El anillo lo fija WORLD.grid (woods = 11, independiente del tier); la
  // calidad solo etiqueta la instrumentación.
  if (dbg) dbg.terrainTier = quality;

  function createTile(): Tile {
    const geometry = new THREE.PlaneGeometry(
      WORLD.tile,
      WORLD.tile,
      WORLD.terrainSegs,
      WORLD.terrainSegs,
    );
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain:tile';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);
    return {
      mesh,
      geometry,
      position: geometry.getAttribute('position') as THREE.BufferAttribute,
      normal: geometry.getAttribute('normal') as THREE.BufferAttribute,
      tx: 0,
      tz: 0,
      wanted: false,
    };
  }

  function build(tile: Tile, tx: number, tz: number): void {
    const cx = tx * WORLD.tile + WORLD.tile / 2;
    const cz = tz * WORLD.tile + WORLD.tile / 2;
    tile.mesh.position.set(cx, 0, cz);

    const pos = tile.position.array as Float32Array;
    const nrm = tile.normal.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const wx = cx + pos[i];
      const wz = cz + pos[i + 2];
      pos[i + 1] = heightfield.height(wx, wz);
      // eps 1.0 al construir tiles (§5.1): normal macro suave y estable.
      heightfield.normal(wx, wz, scratchNormal, 1.0);
      nrm[i] = scratchNormal.x;
      nrm[i + 1] = scratchNormal.y;
      nrm[i + 2] = scratchNormal.z;
    }
    tile.position.needsUpdate = true;
    tile.normal.needsUpdate = true;

    tile.geometry.computeBoundingSphere();
    const sphere = tile.geometry.boundingSphere;
    if (sphere !== null) sphere.radius = Math.max(sphere.radius * 1.05, MIN_RADIUS);
  }

  function update(cx: number, cz: number): void {
    const tx = Math.floor(cx / WORLD.tile);
    const tz = Math.floor(cz / WORLD.tile);
    if (tx === lastTx && tz === lastTz) return; // early-out barato por tile
    lastTx = tx;
    lastTz = tz;
    const t0 = performance.now();

    // Deseadas: rejilla GRID×GRID centrada en el tile actual.
    for (const s of slots) s.wanted = false;
    missing.length = 0;
    for (let i = 0; i < WORLD.grid; i++) {
      const x = tx - HALF + i;
      for (let j = 0; j < WORLD.grid; j++) {
        const z = tz - HALF + j;
        const s = byKey.get(keyOf(x, z));
        if (s !== undefined) s.wanted = true;
        else missing.push(x, z);
      }
    }

    // Liberadas: las asignadas que ya no se desean. |missing| ≥ |freed| siempre,
    // así que emparejamos 1:1 y creamos malla nueva solo al crecer el pool.
    freed.length = 0;
    for (const s of slots) if (!s.wanted) freed.push(s);

    let f = 0;
    for (let m = 0; m + 1 < missing.length; m += 2) {
      let tile: Tile;
      if (f < freed.length) {
        tile = freed[f++];
        byKey.delete(keyOf(tile.tx, tile.tz));
      } else {
        tile = createTile();
        slots.push(tile);
      }
      const ntx = missing[m];
      const ntz = missing[m + 1];
      tile.tx = ntx;
      tile.tz = ntz;
      tile.wanted = true;
      build(tile, ntx, ntz);
      byKey.set(keyOf(ntx, ntz), tile);
    }

    if (dbg) {
      dbg.tiles = slots.length;
      dbg.terrainTriangles = slots.length * WORLD.terrainSegs * WORLD.terrainSegs * 2;
      dbg.terrainUpdateMs = performance.now() - t0;
    }
  }

  function dispose(): void {
    group.removeFromParent();
    for (const s of slots) s.geometry.dispose();
    slots.length = 0;
    byKey.clear();
    // El material es compartido y lo posee el llamante: no se dispone aquí.
  }

  return {
    group,
    update,
    dispose,
    get tileCount(): number {
      return slots.length;
    },
  };
}
