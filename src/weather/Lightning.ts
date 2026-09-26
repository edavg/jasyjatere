import * as THREE from 'three/webgpu';
import { float, uniform } from 'three/tsl';
import type { Dbg } from '../core/dbg';
import { pnum, pstr } from '../core/params';
import { mulberry32 } from '../core/rng';
import type { Shared } from '../core/shared';

declare module '../core/dbg' {
  interface Dbg {
    lightning?: Record<string, unknown>;
  }
}

/**
 * T5.2.3 / §9.4: relámpagos. `flash` (qB) alimenta el cielo (§3), la niebla
 * (§4) y esta PointLight; el rayo visible es una cinta aditiva construida por
 * strike. Determinista con `?seed=`.
 *
 * Interpretación documentada de §9.4: «radio 180+260i / alto +110+90i» usa el
 * parámetro normalizado `t∈[0,1]` (igual que el jitter `(1-t·0.5)`), de modo que
 * el tronco vive entre 180–440 m de radio y 110–200 m de altura: dentro del far
 * de cámara (520 m). Con el índice crudo (180–3820 m) el rayo quedaría clipped.
 *
 * Debug: `?flash=N` fija el destello (capturas deterministas); `?bolt=1` dispara
 * un rayo al arrancar y otro cada ~2.5 s; `?bolt=hold` mantiene el rayo visible.
 */
export interface LightningEx {
  update(dt: number, camPos?: THREE.Vector3, camDir?: THREE.Vector3): void;
  strike(intensity?: number): void;
  onThunder(cb: (intensity: number, delay: number) => void): void;
  dispose(): void;
}

const MAX_PULSES = 4;
const TRUNK_N = 15;
const BRANCH_N = 5;
const BRANCH_PTS = 6;
const VERT_FLOATS = (TRUNK_N * 2 + BRANCH_N * BRANCH_PTS * 2) * 3;
const BOLT_COLOR = [18, 19, 24] as const;
const BOLT_WIDTH = 2.2;
const BOLT_LIFE = 0.6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createLightning(scene: THREE.Scene, shared: Shared): LightningEx {
  const rng = mulberry32(pnum('seed', 1337) + 701);
  const flashParam = pnum('flash', Number.NaN);
  const staticFlash = Number.isFinite(flashParam) ? clamp(flashParam, 0, 1) : null;
  const boltParam = pstr('bolt', '');
  const boltAuto = boltParam === '1';
  const boltHold = boltParam === 'hold' || boltParam === '2';

  const light = new THREE.PointLight(new THREE.Color(0.85, 0.9, 1.0), 0);
  light.name = 'lightning';
  scene.add(light);

  // Geometría del rayo: cinta de triángulos; posiciones mundiales reescritas por
  // strike. Índices fijos [0,1,2, 1,3,2] por segmento.
  const positions = new Float32Array(VERT_FLOATS);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  const indexCount = ((TRUNK_N - 1) + BRANCH_N * (BRANCH_PTS - 1)) * 6;
  {
    const idx = new Uint16Array(indexCount);
    let v = 0;
    let o = 0;
    for (let s = 0; s < TRUNK_N - 1; s++) {
      idx[o++] = v;
      idx[o++] = v + 1;
      idx[o++] = v + 2;
      idx[o++] = v + 1;
      idx[o++] = v + 3;
      idx[o++] = v + 2;
      v += 2;
    }
    for (let br = 0; br < BRANCH_N; br++) {
      for (let s = 0; s < BRANCH_PTS - 1; s++) {
        idx[o++] = v;
        idx[o++] = v + 1;
        idx[o++] = v + 2;
        idx[o++] = v + 1;
        idx[o++] = v + 3;
        idx[o++] = v + 2;
        v += 2;
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geometry.setDrawRange(0, 0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const uOpacity = uniform(0);
  material.colorNode = float(BOLT_COLOR[0]);
  material.opacityNode = uOpacity;
  material.blending = THREE.AdditiveBlending;
  const bolt = new THREE.Mesh(geometry, material);
  bolt.name = 'lightning:bolt';
  bolt.renderOrder = 15;
  bolt.frustumCulled = false;
  bolt.visible = false;
  scene.add(bolt);

  // Pulsos del strike (SoA preasignado).
  const amp = new Float32Array(MAX_PULSES);
  const decay = new Float32Array(MAX_PULSES);
  const t0 = new Float32Array(MAX_PULSES);
  let pulses = 0;
  let elapsed = 0;
  let boltTimer = 0;
  let strikes = 0;
  let thunderCb: ((intensity: number, delay: number) => void) | null = null;

  // Scratch de módulo: strike() no asigna.
  const dir = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const ref = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const side = new THREE.Vector3();
  const cam = new THREE.Vector3();
  const camForward = new THREE.Vector3(0, 0, -1);
  // Scratch del rayo (preasignado: strike() no debe asignar en el bucle).
  const trunkScratch = new Float32Array(TRUNK_N * 3);
  const branchScratch = new Float32Array(BRANCH_PTS * 3);
  let nextStrike = 8 + rng() * 10; // primer rayo a los 8–18 s
  let nextBig = 30 + rng() * 10;

  function writeStrip(v0: number, count: number, pts: Float32Array, width: number): void {
    // Escribe `count` puntos en `positions` como dos vértices por punto (±side).
    const base = v0 * 3;
    const len = Math.max(1, Math.hypot(
      pts[(count - 1) * 3] - pts[0],
      pts[(count - 1) * 3 + 1] - pts[1],
      pts[(count - 1) * 3 + 2] - pts[2],
    ));
    for (let i = 0; i < count; i++) {
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      const pz = pts[i * 3 + 2];
      const j = Math.min(i + 1, count - 1);
      const k = Math.max(i - 1, 0);
      seg.set(pts[j * 3] - pts[k * 3], pts[j * 3 + 1] - pts[k * 3 + 1], pts[j * 3 + 2] - pts[k * 3 + 2]);
      if (seg.lengthSq() < 1e-8) seg.copy(dir);
      seg.normalize();
      ref.copy(cam).sub(pt.set(px, py, pz)).normalize();
      side.crossVectors(seg, ref);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      const r = Math.hypot(px - cam.x, pz - cam.z);
      const w = width * (1 - (r / len) * 0.5);
      side.normalize().multiplyScalar(Math.max(0.05, w));
      const o = base + i * 6;
      positions[o] = px + side.x;
      positions[o + 1] = py + side.y;
      positions[o + 2] = pz + side.z;
      positions[o + 3] = px - side.x;
      positions[o + 4] = py - side.y;
      positions[o + 5] = pz - side.z;
    }
  }

  function rebuildBolt(): void {
    // Tronco: 15 puntos entre 180–440 m de radio y 110–200 m de altura.
    const pts = trunkScratch;
    const az = Math.atan2(dir.x, dir.z);
    for (let i = 0; i < TRUNK_N; i++) {
      const t = i / (TRUNK_N - 1);
      const radius = 180 + 260 * t;
      const height = 110 + 90 * t;
      const jitter = (1 - t * 0.5) * (4 + 6 * t);
      // Azimut estándar: dir.x = sin(a), dir.z = cos(a) (a = atan2(dir.x, dir.z)).
      const a = az + (rng() - 0.5) * 0.12;
      pts[i * 3] = cam.x + Math.sin(a) * radius + perp.x * (rng() - 0.5) * 2 * jitter;
      pts[i * 3 + 1] = height + (rng() - 0.5) * 2 * jitter;
      pts[i * 3 + 2] = cam.z + Math.cos(a) * radius + perp.z * (rng() - 0.5) * 2 * jitter;
    }
    writeStrip(0, TRUNK_N, pts, BOLT_WIDTH);

    // Ramas: 5, desde un punto 3..TRUNK_N-3 del tronco, 6 puntos cada una.
    const branch = branchScratch;
    let v0 = TRUNK_N * 2;
    for (let br = 0; br < BRANCH_N; br++) {
      const start = 3 + Math.floor(rng() * (TRUNK_N - 6));
      pt.fromArray(pts, start * 3);
      const bt = start / (TRUNK_N - 1);
      const bl = (180 + 260 * bt) * 0.35;
      const ba = Math.atan2(dir.x, dir.z) + (rng() - 0.5) * 1.1;
      const bh = bl * (0.35 + rng() * 0.35);
      for (let i = 0; i < BRANCH_PTS; i++) {
        const t = i / (BRANCH_PTS - 1);
        const jitter = (1 - t * 0.5) * (3 + 4 * t);
        branch[i * 3] = pt.x + Math.sin(ba) * bl * t + (rng() - 0.5) * 2 * jitter;
        branch[i * 3 + 1] = pt.y - bh * t + (rng() - 0.5) * 2 * jitter;
        branch[i * 3 + 2] = pt.z + Math.cos(ba) * bl * t + (rng() - 0.5) * 2 * jitter;
      }
      writeStrip(v0, BRANCH_PTS, branch, BOLT_WIDTH * 0.7);
      v0 += BRANCH_PTS * 2;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.setDrawRange(0, indexCount);
  }

  function strike(intensity = 0.6): void {
    const az = Math.atan2(camForward.x, camForward.z) + (rng() - 0.5) * 1.3;
    const elev = 0.55 + rng() * 0.3;
    dir.set(Math.sin(az), elev, Math.cos(az)).normalize();
    perp.set(-dir.z, 0, dir.x).normalize();

    pulses = 2 + Math.floor(rng() * 3);
    let acc = 0;
    for (let i = 0; i < pulses; i++) {
      acc += 0.08 + rng() * 0.22;
      t0[i] = acc;
      amp[i] = (i === 1 ? 1 : 0.45 + rng() * 0.5) * (1.15 - intensity * 0.6);
      decay[i] = 0.08 + rng() * 0.12;
    }
    elapsed = 0;
    strikes += 1;
    const hasBolt = intensity < 0.8 || boltHold;
    if (hasBolt) {
      rebuildBolt();
      bolt.visible = true;
      boltTimer = BOLT_LIFE;
    }
    if (thunderCb) thunderCb(intensity, 0.35 + intensity * 3.4);
  }

  const dbg = dbgRef();
  const dbgLightning: Record<string, unknown> = {
    flash: 0,
    active: false,
    strikes: 0,
    static: staticFlash,
    mode: staticFlash !== null ? 'static' : boltHold ? 'hold' : boltAuto ? 'auto' : 'normal',
  };
  if (dbg) dbg.lightning = dbgLightning;

  function update(dt: number, camPos?: THREE.Vector3, camDir?: THREE.Vector3): void {
    if (camPos) {
      cam.copy(camPos);
      bolt.position.copy(camPos);
    }
    if (camDir) camForward.copy(camDir).normalize();

    if (staticFlash !== null) {
      shared.uFlash.value = staticFlash;
      if (boltHold) {
        if (!bolt.visible) {
          // Dirección fija hacia el frente de cámara (no hay strike que la fije).
          const az = Math.atan2(camForward.x, camForward.z);
          dir.set(Math.sin(az), 0.75, Math.cos(az)).normalize();
          perp.set(-dir.z, 0, dir.x).normalize();
          rebuildBolt();
          bolt.visible = true;
        }
        boltTimer = BOLT_LIFE;
      }
      uOpacity.value = clamp(staticFlash * 6, 0, 1);
      shared.uFlashDir.value.set(dir.x, dir.z);
      if (dir.lengthSq() > 1e-6) shared.uFlashDir.value.normalize();
      light.intensity = staticFlash * 6;
      light.position.set(cam.x + dir.x * 120, dir.y * 120, cam.z + dir.z * 120);
      dbgLightning.flash = staticFlash;
      dbgLightning.active = bolt.visible;
      dbgLightning.strikes = strikes;
      return;
    }

    nextStrike -= dt;
    nextBig -= dt;
    if (boltAuto && nextStrike > 2.5) nextStrike = 2.5; // primer rayo temprano en QA
    if (nextStrike <= 0) {
      strike(0.35 + rng() * 0.65);
      nextStrike = (15 + rng() * 20) * pace();
    }
    if (nextBig <= 0) {
      strike(0.04 + rng() * 0.2);
      nextBig = (30 + rng() * 10) * pace();
    }

    elapsed += dt;
    let flash = 0;
    for (let i = 0; i < pulses; i++) {
      const t = elapsed - t0[i];
      if (t >= 0) {
        flash += amp[i] * Math.exp(-t / decay[i]) * (0.75 + 0.25 * Math.sin(140 * t + t0[i] * 50));
      }
    }
    flash = Math.min(1, flash);
    shared.uFlash.value = flash;
    if (dir.lengthSq() > 1e-6) shared.uFlashDir.value.set(dir.x, dir.z).normalize();
    light.intensity = flash * 6;
    light.position.set(cam.x + dir.x * 120, dir.y * 120, cam.z + dir.z * 120);

    if (bolt.visible) {
      boltTimer -= dt;
      if (boltTimer <= 0 && !boltHold) bolt.visible = false;
    }
    uOpacity.value = clamp(flash * 6, 0, 1);
    dbgLightning.flash = flash;
    dbgLightning.active = bolt.visible;
    dbgLightning.strikes = strikes;
  }

  function pace(): number {
    const rain = clamp(shared.uRainAmount.value, 0, 2) / 2;
    return clamp(1.7 - rain * 0.8, 0.8, 1.7);
  }

  function dispose(): void {
    scene.remove(light);
    scene.remove(bolt);
    geometry.dispose();
    material.dispose();
  }

  return {
    update,
    strike,
    onThunder(cb): void {
      thunderCb = cb;
    },
    dispose,
  };
}
