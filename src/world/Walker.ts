import * as THREE from 'three/webgpu';
import { CAMERA } from '../core/constants';
import type { Input } from '../core/input';
import type { HeightfieldEx } from './Heightfield';
import type { TrunkCollider } from './Scatter';

/**
 * T8.2/T8.3 (§1): caminante de primera persona. Portado de las constantes de
 * "Movimiento (para referencia futura de gameplay)" de la referencia técnica:
 *
 * - `speed = {walk: 1.75, run: 3.9}` m/s (Shift = run, sin stamina).
 * - Aceleración exponencial pura: `vel.lerp(wish, 1 - exp(-9·dt))`.
 * - Snap al suelo: `groundY += (target - groundY) · min(1, dt·14)`.
 * - Colisión: círculos `r + CAMERA.radius (0.32)` con deslizamiento eje a eje
 *   y predicado `walkable`; push-out final anti-atasco.
 * - Bob: fase `φ' = 6 + 5.5u`; vertical `sin(2φ)·0.02·amp·(0.5+0.9u)`;
 *   roll `sin(φ)·0.005·amp` (en `camera.rotation.z`, §1: "rotation.z solo");
 *   respiración `sin(t·1.25)·0.004`. Sin FOV kick ni shake.
 * - Pasos por distancia acumulada: 0.8 m (walk) → 1.35 m (run), interpolado
 *   por `u`.
 *
 * Decisiones documentadas (la referencia no las fija):
 * - `u = |vel| / speed.run` (0..1) y `amp = u`: a velocidad 0 no hay bob, a
 *   run el bob es pleno (la respiración queda siempre, ±4 mm).
 * - `walkable(x,z)`: sin solape con troncos/blockers **y** `normal.y ≥ 0.82`
 *   (el mismo umbral que usa el scatter para rechazar pendientes). Evita
 *   subir paredes; el terreno de woods es suave, así que no genera muros.
 * - El radio del jugador sale de `CAMERA.radius` (0.32, §1), no de un literal.
 */
export interface WalkerDeps {
  input: Input;
  heightfield: HeightfieldEx;
  /** Listas vivas del scatter (no clonar; se refrescan por escaneo). */
  trunks(): readonly TrunkCollider[];
  blockers(): readonly TrunkCollider[];
  yawGroup: THREE.Group;
  pitchGroup: THREE.Group;
  camera: THREE.Camera;
  /** Paso sintetizado (audio); `run` = u > 0.6. */
  onStep?(run: boolean): void;
}

export interface WalkerEx {
  update(dt: number): void;
  /** Velocidad horizontal actual (m/s), para HUD/tests. */
  readonly speed: number;
  dispose(): void;
}

const SPEED_WALK = 1.75;
const SPEED_RUN = 3.9;
const ACCEL_K = 9;
const SNAP_K = 14;
const BOB_FREQ = 6;
const BOB_FREQ_RUN = 5.5;
const BOB_Y = 0.02;
const BOB_ROLL = 0.005;
const BREATH_FREQ = 1.25;
const BREATH_AMP = 0.004;
const STEP_WALK = 0.8;
const STEP_RUN = 1.35;
const SLOPE_MIN_Y = 0.82;

export function createWalker(deps: WalkerDeps): WalkerEx {
  const { input, heightfield, yawGroup, pitchGroup, camera } = deps;

  // Scratch de por vida (update() no asigna).
  const wish = new THREE.Vector2();
  const vel = new THREE.Vector2();
  const normal = new THREE.Vector3();
  let phi = 0;
  let time = 0;
  let stepAcc = 0;
  let speed = 0;

  function blockedByCircles(x: number, z: number): boolean {
    const rp = CAMERA.radius;
    const trunks = deps.trunks();
    for (let i = 0; i < trunks.length; i++) {
      const t = trunks[i];
      const dx = x - t.x;
      const dz = z - t.z;
      const r = t.r + rp;
      if (dx * dx + dz * dz < r * r) return true;
    }
    const blockers = deps.blockers();
    for (let i = 0; i < blockers.length; i++) {
      const b = blockers[i];
      const dx = x - b.x;
      const dz = z - b.z;
      const r = b.r + rp;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  function walkable(x: number, z: number): boolean {
    heightfield.normal(x, z, normal);
    if (normal.y < SLOPE_MIN_Y) return false;
    return !blockedByCircles(x, z);
  }

  /** Empuja fuera de cualquier círculo solapado (evita quedarse atascado). */
  function resolveOverlap(p: THREE.Vector3): void {
    const rp = CAMERA.radius;
    for (let pass = 0; pass < 2; pass++) {
      let pushed = false;
      const lists = [deps.trunks(), deps.blockers()];
      for (let li = 0; li < lists.length; li++) {
        const list = lists[li];
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const r = c.r + rp;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          if (d < 1e-4) {
            p.x += r;
            p.z += 0;
          } else {
            const k = (r - d) / d;
            p.x += dx * k;
            p.z += dz * k;
          }
          pushed = true;
        }
      }
      if (!pushed) break;
    }
  }

  function update(dt: number): void {
    if (dt <= 0) return;
    const p = yawGroup.position;
    const yaw = yawGroup.rotation.y;

    // Dirección de deseo en mundo (mismo convenio que la cámara de vuelo:
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)).
    let fx = 0;
    let fz = 0;
    let rx = 0;
    let rz = 0;
    if (input.isDown('KeyW')) {
      fx -= Math.sin(yaw);
      fz -= Math.cos(yaw);
    }
    if (input.isDown('KeyS')) {
      fx += Math.sin(yaw);
      fz += Math.cos(yaw);
    }
    if (input.isDown('KeyD')) {
      rx += Math.cos(yaw);
      rz -= Math.sin(yaw);
    }
    if (input.isDown('KeyA')) {
      rx -= Math.cos(yaw);
      rz += Math.sin(yaw);
    }
    const run = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const target = run ? SPEED_RUN : SPEED_WALK;
    const len = Math.hypot(fx + rx, fz + rz);
    if (len > 1e-5) {
      const s = target / len;
      wish.set((fx + rx) * s, (fz + rz) * s);
    } else {
      wish.set(0, 0);
    }

    const k = 1 - Math.exp(-ACCEL_K * dt);
    vel.x += (wish.x - vel.x) * k;
    vel.y += (wish.y - vel.y) * k;

    // Deslizamiento eje a eje: cada eje se resuelve por separado (si el X está
    // bloqueado, el Z sigue avanzando → el jugador resbala por el tronco).
    const dx = vel.x * dt;
    const dz = vel.y * dt;
    if (dx !== 0) {
      if (walkable(p.x + dx, p.z)) p.x += dx;
      else vel.x = 0;
    }
    if (dz !== 0) {
      if (walkable(p.x, p.z + dz)) p.z += dz;
      else vel.y = 0;
    }
    resolveOverlap(p);

    // Snap al suelo y bob/respiración.
    const ground = heightfield.height(p.x, p.z);
    p.y += (ground - p.y) * Math.min(1, dt * SNAP_K);

    speed = Math.hypot(vel.x, vel.y);
    const u = Math.min(1, speed / SPEED_RUN);
    const amp = u;
    phi += (BOB_FREQ + BOB_FREQ_RUN * u) * dt;
    time += dt;
    const bobY = Math.sin(2 * phi) * BOB_Y * amp * (0.5 + 0.9 * u);
    const roll = Math.sin(phi) * BOB_ROLL * amp;
    pitchGroup.position.y = CAMERA.eye + bobY + Math.sin(time * BREATH_FREQ) * BREATH_AMP;
    camera.rotation.z = roll;

    // Pasos por distancia recorrida (0.8 m walk → 1.35 m run).
    stepAcc += speed * dt;
    if (stepAcc >= STEP_WALK + (STEP_RUN - STEP_WALK) * u) {
      stepAcc = 0;
      if (deps.onStep) deps.onStep(u > 0.6);
    }
  }

  function dispose(): void {
    /* sin recursos propios: el rig y las listas son del llamante */
  }

  return {
    update,
    get speed(): number {
      return speed;
    },
    dispose,
  };
}
