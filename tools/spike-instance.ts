/**
 * S3a · spike de decisión: ¿`instanceIndex` (gl_InstanceID) funciona en WebGPU
 * con `InstancedBufferGeometry` + `Mesh` (sin InstancedMesh)?
 *
 * Método: 8 instancias de un quad, cada una desplazada por `instanceIndex` y
 * coloreada con `instanceIndex / (N-1)`. Se renderiza a un RenderTarget y se
 * leen los píxeles: si hay 8 rojos distintos, el índice varía por instancia.
 * Salida en `window.__spike` + `#out`. Dev-only.
 */
import * as THREE from 'three/webgpu';
import { float, instanceIndex, positionGeometry, vec3, vec4 } from 'three/tsl';

interface SpikeResult {
  isWebGPU: boolean;
  requested: number;
  distinctReds: number[];
  distinctPositions: number;
  instanceIndexWorks: boolean;
  controlDistinctReds: number;
}

const N = 8;

const canvas = document.getElementById('gl');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('falta #gl');
const out = document.getElementById('out');

const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: new URLSearchParams(location.search).get('gl') === '1' });
await renderer.init();
renderer.setPixelRatio(1);
renderer.setSize(256, 256, false);

const isWebGPU = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;

// Quad centrado, 4 verts / 2 tris. InstancedBufferGeometry + Mesh (la duda del spike).
const quad = new THREE.InstancedBufferGeometry();
quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.9, -0.05, 0, 0.9, -0.05, 0, -0.9, 0.05, 0, 0.9, 0.05, 0], 3));
quad.setIndex([0, 1, 2, 2, 1, 3]);
quad.instanceCount = N;

const material = new THREE.MeshBasicNodeMaterial();
const idx = instanceIndex.toFloat();
// Lane i en y = (i - (N-1)/2) * 0.24 (si el índice es constante, se solapan las 8).
material.positionNode = vec3(positionGeometry.x, positionGeometry.y.add(idx.sub((N - 1) / 2).mul(0.24)), 0);
// (idx+1)/N -> siempre >0: el rojo 0 se confundiría con el fondo negro al leer píxeles.
material.colorNode = vec4(idx.add(1).div(N), 0, 0, 1);

const mesh = new THREE.Mesh(quad, material);
const scene = new THREE.Scene();
scene.add(mesh);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 2;

const rt = new THREE.RenderTarget(64, 64);
renderer.setRenderTarget(rt);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
const pixels = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 64, 64);

const reds = new Set<number>();
const rows = new Set<number>();
for (let i = 0; i < pixels.length; i += 4) {
  if (pixels[i] > 2) {
    reds.add(pixels[i]);
    rows.add(Math.floor(i / 4 / 64));
  }
}
const distinctReds = [...reds].sort((a, b) => a - b);

// Control: mismo grafo con instanceIndex() forzado a 0 -> 1 solo color/posición.
const controlMat = new THREE.MeshBasicNodeMaterial();
controlMat.positionNode = vec3(positionGeometry.x, positionGeometry.y, 0);
controlMat.colorNode = vec4(float(0), 0, 0, 1);
const control = new THREE.Mesh(quad, controlMat);
const controlScene = new THREE.Scene();
controlScene.add(control);
const rt2 = new THREE.RenderTarget(64, 64);
renderer.setRenderTarget(rt2);
renderer.render(controlScene, controlCamera());
renderer.setRenderTarget(null);
const cp = await renderer.readRenderTargetPixelsAsync(rt2, 0, 0, 64, 64);
const controlReds = new Set<number>();
for (let i = 0; i < cp.length; i += 4) if (cp[i] > 2) controlReds.add(cp[i]);

function controlCamera(): THREE.OrthographicCamera {
  const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  c.position.z = 2;
  return c;
}

const result: SpikeResult = {
  isWebGPU,
  requested: N,
  distinctReds,
  distinctPositions: rows.size,
  instanceIndexWorks: distinctReds.length >= N && rows.size >= N,
  controlDistinctReds: controlReds.size,
};

(window as unknown as { __spike: SpikeResult }).__spike = result;
if (out) {
  out.textContent = JSON.stringify(result, null, 2);
}
document.title = `SPIKE instanceIndex: ${result.instanceIndexWorks ? 'WORKS' : 'FAILS'} (${isWebGPU ? 'webgpu' : 'webgl2'})`;
