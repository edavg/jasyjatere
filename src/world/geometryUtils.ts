import * as THREE from 'three/webgpu';

/**
 * Utilidades geométricas procedurales compartidas por árboles (S4b) y props (S4c).
 * Portadas del proyecto propio `horror/src/world/Vegetation.ts` y
 * `horror/src/entities/JasyRig.ts` (algoritmos + constantes propias, sin assets).
 */

/** Fusiona geometrías no indexadas en una sola (position/normal/uv). */
export function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // T7.2.5: r186 avisa «already non-indexed» si se llama `toNonIndexed()` sobre
  // una geometría sin índice; el ternario silencia el warning de consola.
  const parts = list.map((g) => (g.index !== null ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += (g.getAttribute('position') as THREE.BufferAttribute).count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const u = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const k = (o + i) * 3;
      pos[k] = p.getX(i);
      pos[k + 1] = p.getY(i);
      pos[k + 2] = p.getZ(i);
      nrm[k] = n.getX(i);
      nrm[k + 1] = n.getY(i);
      nrm[k + 2] = n.getZ(i);
      const t = (o + i) * 2;
      uvs[t] = u.getX(i);
      uvs[t + 1] = u.getY(i);
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  for (const g of list) g.dispose();
  for (const g of parts) if (!list.includes(g)) g.dispose();
  return out;
}

/** Desplaza radialmente en XZ: `r *= 1 + fn(x,y,z)`. Recalcula normales. */
export function displaceRadial(
  g: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number) => number,
): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.sqrt(x * x + z * z);
    if (r < 1e-4) continue;
    const f = 1 + fn(x, y, z);
    p.setXYZ(i, x * f, y, z * f);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
}

/** Icosaedro escalado en Y y trasladado (rocas, copas de follaje). */
export function scaledIcosa(
  r: number,
  detail: number,
  x: number,
  y: number,
  z: number,
  sy: number,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
}

/** Plano colgante (droop) que se afina hacia la punta; base en y=0. */
export function droopPlane(
  w: number,
  h: number,
  segs: number,
  droop: number,
  taper: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 1, segs);
  g.translate(0, h * 0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, p.getY(i) / h);
    p.setXYZ(i, p.getX(i) * (1 - taper * t), p.getY(i), -droop * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** Tubo cónico a lo largo de una Catmull-Rom por `pts` (troncos y ramas). */
export function taperedTube(
  pts: THREE.Vector3[],
  r0: number,
  r1: number,
  segs: number,
  radial: number,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  const cols = radial + 1;
  const rows = segs + 1;
  const pos = new Float32Array(rows * cols * 3);
  const nor = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const idx: number[] = [];
  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const up2 = new THREE.Vector3(0, 0, 1);

  for (let i = 0; i < rows; i++) {
    const t = i / segs;
    curve.getPoint(t, P);
    curve.getTangent(t, T);
    N.crossVectors(T, up);
    if (N.lengthSq() < 1e-6) N.crossVectors(T, up2);
    N.normalize();
    B.crossVectors(T, N).normalize();
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j < cols; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = ca * N.x + sa * B.x;
      const ny = ca * N.y + sa * B.y;
      const nz = ca * N.z + sa * B.z;
      const vi = i * cols + j;
      pos[vi * 3] = P.x + nx * r;
      pos[vi * 3 + 1] = P.y + ny * r;
      pos[vi * 3 + 2] = P.z + nz * r;
      nor[vi * 3] = nx;
      nor[vi * 3 + 1] = ny;
      nor[vi * 3 + 2] = nz;
      uv[vi * 2] = j / radial;
      uv[vi * 2 + 1] = t;
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Centra en XZ, apoya la base en y=0. Devuelve el maxY original (altura de referencia). */
export function fitToBase(g: THREE.BufferGeometry): number {
  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb) return 1;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  const h0 = bb.max.y - bb.min.y;
  g.translate(-cx, -bb.min.y, -cz);
  return Math.max(1, h0);
}
