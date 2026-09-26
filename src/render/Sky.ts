import * as THREE from 'three/webgpu';
import {
  clamp,
  dot,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { SKY } from '../core/constants';
import type { Shared } from '../core/shared';

export interface SkyEx {
  mesh: THREE.Mesh;
  update(cameraPos: THREE.Vector3): void;
  dispose(): void;
}

export function createSky(shared: Shared): SkyEx {
  const geometry = new THREE.SphereGeometry(SKY.radius, SKY.segments[0], SKY.segments[1]);
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  // §3: los nombres horizon/zenith del doc están invertidos respecto a la física,
  // pero el grafo es el correcto (cenit oscuro, horizonte más claro).
  const w = normalize(positionLocal);
  const T = clamp(w.y, -0.05, 1);
  const zenith = vec3(SKY.zenith[0], SKY.zenith[1], SKY.zenith[2]);
  const horizon = vec3(SKY.horizon[0], SKY.horizon[1], SKY.horizon[2]);
  let D: Node<'vec3'> = mix(zenith, horizon, pow(max(T, 0), 0.5));

  // Nubes: 2 fbm de MaterialX, uv proyectada en el plano y scroll con uTime (no el
  // nodo global `time`, para que el tiempo siga siendo propiedad de Environment).
  const ee = w.xz.div(max(w.y, 0.06).add(0.08));
  const t = shared.uTime.mul(0.006);
  const O = mx_fractal_noise_float(
    vec3(ee.mul(0.55).add(vec2(t, t.mul(0.5))), shared.uTime.mul(0.004)),
    4,
    2.1,
    0.55,
  );
  const ne = mx_fractal_noise_float(vec3(ee.mul(1.7).add(vec2(t.mul(1.8), 3.3)), 7.1), 3, 2.0, 0.5);
  D = D.mul(O.mul(0.3).add(ne.mul(0.09)).add(1));
  D = D.mul(mix(1, 0.7, smoothstep(0.05, 0.3, O)));

  // Disco + halo lunar (la nube O lo atenúa).
  const e = max(dot(w, shared.uMoonDir), 0);
  D = D.add(
    vec3(0.5, 0.58, 0.75)
      .mul(pow(e, 60).mul(0.12).add(pow(e, 8).mul(0.03)))
      .mul(mix(1.2, 0.5, smoothstep(0, 0.3, O))),
  );

  // Calima de horizonte (VB).
  D = mix(
    shared.uHorizonColor.mul(smoothstep(-0.12, 0.45, w.y).mul(0.5).add(0.85)),
    D,
    smoothstep(-0.03, 0.22, w.y),
  );

  // Destello de rayo (flash de F5).
  D = D.add(
    shared.uFlash
      .mul(mix(0.45, 1.5, smoothstep(-0.4, 1, dot(normalize(w.xz), shared.uFlashDir))))
      .mul(vec3(1.1, 1.15, 1.3))
      .mul(smoothstep(0.35, 0.9, w.y).oneMinus().mul(0.7).add(0.3)),
  );

  material.colorNode = D;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;

  return {
    mesh,
    // Sin allocs: copy() reutiliza el Vector3 interno de Object3D.
    update(cameraPos: THREE.Vector3): void {
      mesh.position.copy(cameraPos);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
