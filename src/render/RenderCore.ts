import * as THREE from 'three/webgpu';
import { CAMERA, POST, QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { url } from '../core/params';

export interface RenderCoreEx {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  isWebGPU: boolean;
  quality: Quality;
  render(dt: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

// Frontera sin tipos: `renderer.backend` está tipado como Backend, pero el flag
// isWebGPUBackend solo existe en la clase concreta (WebGPUBackend.d.ts:22).
interface BackendLike {
  isWebGPUBackend?: boolean;
}

interface GpuAdapterLike {
  limits?: { maxSampledTexturesPerShaderStage?: number };
}

interface NavigatorGpuLike {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GpuAdapterLike | null>;
  };
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export async function createRenderCore(canvas: HTMLCanvasElement, quality: Quality): Promise<RenderCoreEx> {
  const forceWebGL = url.get('gl') === '1';

  // Adapter previo SOLO para leer límites de texturas (informativo en __dbg);
  // no se pasa al renderer interno ni altera su inicialización.
  const navGpu = (navigator as unknown as NavigatorGpuLike).gpu;
  if (navGpu) {
    try {
      const adapter = await navGpu.requestAdapter({ powerPreference: 'high-performance' });
      const limit = adapter?.limits?.maxSampledTexturesPerShaderStage;
      const dbg = dbgRef();
      if (dbg && typeof limit === 'number') Object.assign(dbg, { maxSampledTexturesPerShaderStage: limit });
    } catch {
      /* adapter no disponible: los límites quedan sin leer */
    }
  }

  let renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    forceWebGL,
  });

  try {
    await renderer.init();
  } catch (err) {
    // WebGPU no disponible: se reintenta con el mismo WebGPURenderer pero
    // forceWebGL. Canvas nuevo in-place: si el intento WebGPU ya reservó el
    // contexto del canvas, getContext('webgl2') devolvería null sobre el viejo.
    console.warn('[nightwoods] WebGPU init failed, falling back to WebGL2', err);
    const failed = renderer;
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
    renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      forceWebGL: true,
    });
    try {
      await failed.dispose();
    } catch {
      /* el renderer fallido puede no estar inicializado */
    }
    await renderer.init();
  }

  const isWebGPU = (renderer.backend as unknown as BackendLike).isWebGPUBackend === true;

  let width = canvas.clientWidth || window.innerWidth;
  let height = canvas.clientHeight || window.innerHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0f);

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, width / height, CAMERA.near, CAMERA.far);
  camera.layers.enable(1);
  camera.layers.enable(2);

  renderer.shadowMap.enabled = true;
  // §2.2 pide PCFSoftShadowMap, pero r186 lo eliminó del WebGPURenderer (lo
  // degrada a PCFShadowMap con un warn en el primer render). Fijamos el real.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // AgX existe en r186 (=6); si una build futura lo quitase, se cae a ACES.
  const AGX = (THREE as unknown as { AgXToneMapping?: THREE.ToneMapping }).AgXToneMapping;
  renderer.toneMapping = AGX ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = POST.exposure;

  function applySize(): void {
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function applyDpr(q: Quality): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[q].dpr));
    renderer.setSize(width, height, false);
    const dbg = dbgRef();
    if (dbg) {
      dbg.quality = q;
      dbg.dpr = renderer.getPixelRatio();
    }
  }

  function onResize(): void {
    // setPixelRatio NO se llama aquí (decisión documentada, igual que RW):
    // el cap de DPR solo cambia al cambiar de calidad.
    applySize();
  }
  window.addEventListener('resize', onResize);

  let current = quality;
  applyDpr(current);
  applySize();

  function render(_dt: number): void {
    renderer.render(scene, camera);
  }

  function setQuality(q: Quality): void {
    current = q;
    applyDpr(q);
  }

  function dispose(): void {
    window.removeEventListener('resize', onResize);
    renderer.setAnimationLoop(null);
    scene.clear();
    void renderer.dispose();
  }

  return {
    renderer,
    scene,
    camera,
    isWebGPU,
    get quality(): Quality {
      return current;
    },
    render,
    setQuality,
    dispose,
  };
}
