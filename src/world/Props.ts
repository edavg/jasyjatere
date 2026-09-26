import * as THREE from 'three/webgpu';
import { QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { hash3 } from '../core/rng';
import type { Shared } from '../core/shared';
import type { HeightfieldEx } from './Heightfield';
import { SALT, type ScatterLayer, type ScatterSystem } from './Scatter';
import { buildPropGeometries, geometryTriangles, type PropId, type PropGeo } from './propsGeometry';

declare module '../core/dbg' {
  interface Dbg {
    props?: Record<string, unknown>;
  }
}

/**
 * ============================================================================
 * Props — 8 capas de scatter de sotobosque para woods (T4.2.4, §8).
 *
 * Una capa por tipo, `field 1`, id de capa = índice en `PROPS` (0..7, estable).
 * Los `shoreOnly` (`rock_face_*`, `boulder_01`) NO se generan en woods.
 *
 * DECISIONES (documentadas por exigencia de T4.2.4):
 * - **LOD único**: §8 no define LODs de props. El motor exige 3 tiers, así que
 *   `lodDist = [r, r, r]` (el radio de escaneo usa el índice 2) y
 *   `cap = [cap, 0, 0]` (`cap<=0` deshabilita el tier). `propsGeometry` solo
 *   produce LOD0 y `primitives()` nunca es llamado con `lod > 0`.
 * - **rScale**: `lodScale = QUALITY[quality].props` (.6/.8/1); `probScale = 1`
 *   (la tabla §8 no escala la probabilidad con la calidad).
 * - **patch** vía hook `density`: para los props con patch, la densidad de
 *   aceptación ES el patch (`hash(1) > prob · patch` → saltar). Los props no
 *   usan la máscara de densidad field-1 de árboles (§7.2): §8 presenta `patch`
 *   como el único modulador probabilístico de props. Fórmula exacta:
 *   `smoothstep(noise(x·s + 700 + n·31, z·s + 33), thr, thr+0.25)` con `n` =
 *   índice del tipo (0..7) y `[s, thr]` de la tabla.
 * - **align** vía hook `orient` (devuelve `true`): inclina el eje +Y local a la
 *   normal del terreno (`heightfield.normal(x, z, out, 1.0)`, eps del doc) y
 *   compone el yaw canónico `hash3(cellX, cellZ, SALT.rot)·2π` alrededor de ese
 *   eje inclinado. La celda se recupera con `floor(x/cellSize)` porque
 *   `inset+span = 0.1+0.8 = 0.9 < 1` → determinista e idéntica al yaw por
 *   defecto del motor. Sin allocs (scratch de módulo del sistema).
 * - **sink**: el motor hace `y = height - sink·escala` (positivo entierra).
 * - **Rocas musgosas** (`rock_moss_set_01/02`): RW escala `lerp(0.55, 1,
 *   distRoad)`; en woods NO hay caminos (`roadDist = ∞`) → el factor es
 *   exactamente 1 y omitir el lerp es equivalente. Hook futuro (línea de
 *   caminos F?) documentado aquí; hoy no se registra `roadDist`.
 * - **solid** vía `solidRadius` del motor: semiejes XZ de la elipse ANTES de
 *   escala, calculados como el máximo bbox XZ de las variantes del tipo (una
 *   elipse por capa cubre la variante más ancha; el motor convierte a cadena
 *   de círculos y multiplica por la escala del placement).
 * - **Sombras**: `shadow = solid` (§ T4.2.4). Los props quedan en la capa 0,
 *   que la cámara de sombras ya habilita junto a la 2 (§2.3).
 *
 * INTEGRACIÓN (orquestador, en `main.ts` — S4c NO toca `main.ts`):
 *   const props = createProps(scatter, heightfield, quality, shared); // tras trees.addLayer(...)
 *   // por frame: scatter.update(camX, camZ);  (?props=0 → no crear las capas)
 * ============================================================================
 */

export interface PropsEx {
  /** Ids en orden de capa: `ids[i]` es la prop de la capa scatter `i`. */
  readonly ids: readonly PropId[];
  /** Capa scatter (0..7) de cada prop. */
  readonly layerOf: Record<PropId, number>;
  /** Resumen numérico (allocs en la llamada; no está en el bucle por frame). */
  stats(): Record<string, number>;
  /** Libera geometrías y materiales propios. `scatter.dispose()` va aparte. */
  dispose(): void;
}

interface PropDef {
  readonly id: PropId;
  readonly cell: number;
  readonly prob: number;
  readonly radius: number;
  readonly cap: number;
  readonly scale: readonly [number, number];
  readonly align: boolean;
  readonly sink: number;
  readonly foliage: boolean;
  readonly patch: readonly [number, number] | null;
  readonly solid: boolean;
}

/** Tabla §8 EXACTA (woods). Los shoreOnly no están: viven en otras fases. */
const PROPS: readonly PropDef[] = [
  { id: 'fern',             cell: 3.2, prob: 0.50, radius: 55, cap: 140, scale: [0.8, 1.4], align: false, sink: 0.02, foliage: true,  patch: [0.9, 0.45], solid: false },
  { id: 'grass_medium',     cell: 2.6, prob: 0.45, radius: 42, cap: 60,  scale: [0.9, 1.5], align: false, sink: 0.03, foliage: true,  patch: [1.2, 0.40], solid: false },
  { id: 'shrub',            cell: 7.5, prob: 0.32, radius: 60, cap: 60,  scale: [0.8, 1.3], align: false, sink: 0.03, foliage: true,  patch: [0.7, 0.42], solid: false },
  { id: 'rock_moss_set_01', cell: 12,  prob: 0.30, radius: 90, cap: 30,  scale: [0.8, 1.6], align: true,  sink: 0.06, foliage: false, patch: null,        solid: true  },
  { id: 'rock_moss_set_02', cell: 13,  prob: 0.30, radius: 90, cap: 30,  scale: [0.8, 1.6], align: true,  sink: 0.06, foliage: false, patch: null,        solid: true  },
  { id: 'tree_stump',       cell: 26,  prob: 0.35, radius: 90, cap: 24,  scale: [0.9, 1.3], align: false, sink: 0.04, foliage: false, patch: null,        solid: true  },
  { id: 'dead_tree_trunk',  cell: 40,  prob: 0.40, radius: 60, cap: 8,   scale: [0.9, 1.2], align: true,  sink: 0.05, foliage: false, patch: null,        solid: true  },
  { id: 'dry_branches',     cell: 6,   prob: 0.30, radius: 50, cap: 70,  scale: [0.9, 1.4], align: true,  sink: 0.01, foliage: false, patch: null,        solid: false },
];

function dbgRef(): Dbg | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

/** `smoothstep(e0, e1, x)` de la GPU: clamp + polinomio 3t²−2t³. */
function smoothstep01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function createProps(
  scatter: ScatterSystem,
  heightfield: HeightfieldEx,
  quality: Quality,
  shared: Shared,
): PropsEx {
  void shared; // reservado (viento de follaje F5); hoy no se consume
  const geoById: Record<PropId, PropGeo> = buildPropGeometries();
  const rScale = QUALITY[quality].props;
  const ids: PropId[] = [];
  const layerOf = {} as Record<PropId, number>;
  const dbgLayers: Record<string, unknown>[] = [];
  let trianglesTotal = 0;
  let variantsTotal = 0;
  let solidsTotal = 0;

  // Scratch de por vida (los hooks corren en el escaneo; cero allocs).
  const normalOut = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const qTilt = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();

  for (let n = 0; n < PROPS.length; n++) {
    const def = PROPS[n];
    const geo = geoById[def.id];
    ids.push(def.id);
    layerOf[def.id] = n;

    const variantCount = geo.variants.length;
    variantsTotal += variantCount;

    let hx = 0;
    let hz = 0;
    let tri = 0;
    for (let v = 0; v < variantCount; v++) {
      const g = geo.variants[v][0];
      tri += geometryTriangles(g);
      g.computeBoundingBox();
      const bb = g.boundingBox;
      if (bb !== null) {
        hx = Math.max(hx, (bb.max.x - bb.min.x) * 0.5);
        hz = Math.max(hz, (bb.max.z - bb.min.z) * 0.5);
      }
    }
    trianglesTotal += tri;
    if (def.solid) solidsTotal++;

    // patch §8 (sustituye a la densidad field-1 de árboles; ver cabecera).
    let density: ScatterLayer['density'];
    if (def.patch !== null) {
      const s = def.patch[0];
      const thr = def.patch[1];
      const off = 700 + n * 31;
      density = (x: number, z: number, _field: 0 | 1): number =>
        smoothstep01(thr, thr + 0.25, heightfield.noise(x * s + off, z * s + 33));
    }

    // align: yaw canónico + inclinación a la normal (eps 1.0), sin allocs.
    let orient: ScatterLayer['orient'];
    if (def.align) {
      const cell = def.cell;
      orient = (x: number, z: number, out: THREE.Quaternion): boolean => {
        heightfield.normal(x, z, normalOut, 1.0);
        qTilt.setFromUnitVectors(up, normalOut);
        qYaw.setFromAxisAngle(
          up,
          hash3(Math.floor(x / cell), Math.floor(z / cell), SALT.rot) * Math.PI * 2,
        );
        out.copy(qTilt).multiply(qYaw);
        return true;
      };
    }

    const shadow = def.solid;
    scatter.addLayer({
      id: n,
      field: 1,
      cellSize: def.cell,
      prob: def.prob,
      variants: variantCount,
      lodDist: [def.radius, def.radius, def.radius],
      cap: [def.cap, 0, 0],
      scale: def.scale,
      sink: def.sink,
      inset: 0.1, // §8: posición de celda 0.1 + hash·0.8
      span: 0.8,
      lodScale: rScale,
      probScale: 1,
      density,
      orient,
      solidRadius: def.solid ? [hx, hz] : undefined,
      // `lod` siempre 0: cap=[cap,0,0] deshabilita los tiers 1 y 2.
      primitives: (v: number, lod: number) => [
        { key: 0, geometry: geo.variants[v][lod], material: geo.material, shadow },
      ],
    });

    dbgLayers.push({
      id: def.id,
      layer: n,
      cell: def.cell,
      prob: def.prob,
      radius: def.radius,
      cap: def.cap,
      variants: variantCount,
      triangles: tri,
      foliage: def.foliage,
      patch: def.patch,
      solid: def.solid ? [hx, hz] : null,
    });
  }

  const dbg = dbgRef();
  if (dbg) {
    dbg.props = {
      count: PROPS.length,
      variants: variantsTotal,
      triangles: trianglesTotal,
      solids: solidsTotal,
      layers: dbgLayers,
    };
  }

  function stats(): Record<string, number> {
    return {
      layers: PROPS.length,
      variants: variantsTotal,
      triangles: trianglesTotal,
      solids: solidsTotal,
    };
  }

  function dispose(): void {
    for (let n = 0; n < PROPS.length; n++) {
      const geo = geoById[PROPS[n].id];
      for (let v = 0; v < geo.variants.length; v++) geo.variants[v][0].dispose();
      geo.material.dispose();
    }
  }

  return { ids, layerOf, stats, dispose };
}
