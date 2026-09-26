import * as THREE from 'three/webgpu';
import {
  mix,
  mx_noise_float,
  normalGeometry,
  positionGeometry,
  smoothstep,
  uv,
  vec3,
} from 'three/tsl';
import { mulberry32, snoise2 } from '../core/rng';
import {
  displaceRadial,
  droopPlane,
  fitToBase,
  mergeGeos,
  scaledIcosa,
  taperedTube,
} from './geometryUtils';

/**
 * ============================================================================
 * propsGeometry — 8 props procedurales de sotobosque para woods (T4.2.4, §8).
 *
 * Tipos y presupuesto LOD0 (2–4 variantes deterministas por tipo):
 *   fern             3 var · ~60/80/100 tri   roseta de frondas (droopPlane)
 *   grass_medium     3 var · ~36/48/66 tri    matojo de briznas anchas
 *   shrub            3 var · ~250/330/430 tri arbusto de blobs icosaédricos
 *   rock_moss_set_01 3 var · ~100/140/120 tri rocas musgosas (displaceRadial)
 *   rock_moss_set_02 3 var · ~80/160/120 tri  lajas musgosas
 *   tree_stump       3 var · ~150/180/210 tri tocón con raíces y tapa
 *   dead_tree_trunk  3 var · ~170/200/150 tri tronco seco partido
 *   dry_branches     3 var · ~200/280/360 tri pila de ramas secas
 *
 * LOD ÚNICO: §8 no define LODs para props. `Props.ts` los registra con
 * `lodDist=[r,r,r]`, `cap=[cap,0,0]`, así que el motor solo habilita el tier 0
 * y nunca consulta `primitives(v, lod>0)`. Por eso `variants[v] = [geo0]`
 * (un único LOD0) y no se generan LOD1/LOD2 que jamás se dibujarían.
 *
 * Normalización: toda variante pasa por `fitToBase` (centrada en XZ, base en
 * y=0). La altura de referencia resultante se expone en `PropGeo.heights`.
 *
 * Materiales: `MeshStandardNodeMaterial` oscuros, sin texturas. El tinte
 * procedural vive en `colorNode` (TSL): gradiente + ruido MaterialX en hojas,
 * musgo por normal+ruido en rocas y veta vertical en madera. `flatShading` en
 * rocas para conservar la lectura facetada del icosaedro displazado.
 *
 * Convención de transformaciones: helpers `rotX/rotY/rotZ/move` aplican
 * matrices en secuencia (izquierda), sin depender del orden de Euler.
 * ============================================================================
 */

export type PropId =
  | 'fern'
  | 'grass_medium'
  | 'shrub'
  | 'rock_moss_set_01'
  | 'rock_moss_set_02'
  | 'tree_stump'
  | 'dead_tree_trunk'
  | 'dry_branches';

export interface PropGeo {
  /** `[variant][lod]`; para props solo existe LOD0 → `[[geo0], [geo1], …]`. */
  variants: THREE.BufferGeometry[][];
  /** Material único del tipo (hoja / roca / madera según la tabla §8). */
  material: THREE.Material;
  /** Altura de referencia por variante (`fitToBase`), informativa. */
  heights: number[];
}

type RGB = readonly [number, number, number];

// --- Helpers de transformación (sin asignar por llamada) ---------------------

const _m = new THREE.Matrix4();

function v3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function rotY(g: THREE.BufferGeometry, a: number): THREE.BufferGeometry {
  return g.applyMatrix4(_m.makeRotationY(a));
}

function rotZ(g: THREE.BufferGeometry, a: number): THREE.BufferGeometry {
  return g.applyMatrix4(_m.makeRotationZ(a));
}

function move(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  return g.applyMatrix4(_m.makeTranslation(x, y, z));
}

/** `fitToBase` muta y devuelve la altura; este wrapper devuelve la geometría. */
function baseAtZero(g: THREE.BufferGeometry): THREE.BufferGeometry {
  fitToBase(g);
  return g;
}

// --- Geometrías --------------------------------------------------------------

/** Roseta de frondas: `droopPlane` inclinado hacia fuera y girado en Y. */
function buildFern(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const counts = [6, 8, 10];
  const baseLen = [0.5, 0.62, 0.74];
  for (let v = 0; v < counts.length; v++) {
    const rnd = mulberry32(0x6665726e + v * 977);
    const n = counts[v];
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.45;
      const len = baseLen[v] * (0.8 + rnd() * 0.45);
      const wid = 0.07 + rnd() * 0.05;
      const tilt = 0.45 + rnd() * 0.6;
      const blade = droopPlane(wid, len, 5, len * (0.35 + rnd() * 0.3), 0.8 + rnd() * 0.14);
      rotZ(blade, tilt);
      rotY(blade, yaw);
      move(blade, 0, 0.012, 0);
      parts.push(blade);
    }
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

/** Matojo de briznas anchas, más erguidas que las frondas del helecho. */
function buildGrassMedium(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const counts = [6, 8, 11];
  const baseLen = [0.52, 0.64, 0.76];
  for (let v = 0; v < counts.length; v++) {
    const rnd = mulberry32(0x67726173 + v * 701);
    const n = counts[v];
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const len = baseLen[v] * (0.8 + rnd() * 0.4);
      const wid = 0.035 + rnd() * 0.025;
      const tilt = 0.25 + rnd() * 0.5;
      const blade = droopPlane(wid, len, 3, len * (0.16 + rnd() * 0.22), 0.88 + rnd() * 0.08);
      rotZ(blade, tilt);
      rotY(blade, yaw);
      move(blade, 0, 0.008, 0);
      parts.push(blade);
    }
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

/** Arbusto: tallo corto + blobs icosaédricos displazados en racimo. */
function buildShrub(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const blobs = [3, 4, 5];
  const stemH = [0.5, 0.62, 0.72];
  for (let v = 0; v < blobs.length; v++) {
    const rnd = mulberry32(0x73687275 + v * 613);
    const parts: THREE.BufferGeometry[] = [];
    const h = stemH[v];
    parts.push(
      taperedTube([v3(0, 0, 0), v3(0.01, h * 0.5, 0.01), v3(0, h, 0)], 0.05, 0.028, 3, 5),
    );
    const n = blobs[v];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.9;
      const rad = 0.12 + rnd() * 0.26;
      const r = 0.26 + rnd() * 0.14;
      const by = h * (0.42 + rnd() * 0.45);
      const blob = scaledIcosa(r, 1, 0, 0, 0, 0.7 + rnd() * 0.3);
      const seed = 0x73687275 + v * 613 + i * 97;
      displaceRadial(
        blob,
        (x, y, z) =>
          (snoise2(x * 3.2 + seed * 0.013, z * 3.2 - seed * 0.007, seed) - 0.5) * 0.26 + y * 0.35,
      );
      move(blob, Math.cos(a) * rad, by, Math.sin(a) * rad);
      parts.push(blob);
    }
    const top = scaledIcosa(0.24 + v * 0.03, 1, 0, 0, 0, 0.85);
    move(top, 0, h * 0.9, 0);
    parts.push(top);
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

interface RockSpec {
  r: number;
  sy: number;
  x: number;
  y: number;
  z: number;
  detail: number;
}

/** Cluster de rocas: icosaedro escalado + `displaceRadial` (muescas) por roca. */
function rockCluster(seed: number, specs: readonly RockSpec[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const g = scaledIcosa(s.r, s.detail, 0, 0, 0, s.sy);
    const o = seed + i * 137;
    displaceRadial(g, (x, y, z) => {
      const n1 = snoise2(x * 2.6 + o * 0.017, z * 2.6 - o * 0.031, o);
      const n2 = snoise2(y * 3.3 + o * 0.011, x * 1.9 + z * 1.4, o + 41);
      return (n1 - 0.5) * 0.44 + (n2 - 0.5) * 0.22;
    });
    move(g, s.x, s.y, s.z);
    parts.push(g);
  }
  return mergeGeos(parts);
}

/** `rock_moss_set_01`: rocas macizas, una dominante por variante. */
function buildRockSet01(): THREE.BufferGeometry[] {
  return [
    rockCluster(0x726f6b31, [
      { r: 0.55, sy: 0.8, x: 0, y: 0.34, z: 0, detail: 1 },
      { r: 0.24, sy: 0.7, x: 0.52, y: 0.12, z: 0.18, detail: 0 },
    ]),
    rockCluster(0x726f6b32, [
      { r: 0.44, sy: 0.75, x: -0.18, y: 0.26, z: 0.05, detail: 1 },
      { r: 0.38, sy: 0.7, x: 0.28, y: 0.2, z: -0.12, detail: 1 },
    ]),
    rockCluster(0x726f6b33, [
      { r: 0.5, sy: 0.6, x: 0.05, y: 0.24, z: 0, detail: 1 },
      { r: 0.28, sy: 0.8, x: -0.38, y: 0.16, z: 0.22, detail: 0 },
      { r: 0.2, sy: 0.9, x: 0.3, y: 0.12, z: -0.34, detail: 0 },
    ]),
  ].map(baseAtZero);
}

/** `rock_moss_set_02`: lajas bajas y anchas (misma técnica, otra silueta). */
function buildRockSet02(): THREE.BufferGeometry[] {
  return [
    rockCluster(0x736c6162, [{ r: 0.6, sy: 0.42, x: 0, y: 0.15, z: 0, detail: 1 }]),
    rockCluster(0x736c6163, [
      { r: 0.5, sy: 0.4, x: -0.3, y: 0.12, z: 0.1, detail: 1 },
      { r: 0.42, sy: 0.5, x: 0.35, y: 0.14, z: -0.18, detail: 1 },
    ]),
    rockCluster(0x736c6164, [
      { r: 0.55, sy: 0.35, x: 0.1, y: 0.12, z: -0.05, detail: 1 },
      { r: 0.3, sy: 0.5, x: -0.45, y: 0.1, z: 0.3, detail: 0 },
      { r: 0.24, sy: 0.6, x: 0.48, y: 0.08, z: 0.28, detail: 0 },
    ]),
  ].map(baseAtZero);
}

/** Tocón: tubo cónico con leve inclinación, tapa superior y raíces radiales. */
function buildStump(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const hs = [0.85, 1.15, 1.45];
  const rs = [0.2, 0.25, 0.17];
  const rootsN = [3, 4, 5];
  for (let v = 0; v < hs.length; v++) {
    const rnd = mulberry32(0x7374756d + v * 431);
    const parts: THREE.BufferGeometry[] = [];
    const h = hs[v];
    const r = rs[v];
    const tx = (rnd() - 0.5) * 0.16;
    const tz = (rnd() - 0.5) * 0.16;
    parts.push(
      taperedTube(
        [
          v3(0, 0, 0),
          v3(tx * 0.35, h * 0.45, tz * 0.35),
          v3(tx * 0.7, h * 0.78, tz * 0.7),
          v3(tx, h, tz),
        ],
        r,
        r * 0.82,
        5,
        7,
      ),
    );
    const cap = scaledIcosa(r * 1.04, 0, 0, 0, 0, 0.24);
    move(cap, tx, h - r * 0.04, tz);
    parts.push(cap);
    const n = rootsN[v];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
      const len = r * (1.1 + rnd() * 1.2);
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      parts.push(
        taperedTube(
          [
            v3(dx * r * 0.15, r * 0.45, dz * r * 0.15),
            v3(dx * len * 0.5, r * 0.22, dz * len * 0.5),
            v3(dx * len, 0.01, dz * len),
          ],
          r * 0.42,
          r * 0.13,
          3,
          5,
        ),
      );
    }
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

/** Rama/stub cónico desde `base` hacia (yaw, pitch), con caída `sag`. */
function stub(
  base: THREE.Vector3,
  yaw: number,
  pitch: number,
  len: number,
  r0: number,
  sag: number,
): THREE.BufferGeometry {
  const dx = Math.cos(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = Math.sin(yaw) * Math.cos(pitch);
  return taperedTube(
    [
      v3(base.x, base.y, base.z),
      v3(base.x + dx * len * 0.5, base.y + dy * len * 0.5, base.z + dz * len * 0.5),
      v3(base.x + dx * len, base.y + dy * len - sag * len, base.z + dz * len),
    ],
    r0,
    r0 * 0.22,
    3,
    5,
  );
}

/** Tronco seco en pie partido: caña con codo + stubs en la copa y los flancos. */
function buildDeadTrunk(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const cfg = [
    { h: 2.4, r0: 0.26, r1: 0.1, bend: 0.18, top: 2, side: 1 },
    { h: 1.9, r0: 0.22, r1: 0.12, bend: 0.85, top: 1, side: 3 },
    { h: 1.4, r0: 0.3, r1: 0.16, bend: 0.12, top: 4, side: 0 },
  ];
  for (let v = 0; v < cfg.length; v++) {
    const c = cfg[v];
    const rnd = mulberry32(0x736e6167 + v * 587);
    const parts: THREE.BufferGeometry[] = [];
    const p1 = v3(c.bend * c.h * 0.05, c.h * 0.34, c.bend * c.h * 0.02);
    const p2 = v3(c.bend * c.h * 0.28, c.h * 0.7, c.bend * c.h * 0.12);
    const p3 = v3(c.bend * c.h * 0.62, c.h, c.bend * c.h * 0.3);
    parts.push(taperedTube([v3(0, 0, 0), p1, p2, p3], c.r0, c.r1, 6, 7));
    for (let i = 0; i < c.top; i++) {
      const a = (i / Math.max(1, c.top)) * Math.PI * 2 + rnd() * 1.2;
      parts.push(stub(p3, a, 0.55 + rnd() * 0.6, 0.25 + rnd() * 0.3, c.r1 * 1.15, 0.15 + rnd() * 0.2));
    }
    for (let i = 0; i < c.side; i++) {
      const base = i % 2 === 0 ? p2 : p3;
      parts.push(
        stub(base, rnd() * Math.PI * 2, 0.1 + rnd() * 0.45, 0.3 + rnd() * 0.45, c.r0 * 0.55, 0.18 + rnd() * 0.22),
      );
    }
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

/** Pila de ramas secas casi tumbadas (arco suave alrededor del centro). */
function buildDryBranches(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const counts = [5, 7, 9];
  const baseLen = [1.5, 1.2, 0.95];
  for (let v = 0; v < counts.length; v++) {
    const rnd = mulberry32(0x6272616e + v * 769);
    const n = counts[v];
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const len = baseLen[v] * (0.75 + rnd() * 0.5);
      const r1 = 0.045 + rnd() * 0.035;
      const branch = taperedTube(
        [
          v3(0, 0, 0),
          v3(len * 0.28, 0.02 + rnd() * 0.06, 0.03),
          v3(len * 0.62, 0.06 + rnd() * 0.05, -0.03),
          v3(len, 0.03 + rnd() * 0.05, 0.02),
        ],
        0.018 + rnd() * 0.014,
        r1,
        4,
        5,
      );
      rotZ(branch, 0.05 + rnd() * 0.12);
      rotY(branch, rnd() * Math.PI * 2);
      move(branch, (rnd() - 0.5) * 0.5, 0.02 + rnd() * 0.04, (rnd() - 0.5) * 0.5);
      parts.push(branch);
    }
    out.push(baseAtZero(mergeGeos(parts)));
  }
  return out;
}

// --- Materiales TSL ----------------------------------------------------------

function rgb(c: RGB) {
  return vec3(c[0], c[1], c[2]);
}

/** Hoja: gradiente base→punta + ruido; `dryTips` seca la punta (§6.7 style). */
function leafMaterial(
  name: string,
  dark: RGB,
  mid: RGB,
  dry: RGB,
  dryTips: boolean,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  m.roughness = 0.9;
  m.side = THREE.DoubleSide;
  m.shadowSide = THREE.FrontSide;
  m.envMapIntensity = 0.35;
  const grad = smoothstep(0, 0.6, positionGeometry.y);
  const grain = mx_noise_float(positionGeometry.mul(6.5).add(vec3(3.1, 1.7, 8.3)))
    .mul(0.5)
    .add(0.5);
  let col = mix(rgb(dark), rgb(mid), grad.mul(0.7).add(grain.mul(0.3)));
  if (dryTips) {
    col = mix(col, rgb(dry), smoothstep(0.62, 1, uv().y).mul(grain).mul(0.45));
  }
  m.colorNode = col;
  return m;
}

/** Roca: musgo en caras hacia arriba (normal local Y × ruido), cuerpo pétreo. */
function rockMaterial(
  name: string,
  base: RGB,
  light: RGB,
  moss: RGB,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  m.roughness = 0.95;
  m.side = THREE.FrontSide;
  m.flatShading = true;
  m.envMapIntensity = 0.35;
  const n = mx_noise_float(positionGeometry.mul(2.7).add(vec3(7.1, 2.3, 4.9)))
    .mul(0.5)
    .add(0.5);
  const body = mix(rgb(base), rgb(light), n.mul(0.55));
  const mossMask = smoothstep(0.1, 0.8, normalGeometry.y.mul(n.mul(0.7).add(0.5)));
  m.colorNode = mix(body, rgb(moss), mossMask.mul(0.75));
  return m;
}

/** Madera seca: veta vertical por ruido direccional; musgo opcional en la base. */
function woodMaterial(
  name: string,
  dark: RGB,
  light: RGB,
  mossy: boolean,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  m.roughness = 0.95;
  m.side = THREE.FrontSide;
  m.envMapIntensity = 0.35;
  const xz = positionGeometry.x.mul(8.5).add(positionGeometry.z.mul(8.5));
  const grain = mx_noise_float(vec3(xz, positionGeometry.y.mul(1.7), xz.mul(0.11)))
    .mul(0.5)
    .add(0.5);
  let col = mix(rgb(dark), rgb(light), grain.mul(0.62));
  if (mossy) {
    const low = smoothstep(0.02, 0.3, positionGeometry.y).oneMinus();
    col = mix(col, rgb([0.04, 0.07, 0.028]), low.mul(0.5).mul(grain));
  }
  m.colorNode = col;
  return m;
}

// --- Empaquetado y validación ------------------------------------------------

function assertFinite(g: THREE.BufferGeometry, label: string): void {
  const p = g.getAttribute('position');
  const a = p.array as Float32Array;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) throw new Error(`propsGeometry: NaN/Inf en ${label}`);
  }
  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (
    bb === null ||
    !Number.isFinite(bb.min.x + bb.min.y + bb.min.z + bb.max.x + bb.max.y + bb.max.z)
  ) {
    throw new Error(`propsGeometry: bbox no finita en ${label}`);
  }
}

/** Nº de triángulos (indexado o no). Lo usan `Props.stats` y la verificación. */
export function geometryTriangles(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx !== null) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

function prop(name: string, list: THREE.BufferGeometry[], material: THREE.Material): PropGeo {
  const variants: THREE.BufferGeometry[][] = [];
  const heights: number[] = [];
  for (let v = 0; v < list.length; v++) {
    assertFinite(list[v], `${name}[${v}]`);
    list[v].computeBoundingBox();
    const bb = list[v].boundingBox;
    heights.push(bb === null ? 0 : bb.max.y);
    variants.push([list[v]]);
  }
  return { variants, material, heights };
}

/**
 * Construye los 8 tipos (una vez, en `load`). El llamante es dueño de las
 * geometrías/materiales: `Props.dispose()` los libera.
 */
export function buildPropGeometries(): Record<PropId, PropGeo> {
  return {
    fern: prop(
      'fern',
      buildFern(),
      leafMaterial(
        'prop:fern',
        [0.035, 0.075, 0.02],
        [0.06, 0.125, 0.035],
        [0.13, 0.11, 0.04],
        true,
      ),
    ),
    grass_medium: prop(
      'grass_medium',
      buildGrassMedium(),
      leafMaterial(
        'prop:grass_medium',
        [0.05, 0.08, 0.018],
        [0.09, 0.135, 0.03],
        [0.16, 0.13, 0.05],
        true,
      ),
    ),
    shrub: prop(
      'shrub',
      buildShrub(),
      leafMaterial(
        'prop:shrub',
        [0.025, 0.055, 0.02],
        [0.045, 0.09, 0.03],
        [0.08, 0.07, 0.03],
        false,
      ),
    ),
    rock_moss_set_01: prop(
      'rock_moss_set_01',
      buildRockSet01(),
      rockMaterial(
        'prop:rock_moss_set_01',
        [0.085, 0.088, 0.09],
        [0.125, 0.13, 0.135],
        [0.045, 0.075, 0.03],
      ),
    ),
    rock_moss_set_02: prop(
      'rock_moss_set_02',
      buildRockSet02(),
      rockMaterial(
        'prop:rock_moss_set_02',
        [0.075, 0.08, 0.085],
        [0.11, 0.115, 0.12],
        [0.04, 0.07, 0.032],
      ),
    ),
    tree_stump: prop(
      'tree_stump',
      buildStump(),
      woodMaterial('prop:tree_stump', [0.055, 0.045, 0.035], [0.1, 0.085, 0.06], true),
    ),
    dead_tree_trunk: prop(
      'dead_tree_trunk',
      buildDeadTrunk(),
      woodMaterial(
        'prop:dead_tree_trunk',
        [0.06, 0.055, 0.05],
        [0.105, 0.095, 0.08],
        false,
      ),
    ),
    dry_branches: prop(
      'dry_branches',
      buildDryBranches(),
      woodMaterial('prop:dry_branches', [0.07, 0.06, 0.045], [0.12, 0.105, 0.075], false),
    ),
  };
}
