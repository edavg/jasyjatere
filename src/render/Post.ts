import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  convertToTexture,
  float,
  int,
  length,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { POST, QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool, pnum, pstr } from '../core/params';

/**
 * Post — cadena TSL de §11 sobre `RenderPipeline` (r183+; `PostProcessing` está
 * deprecado). Orden de la cadena numerada de la referencia:
 *
 *   pass(MRT output/normal/velocity) → AO → Sharpen → TAA → Bloom → Motion
 *   → renderOutput (AgX+exposición+sRGB) → grade → CA → viñeta → grano
 *
 * La referencia lista «Sharpen después del AA» en §11.2 pero el pipeline
 * numerado de §11 (y del prompt T6.2.1) pone Sharpen antes del TAA; se sigue
 * la cadena numerada. Excepción medida: con `?taa=taau` el pase de escena es el
 * buffer de BAJA resolución que consume el propio TAAU, así que el Sharpen se
 * aplica después del upscale (si no, el TAAU leería un input full-res con
 * velocity low-res: mezcla de resoluciones rota). Documentado en el informe.
 *
 * `outputColorTransform = false` + un único `renderOutput` explícito = AgX y
 * encoding exactamente una vez (sin doble tonemap).
 *
 * Debug: `?post=N` corta la cadena a partir del nivel N (3 AO, 4 sharpen,
 * 5 AA, 6 bloom, 7 motion, 8 CA, 9 viñeta, 10 grano; 0 = sin post, lo gestiona
 * main.ts), `?view=normal|depth|velocity`, `?ao=0`, `?aoView=1`,
 * `?taa=off|traa|taau`, `?tune=clave:valor,...` (sobrescribe POST; `aa` admite
 * traa|taau|off) y `?motion=0|1`.
 */
export interface PostEx {
  pipeline: THREE.RenderPipeline;
  render(dt: number): void;
  setSize(width: number, height: number): void;
  /** Precompila el pase de escena con el MRT configurado (evita el hitch inicial). */
  compileAsync(): Promise<void>;
  dispose(): void;
}

type TaaMode = 'off' | 'traa' | 'taau';
type ViewMode = 'normal' | 'depth' | 'velocity';

/** Niveles de corte de `?post=N` (§11 y T6.2.3). */
const LEVEL = { ao: 3, sharpen: 4, aa: 5, bloom: 6, motion: 7, ca: 8, vignette: 9, grain: 10 } as const;

const TUNE_KEYS = [
  'exposure',
  'bloom',
  'bloomRadius',
  'bloomThreshold',
  'motion',
  'ca',
  'grain',
  'vignette',
  'sharpen',
  'ao',
  'saturation',
  'contrast',
] as const;
type TuneKey = (typeof TUNE_KEYS)[number];

function dbgRef(): Dbg | null {
  return (typeof window === 'undefined' ? null : (window as unknown as { __dbg?: Dbg }).__dbg) ?? null;
}

/**
 * Los nodos de post de `three/addons/tsl/display` están tipados en
 * @types/three como `TempNode<unknown>` aunque emiten `vec4`; este cast local
 * evita sembrar `any` por todo el encadenado.
 */
function asVec4(node: object): Node<'vec4'> {
  return node as unknown as Node<'vec4'>;
}

/** `BloomNode` solo expone `getTextureNode()` en runtime (el .d.ts dice `getTexture()`). */
function bloomTerm(bloomNode: ReturnType<typeof bloom>): Node<'vec4'> {
  return asVec4((bloomNode as unknown as { getTextureNode(): Node }).getTextureNode());
}

function parseTune(): Record<TuneKey, number> & { aa: string } {
  const tune = {} as Record<TuneKey, number> & { aa: string };
  for (const key of TUNE_KEYS) tune[key] = POST[key];
  tune.aa = POST.aa;
  for (const pair of pstr('tune', '').split(',')) {
    const sep = pair.indexOf(':');
    if (sep <= 0) continue;
    const key = pair.slice(0, sep).trim();
    const raw = pair.slice(sep + 1).trim();
    if (key === 'aa') {
      if (raw === 'off' || raw === 'traa' || raw === 'taau') tune.aa = raw;
      continue;
    }
    if (!(TUNE_KEYS as readonly string[]).includes(key)) continue;
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) tune[key as TuneKey] = value;
  }
  return tune;
}

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: Quality,
): PostEx {
  const tune = parseTune();
  const level = pnum('post', 99);
  const viewParam = pstr('view', '');
  const view: ViewMode | null =
    viewParam === 'normal' || viewParam === 'depth' || viewParam === 'velocity' ? viewParam : null;
  const taaMode: TaaMode = tune.aa === 'off' ? 'off' : tune.aa === 'taau' ? 'taau' : 'traa';
  const isLow = quality === 'low';

  const wantAo = tune.ao !== 0 && !isLow && pbool('ao', true) && view === null;
  const aoView = pbool('aoView', false) && wantAo;
  // Motion blur: decisión S6 (medida con `?view=velocity&fly=1`). El velocity
  // del césped/lluvia no es fiable (positionNode procedural sin
  // positionPrevious), así que por defecto queda OFF; `?motion=1` lo activa.
  const motionSamples = !isLow && pbool('motion', false) ? QUALITY[quality].mb : 0;
  const useAo = wantAo && level >= LEVEL.ao;
  const useSharpen = level >= LEVEL.sharpen && tune.sharpen !== 0;
  const useTaa = level >= LEVEL.aa && taaMode !== 'off' && view === null;
  const useBloom = level >= LEVEL.bloom && tune.bloom > 0;
  const useMotion = level >= LEVEL.motion && motionSamples > 0 && view === null;
  const useCa = level >= LEVEL.ca && tune.ca !== 0;
  const useVignette = level >= LEVEL.vignette && tune.vignette !== 0;
  const useGrain = level >= LEVEL.grain && tune.grain !== 0;

  renderer.toneMappingExposure = tune.exposure;

  // --- Pase de escena con MRT {output, normal, velocity} (T6.2.2) ----------
  // `getTextureNode` de los 4 buffers ANTES de renderizar: cada llamada crea el
  // attachment en el render target, de modo que el MRT declarado y el render
  // target coinciden desde el primer frame (sin attachments perezosos).
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
  const colorTex = scenePass.getTextureNode('output');
  const depthTex = scenePass.getTextureNode('depth');
  const normalTex = scenePass.getTextureNode('normal');
  const velocityTex = scenePass.getTextureNode('velocity');

  // --- 1. GTAO (§11.1) -----------------------------------------------------
  let aoPass: ReturnType<typeof ao> | null = null;
  if (useAo && view === null) {
    aoPass = ao(depthTex, normalTex, camera);
    aoPass.radius.value = 0.7;
    aoPass.thickness.value = 0.6;
    aoPass.scale.value = 1;
    aoPass.samples.value = QUALITY[quality].ao.samples;
    aoPass.resolutionScale = QUALITY[quality].ao.scale;
    // Sin filtrado temporal: patrón fijo por frame (no deja estelas al caminar).
    aoPass.useTemporalFiltering = false;
  }

  const chain: string[] = [];
  let outNode: Node<'vec4'>;
  // Referencias para dispose() (los nodos de post tienen render targets propios).
  let sharpenNode: ReturnType<typeof sharpen> | null = null;
  let taaNode: ReturnType<typeof traa> | ReturnType<typeof taau> | null = null;
  let bloomNode: ReturnType<typeof bloom> | null = null;
  const rtts: { dispose?: () => void }[] = [];

  /** Materializa un nodo en RTT si no es ya una textura (dispose diferido). */
  function asTexture(node: Node<'vec4'>): Node<'vec4'> {
    const converted = convertToTexture(node);
    if (converted !== node) rtts.push(converted as unknown as { dispose?: () => void });
    return asVec4(converted);
  }

  if (view !== null) {
    // Vistas de depuración: buffer crudo, sin grade ni tonemap (solo visible).
    chain.push(`view:${view}`);
    if (view === 'normal') {
      outNode = vec4(normalTex.sample(screenUV).rgb.mul(0.5).add(0.5), 1);
    } else if (view === 'depth') {
      // viewZ de three es NEGATIVO (la cámara mira a -Z): se usa -viewZ (m) y se
      // normaliza a 60 m para que la estructura sea visible con niebla de 185.
      outNode = vec4(vec3(clamp(scenePass.getViewZNode('depth').negate().mul(1 / 60), 0, 1)), 1);
    } else {
      // |velocity| ampliada ×30: negro en reposo, color al moverse (probe S6).
      const v = velocityTex.sample(screenUV).xy;
      outNode = vec4(vec3(clamp(v.abs().mul(30), 0, 1), 0), 1);
    }
  } else if (aoView && aoPass !== null) {
    chain.push('aoView');
    outNode = vec4(vec3(aoPass.getTextureNode().sample(screenUV).r), 1);
  } else {
    let node: Node<'vec4'> = colorTex;
    chain.push('pass');

    if (aoPass !== null) {
      chain.push('ao');
      const aoTex = aoPass.getTextureNode().sample(screenUV).r;
      // `viewZ` de three es negativo (cámara a -Z): la rampa de §11 usa la
      // distancia real (45→95 m) => -viewZ. Con el signo crudo la rampa nunca
      // dispara (smoothstep de un valor negativo = 0) y el AO no se aplicaría.
      const ramp = smoothstep(45, 95, scenePass.getViewZNode('depth').negate());
      node = vec4(node.rgb.mul(mix(float(1), aoTex, ramp)), node.a);
    }

    if (useSharpen && taaMode !== 'taau') {
      chain.push('sharpen');
      sharpenNode = sharpen(node, tune.sharpen);
      node = asVec4(sharpenNode);
    }

    if (useTaa) {
      if (taaMode === 'taau') {
        // El pase de escena ES el input de baja resolución de TAAU (§12).
        scenePass.setResolutionScale(QUALITY[quality].taau);
        chain.push('taau');
        taaNode = taau(asTexture(node) as unknown as Parameters<typeof taau>[0], depthTex, velocityTex, camera);
        node = asVec4(taaNode);
      } else {
        chain.push('traa');
        taaNode = traa(node, depthTex, velocityTex, camera);
        node = asVec4(taaNode);
      }
      // Con taau el Sharpen va tras el upscale (ver cabecera).
      if (useSharpen && taaMode === 'taau') {
        chain.push('sharpen');
        sharpenNode = sharpen(node, tune.sharpen);
        node = asVec4(sharpenNode);
      }
    }

    if (useBloom) {
      chain.push('bloom');
      // `bloom()` devuelve SOLO el término aditivo (no input+bloom): se suma
      // aquí, antes del tonemap (§11.4, «aditivo, antes del tonemap»).
      bloomNode = bloom(node, tune.bloom, tune.bloomRadius, tune.bloomThreshold);
      const b = bloomTerm(bloomNode);
      node = vec4(node.rgb.add(b.rgb), node.a);
    }

    if (useMotion) {
      chain.push('motion');
      // `motionBlur` exige un TextureNode (`inputNode.sample`): se materializa
      // el color compuesto (ya con bloom) en un RTT. No vale `bloomTerm`: bloom
      // solo aporta el término aditivo, no la imagen completa.
      node = asVec4(motionBlur(asTexture(node), velocityTex, int(motionSamples)));
    }

    // --- Tonemap + encoding exactamente una vez (§11.6, §6.4) --------------
    chain.push('output');
    node = asVec4(renderOutput(node, THREE.AgXToneMapping, THREE.SRGBColorSpace));

    // --- 7. Grade display-referred (§11) -----------------------------------
    chain.push('grade');
    {
      const rgb = node.rgb;
      const graded = mix(vec3(luminance(rgb)), rgb, tune.saturation)
        .sub(0.5)
        .mul(tune.contrast)
        .add(0.5);
      node = vec4(graded, node.a);
    }

    if (useCa) {
      chain.push('ca');
      node = asVec4(chromaticAberration(node, float(tune.ca), vec2(0.5, 0.5), float(1.1)));
    }

    if (useVignette) {
      chain.push('vignette');
      const vig = smoothstep(0.55, 1.25, length(uv().sub(0.5)).mul(1.4142)).mul(tune.vignette);
      node = vec4(node.rgb.mul(float(1).sub(vig)), node.a);
    }

    if (useGrain) {
      chain.push('grain');
      // `film` (multiplicativo) con intensidad 0.022·(1 - luma·0.7).
      const intensity = float(tune.grain).mul(float(1).sub(luminance(node.rgb).mul(0.7)));
      node = asVec4(film(node, intensity, uv()));
    }

    outNode = node;
  }

  const pipeline = new THREE.RenderPipeline(renderer, outNode);
  pipeline.outputColorTransform = false;

  // --- setSize / resize ----------------------------------------------------
  const dbg = dbgRef();
  const dbgPost: Record<string, unknown> = {
    chain,
    samples: { ao: aoPass !== null ? QUALITY[quality].ao.samples : 0, mb: motionSamples },
    taa: taaMode,
    view,
    ao: aoPass !== null,
    aoView,
    level,
    tune: { ...tune },
    size: [0, 0],
  };
  if (dbg) dbg.post = dbgPost;

  const scratchSize = new THREE.Vector2();

  function setSize(width: number, height: number): void {
    const dpr = renderer.getPixelRatio();
    scenePass.setSize(Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr)));
    dbgPost.size = [width, height];
  }

  function onResize(): void {
    const el = renderer.domElement;
    setSize(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
  }
  window.addEventListener('resize', onResize);
  {
    const size = renderer.getDrawingBufferSize(scratchSize);
    dbgPost.size = [Math.round(size.width), Math.round(size.height)];
  }

  function render(_dt: number): void {
    pipeline.render();
  }

  async function compileAsync(): Promise<void> {
    await scenePass.compileAsync(renderer);
  }

  function dispose(): void {
    window.removeEventListener('resize', onResize);
    pipeline.dispose();
    scenePass.dispose();
    if (aoPass !== null) aoPass.dispose();
    if (sharpenNode !== null) sharpenNode.dispose();
    if (taaNode !== null) taaNode.dispose();
    if (bloomNode !== null) bloomNode.dispose();
    for (const rtt of rtts) rtt.dispose?.();
  }

  return { pipeline, render, setSize, compileAsync, dispose };
}
