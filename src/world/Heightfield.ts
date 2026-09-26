import * as THREE from 'three/webgpu';
import { Fn, texture as sampleTexture, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { createHeightNoise } from '../assets/noise';
import { pnum } from '../core/params';
import type { HeightNodeFn, Shared } from '../core/shared';
import { LUT_SEED, RES, SHAPE, normalFrom, noiseFrom, rawHeight } from './heightMath';

/**
 * Fuente de verdad de altura (T2.2.2): JS y TSL leen el MISMO LUT (§5.1). El
 * JS muestrea el `Float32Array`; el shader muestrea la `DataTexture`
 * half-float (Repeat+Linear), por lo que la única diferencia posible es la
 * cuantización de la textura, no la fórmula.
 */
export interface HeightfieldEx {
  /** Altura exacta en CPU (= raw). Sin allocs. */
  height(x: number, z: number): number;
  /** Normal por diferencias finitas centradas; escribe en `out`. Sin allocs. */
  normal(x: number, z: number, out: THREE.Vector3, eps?: number): THREE.Vector3;
  /** `N(x/64, z/64)`, densidad de árboles/props (§5.1). Sin allocs. */
  noise(x: number, z: number): number;
  /** `(vec2 worldXZ) -> float` para shaders (césped, lluvia, …). */
  heightNode: Shared['uHeightNode'];
  /** Forma del terreno §5.1 (= height). Sin allocs. */
  raw(x: number, z: number): number;
  texture: THREE.DataTexture;
  /** LUT Float32 pre-cuantización (extra: lo usará Scatter si lo necesita). */
  data: Float32Array;
  dispose(): void;
}

export function createHeightfield(shared: Shared): HeightfieldEx {
  const seed = pnum('seed', LUT_SEED);
  const { texture, data } = createHeightNoise(seed);
  const res = RES;

  const h = (x: number, z: number): number => rawHeight(data, res, x, z);

  // Espejo TSL de raw(): mismas constantes y misma aritmética que heightMath.
  // RepeatWrapping + LinearFilter dan el wrap y el bilineal gratis.
  // El contrato `HeightNodeFn` (shared.ts) es el que hace asignable un Fn con
  // retorno calculado (el inicializador por defecto es demasiado estrecho).
  const heightNode: HeightNodeFn = Fn(([p]: [Node<'vec2'>]) => {
    const ov = Math.cos(SHAPE.rot);
    const kv = Math.sin(SHAPE.rot);
    const uvA = p.div(SHAPE.periodA);
    const uvB = vec2(p.x.mul(ov).sub(p.y.mul(kv)), p.x.mul(kv).add(p.y.mul(ov)))
      .div(SHAPE.periodB)
      .add(vec2(SHAPE.offBx, SHAPE.offBy));
    const a = sampleTexture(texture, uvA).r.sub(0.5).mul(2 * SHAPE.ampA);
    const b = sampleTexture(texture, uvB).r.sub(0.5).mul(2 * SHAPE.ampB);
    return a.add(b);
  });

  // Único campo mutado por F2 (contrato shared): los consumidores deben leerlo
  // siempre como `shared.uHeightNode(...)`.
  shared.uHeightNode = heightNode;

  return {
    height: h,
    normal(x, z, out, eps = 0.4): THREE.Vector3 {
      normalFrom(data, res, x, z, out, eps);
      return out;
    },
    noise(x: number, z: number): number {
      return noiseFrom(data, res, x, z);
    },
    heightNode,
    raw: h,
    texture,
    data,
    dispose(): void {
      texture.dispose();
    },
  };
}
