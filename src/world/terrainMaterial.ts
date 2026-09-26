import * as THREE from 'three/webgpu';
import {
  mix,
  mx_noise_float,
  normalWorldGeometry,
  positionWorld,
  smoothstep,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { TERRAIN_LAYERS, TERRAIN_SOIL, type RGB } from '../assets/textures';
import type { Quality } from '../core/constants';
import type { Shared } from '../core/shared';

/**
 * Material del terreno (T2.2.4), 100 % procedural y **world-space**: toda la
 * señal sale de `positionWorld.xz`, así que las 121 geometrías comparten
 * material y no puede haber costuras de UV entre tiles.
 *
 * Decisión documentada (vía simple del doc): **rampas de color de 3 stops por
 * capa + perturbación fbm de alta frecuencia**, sin tripletes diff/nor/arm ni
 * ficheros. Además se deriva un mapa de normal procedural del mismo fbm (bump
 * Mikkelsen con derivadas de pantalla), salvo en `low`. La niebla llega por
 * `scene.fogNode` (el material deja `fog = true`).
 */

/** Umbrales de las 4 máscaras de splat (doc sugiere 0.35–0.65). */
const MASK_LO = 0.35;
const MASK_HI = 0.65;

/** fbm de detalle (2 octavas) y frecuencias macro, en ciclos/m. */
const DETAIL_FREQ_A = 1.15;
const DETAIL_FREQ_B = 3.7;
const DETAIL_GAIN_A = 0.62;
const DETAIL_GAIN_B = 0.38;
/** Cuánto oscurece/aclara el detalle el color base (±13 %). */
const DETAIL_TINT = 0.13;
const MACRO_FREQ_A = 0.35;
const MACRO_FREQ_B = 0.02;
/** Fuerza del bump procedural (solo medium/high). */
const BUMP_SCALE = 0.35;
/** Mojado: oscurecimiento máximo y roughness de charco. */
const WET_DARKEN = 0.45;
const WET_ROUGHNESS = 0.03;

/** Rampa de 3 stops con transiciones suaves. */
function ramp3(stops: readonly [RGB, RGB, RGB], t: Node<'float'>): Node<'vec3'> {
  const a = vec3(stops[0][0], stops[0][1], stops[0][2]);
  const b = vec3(stops[1][0], stops[1][1], stops[1][2]);
  const c = vec3(stops[2][0], stops[2][1], stops[2][2]);
  return mix(mix(a, b, smoothstep(0, 0.5, t)), c, smoothstep(0.5, 1, t));
}

export function createTerrainMaterial(shared: Shared, quality: Quality): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'terrain';
  material.metalness = 0;
  material.roughness = 0.9; // roughnessNode lo sustituye; valor de respaldo
  material.envMapIntensity = 0.75;
  material.fog = true; // la niebla entra por scene.fogNode (F1b)

  const p = positionWorld.xz;

  // --- Splat de 4 capas: máscara y rampa con UVs de mundo independientes ----
  // Cada capa tiene su propia UV `coords/scale + offset` (xor (z,x) si `swap`):
  // la máscara de presencia usa su frecuencia/offset del doc y el parámetro de
  // la rampa de color se muestrea con la UV de la capa, así las 4 capas no
  // comparten patrón espacial.
  const masks: Array<Node<'float'>> = [];
  const colors: Array<Node<'vec3'>> = [];
  for (let i = 0; i < TERRAIN_LAYERS.length; i++) {
    const def = TERRAIN_LAYERS[i];
    const maskN = mx_noise_float(
      p.mul(def.maskFreq).add(vec2(def.maskOffset[0], def.maskOffset[1])),
    );
    masks.push(smoothstep(MASK_LO, MASK_HI, maskN.mul(0.5).add(0.5).clamp(0, 1)));

    const uv = def.swap ? vec2(p.y, p.x) : p;
    const layerUV = uv.div(def.scale).add(vec2(def.offset[0], def.offset[1]));
    const rampN = mx_noise_float(layerUV.add(vec2(1.7 + i * 13.7, 4.3 + i * 7.1)));
    colors.push(ramp3(def.ramp, rampN.mul(0.5).add(0.5).clamp(0, 1)));
  }

  // Composición alfa secuencial: capa 0 sobre la tierra, 1–3 encima.
  let color = mix(vec3(TERRAIN_SOIL[0], TERRAIN_SOIL[1], TERRAIN_SOIL[2]), colors[0], masks[0]);
  color = mix(color, colors[1], masks[1]);
  color = mix(color, colors[2], masks[2]);
  color = mix(color, colors[3], masks[3]);

  // --- fbm de alta frecuencia (2 octavas) ---------------------------------
  const detail = mx_noise_float(p.mul(DETAIL_FREQ_A).add(vec2(5.7, 2.9)))
    .mul(DETAIL_GAIN_A)
    .add(mx_noise_float(p.mul(DETAIL_FREQ_B).add(vec2(17.3, 8.1))).mul(DETAIL_GAIN_B));
  const detail01 = detail.mul(0.5).add(0.5).clamp(0, 1).toVar('terrainDetail');
  color = color.mul(detail.mul(DETAIL_TINT).add(1));

  // --- Modulación macro ----------------------------------------------------
  const macroA = mx_noise_float(p.mul(MACRO_FREQ_A).add(vec2(1.7, 9.2)))
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1);
  color = color.mul(mix(0.7, 1.1, macroA));
  const macroB = mx_noise_float(p.mul(MACRO_FREQ_B).add(vec2(3.3, 44.1)))
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1);
  color = color.mul(mix(0.75, 1.0, macroB));

  // --- Wetness nocturno (iV/clima) ----------------------------------------
  // Zonas planas (normal de la geometría, no la perturbada) = charcos: oscurecen
  // y bajan roughness a ~0.03. `smoothstep` inverso por diseño (§4/T2.2.4).
  const flatness = smoothstep(0.02, 0.003, normalWorldGeometry.y.oneMinus());
  const wet = flatness.mul(shared.uWetness).mul(shared.uRainAmount).clamp(0, 1);
  color = color.mul(wet.mul(-WET_DARKEN).add(1));

  material.colorNode = color;
  material.roughnessNode = mix(mix(0.92, 0.72, detail01), WET_ROUGHNESS, wet);

  // AO procedural: máscara macro (macroB) modulada por el detalle fino.
  material.aoNode = mix(0.6, 1.0, macroB).mul(mix(0.85, 1.0, detail01));

  // --- Normal procedural derivado del fbm (bump Mikkelsen) ----------------
  // `normalWorldGeometry` conserva el relieve real del heightfield; el gradiente
  // del fbm en pantalla añade el microrrelieve. Los meshes no tienen rotación
  // (la geometría se rota al construirla), así que local == mundo.
  if (quality !== 'low') {
    const dH = vec2(detail01.dFdx(), detail01.dFdy()).mul(BUMP_SCALE);
    const sigmaX = positionWorld.dFdx().normalize();
    const sigmaY = positionWorld.dFdy().normalize();
    const base = normalWorldGeometry;
    const r1 = sigmaY.cross(base);
    const r2 = base.cross(sigmaX);
    const det = sigmaX.dot(r1);
    const grad = det.sign().mul(dH.x.mul(r1).add(dH.y.mul(r2)));
    material.normalNode = transformNormalToView(det.abs().mul(base).sub(grad).normalize());
  }

  return material;
}
