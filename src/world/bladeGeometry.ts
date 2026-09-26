import * as THREE from 'three/webgpu';

/**
 * Geometría de brizna de césped (T3.2.1, §6.4): 5 filas → 9 vértices / 7
 * triángulos, indexada, con la punta en (0,1,0) y perfil que estrecha hacia
 * arriba (`i = 1 - r*0.55`). Las normales van a (0,0,1): el material las
 * sobrescribe con `normalNode` (§6.7). Sin atributos por instancia.
 *
 * La base está en y=0; el shader hunde 1 cm (`-0.01`) para que no floten.
 */
export function buildGrassBlade(): THREE.BufferGeometry {
  const position: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];

  for (let row = 0; row <= 4; row++) {
    const r = row / 4;
    if (row === 4) {
      position.push(0, 1, 0);
      uv.push(0.5, 1);
      normal.push(0, 0, 1);
    } else {
      const i = 1 - r * 0.55;
      position.push(-i, r, 0, i, r, 0);
      uv.push(0, r, 1, r);
      normal.push(0, 0, 1, 0, 0, 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6, 5, 7, 6, 6, 7, 8]);
  return geometry;
}
