# Fase 0 — Andamiaje y arranque

**Objetivo**: proyecto vacío que arranca, muestra un frame y reporta su backend. Nada de mundo todavía.
**Depende de**: nada. **Bloquea**: todo lo demás.
**Esfuerzo**: pequeño.

---

## 0.1 Objetivo verificable

Al terminar, `npm run dev` + abrir `http://127.0.0.1:5173` debe:
1. Mostrar el overlay con selector de calidad (LOW/MEDIUM/HIGH) y botón START deshabilitado.
2. Arrancar el `WebGPURenderer` (o fallback WebGL2) y reportar el backend en la UI.
3. Pintar un frame con `clearColor`night y reportar DPR, shadowMap type y toneMapping.
4. Aceptar los params `?q=`, `?post=`, `?view=`, `?nowarm=1`, `?debug=1` (aunque el post aún no exista).
5. Registrar en `window.__dbg` un objeto con `backend`, `dpr`, `quality`, `frame`.

---

## 0.2 Tareas

### T0.2.1 Scaffolding
Crear en la raíz del proyecto:
- `package.json` — deps: `three@^0.186.1`; devDeps: `vite@^8`, `typescript@^5.8`, `@types/three@^0.186`,
  `puppeteer-core@^25`.
  Scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`), `typecheck` (`tsc --noEmit`), `preview`.
- `tsconfig.json` — `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `isolatedModules`, `moduleResolution: "bundler"`, `noEmit`, target ES2022, `include: ["src","tools","vite.config.ts"]`.
- `vite.config.ts` — `base: './'`, `server: { host: '127.0.0.1', port: 5173 }`,
  `build: { target: 'es2022', sourcemap: true }`.
- `index.html` — `#gl` (canvas), `#ui`, `#boot`, vars CSS: `--bg:#0b0d0f; --ink:#cfd6dc; --dim:#95a4a9; --acc:#c0a858`.
  Estilo inline mínimo, fuente `ui-monospace`. **Referencia visual**: copiar la paleta y el esqueleto del
  `<style>` de `/tmp/rw_index.html` (no sus assets).

### T0.2.2 `src/core/constants.ts`
Tabla única de constantes (frozen, `as const`), alimentada desde
[`00-referencia-tecnica.md`](00-referencia-tecnica.md) secciones 1–12:
```ts
export const QUALITY = { low: {...}, medium: {...}, high: {...} } as const;  // grass, trees, props,
                                                                              // rain, shadow, dpr, ao, mb
export const SUN   = { offset: [38,78,26], color: [0.55,0.65,0.90], intensity: 0.14,
                        shadowR: 42, near: 4, far: 220, bias: -6e-4, normalBias: 0.08, radius: 4 } as const;
export const HEMI  = { sky:[0.55,0.60,0.70], ground:[0.12,0.11,0.09], intensity: 0.04 } as const;
export const SKY   = { radius: 470, zenith:[0.028,0.032,0.042], horizon:[0.010,0.012,0.018] } as const;
export const FOG   = { color:[0.02,0.023,0.032], density: 0.0062, near: 120, far: 185 } as const;
export const GRASS = { cell: 0.5, tiers: { low:{n:112,k:3}, medium:{n:160,k:6}, high:{n:160,k:10} } } as const;
export const TREES = { lodScale: {low:.62,medium:.8,high:1} } as const;
export const WORLD = { tile: 32, grid: 11, terrainSegs: 32, noiseRes: 512,
                        amplitude: [6.5, 0.55], periods: [384, 47], rot: 0.62, uvOff: [0.37,0.11] } as const;
export const POST  = { /* TR completo */ } as const;
export const RAIN  = { tiers:{...}, box:[24,16,24], splashBox:22, nightDim:0.12 } as const;
export const WIND  = { dir:[0.82,0.38], strength:1.64, gustMin:0.15, gustMax:0.85 } as const;
export const CAMERA = { fov: 62, near: 0.08, far: 520, eye: 1.70, radius: 0.32 } as const;
```

### T0.2.3 `src/core/rng.ts`
- `hash3(x, z, salt): number` — imul avalanche exacto de RW:
  ```ts
  let r = (x * 374761393 + z * 668265263 + salt * 1274126177) | 0;
  r = Math.imul(r ^ (r >>> 13), 1274126177);
  return ((r ^ (r >>> 16)) >>> 0) / 4294967296;
  ```
- `hash2`, `mulberry32(seed)`, `rand01(seed)`, `snoise2` (valor con fade quíntico, base para el LUT).
- Debe ser **idéntico bit a bit** a RW en los tres primeros (crítico: los hashes definen la distribución).

### T0.2.4 `src/render/RenderCore.ts`
```ts
export function createRenderCore(canvas, quality): RenderCoreEx
```
- `new THREE.WebGPURenderer({ canvas, antialias:false, powerPreference:'high-performance',
                               forceWebGL: urlParams.get('gl')==='1' })`
- `await renderer.init()`; `isWebGPU = renderer.backend.isWebGPUBackend === true`.
- Si `navigator.gpu` existe: pedir adapter `powerPreference:'high-performance'`; si
  `maxSampledTexturesPerShaderStage > 16`, pedir `requiredLimits:{maxSampledTexturesPerShaderStage: min(n,32)}`.
- `renderer.setPixelRatio(Math.min(devicePixelRatio, DPR_CAP[quality]))`, `setSize`.
- `shadowMap.enabled = true; shadowMap.type = THREE.PCFSoftShadowMap`.
- `toneMapping = THREE.AgXToneMapping; toneMappingExposure = POST.exposure`.
- Cámara `PerspectiveCamera(62, aspect, 0.08, 520)` + `layers.enable(1)` + `layers.enable(2)`.
- `resize()` en `window.resize`.
- Devolver `{ renderer, scene, camera, isWebGPU, quality, render(dt), setQuality(), dispose() }`.

### T0.2.5 `src/main.ts` — arranque y bucle
Fases de arranque con UI de carga (etapas de §12 de la referencia):
1. `ui.showLoading('starting the renderer', 8%)` → `createRenderCore`.
2. `ui.showLoading('loading the world', 8%)` → stub vacío.
3. `ui.showLoading('placing the walker', 68%)` → crear rig de cámara (yaw→pitch→camera) aunque esté vacío.
4. `ui.showLoading('compiling shaders', 78%)` → `await renderer.compileAsync(scene, camera)`.
5. `ui.ready()` → habilitar START.
Bucle: `renderer.setAnimationLoop(frame)`; `dt = min(delta, .05)`; en esta fase solo `render`.
`window.__dbg = { backend, dpr, quality, frame, gl: renderer.info }` (solo en DEV o siempre, es útil).

### T0.2.6 `src/ui/boot.ts` + `src/ui/menu.ts`
- `boot.ts`: overlay con etapas ponderadas (`.08/.6/.1/.22`), barra con `LOADING nn%` +
  `linear-gradient` de relleno, estimación por defecto `[900, 7000, 700, 3000] ms`, memo
  `localStorage['nightwoods-load-<quality>']`.
- `menu.ts`: botones LOW/MEDIUM/HIGH (auto-seleccionados por `hardwareConcurrency`, §12), botón START,
  nota de backend (`WebGPU` o `WebGL2 fallback: some effects are reduced`), panel `<details>` de controles.
- Detección de calidad: `hardwareConcurrency >= 10 ? high : >= 6 ? medium : low`; `matchMedia('(pointer: coarse)')` → low.

### T0.2.7 `tools/shot.ts`
Harness puppeteer-core (como el `tools/playtest.ts` del proyecto horror, reutilizable):
```ts
// lanza vite dev, abre la url, opcionalmente ?q=high, espera a window.__dbg, captura screenshot a
// artifacts/shot-<etiqueta>.png, e imprime { backend, dpr, frame }.
```
Debe aceptar `--url`, `--out`, `--wait`, y devolver JSON por stdout.

---

## 0.3 Criterios de aceptación

- [ ] `npm run typecheck` sin errores.
- [ ] `npm run build` genera bundle sin warnings de three.
- [ ] `tools/shot.ts` produce un PNG y un JSON con `backend` no vacío.
- [ ] `?q=low|medium|high` cambia el DPR cap (verificable en `__dbg.dpr`).
- [ ] `?gl=1` fuerza WebGL2 sin romper.
- [ ] START habilitado tras compilar; al pulsar, se ve un frame (aún vacío/violeta de fondo).

---

## 0.4 Notas / trampas
- `WebGPURenderer.init()` es **async** y puede lanzar si no hay adaptador. Envolver en try/catch y, si
  falla, reintentar con `forceWebGL: true`.
- `renderer.setPixelRatio` **no** se llama en `resize` (RW tampoco); decide explícitamente si lo cambias.
- `AgXToneMapping` existe en r186 (`constants.js`). Verificar antes de fijar `toneMapping`.
- No usar `antialias: true` (el AA va en post, fase 6).

---

## Estado de implementación (Fase 0) — ✅ verificada por el orquestador

**Ficheros**: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`,
`src/core/{constants,params,quality,dbg,rng,shared}.ts`, `src/render/RenderCore.ts`,
`src/ui/{boot,menu}.ts`, `tools/shot.ts`.

**Decisiones (desviaciones documentadas)**
- `PCFSoftShadowMap` fue **eliminado en r186** (`three.webgpu.js:62565` lo degrada a `PCFShadowMap` con
  warn). Se fija directamente `PCFShadowMap` (el literal de §2.2 es obsoleto en esta build).
- `@types/node@^22` añadido a devDeps: `tools/shot.ts` usa APIs de Node y `types:["vite/client"]` no las
  declara.
- `src/core/quality.ts` nace ya en F0 (detección + persistencia) para que el menú no duplique lógica;
  F7 solo añade la recarga por `location.search`.
- `src/core/dbg.ts` centraliza `window.__dbg` (contrato del orquestador).
- `src/core/shared.ts` (contrato F1–F5) se escribió antes de F1 y ya está validado por typecheck.
- `?cam=x,y,z` y `?look=yaw,pitch` (añadidos en F1a) posicionan el rig para las capturas; `?cam` es la
  posición del grupo yaw, el ojo queda en `y + 1.70`.
- **Colisión de puerto**: el proyecto `horror` tiene un dev server en `127.0.0.1:5173`. Toda la
  verificación de este repo se hace con `npm run dev -- --port 5174` y `tools/shot.ts --url ...5174/`
  (el auto-spawn deriva el puerto del `--url`). `npm run dev` a secas fallará mientras ese server viva.

**Evidencia**
- `npm run typecheck` → 0 errores; `npm run build` → 14 módulos, sin warnings de three.
- `tools/shot.ts` → `{"backend":"webgpu","dpr":1,"quality":"high","frame":176,"consoleErrors":[]}`;
  `?gl=1` → `"backend":"webgl2"`.
- DPR caps con `deviceScaleFactor:2`: low 1.0 · medium 1.25 · high 1.5.
- Capturas: `artifacts/fase-0-menu-ui.png` (menú), `fase-0-frame.png` (fondo night), `fase-0-webgl2.png`.
