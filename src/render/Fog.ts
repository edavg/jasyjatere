import * as THREE from 'three/webgpu';
import { cameraPosition, clamp, exp, fog, length, max, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { FOG, TORCH } from '../core/constants';
import { pnum, pstr } from '../core/params';
import type { Shared } from '../core/shared';
import type { TorchEx } from './Torch';

export interface FogEx {
  /** Nodo fog(color, factor) listo para scene.fogNode. */
  node: unknown;
  install(scene: THREE.Scene): void;
  dispose(): void;
}

/** @types/three 0.186 no declara Scene.fogNode, pero r186 lo lee (three.webgpu.js:58077). */
type SceneFogHost = THREE.Scene & { fogNode?: unknown };

export function createFog(shared: Shared, torch: TorchEx): FogEx {
  // ?fog=N escala zB; ?fogcol=r,g,b sustituye VB (si el parseo falla, quedan los defaults).
  shared.uFogDensity.value = FOG.density * pnum('fog', 1);
  const fogcol = pstr('fogcol', '');
  if (fogcol !== '') {
    const parts = fogcol.split(',').map((s) => Number.parseFloat(s));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      shared.uHorizonColor.value.set(parts[0], parts[1], parts[2]);
    }
  }

  const d = positionWorld.sub(cameraPosition);
  const f = length(d);
  const p = d.y.div(max(f, 0.001));

  const h = exp(f.mul(shared.uFogDensity).negate()).oneMinus();
  const g = clamp(exp(positionWorld.y.sub(shared.uFogHeightRef).mul(-0.9)), 0, 1).mul(
    smoothstep(200, 600, f).oneMinus(),
  );
  const w = smoothstep(
    shared.uFogHeightRef.sub(220),
    shared.uFogHeightRef.sub(60),
    positionWorld.y,
  ).oneMinus();
  const v = exp(
    f
      .mul(shared.uFogDensity)
      .mul(g.mul(0.45).add(w.mul(0.9)))
      .negate(),
  ).oneMinus();
  const y = smoothstep(shared.uFogNearFar.x, shared.uFogNearFar.y, f);
  const factor = clamp(max(h.oneMinus().mul(v.oneMinus()).oneMinus(), y), 0, 1);

  // Dispersión del haz: en RW los faros se ven en el aire (lluvia en el cono).
  // Aquí el mismo `beamAt` que usa la lluvia tiñe la niebla de ámbar dentro del
  // haz; con la linterna apagada vale 0 y la niebla queda igual que antes.
  const beam = torch.beamAt(positionWorld);

  const color = shared.uHorizonColor
    .mul(smoothstep(-0.12, 0.45, p).mul(0.5).add(0.85))
    .mul(shared.uFlash.mul(2.2).add(1))
    .add(vec3(TORCH.color[0], TORCH.color[1], TORCH.color[2]).mul(beam).mul(TORCH.fogGain));

  const node = fog(color, factor);

  let host: SceneFogHost | null = null;

  return {
    node,
    install(scene: THREE.Scene): void {
      host = scene as SceneFogHost;
      host.fogNode = node;
    },
    dispose(): void {
      if (host !== null && host.fogNode === node) delete host.fogNode;
      host = null;
    },
  };
}
