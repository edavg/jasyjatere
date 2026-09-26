import * as THREE from 'three/webgpu';
import { createAudio } from './core/audio';
import { CAMERA } from './core/constants';
import { createDbg, installDbg } from './core/dbg';
import { createInput } from './core/input';
import { createPerf } from './core/perf';
import { pbool, pnum, pstr } from './core/params';
import { initialQuality, persistQuality } from './core/quality';
import { shared } from './core/shared';
import { createEnvironment } from './render/Environment';
import { createFog } from './render/Fog';
import { createPost } from './render/Post';
import { createRenderCore } from './render/RenderCore';
import { createSky } from './render/Sky';
import { createTorch } from './render/Torch';
import { createLightning } from './weather/Lightning';
import { createBoot } from './ui/boot';
import { createHud } from './ui/hud';
import { createMenu } from './ui/menu';
import { createRain } from './weather/Rain';
import { createWeather } from './weather/Weather';
import { createHeightfield } from './world/Heightfield';
import { createGrass } from './world/Grass';
import { createProps } from './world/Props';
import { createScatter } from './world/Scatter';
import { createTerrain } from './world/Terrain';
import { createTerrainMaterial } from './world/terrainMaterial';
import { createTrees } from './world/Trees';
import { createWalker } from './world/Walker';

const canvas = document.getElementById('gl');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('main: falta el canvas #gl');

const quality = initialQuality();
const dbg = createDbg();
dbg.quality = quality;
dbg.snap = pbool('snap', true);
installDbg(dbg);

const bootUi = createBoot(quality);
const menu = createMenu();
// T7.2.3: audio 100 % procedural. El AudioContext nace en `unlock()` (click de
// START, política de autoplay); aquí solo se instancia la fábrica.
const audio = createAudio();

let running = false;
let last = performance.now();

bootUi.showLoading('starting the renderer', 8);
const core = await createRenderCore(canvas, quality);
dbg.backend = core.isWebGPU ? 'webgpu' : 'webgl2';
dbg.dpr = core.renderer.getPixelRatio();
dbg.gl = core.renderer.info;

bootUi.showLoading('loading the world', 30);
// F2b: el heightfield y el pool de tiles se montan tras fijar el pose inicial.

bootUi.showLoading('placing the walker', 68);
// Rig anidado §1: la cámara nunca recibe transformada directa.
const yawGroup = new THREE.Group();
yawGroup.name = 'walker:yaw';
const pitchGroup = new THREE.Group();
pitchGroup.name = 'walker:pitch';
pitchGroup.position.y = CAMERA.eye;
yawGroup.add(pitchGroup);
pitchGroup.add(core.camera);
core.scene.add(yawGroup);

// Params de captura: ?cam=x,y,z posiciona el rig; ?look=yaw,pitch en radianes.
// Con ?cam el pose es literal (no se sigue el suelo): lo usan las capturas.
const camParam = pstr('cam', '');
let camApplied = false;
if (camParam !== '') {
  const v = camParam.split(',').map(Number.parseFloat);
  if (v.length >= 3 && v.every(Number.isFinite)) {
    yawGroup.position.set(v[0], v[1], v[2]);
    camApplied = true;
  }
}
const lookParam = pstr('look', '');
if (lookParam !== '') {
  const v = lookParam.split(',').map(Number.parseFloat);
  if (v.length >= 2 && v.every(Number.isFinite)) {
    yawGroup.rotation.y = v[0];
    pitchGroup.rotation.x = Math.max(-1.45, Math.min(1.45, v[1]));
  }
}

// T8.1: entrada unificada (walker + vuelo). El canvas real es el del renderer:
// RenderCore puede haber clonado el #gl al caer a WebGL2, y `canvas` (main)
// seguiría apuntando al viejo.
const fly = pbool('fly', false);
const input = createInput(core.renderer.domElement as HTMLCanvasElement);
// ?cam fija un pose literal para capturas: sin input salvo en vuelo de dev.
if (camApplied && !fly) input.setEnabled(false);

// F2b: fuente de altura (LUT §5.1) + material procedural + pool de tiles (§5.2).
const heightfield = createHeightfield(shared);
const terrainMaterial = createTerrainMaterial(shared, quality);
const terrain = createTerrain(heightfield, terrainMaterial, quality);
core.scene.add(terrain.group);

// F3: césped (1 draw call, n²·k briznas, posición derivada en el shader). Se
// crea tras el heightfield (lee shared.uHeightNode) y se actualiza por frame
// escribiendo solo uOrigin/uCamXZ. ?grass=0 lo oculta.
const grass = createGrass(core.scene, shared, quality);

// F4: motor de streaming (T4.2.2) + árboles procedurales (4 especies × 3 LODs,
// T4.2.1/T4.2.3). `?trees=0` no registra capas (A/B). El sway usa `shared`.
const scatter = createScatter(heightfield, quality, core.scene, shared);
const trees = createTrees(scatter, quality, shared);

// F4c: props procedurales (§8). ?props=0 los desactiva (A/B).
const props = pbool('props', true) ? createProps(scatter, heightfield, quality, shared) : null;

// F5a: clima (driver de GB/UB/rV/iV/XB) + lluvia nocturna (rachas + salpicaduras
// con wrap de volumen). Weather debe actualizarse ANTES que Rain: escribe los
// uniforms que el shader de la lluvia lee en vivo. `?rain=0` no crea mallas.
const weather = createWeather(shared, quality);
// T5.2.4.1: linterna en primera persona. `?torch=1` cuelga un SpotLight del rig
// (ilumina terreno/árboles/césped) y publica los uniforms del haz que reutilizan
// la lluvia y la niebla. `?torch=0` (default) no crea luz. Va antes que Rain y
// Fog porque ambos reciben su `TorchEx`.
const torch = createTorch(pitchGroup, quality);
const rain = createRain(core.scene, shared, quality, torch);

// F5b: relámpagos (§9.4). Escribe shared.uFlash/uFlashDir (que ya consumen el
// domo y la niebla) y mueve su PointLight. `?flash=N` fija el destello para
// capturas; `?bolt=1|hold` dispara/mantiene el rayo. F7 engancha onThunder al audio.
const lightning = createLightning(core.scene, shared);
// T7.2.3: el callback ya trae el retardo (0.35 + intensity·3.4): el audio solo
// programa el burst.
lightning.onThunder((intensity, delay) => {
  audio.thunder(intensity, delay);
});

// T8.2/T8.3: caminante (física §1 + colisión de círculos contra los
// colisionadores vivos del scatter). Los pasos disparan `audio.step`.
const walker = createWalker({
  input,
  heightfield,
  trunks: () => scatter.trunks(),
  blockers: () => scatter.blockers(),
  yawGroup,
  pitchGroup,
  camera: core.camera,
  onStep: (run) => {
    audio.step(run);
  },
});

// T4.2.5: colisionadores de tronco (árboles) y de props solid, listos para la
// futura fase de jugador. Los arrays son reutilizados por el motor (no clonar).
(window as unknown as { __nightwoodsWorld: unknown }).__nightwoodsWorld = {
  trunks: scatter.trunks(),
  blockers: scatter.blockers(),
};

// ?fly=1: cámara de vuelo libre de dev (WASD, Shift acelera, ratón/flechas para
// mirar). No colisiona y no depende del suelo; ?cam/?look fijan el pose inicial.
if (fly && !camApplied) {
  yawGroup.position.y = heightfield.height(yawGroup.position.x, yawGroup.position.z) + 40;
}
terrain.update(yawGroup.position.x, yawGroup.position.z);

const FLY_SPEED = 20;
const FLY_BOOST = 5;
const FLY_LOOK_SPEED = 1.6;
const PITCH_LIMIT = 1.45;
const lookDelta = { yaw: 0, pitch: 0 };

/** Aplica la mirada acumulada del input al rig (ratón/táctil/flechas). */
function applyLook(): void {
  if (!input.enabled) return;
  input.consumeLook(lookDelta);
  if (lookDelta.yaw !== 0) yawGroup.rotation.y -= lookDelta.yaw;
  if (lookDelta.pitch !== 0) {
    pitchGroup.rotation.x = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, pitchGroup.rotation.x - lookDelta.pitch),
    );
  }
}

function updateFly(step: number): void {
  if (input.isDown('ArrowLeft')) yawGroup.rotation.y += FLY_LOOK_SPEED * step;
  if (input.isDown('ArrowRight')) yawGroup.rotation.y -= FLY_LOOK_SPEED * step;
  if (input.isDown('ArrowUp')) {
    pitchGroup.rotation.x = Math.min(PITCH_LIMIT, pitchGroup.rotation.x + FLY_LOOK_SPEED * step);
  }
  if (input.isDown('ArrowDown')) {
    pitchGroup.rotation.x = Math.max(-PITCH_LIMIT, pitchGroup.rotation.x - FLY_LOOK_SPEED * step);
  }
  if (step <= 0) return;

  const yaw = yawGroup.rotation.y;
  const pitch = pitchGroup.rotation.x;
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (input.isDown('KeyW')) {
    dx += fx;
    dy += fy;
    dz += fz;
  }
  if (input.isDown('KeyS')) {
    dx -= fx;
    dy -= fy;
    dz -= fz;
  }
  if (input.isDown('KeyD')) {
    dx += rx;
    dz += rz;
  }
  if (input.isDown('KeyA')) {
    dx -= rx;
    dz -= rz;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  const boost = input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? FLY_BOOST : 1;
  const s = (FLY_SPEED * boost * step) / len;
  yawGroup.position.x += dx * s;
  yawGroup.position.y += dy * s;
  yawGroup.position.z += dz * s;
}

// F1a: luz/luna con snap a texel e IBL procedural.
// createEnvironment añade sun, sun.target y hemi a la escena.
const environment = createEnvironment(core.scene, quality, shared, core.renderer);

// F1b: domo de cielo (sigue a la cámara) + niebla TSL en scene.fogNode (§4).
// El domo no se ve afectado por la niebla (fog:false en su material).
const sky = createSky(shared);
core.scene.add(sky.mesh);
const fog = createFog(shared, torch);
fog.install(core.scene);

// F6: cadena de post TSL (Post.ts). `?post=0` mantiene el render directo de
// RenderCore (sin MRT ni post); con post activo el bucle llama a post.render.
const post = pnum('post', 99) === 0 ? null : createPost(core.renderer, core.scene, core.camera, quality);

bootUi.showLoading('compiling shaders', 78);
if (!pbool('nowarm', false)) {
  if (post !== null) await post.compileAsync();
  else if (typeof core.renderer.compileAsync === 'function') await core.renderer.compileAsync(core.scene, core.camera);
}

bootUi.ready();
menu.show();
menu.enableStart(core.isWebGPU ? 'WebGPU' : 'WebGL2 fallback: some effects are reduced');

// Criterio 0.3.3: DPR, tipo de shadow map y tone mapping visibles en la pestaña.
const AGX = (THREE as unknown as { AgXToneMapping?: THREE.ToneMapping }).AgXToneMapping;
const shadowName = core.renderer.shadowMap.type === THREE.PCFShadowMap
  ? 'PCFShadowMap'
  : `type ${core.renderer.shadowMap.type}`;
const toneName = core.renderer.toneMapping === AGX ? 'AgX' : `type ${core.renderer.toneMapping}`;
document.title = `NIGHTWOODS · dpr ${dbg.dpr.toFixed(2)} · ${core.isWebGPU ? 'WebGPU' : 'WebGL2'} · shadow ${shadowName} · tonemap ${toneName}`;

// T7.2.2: HUD (barras de clima con flash, stats con P, nota de backend y log
// con ?debug=1). El HUD también escucha 1/2/3/4, -/=, M y P.
const hud = createHud({
  quality,
  backend: dbg.backend,
  dpr: dbg.dpr,
  info: core.renderer.info,
  dbg,
  weather,
  audio,
});

// T7.2.1: al cambiar de tier se recarga con `?q=` (como RW) para reconstruir
// todo con la tabla nueva (césped, árboles/lluvia/post se dimensionan al
// arrancar). Se preservan los demás params de depuración de la URL.
menu.onQuality((q) => {
  persistQuality(q);
  const u = new URL(location.href);
  u.searchParams.set('q', q);
  location.replace(u.toString());
});
menu.onStart(() => {
  menu.hide();
  hud.setVisible(pbool('hud', true)); // ?hud=0 para capturas limpias
  // Gesto de usuario: desbloquea el AudioContext (autoplay policy).
  void audio.unlock();
  // Con el menú cerrado vuelve el input (salvo pose fija de captura).
  if (!camApplied) input.setEnabled(true);
  running = true;
});

// T7.2.2: ESC alterna menú/HUD. El mundo sigue animándose detrás del menú y
// START reanuda (el rig/cámara conservan el pose). Con el menú abierto el
// input se neutraliza (teclas limpias y pointer lock fuera).
window.addEventListener('keydown', (e) => {
  // Solo tras START (`running`): en la pantalla de título el menú manda.
  if (e.code !== 'Escape' || !bootUi.hidden || !running) return;
  if (menu.isVisible()) {
    menu.hide();
    hud.setVisible(pbool('hud', true));
    if (!camApplied) input.setEnabled(true);
  } else {
    menu.show();
    hud.setVisible(false);
    input.setEnabled(false);
  }
});

// T7.2.5: desmontaje global para tests/probes (`window.__nightwoods.dispose()`).
// No se usa en runtime normal; orden inverso al de construcción.
(window as unknown as { __nightwoods: unknown }).__nightwoods = {
  rig: yawGroup,
  camera: core.camera,
  /** API de audio (el QA comprueba `contextState`/`stats()`). */
  audio,
  /** Walker (el `walk-probe` lee `speed`). */
  walker,
  dispose(): void {
    running = false;
    input.dispose();
    walker.dispose();
    hud.dispose();
    audio.dispose();
    if (post !== null) post.dispose();
    fog.dispose();
    sky.dispose();
    environment.dispose();
    lightning.dispose();
    torch.dispose();
    rain.dispose();
    weather.dispose();
    if (props !== null) props.dispose();
    trees.dispose();
    scatter.dispose();
    grass.dispose();
    terrain.dispose();
    terrainMaterial.dispose();
    heightfield.dispose();
    core.dispose();
  },
};

const focus = new THREE.Vector3();
const camForward = new THREE.Vector3();
// Scratch del clima para el audio: se muta in-place (cero allocs por frame).
const audioWeather = { rain: 0, wind: 0, gust: 0 };
// F9: benchmark in-app `?perf=N` (no-op si no hay param).
const perf = createPerf(dbg);
const perfStats = { draws: 0, tris: 0, scanMs: 0 };

function frame(now: number): void {
  // `rawDt` sin capar para el bench ?perf (los picos reales no deben ocultarse
  // tras el techo de simulación de 50 ms).
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 0.05);
  last = now;
  // Hasta START se pinta el fondo (paso 0); las fases siguientes actualizan aquí.
  const step = running ? dt : 0;
  if (step > 0) applyLook();
  if (fly) updateFly(step);
  else if (!camApplied) walker.update(step);
  core.camera.getWorldPosition(focus);
  terrain.update(focus.x, focus.z);
  // Árboles: escaneo solo si la cámara se movió ≥ 3 m; uPrevTime se copia
  // antes de que Environment avance shared.uTime (positionPrevious, F6).
  scatter.update(focus.x, focus.z);
  trees.update();
  grass.update(focus, step);
  environment.update(step, focus);
  // F5: primero Weather (uniforms del clima), después el forward de cámara
  // (acimut del rayo) y por último Torch/Rain/Lightning.
  weather.update(step);
  audioWeather.rain = weather.rain;
  audioWeather.wind = weather.wind;
  audioWeather.gust = shared.uGust.value;
  audio.update(step, audioWeather);
  core.camera.getWorldDirection(camForward);
  // La linterna escribe aquí el estado del haz (posición/dirección reales del
  // SpotLight del rig) que Rain y Fog leen en sus shaders: antes de ambas.
  torch.update();
  rain.update(focus);
  lightning.update(step, focus, camForward);
  sky.update(focus);
  if (post !== null) post.render(step);
  else core.render(step);
  hud.update(step);
  if (running && perf.enabled) {
    perfStats.draws = core.renderer.info.render.frameCalls;
    perfStats.tris = core.renderer.info.render.triangles;
    perfStats.scanMs = typeof dbg.scatterStats?.lastScanMs === 'number' ? dbg.scatterStats.lastScanMs : 0;
    perf.update(rawDt, perfStats);
  }
  dbg.frame += 1;
}

void core.renderer.setAnimationLoop(frame);
