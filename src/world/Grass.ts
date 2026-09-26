import * as THREE from 'three/webgpu';
import {
  clamp,
  cos,
  float,
  hash,
  instanceIndex,
  length,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  transformNormalToView,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { GRASS, WIND, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool, pnum } from '../core/params';
import type { Shared } from '../core/shared';
import { buildGrassBlade } from './bladeGeometry';

/**
 * Césped (T3.2.2, §6): un solo draw call, n²·k briznas, cero atributos por
 * instancia. La posición de cada brizna se deriva en el vertex shader desde
 * `uOrigin` + `instanceIndex` + hash PCG uint; por frame solo se escriben dos
 * Vector2 (uniform, ~32 B), nunca buffers.
 *
 * Decisión S3a (spike verificado en `tools/spike-instance.ts`): `instanceIndex`
 * (gl_InstanceID) funciona con `InstancedBufferGeometry` + `Mesh` en WebGPU, así
 * que NO se usa `InstancedMesh`: se ahorran los ~16 MB de `instanceMatrix`
 * identidad en high (que además nunca se leería, porque la matriz va en el
 * shader).
 */
export interface GrassEx {
  mesh: THREE.Mesh;
  readonly count: number;
  /** radio de la rejilla: n·GRASS.cell/2 (m) */
  readonly R: number;
  update(camPos: THREE.Vector3, dt: number): void;
  dispose(): void;
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createGrass(scene: THREE.Scene, shared: Shared, quality: Quality): GrassEx {
  const { n, k } = GRASS.tiers[quality];
  const count = n * n * k;
  const R = (n * GRASS.cell) / 2;
  const XV = GRASS.cell;

  // Uniforms locales (el contrato `shared` no define ninguno de los tres):
  // - uOrigin: origen de la rejilla n×n de celdas, §6.2 (lo pide el doc).
  // - uCamXZ: centro del fade radial `te` §6.3. El doc usa la posición de la
  //   cámara directamente, pero aquí es imprescindible como uniform porque el
  //   fade se evalúa contra un XZ fijo mientras la cámara se mueve dentro de la
  //   rejilla (uOrigin solo cambia al cruzar 0.5 m). Añadido necesario.
  // - uWind: fuerza del viento §6.6 = WIND.strength × ?wind=N.
  const uOrigin = uniform(new THREE.Vector2());
  const uCamXZ = uniform(new THREE.Vector2());
  const uWind = uniform(WIND.strength * pnum('wind', 1));

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'grass';
  material.metalness = 0;
  material.envMapIntensity = 0.35;
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.FrontSide;
  material.fog = true; // la niebla entra por scene.fogNode (F1b)

  // --- Índice de instancia → celda (§6.2) ---------------------------------
  const divK = uint(k);
  const divN = uint(n);
  const f = instanceIndex.div(divK); // uint: instancia / k
  const p = instanceIndex.mod(divK); // uint: slot de brizna en la celda
  const mx = f.mod(divN); // offset de celda X (= m del doc)
  const mz = f.div(divN); // offset de celda Z (= h del doc)
  const gx = uint(uOrigin.x).add(mx);
  const gz = uint(uOrigin.y).add(mz);
  // Hash de celda en uint32 real: nada de hash float (§6.2, trampa clásica).
  const cell = gx
    .mul(uint(73856093))
    .bitXor(gz.mul(uint(19349663)))
    .bitXor(p.add(uint(1)).mul(uint(83492791)));
  // y(s) = hash(cell + s·7919); el `hash` de three ya es el PCG de §6.2.
  const y = (salt: number): Node<'float'> => hash(cell.add(uint(salt * 7919)));
  const y1 = y(1);
  const y2 = y(2);
  const y3 = y(3);
  const y4 = y(4);
  const y5 = y(5);
  const y6 = y(6);
  const y7 = y(7);
  const y8 = y(8);
  const y9 = y(9);
  const worldX = float(gx).sub(1e6).mul(XV).add(y1.mul(XV));
  const worldZ = float(gz).sub(1e6).mul(XV).add(y2.mul(XV));
  const S = vec2(worldX, worldZ);
  const C = shared.uHeightNode(S); // leído en vivo (contrato shared)

  // --- Densidad, fade radial y claro (§6.3) -------------------------------
  // n01(x) = mx_noise_float(vec3(x,0))·0.5+0.5. El doc no define n01; decisión
  // documentada: Perlin de MaterialX remapeado a [0,1) (el ruido devuelve ~[-1,1]).
  const n01 = (x: Node<'vec2'>): Node<'float'> => mx_noise_float(vec3(x, 0)).mul(0.5).add(0.5);
  const t = shared.uTime;

  const w = n01(S.mul(0.06).add(vec2(13.1, 4.4))).toVar('grassW');
  const T = n01(S.mul(0.28).add(vec2(1.7, 9.9)));
  // T (tinte de densidad) y le (facing) se necesitan también en el fragment:
  // se pasan como varyings para no reevaluar el hash/Perlin por píxel.
  const tv = T.toVarying('grassT');
  const E = smoothstep(0.38, 0.62, w.add(tv.sub(0.5).mul(0.35)));
  const te = smoothstep(R * 0.72, R * 0.97, length(S.sub(uCamXZ))).oneMinus();
  const O = smoothstep(
    shared.uClear.z.sub(1.5),
    shared.uClear.z,
    length(S.sub(shared.uClear.xy)),
  );
  // landNode(S): máscara de terreno (calles/landmarks). En woods no existe (F4
  // la añadirá): constante 1, igual que el valor por defecto del doc.
  const land = float(1);
  const ie = select(y3.lessThan(E), float(1), float(0)).mul(te).mul(O).mul(land);

  // --- Aleatoriedad por brizna (§6.5) -------------------------------------
  const oe = mix(0.22, 0.62, y4).mul(mix(0.7, 1.0, w)).mul(ie);
  const se = mix(0.011, 0.02, y5).mul(ie);
  const ce = y6.mul(6.2832);
  const le = vec2(cos(ce), sin(ce));
  const lev = le.toVarying('grassLe');
  const ue = vec2(lev.y.negate(), lev.x);
  const de = mix(0.12, 0.42, y7);

  // --- Viento (§6.6) ------------------------------------------------------
  const fe = n01(S.mul(0.018).sub(shared.uWindDir.mul(t.mul(0.11))))
    .mul(0.7)
    .add(0.3)
    .mul(shared.uGust.mul(0.6).add(0.4))
    .toVar('grassFe');
  const py = positionGeometry.y;
  const pe = sin(t.mul(1.9).add(worldX.mul(0.7)).add(worldZ.mul(0.5)).add(y8.mul(6.28))).mul(0.06);
  const me = sin(t.mul(11).add(y9.mul(60))).mul(0.002);
  const he = fe.mul(0.3).add(pe).add(me).mul(uWind).mul(1.3);
  const ge = lev.mul(de).add(shared.uWindDir.mul(he));
  const bw = py.mul(py); // altura²: la punta dobla más
  // lf = 1 - |ge|²·0.35: conservación de longitud intencionada (no es 0.5, §6.6).
  const lf = float(1).sub(length(ge).pow(2).mul(0.35));

  // --- Posición final (§6.6) ----------------------------------------------
  const px = positionGeometry.x;
  material.positionNode = vec3(
    worldX.add(ue.x.mul(px).mul(se)).add(ge.x.mul(bw).mul(oe)),
    C.add(py.mul(oe).mul(lf)).sub(0.01), // -1 cm hunde la base
    worldZ.add(ue.y.mul(px).mul(se)).add(ge.y.mul(bw).mul(oe)),
  );

  // --- Normal y color (§6.7); normales en espacio de vista -----------------
  const y10v = y(10).toVarying('grassY10');
  const y11v = y(11).toVarying('grassY11');
  material.normalNode = transformNormalToView(
    normalize(mix(vec3(lev.x, 0, lev.y), vec3(0, 1, 0), 0.6)),
  );

  const uvY = uv().y;
  const base = mix(vec3(0.03, 0.078, 0.013), vec3(0.068, 0.16, 0.026), y10v).mul(
    mix(0.38, 1, uvY),
  );
  const dried = mix(
    base,
    vec3(0.15, 0.125, 0.036),
    smoothstep(0.72, 1, uvY).mul(y11v).mul(0.55),
  );
  material.colorNode = dried.mul(mix(0.8, 1.15, tv));
  material.roughnessNode = clamp(mix(0.8, 0.6, uvY), 0, 1);

  // --- Geometría y malla --------------------------------------------------
  // `InstancedBufferGeometry` copiando la brizna (9 verts / 7 tris, compartidos
  // por las n²·k instancias). Sin atributos por instancia.
  const blade = buildGrassBlade();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', blade.getAttribute('position'));
  geometry.setAttribute('uv', blade.getAttribute('uv'));
  geometry.setAttribute('normal', blade.getAttribute('normal'));
  const index = blade.getIndex();
  if (index === null) throw new Error('Grass: la brizna no tiene índice');
  geometry.setIndex(index);
  geometry.instanceCount = count;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'grass';
  // La posición sale del shader: la bounding sphere local nunca es válida.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Capa 1: excluida de reflejos y del shadow map (la cámara de sombras solo
  // habilita 0 y 2, §2.3). La cámara principal sí la ve.
  mesh.layers.set(1);
  // Matriz identidad a propósito: positionNode ya escribe coordenadas de mundo.
  mesh.visible = pbool('grass', true);
  scene.add(mesh);

  const dbg = dbgRef();
  if (dbg) {
    dbg.grass = {
      count,
      R,
      cell: GRASS.cell,
      tier: quality,
      visible: mesh.visible,
      effective: Math.round(count * 0.5), // ~50% sobrevive a la densidad §6.3
      instanceCount: geometry.instanceCount,
      attrs: Object.keys(geometry.attributes),
    };
  }

  function update(camPos: THREE.Vector3, _dt: number): void {
    // Lo ÚNICO que se escribe por frame: el origen de la rejilla (§6.2) y el
    // centro del fade radial. Cero allocs, cero buffers.
    uOrigin.value.set(
      Math.floor((camPos.x - R) / XV) + 1e6,
      Math.floor((camPos.z - R) / XV) + 1e6,
    );
    uCamXZ.value.set(camPos.x, camPos.z);
  }

  function dispose(): void {
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
  }

  return { mesh, count, R, update, dispose };
}
