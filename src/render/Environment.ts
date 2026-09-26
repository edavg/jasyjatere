import * as THREE from 'three/webgpu';
import { createNightEquirect, disposeNightEquirect } from '../assets/env';
import { HEMI, QUALITY, SKY, SUN, WIND, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool, pnum } from '../core/params';
import { mulberry32 } from '../core/rng';
import type { Shared } from '../core/shared';

// Campos que Fase 1 añade a `__dbg`; dbg.ts (F0) no se toca, se aumenta aquí.
declare module '../core/dbg' {
  interface Dbg {
    sunTarget?: number[];
    shadowTexel?: number;
  }
}

export interface EnvironmentEx {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** snap a texel + gust + KB + uTime; llamar cada frame antes del render */
  update(dt: number, focus: THREE.Vector3): void;
  dispose(): void;
}

// Scratch de módulo: update() no asigna memoria por frame.
const SUN_OFF = new THREE.Vector3(SUN.offset[0], SUN.offset[1], SUN.offset[2]);
const ORIGIN = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);
const LIGHT_ROT = new THREE.Matrix4().lookAt(SUN_OFF, ORIGIN, Y_UP);
const LIGHT_ROT_INV = LIGHT_ROT.clone().invert();
const _anchor = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createEnvironment(
  scene: THREE.Scene,
  quality: Quality,
  shared: Shared,
  renderer?: THREE.WebGPURenderer,
): EnvironmentEx {
  const snap = pbool('snap', true);
  // ?sun=N divide intensidad (0.5 -> x2); ?env=N divide environmentIntensity.
  const sunIntensity = SUN.intensity / clamp(pnum('sun', 1), 0.05, 10);
  const envIntensity = SKY.envIntensity / clamp(pnum('env', 1), 0.05, 10);

  const sun = new THREE.DirectionalLight(new THREE.Color(...SUN.color), sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QUALITY[quality].shadow, QUALITY[quality].shadow);
  const shadowCam = sun.shadow.camera;
  shadowCam.left = -SUN.shadowR;
  shadowCam.right = SUN.shadowR;
  shadowCam.top = SUN.shadowR;
  shadowCam.bottom = -SUN.shadowR;
  shadowCam.near = SUN.near;
  shadowCam.far = SUN.far;
  shadowCam.updateProjectionMatrix();
  // Crítico en WebGPU: sin esto el shadow renderer de césped/lluvia (F3/F5)
  // hereda la máscara de la cámara principal y proyectarían sombra.
  shadowCam.layers.enable(2);
  sun.shadow.bias = SUN.bias;
  sun.shadow.normalBias = SUN.normalBias;
  sun.shadow.radius = SUN.radius;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(new THREE.Color(...HEMI.sky), new THREE.Color(...HEMI.ground), HEMI.intensity);
  scene.add(hemi);

  const equirect = createNightEquirect();
  // T1.2.1: equirect -> PMREM -> scene.environment. EnvironmentNode ya lo haría
  // perezosamente (pmremTexture con caché por renderer); hornearlo aquí evita el
  // coste en el primer frame y deja un RenderTarget que controlamos en dispose().
  let baked: THREE.RenderTarget | null = null;
  if (renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    baked = pmrem.fromEquirectangular(equirect);
    pmrem.dispose();
    scene.environment = baked.texture;
  } else {
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = equirect;
  }
  scene.environmentIntensity = envIntensity;
  scene.background = null;

  shared.uMoonDir.value.copy(SUN_OFF).normalize();
  const rng = mulberry32(pnum('seed', 1337));
  let gust = shared.uGust.value;
  let gustTarget = WIND.gustMin + rng() * (WIND.gustMax - WIND.gustMin);
  let gustTimer = WIND.everyMin + rng() * (WIND.everyMax - WIND.everyMin);

  const texel = (2 * SUN.shadowR) / sun.shadow.mapSize.width;
  const dbg = dbgRef();
  const sunTargetArr: number[] = [0, 0, 0];
  const moonDirArr: number[] = [shared.uMoonDir.value.x, shared.uMoonDir.value.y, shared.uMoonDir.value.z];
  if (dbg) {
    dbg.snap = snap;
    dbg.moonDir = moonDirArr;
    dbg.gust = gust;
    dbg.flash = shared.uFlash.value;
    dbg.sunTarget = sunTargetArr;
    dbg.shadowTexel = texel;
  }

  function update(dt: number, focus: THREE.Vector3): void {
    shared.uTime.value += dt;
    shared.uFogHeightRef.value += (focus.y - shared.uFogHeightRef.value) * Math.min(1, dt * WIND.heightRefLerp);

    gustTimer -= dt;
    if (gustTimer <= 0) {
      gustTimer = WIND.everyMin + rng() * (WIND.everyMax - WIND.everyMin);
      gustTarget = WIND.gustMin + rng() * (WIND.gustMax - WIND.gustMin);
    }
    gust += (gustTarget - gust) * Math.min(1, dt * WIND.gustLerp);
    shared.uGust.value = gust;

    if (snap) {
      _anchor.copy(focus).applyMatrix4(LIGHT_ROT_INV);
      _anchor.x = Math.round(_anchor.x / texel) * texel;
      _anchor.y = Math.round(_anchor.y / texel) * texel;
      _anchor.applyMatrix4(LIGHT_ROT);
    } else {
      _anchor.copy(focus);
    }
    sun.position.copy(_anchor).add(SUN_OFF);
    sun.target.position.copy(_anchor);
    sun.target.updateMatrixWorld();

    if (dbg) {
      dbg.gust = gust;
      dbg.flash = shared.uFlash.value;
      sunTargetArr[0] = _anchor.x;
      sunTargetArr[1] = _anchor.y;
      sunTargetArr[2] = _anchor.z;
    }
  }

  function dispose(): void {
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(hemi);
    scene.environment = null;
    if (baked) baked.dispose();
    disposeNightEquirect(equirect);
    sun.shadow.dispose();
  }

  return { sun, hemi, update, dispose };
}
