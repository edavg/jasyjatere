import * as THREE from 'three/webgpu';
import { QUALITY, type Quality } from '../core/constants';
import { mulberry32 } from '../core/rng';
import { displaceRadial, droopPlane, fitToBase, mergeGeos, scaledIcosa, taperedTube } from './geometryUtils';

/**
 * treeGeometry — geometrías procedurales de las 4 especies de árbol (§7.1,
 * T4.2.1) con 3 LODs y variantes fijas: fir 3, pine 6, firsap 3, sapling 3.
 * Cero assets: troncos/ramas con `taperedTube`, follaje con `droopPlane` /
 * `scaledIcosa`, fusión con `mergeGeos`.
 *
 * LOD0: detalle completo. LOD1: menos segmentos radiales, pisos y racimos.
 * LOD2: impostor de silueta <100 triángulos — 3 capas cruzadas de una
 * `ShapeGeometry` con el contorno aproximado de la especie (sin atlas, sin
 * texturas), fusionadas en `foliage`; `trunks[v][2] = null` porque el tronco va
 * horneado en la silueta. `variants[v][2]` referencia esa misma malla (el campo
 * `variants` se reserva al merged completo del LOD2 y vale `null` en LOD0/1
 * para no duplicar memoria).
 *
 * Normalización: cada variante/LOD se centra en XZ y apoya la base en y=0.
 * `h0[variant]` = altura de referencia del LOD0 (la que consume el sway §7.4).
 * Para partes emparejadas (tronco+follaje) se usa una bbox de UNIÓN y se
 * traslada ambas por igual (`normalizeParts`, mismo criterio que `fitToBase`
 * pero sin fusionar); el impostor LOD2 ya es una sola malla y usa `fitToBase`.
 *
 * Materiales: NO se crean aquí. Los construye `Trees.ts` porque el sway
 * (`positionNode`) depende de `shared` y de la altura de referencia de especie.
 */

export type TreeSpecies = 'fir' | 'pine' | 'firsap' | 'sapling';

/** Variantes por especie (§7.1). Debe coincidir con `variants.length`. */
export const TREE_VARIANTS: Record<TreeSpecies, number> = {
  fir: 3,
  pine: 6,
  firsap: 3,
  sapling: 3,
};

export interface TreeSpeciesGeo {
  /** `[variant][lod]`: merged completo del LOD2 (impostor); null en LOD0/1. */
  variants: (THREE.BufferGeometry | null)[][];
  /** `[variant][lod]`: tronco+ramas; null en LOD2 (va en la silueta). */
  trunks: (THREE.BufferGeometry | null)[][];
  /** `[variant][lod]`: follaje; en LOD2 es la silueta completa. */
  foliage: (THREE.BufferGeometry | null)[][];
  /** Altura de referencia LOD0 por variante (m). */
  h0: number[];
}

const TWO_PI = Math.PI * 2;

/** Detalle por calidad: high = base, low ≈ 0.83·base (nunca por debajo de `min`). */
function dcount(base: number, t: number): number {
  return Math.max(2, Math.round(base * (0.55 + 0.45 * t)));
}

function rngFor(species: TreeSpecies, variant: number): () => number {
  const seed =
    species === 'fir' ? 1201 : species === 'pine' ? 2203 : species === 'firsap' ? 3307 : 4409;
  return mulberry32(seed * 31 + variant * 977);
}

interface Part {
  trunk: THREE.BufferGeometry | null;
  foliage: THREE.BufferGeometry;
  /** Altura de referencia (bbox de unión) de este LOD. */
  h0: number;
}

/**
 * Centra en XZ y apoya en y=0 el conjunto de partes (misma traslación para
 * todas). Devuelve `max(1, alto)`, igual que `fitToBase`.
 */
function normalizeParts(parts: readonly (THREE.BufferGeometry | null)[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const g of parts) {
    if (g === null) continue;
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb === null) continue;
    if (bb.min.x < minX) minX = bb.min.x;
    if (bb.max.x > maxX) maxX = bb.max.x;
    if (bb.min.y < minY) minY = bb.min.y;
    if (bb.max.y > maxY) maxY = bb.max.y;
    if (bb.min.z < minZ) minZ = bb.min.z;
    if (bb.max.z > maxZ) maxZ = bb.max.z;
  }
  if (!Number.isFinite(minX)) return 1;
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  for (const g of parts) {
    if (g !== null) g.translate(-cx, -minY, -cz);
  }
  return Math.max(1, maxY - minY);
}

/** 2–3 capas cruzadas de una silueta (ShapeGeometry), fusionadas. */
function silhouetteCross(shape: THREE.Shape, layers: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < layers; k++) {
    const g = new THREE.ShapeGeometry(shape, 1);
    g.rotateY((k * Math.PI) / layers);
    parts.push(g);
  }
  return mergeGeos(parts);
}

// --- fir / firsap (coníferas) ----------------------------------------------

interface ConiferSpec {
  baseR: number;
  height: number;
  branchR: number;
  leanX: number;
  leanZ: number;
  crownStart: number;
  floors: number;
  floorT: Float64Array;
  floorAng: Float64Array;
  floorLen: Float64Array;
  floorDroop: Float64Array;
  branches: number;
}

function makeConiferSpec(species: 'fir' | 'firsap', variant: number): ConiferSpec {
  const rng = rngFor(species, variant);
  const big = species === 'fir';
  const height = big ? 13.5 + rng() * 4.5 : 2.05 + rng() * 1.45;
  const floors = big ? 16 : 10;
  const floorT = new Float64Array(floors);
  const floorAng = new Float64Array(floors);
  const floorLen = new Float64Array(floors);
  const floorDroop = new Float64Array(floors);
  for (let i = 0; i < floors; i++) {
    floorT[i] = i / (floors - 1);
    floorAng[i] = i * 2.39996 + rng() * 0.35;
    floorLen[i] = 0.72 + rng() * 0.5;
    floorDroop[i] = 0.2 + rng() * 0.18;
  }
  return {
    baseR: big ? 0.34 : 0.07,
    height,
    branchR: big ? 2.35 + rng() * 0.75 : 0.62 + rng() * 0.26,
    leanX: (rng() - 0.5) * height * 0.02,
    leanZ: (rng() - 0.5) * height * 0.02,
    crownStart: big ? 0.15 : 0.12,
    floors,
    floorT,
    floorAng,
    floorLen,
    floorDroop,
    branches: big ? 5 : 4,
  };
}

function buildConiferParts(spec: ConiferSpec, lod: 0 | 1, t: number): Part {
  const radial = lod === 0 ? dcount(8, t) : dcount(5, t);
  const trunkSegs = lod === 0 ? 8 : 4;
  const floors = lod === 0 ? spec.floors : Math.max(5, Math.round(spec.floors * 0.62));
  const perFloor = lod === 0 ? spec.branches : Math.max(3, spec.branches - 1);
  const H = spec.height;

  const trunk = taperedTube(
    [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(spec.leanX * 0.3, H * 0.34, spec.leanZ * 0.3),
      new THREE.Vector3(spec.leanX * 0.62, H * 0.68, spec.leanZ * 0.62),
      new THREE.Vector3(spec.leanX, H, spec.leanZ),
    ],
    spec.baseR,
    spec.baseR * 0.12,
    trunkSegs,
    radial,
  );

  const branchParts: THREE.BufferGeometry[] = [];
  const foliageParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < floors; i++) {
    const fi = lod === 0 ? i : Math.round((i / (floors - 1)) * (spec.floors - 1));
    const ft = spec.floorT[fi];
    const y = H * (spec.crownStart + (0.965 - spec.crownStart) * ft);
    const ax = spec.leanX * (y / H);
    const az = spec.leanZ * (y / H);
    const len = Math.max(0.12, spec.branchR * Math.pow(1 - ft * 0.94, 0.9) * spec.floorLen[fi]);
    const droop = len * spec.floorDroop[fi];
    // Núcleo de copa: blob achatado por piso que rellena la silueta entre las
    // ramas (una conífera densa, no un esqueleto de ramas).
    foliageParts.push(
      scaledIcosa(Math.max(0.18, len * 0.42), 0, ax, y, az, 0.5),
    );
    for (let j = 0; j < perFloor; j++) {
      const ang = spec.floorAng[fi] + (j * TWO_PI) / perFloor;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      branchParts.push(
        taperedTube(
          [
            new THREE.Vector3(ax + dx * 0.03, y, az + dz * 0.03),
            new THREE.Vector3(ax + dx * len * 0.55, y + len * 0.06, az + dz * len * 0.55),
            new THREE.Vector3(ax + dx * len, y - droop, az + dz * len),
          ],
          Math.max(0.02, spec.baseR * 0.16),
          Math.max(0.008, spec.baseR * 0.035),
          2,
          lod === 0 ? 4 : 3,
        ),
      );
      // Racimos alargados a lo largo de la rama (varios por rama): el ancho se
      // estrecha hacia la punta para que la copa lea como masa de agujas y no
      // como una pala plana. Un blob achatado a media rama da volumen.
      const sprays = lod === 0 ? 3 : 2;
      for (let s = 0; s < sprays; s++) {
        const u = 0.36 + (0.54 * s) / (sprays - 1);
        const w = Math.max(0.14, len * (0.62 - 0.16 * u));
        const h = Math.max(0.18, len * 0.45);
        const g = droopPlane(w, h, lod === 0 ? 2 : 1, 0.45, 0.85);
        g.rotateX(-Math.PI / 2 + 0.3 + 0.1 * s);
        g.rotateY(-Math.PI / 2 - ang + s * 0.8);
        g.translate(
          ax + dx * len * u,
          y - droop * u * 0.8 + 0.02,
          az + dz * len * u,
        );
        foliageParts.push(g);
      }
      foliageParts.push(
        scaledIcosa(
          Math.max(0.14, len * (lod === 0 ? 0.42 : 0.34)),
          0,
          ax + dx * len * 0.7,
          y - droop * 0.6,
          az + dz * len * 0.7,
          0.45,
        ),
      );
    }
  }
  const tip = droopPlane(Math.max(0.25, spec.branchR * 0.3), Math.max(0.3, H * 0.05), 2, 0.3, 0.9);
  tip.rotateX(-Math.PI / 2 + 0.55);
  tip.translate(spec.leanX, H * 0.985, spec.leanZ);
  foliageParts.push(tip);

  const trunkGeo = mergeGeos([trunk, ...branchParts]);
  const foliage = mergeGeos(foliageParts);
  const h0 = normalizeParts([trunkGeo, foliage]);
  return { trunk: trunkGeo, foliage, h0 };
}

function coniferSilhouette(spec: ConiferSpec): THREE.Shape {
  const H = spec.height;
  const crownY = H * spec.crownStart;
  const tw = spec.baseR * 1.15;
  const steps = 6;
  const left: THREE.Vector2[] = [
    new THREE.Vector2(-tw, 0),
    new THREE.Vector2(-tw * 0.85, crownY),
  ];
  const span = H * 0.96 - crownY;
  for (let i = 0; i < steps; i++) {
    const u = i / (steps - 1);
    const y = crownY + span * u;
    const idx = Math.round(u * (spec.floors - 1));
    const w = spec.branchR * 1.2 * Math.pow(1 - u * 0.9, 0.9) * spec.floorLen[idx];
    left.push(new THREE.Vector2(-w, y));
    if (i < steps - 1) left.push(new THREE.Vector2(-w * 0.5, y + (span / steps) * 0.5));
  }
  const pts: THREE.Vector2[] = left.slice();
  pts.push(new THREE.Vector2(0, H));
  for (let i = left.length - 1; i >= 0; i--) {
    const p = left[i];
    pts.push(new THREE.Vector2(-p.x, p.y));
  }
  return new THREE.Shape(pts);
}

function buildConiferImpostor(spec: ConiferSpec): Part {
  const foliage = silhouetteCross(coniferSilhouette(spec), 3);
  const h0 = fitToBase(foliage);
  return { trunk: null, foliage, h0 };
}

// --- pine (copa alta tipo umbrella) ----------------------------------------

interface PineSpec {
  baseR: number;
  height: number;
  branchR: number;
  leanX: number;
  leanZ: number;
  crownStart: number;
  tiers: number;
  tierT: Float64Array;
  tierAng: Float64Array;
  tierLen: Float64Array;
  branches: number;
  /** Jitter vertical por (tier, rama) en m; rompe los pisos planos. */
  jitter: Float64Array;
}

function makePineSpec(variant: number): PineSpec {
  const rng = rngFor('pine', variant);
  const height = 14 + rng() * 6;
  const tiers = 4;
  const branches = 5;
  const tierT = new Float64Array(tiers);
  const tierAng = new Float64Array(tiers);
  const tierLen = new Float64Array(tiers);
  for (let i = 0; i < tiers; i++) {
    tierT[i] = (i / (tiers - 1)) * 0.92 + rng() * 0.08;
    tierAng[i] = rng() * TWO_PI;
    tierLen[i] = 0.72 + rng() * 0.5;
  }
  // Jitter vertical por rama: rompe los "pisos" planos de la copa umbrella.
  const jitter = new Float64Array(tiers * branches);
  for (let i = 0; i < jitter.length; i++) jitter[i] = rng() - 0.5;
  return {
    baseR: 0.36,
    height,
    branchR: 2.7 + rng() * 1.5,
    leanX: (rng() - 0.5) * height * 0.02,
    leanZ: (rng() - 0.5) * height * 0.02,
    crownStart: 0.5 + rng() * 0.1,
    tiers,
    tierT,
    tierAng,
    tierLen,
    branches,
    jitter,
  };
}

function buildPineParts(spec: PineSpec, lod: 0 | 1, t: number): Part {
  const radial = lod === 0 ? dcount(9, t) : dcount(6, t);
  const trunkSegs = lod === 0 ? 9 : 5;
  const tiers = lod === 0 ? spec.tiers : Math.max(2, spec.tiers - 1);
  const perTier = lod === 0 ? spec.branches : Math.max(2, spec.branches - 1);
  const H = spec.height;

  const trunk = taperedTube(
    [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(spec.leanX * 0.3, H * 0.35, spec.leanZ * 0.3),
      new THREE.Vector3(spec.leanX * 0.65, H * 0.7, spec.leanZ * 0.65),
      new THREE.Vector3(spec.leanX, H, spec.leanZ),
    ],
    spec.baseR,
    spec.baseR * 0.45,
    trunkSegs,
    radial,
  );
  // Corteza rugosa en el tronco (no en las ramas): la silueta gana irregularidad.
  displaceRadial(trunk, (x, y, z) => {
    const n = Math.sin(x * 9.1 + y * 0.9) * Math.cos(z * 8.7 + y * 1.3);
    return n > 0 ? 0.06 * n * n : 0;
  });

  const branchParts: THREE.BufferGeometry[] = [];
  const foliageParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < tiers; i++) {
    const ti = lod === 0 ? i : Math.round((i / (tiers - 1)) * (spec.tiers - 1));
    const y = H * (spec.crownStart + (0.94 - spec.crownStart) * spec.tierT[ti]);
    const ax = spec.leanX * (y / H);
    const az = spec.leanZ * (y / H);
    const len = Math.max(0.6, spec.branchR * spec.tierLen[ti]);
    for (let j = 0; j < perTier; j++) {
      const ang = spec.tierAng[ti] + (j * TWO_PI) / perTier;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const yj = y + spec.jitter[ti * spec.branches + j] * 1.7;
      branchParts.push(
        taperedTube(
          [
            new THREE.Vector3(ax + dx * 0.04, yj + 0.05, az + dz * 0.04),
            new THREE.Vector3(ax + dx * len * 0.6, yj + 0.22, az + dz * len * 0.6),
            new THREE.Vector3(ax + dx * len, yj + 0.02, az + dz * len),
          ],
          0.09,
          0.02,
          2,
          lod === 0 ? 4 : 3,
        ),
      );
      // Copa umbrella: 1–2 racimos aplanados por rama + faldón colgante en la
      // punta (racimos más pequeños y numerosos en LOD0).
      foliageParts.push(
        scaledIcosa(
          len * 0.5,
          lod === 0 ? 1 : 0,
          ax + dx * len * 0.6,
          yj + 0.18,
          az + dz * len * 0.6,
          0.4,
        ),
      );
      if (lod === 0) {
        foliageParts.push(
          scaledIcosa(
            len * 0.36,
            0,
            ax + dx * len * 0.3,
            yj + 0.16,
            az + dz * len * 0.3,
            0.38,
          ),
        );
      }
      const spray = droopPlane(
        len * 0.55,
        Math.max(0.35, len * 0.45),
        lod === 0 ? 2 : 1,
        0.5,
        0.85,
      );
      spray.rotateX(-Math.PI / 2 + 0.15);
      spray.rotateY(-Math.PI / 2 - ang);
      spray.translate(ax + dx * len * 0.94, yj + 0.04, az + dz * len * 0.94);
      foliageParts.push(spray);
    }
  }
  foliageParts.push(
    scaledIcosa(spec.branchR * 0.45, lod === 0 ? 1 : 0, spec.leanX, H, spec.leanZ, 0.45),
  );
  const topSpray = droopPlane(spec.branchR * 0.7, 0.6, 2, 0.6, 0.85);
  topSpray.rotateX(-Math.PI / 2 + 0.2);
  topSpray.translate(spec.leanX, H + 0.05, spec.leanZ);
  foliageParts.push(topSpray);

  const trunkGeo = mergeGeos([trunk, ...branchParts]);
  const foliage = mergeGeos(foliageParts);
  const h0 = normalizeParts([trunkGeo, foliage]);
  return { trunk: trunkGeo, foliage, h0 };
}

/**
 * Impostor pine: tronco desnudo (quad) + copa umbrella achatada (hexágono),
 * en 3 capas cruzadas. Conserva el hueco entre el suelo y la copa, que es la
 * seña de identidad de la especie a distancia.
 */
function buildPineImpostor(spec: PineSpec): Part {
  const H = spec.height;
  const crownY = H * spec.crownStart;
  const ch = H - crownY;
  const tw = spec.baseR * 1.05;
  const trunkShape = new THREE.Shape([
    new THREE.Vector2(-tw, 0),
    new THREE.Vector2(tw, 0),
    new THREE.Vector2(tw * 0.55, crownY + ch * 0.5),
    new THREE.Vector2(-tw * 0.55, crownY + ch * 0.5),
  ]);
  const crownShape = new THREE.Shape([
    new THREE.Vector2(-spec.branchR, crownY + ch * 0.3),
    new THREE.Vector2(-spec.branchR * 0.55, crownY + ch * 0.56),
    new THREE.Vector2(0, crownY + ch * 0.64),
    new THREE.Vector2(spec.branchR * 0.55, crownY + ch * 0.56),
    new THREE.Vector2(spec.branchR, crownY + ch * 0.3),
    new THREE.Vector2(0, crownY + ch * 0.12),
  ]);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const rot = (k * Math.PI) / 3;
    const trunk = new THREE.ShapeGeometry(trunkShape, 1);
    trunk.rotateY(rot);
    parts.push(trunk);
    const crown = new THREE.ShapeGeometry(crownShape, 1);
    crown.rotateY(rot);
    parts.push(crown);
  }
  const foliage = mergeGeos(parts);
  const h0 = fitToBase(foliage);
  return { trunk: null, foliage, h0 };
}

// --- sapling (sotobosque esbelto, hojas sueltas) ----------------------------

interface SaplingSpec {
  height: number;
  bendX: number;
  bendZ: number;
  leaves: number;
  leafT: Float64Array;
  leafAng: Float64Array;
  leafLen: Float64Array;
}

function makeSaplingSpec(variant: number): SaplingSpec {
  const rng = rngFor('sapling', variant);
  const height = 1.5 + rng() * 1.5;
  const leaves = 8;
  const leafT = new Float64Array(leaves);
  const leafAng = new Float64Array(leaves);
  const leafLen = new Float64Array(leaves);
  for (let i = 0; i < leaves; i++) {
    leafT[i] = 0.25 + (0.7 * i) / (leaves - 1) + rng() * 0.04;
    leafAng[i] = i * 2.39996 + rng() * 0.4;
    leafLen[i] = 0.34 + rng() * 0.34;
  }
  return {
    height,
    bendX: (rng() - 0.5) * height * 0.06,
    bendZ: (rng() - 0.5) * height * 0.06,
    leaves,
    leafT,
    leafAng,
    leafLen,
  };
}

function buildSaplingParts(spec: SaplingSpec, lod: 0 | 1, t: number): Part {
  const radial = lod === 0 ? dcount(5, t) : dcount(4, t);
  const stemSegs = lod === 0 ? 4 : 3;
  const leaves = lod === 0 ? spec.leaves : Math.max(2, Math.round(spec.leaves * 0.5));
  const H = spec.height;

  const stem = taperedTube(
    [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(spec.bendX * 0.4, H * 0.35, spec.bendZ * 0.4),
      new THREE.Vector3(spec.bendX * 0.75, H * 0.7, spec.bendZ * 0.75),
      new THREE.Vector3(spec.bendX, H, spec.bendZ),
    ],
    0.032,
    0.012,
    stemSegs,
    radial,
  );

  const foliageParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < leaves; i++) {
    const li = lod === 0 ? i : Math.round((i / (leaves - 1)) * (spec.leaves - 1));
    const ang = spec.leafAng[li];
    const len = spec.leafLen[li];
    // Hoja casi vertical (con caída): a nivel de suelo se ve la cara, no el
    // canto. Las ramas del sapling nacen del tallo y caen hacia fuera.
    const g = droopPlane(len * 0.72, len, lod === 0 ? 2 : 1, 0.5, 0.7);
    g.rotateX(-Math.PI / 2 + 0.9);
    g.rotateY(-Math.PI / 2 - ang);
    g.translate(Math.cos(ang) * 0.05, H * spec.leafT[li], Math.sin(ang) * 0.05);
    foliageParts.push(g);
  }

  const foliage = mergeGeos(foliageParts);
  const h0 = normalizeParts([stem, foliage]);
  return { trunk: stem, foliage, h0 };
}

function leafDiamond(len: number, w: number): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(w * 0.5, len * 0.45),
    new THREE.Vector2(0, len),
    new THREE.Vector2(-w * 0.5, len * 0.45),
  ]);
  return new THREE.ShapeGeometry(shape, 1);
}

function buildSaplingImpostor(spec: SaplingSpec): Part {
  const H = spec.height;
  const stemShape = new THREE.Shape([
    new THREE.Vector2(-0.04, 0),
    new THREE.Vector2(0.04, 0),
    new THREE.Vector2(0.022, H),
    new THREE.Vector2(-0.022, H),
  ]);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const rot = (k * Math.PI) / 3;
    const stem = new THREE.ShapeGeometry(stemShape, 1);
    stem.rotateY(rot);
    parts.push(stem);
    for (let l = 0; l < 4; l++) {
      const ang = spec.leafAng[l];
      const len = spec.leafLen[l];
      const leaf = leafDiamond(Math.max(0.3, len), Math.max(0.2, len * 0.75));
      leaf.rotateX(-0.35);
      leaf.rotateY(ang + rot);
      leaf.translate(Math.cos(ang) * 0.05, H * spec.leafT[l], Math.sin(ang) * 0.05);
      parts.push(leaf);
    }
  }
  const foliage = mergeGeos(parts);
  const h0 = fitToBase(foliage);
  return { trunk: null, foliage, h0 };
}

// --- ensamblado por especie -------------------------------------------------

function buildSpeciesGeo(species: TreeSpecies, t: number): TreeSpeciesGeo {
  const count = TREE_VARIANTS[species];
  const trunks: (THREE.BufferGeometry | null)[][] = [];
  const foliage: (THREE.BufferGeometry | null)[][] = [];
  const variants: (THREE.BufferGeometry | null)[][] = [];
  const h0: number[] = [];

  for (let v = 0; v < count; v++) {
    const tr: (THREE.BufferGeometry | null)[] = [null, null, null];
    const fo: (THREE.BufferGeometry | null)[] = [null, null, null];
    const va: (THREE.BufferGeometry | null)[] = [null, null, null];
    let ref = 1;

    if (species === 'pine') {
      const spec = makePineSpec(v);
      for (let lod = 0; lod < 3; lod++) {
        const part = lod < 2 ? buildPineParts(spec, lod as 0 | 1, t) : buildPineImpostor(spec);
        tr[lod] = part.trunk;
        fo[lod] = part.foliage;
        if (lod === 2) va[lod] = part.foliage;
        if (lod === 0) ref = part.h0;
      }
    } else if (species === 'sapling') {
      const spec = makeSaplingSpec(v);
      for (let lod = 0; lod < 3; lod++) {
        const part = lod < 2 ? buildSaplingParts(spec, lod as 0 | 1, t) : buildSaplingImpostor(spec);
        tr[lod] = part.trunk;
        fo[lod] = part.foliage;
        if (lod === 2) va[lod] = part.foliage;
        if (lod === 0) ref = part.h0;
      }
    } else {
      const spec = makeConiferSpec(species, v);
      for (let lod = 0; lod < 3; lod++) {
        const part = lod < 2 ? buildConiferParts(spec, lod as 0 | 1, t) : buildConiferImpostor(spec);
        tr[lod] = part.trunk;
        fo[lod] = part.foliage;
        if (lod === 2) va[lod] = part.foliage;
        if (lod === 0) ref = part.h0;
      }
    }

    trunks.push(tr);
    foliage.push(fo);
    variants.push(va);
    h0.push(ref);
  }

  return { variants, trunks, foliage, h0 };
}

export function buildSpeciesGeometries(quality: Quality): Record<TreeSpecies, TreeSpeciesGeo> {
  const t = QUALITY[quality].trees;
  return {
    fir: buildSpeciesGeo('fir', t),
    pine: buildSpeciesGeo('pine', t),
    firsap: buildSpeciesGeo('firsap', t),
    sapling: buildSpeciesGeo('sapling', t),
  };
}
