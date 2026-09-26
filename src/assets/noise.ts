import * as THREE from 'three/webgpu';
import { RES, bakeHeightMap } from '../world/heightMath';

/** LUT de altura horneada + su `DataTexture` half-float (§5.1 / T2.2.1). */
export interface HeightNoise {
  texture: THREE.DataTexture;
  data: Float32Array;
}

/**
 * Hornea el LUT de altura (§5.1) y lo empaqueta en la `DataTexture` que muestrea
 * el shader. Devuelve también el `Float32Array` original: JS (`height`) y GPU
 * (`heightNode`) quedan atados a la misma fuente. `seed` es la semilla global
 * (`?seed=`, ver `bakeHeightMap`).
 */
export function createHeightNoise(seed: number): HeightNoise {
  const data = bakeHeightMap(RES, seed);
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);

  const texture = new THREE.DataTexture(half, RES, RES, THREE.RedFormat, THREE.HalfFloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, data };
}
