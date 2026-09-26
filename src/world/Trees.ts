import * as THREE from 'three/webgpu';
import {
  Fn,
  clamp,
  cos,
  hash,
  instanceIndex,
  mx_noise_float,
  positionGeometry,
  positionLocal,
  positionPrevious,
  sin,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool } from '../core/params';
import type { Shared } from '../core/shared';
import type { ScatterLayer, ScatterPrimitive, ScatterSystem } from './Scatter';
import {
  buildSpeciesGeometries,
  TREE_VARIANTS,
  type TreeSpecies,
  type TreeSpeciesGeo,
} from './treeGeometry';

declare module '../core/dbg' {
  interface Dbg {
    trees?: Record<string, unknown>;
  }
}

/**
 * Trees — integración de las 4 especies en el motor `Scatter` (T4.2.3).
 *
 * Tabla §7.1 EXACTA (variantes, distancias de LOD, radio de tronco, escala,
 * celda, probabilidad, capacidades y campo). `lodScale`/`probScale` =
 * `QUALITY[quality].trees`. `sink` = 0.08 en las 4 especies: RW camper usa 0.7
 * para pine (entierra el tronco grueso), pero aquí se mantiene el anclaje
 * uniforme y documentado del prompt.
 *
 * Sway §7.4 como `positionNode` (tronco suave; follaje con 2 octavas extra) y
 * `positionPrevious` escrito en el mismo grafo para el velocity MRT de F6.
 * `positionLocal` ya lleva la transformada de instancia (igual que
 * `StreetTreeGenerator` de three), así que el desplazamiento se suma ENCIMA de
 * ella; se calcula con `positionGeometry` (atributo crudo) para que `c` y el
 * ruido no dependan de la traslación/escala de la instancia.
 *
 * `?trees=0`: no se registran capas (el grupo `scatter` queda vacío); la
 * geometría se construye igual para que `dispose()` y el debug sean simples.
 */

interface SpeciesDef {
  id: number;
  field: 0 | 1;
  cellSize: number;
  prob: number;
  variants: number;
  lodDist: readonly [number, number, number];
  cap: readonly [number, number, number];
  scale: readonly [number, number];
  sink: number;
  trunkRadius: number;
}

export const SPECIES_TABLE: Record<TreeSpecies, SpeciesDef> = {
  fir: { id: 0, field: 0, cellSize: 8.5, prob: 0.64, variants: 3, lodDist: [22.5, 60, 175], cap: [30, 90, 300], scale: [0.85, 1.2], sink: 0.08, trunkRadius: 0.34 },
  pine: { id: 1, field: 0, cellSize: 8.5, prob: 0.64, variants: 6, lodDist: [22.5, 60, 175], cap: [30, 90, 300], scale: [0.85, 1.2], sink: 0.08, trunkRadius: 0.36 },
  firsap: { id: 2, field: 1, cellSize: 6.5, prob: 0.42, variants: 3, lodDist: [32.5, 75, 110], cap: [40, 100, 240], scale: [0.8, 1.3], sink: 0.08, trunkRadius: 0.07 },
  sapling: { id: 3, field: 1, cellSize: 4.5, prob: 0.38, variants: 3, lodDist: [25, 56.25, 85], cap: [50, 140, 300], scale: [0.9, 1.5], sink: 0.08, trunkRadius: 0 },
};

const BARK_COLOR: Record<TreeSpecies, readonly [number, number, number]> = {
  fir: [0.021, 0.017, 0.013],
  pine: [0.026, 0.02, 0.014],
  firsap: [0.021, 0.017, 0.013],
  sapling: [0.028, 0.024, 0.016],
};

const LEAF_COLOR: Record<TreeSpecies, readonly [number, number, number]> = {
  fir: [0.02, 0.05, 0.016],
  pine: [0.018, 0.042, 0.024],
  firsap: [0.022, 0.056, 0.018],
  sapling: [0.026, 0.062, 0.02],
};

interface SpeciesMaterials {
  bark: THREE.MeshStandardNodeMaterial;
  leaf: THREE.MeshStandardNodeMaterial;
}

export interface TreesEx {
  readonly group: THREE.Group;
  readonly enabled: boolean;
  /** Altura de referencia LOD0 usada por el sway (media de variantes). */
  readonly h0: Record<TreeSpecies, number>;
  /**
   * Debe llamarse cada frame ANTES de `environment.update` (que avanza
   * `shared.uTime`): copia el tiempo del último frame renderizado a
   * `uPrevTime`, que alimenta `positionPrevious` (velocity MRT de F6).
   */
  update(): void;
  dispose(): void;
}

function dbgRef(): Dbg | null {
  return (typeof window === 'undefined' ? null : (window as unknown as { __dbg?: Dbg }).__dbg) ?? null;
}

export function createTrees(scatter: ScatterSystem, quality: Quality, shared: Shared): TreesEx {
  const enabled = pbool('trees', true);
  const treeScale = QUALITY[quality].trees;
  const geos = buildSpeciesGeometries(quality);
  const uPrevTime = uniform(0);

  const speciesNames = Object.keys(SPECIES_TABLE) as TreeSpecies[];

  /**
   * §7.4. `detail` devuelve el desplazamiento (vec3, en la práctica XY→XZ) para
   * un tiempo dado: base con `windDir`, más 2 octavas en follaje (reparto por
   * ejes 0.6 / 0.35 (f1) y 0.4 (f2) / 0.5). El `* wind` final es
   * `shared.uWindStrength`.
   */
  function makeSwayNode(h0: number, foliage: boolean): Node<'vec3'> {
    const build = Fn(() => {
      const raw = positionGeometry;
      const c = clamp(raw.y.div(h0), 0, 1);
      const phase = hash(instanceIndex.add(3)).mul(Math.PI * 2);
      const windDir = shared.uWindDir;
      const gust = shared.uGust.mul(0.6).add(0.4);

      const detail = (time: Shared['uTime']): Node<'vec3'> => {
        const off = vec2(raw.x, raw.z).mul(0.018).sub(windDir.mul(time.mul(0.11)));
        const n = mx_noise_float(vec3(off.x, 0, off.y))
          .mul(0.5)
          .add(0.5)
          .mul(0.7)
          .add(0.3)
          .mul(gust);
        const r = cos(time.mul(0.5).add(phase)).mul(0.35).add(0.65);
        const amp = n.mul(r).mul(1.7).mul(c).mul(c);
        const base = vec3(windDir.x.mul(amp), 0, windDir.y.mul(amp));
        if (!foliage) return base;
        const f1 = sin(time.mul(1.9).add(phase.mul(2)).add(raw.y.mul(0.9)).add(raw.x.mul(0.6)))
          .mul(0.27)
          .mul(c)
          .mul(n);
        const f2 = sin(time.mul(6.5).add(raw.x.mul(3.1)).add(raw.z.mul(2.7)).add(raw.y.mul(4.3)))
          .mul(0.055)
          .mul(n);
        return base.add(
          vec3(
            f1.mul(0.6).add(f2.mul(0.6)),
            f1.mul(0.35).add(f2.mul(0.4)),
            f1.mul(0.5).add(f2.mul(0.5)),
          ),
        );
      };

      const now = detail(shared.uTime).mul(shared.uWindStrength);
      const prev = detail(uPrevTime).mul(shared.uWindStrength);
      // Mismo desplazamiento con t - dt: el uniform uPrevTime se copia por
      // frame desde Trees.update() antes de que Environment avance uTime.
      positionPrevious.assign(positionPrevious.add(prev));
      return positionLocal.add(now);
    });
    return build();
  }

  function makeMaterials(species: TreeSpecies, h0: number): SpeciesMaterials {
    const bark = new THREE.MeshStandardNodeMaterial();
    bark.name = `${species}:bark`;
    bark.color.setRGB(...BARK_COLOR[species]);
    bark.roughness = 0.95;
    bark.metalness = 0;
    bark.envMapIntensity = 0.4;
    bark.positionNode = makeSwayNode(h0, false);

    const leaf = new THREE.MeshStandardNodeMaterial();
    leaf.name = `${species}:leaf`;
    leaf.color.setRGB(...LEAF_COLOR[species]);
    leaf.roughness = 0.9;
    leaf.metalness = 0;
    leaf.side = THREE.DoubleSide;
    // Sin texturas el follaje es opaco: alphaTest no recorta nada hoy, pero
    // deja el material listo si una fase futura añade un alpha map.
    leaf.alphaTest = 0.5;
    leaf.envMapIntensity = 0.5;
    leaf.positionNode = makeSwayNode(h0, true);
    return { bark, leaf };
  }

  function meanH0(g: TreeSpeciesGeo): number {
    let sum = 0;
    for (const h of g.h0) sum += h;
    return sum / g.h0.length;
  }

  function primitivesFor(
    g: TreeSpeciesGeo,
    mats: SpeciesMaterials,
  ): (variant: number, lod: number) => ScatterPrimitive[] {
    return (variant, lod) => {
      // Misma longitud (1–2) en todas las variantes de un LOD: LOD0/1 llevan
      // tronco+follaje; LOD2 solo la silueta (tronco horneado, `trunks = null`).
      const out: ScatterPrimitive[] = [];
      const trunk = g.trunks[variant][lod];
      if (trunk !== null) {
        out.push({ key: 0, geometry: trunk, material: mats.bark, shadow: lod < 2, layer: lod < 2 ? 2 : 0 });
      }
      const leaf = g.foliage[variant][lod];
      if (leaf !== null) {
        out.push({ key: 1, geometry: leaf, material: mats.leaf, shadow: lod < 2, layer: lod < 2 ? 2 : 0 });
      }
      return out;
    };
  }

  const materials = {} as Record<TreeSpecies, SpeciesMaterials>;
  const h0 = {} as Record<TreeSpecies, number>;

  for (const species of speciesNames) {
    const g = geos[species];
    h0[species] = meanH0(g);
    materials[species] = makeMaterials(species, h0[species]);
  }

  let drawCalls = 0;
  // Mallas de sombra: 4 por variante (LOD0/1 × tronco/follaje); la silueta
  // LOD2 nunca proyecta sombra (§2.3, T4.2.3).
  let shadowMeshes = 0;
  let lod2Meshes = 0;
  if (enabled) {
    for (const species of speciesNames) {
      const def = SPECIES_TABLE[species];
      if (def.variants !== TREE_VARIANTS[species]) {
        throw new Error(`Trees: variantes de ${species} (${TREE_VARIANTS[species]}) ≠ tabla (${def.variants})`);
      }
      // 5 pools por variante: LOD0/1 (tronco+follaje) + LOD2 (silueta).
      drawCalls += def.variants * 5;
      shadowMeshes += def.variants * 4;
      lod2Meshes += def.variants;
      const layer: ScatterLayer = {
        id: def.id,
        field: def.field,
        cellSize: def.cellSize,
        prob: def.prob,
        variants: def.variants,
        lodDist: def.lodDist,
        cap: def.cap,
        scale: def.scale,
        sink: def.sink,
        trunkRadius: def.trunkRadius > 0 ? def.trunkRadius : undefined,
        lodScale: treeScale,
        probScale: treeScale,
        primitives: primitivesFor(geos[species], materials[species]),
      };
      if (def.field === 0) {
        // speciesPick por defecto del motor: fir = 0, pine = 1 (§7.2). La capa
        // grande solo se registra si su id coincide con el voto.
        layer.speciesId = def.id;
      }
      scatter.addLayer(layer);
    }
  }

  const dbg = dbgRef();
  if (dbg) {
    const perSpecies: Record<string, number> = {};
    const meanHeights: Record<string, number> = {};
    for (const species of speciesNames) {
      perSpecies[species] = SPECIES_TABLE[species].variants;
      meanHeights[species] = Math.round(h0[species] * 100) / 100;
    }
    dbg.trees = {
      enabled,
      quality,
      treeScale,
      variants: perSpecies,
      h0: meanHeights,
      drawCalls: enabled ? drawCalls : 0,
      shadowMeshes: enabled ? shadowMeshes : 0,
      lod2Meshes: enabled ? lod2Meshes : 0,
      sink: 0.08,
      sway: 'positionNode + positionPrevious (uPrevTime)',
      layers: enabled ? speciesNames.length : 0,
    };
  }

  function update(): void {
    // uTime aún no ha avanzado este frame (Environment lo hace después):
    // copiarlo aquí es exactamente t - dt del frame anterior.
    uPrevTime.value = shared.uTime.value;
  }

  function dispose(): void {
    const seen = new Set<THREE.BufferGeometry>();
    for (const species of speciesNames) {
      const g = geos[species];
      for (let v = 0; v < g.foliage.length; v++) {
        for (let lod = 0; lod < 3; lod++) {
          const parts = [g.foliage[v][lod], g.trunks[v][lod]];
          for (const part of parts) {
            if (part !== null && !seen.has(part)) {
              seen.add(part);
              part.dispose();
            }
          }
        }
      }
      materials[species].bark.dispose();
      materials[species].leaf.dispose();
    }
  }

  return {
    group: scatter.group,
    enabled,
    h0,
    update,
    dispose,
  };
}
