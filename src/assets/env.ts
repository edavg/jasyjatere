import * as THREE from 'three/webgpu';
import { SKY, SUN } from '../core/constants';

// Equirectangular nocturno 100 % procedural (§2.4/T1.2.3). El PMREM que genera
// three a partir de él es tan suave que el "disco" lunar es un lóbulo gaussiano
// ancho, no una fuente dura: el IBL solo aporta un sheen direccional sutil.
const W = 256;
const H = 128;

const MOON_DIR = new THREE.Vector3(SUN.offset[0], SUN.offset[1], SUN.offset[2]).normalize();
const MOON_COLOR: readonly [number, number, number] = [0.5, 0.58, 0.75];
const GROUND: readonly [number, number, number] = [0.006, 0.006, 0.008];

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function createNightEquirect(): THREE.DataTexture {
  const data = new Uint16Array(W * H * 4);
  const { zenith, horizon } = SKY;

  for (let j = 0; j < H; j++) {
    // Fila 0 = v=0 = nadir; la última fila = cenit (equirectUV usa asin(y)).
    const v = (j + 0.5) / H;
    const sinEl = Math.sin((v - 0.5) * Math.PI);
    const cosEl = Math.cos((v - 0.5) * Math.PI);
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const phi = (u - 0.5) * Math.PI * 2;
      const wx = cosEl * Math.cos(phi);
      const wz = cosEl * Math.sin(phi);
      const wy = sinEl;

      const t = Math.pow(Math.max(wy, 0), 0.5);
      let r = horizon[0] + (zenith[0] - horizon[0]) * t;
      let g = horizon[1] + (zenith[1] - horizon[1]) * t;
      let b = horizon[2] + (zenith[2] - horizon[2]) * t;

      // Transición suave al suelo oscuro por debajo del horizonte.
      const under = smoothstep(0, -0.4, wy);
      r += (GROUND[0] - r) * under;
      g += (GROUND[1] - g) * under;
      b += (GROUND[2] - b) * under;

      // Lóbulo lunar ancho (gaussiana en 1-cos), sin borde duro.
      const e = Math.max(wx * MOON_DIR.x + wy * MOON_DIR.y + wz * MOON_DIR.z, 0);
      const lobe = Math.exp(-(1 - e) / 0.08) * 0.55;
      r += MOON_COLOR[0] * lobe;
      g += MOON_COLOR[1] * lobe;
      b += MOON_COLOR[2] * lobe;

      const o = (j * W + i) * 4;
      data[o] = THREE.DataUtils.toHalfFloat(r);
      data[o + 1] = THREE.DataUtils.toHalfFloat(g);
      data[o + 2] = THREE.DataUtils.toHalfFloat(b);
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function disposeNightEquirect(tex: THREE.DataTexture): void {
  tex.dispose();
}
