# PROMPT MAESTRO — ejecución por fases con subagentes

> Copia el bloque de abajo y pégalo en una sesión nueva de opencode.
> El orquestador it'll leer las fases y **desplegará subagentes en paralelo** donde el grafo lo permita,
>avanzando secuencialmente y con puertas de verificación entre fases.

---

## EL PROMPT (copiar desde aquí)

````markdown
# ROL

Eres el orquestador de un proyecto nuevo en `/Users/edavg/www/test/nightwoods`.
Objetivo: reproducir la escena "woods" de https://rainyworlds.com (el capítulo 1) con su sistema de
césped, árboles, luz y perspectiva **pero de noche**, usando **three.js WebGPURenderer + TSL** y assets
**100 % procedurales**. Alcance v1: **solo el mundo**, sin gameplay.

Lee **primero y por completo**, en este orden:
1. `PLAN.md` — índice, grafo de dependencias, convenciones.
2. `docs/00-referencia-tecnica.md` — la especificación. TODAS las constantes y algoritmos salen de aquí.
3. `docs/fase-N-*.md` — el doc de la fase que vas a ejecutar.

Nunca inventes un valor numérico: si un número aparece en un doc de fase, cópialo. Si no aparece,
está en la referencia técnica. Si no está en ninguno, **decídelo tú y documéntalo** en el código.

# REGLAS INVIOLABLES

1. **Cero assets de Rainy Worlds.** Ni un solo fichero, textura, modelo, HDRI o fragmento de su bundle de
   producción. Solo replicamos **algoritmo y constantes**. Cualquier geometría, textura o cielo se genera
   por código.
2. **Fases secuenciales con puertas.** No empieces la fase N+1 hasta que la fase N pase su checklist.
3. **Verificación real, no declarativa.** Cada fase termina con `npm run typecheck` limpio + una captura
   feita con `tools/shot.ts` + los tests propios de la fase. Si una verificación falla, **arréglala antes
   de seguir**. No declares una fase completada sin evidencia.
4. **TypeScript estricto.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`.
5. **Cero asignaciones en el bucle de render.** Ni `new`, ni closures, ni strings, ni `.clone()` por frame.
   Scratch a nivel de módulo, buffers SoA preasignados.
6. **Captura de regresión al final de cada fase** en `artifacts/`. Es lo que detecta regresiones.
7. Si un subagente devuelve un resultado que no cuadra con la referencia, **verifícalo tú** leyendo su
   diff. No confíes ciegamente.

# PROTOCOLO POR FASE

Para cada fase, el orquestador:

1. **Plan** — lee el doc de fase, descompón en tareas, decide qué tareas se paralelizan.
2. **Despliega subagentes** (ver tabla). Cada subagente recibe: el doc de su fase (ruta exacta), la
   referencia técnica, el contexto mínimo del proyecto, y una **tarea concreta y delimitada**.
   Cada subagente escribe código real, verifica lo suyo, y devuelve un informe estructurado.
3. **Integra** — revisa los diffs, resuelve conflictos, ejecuta `npm run typecheck`.
4. **Verifica en conjunto** — levanta el dev server, corre `tools/shot.ts`, evalúa la checklist de la fase.
5. **Documenta** — captura en `artifacts/`, y anota en el doc de fase qué se implementó y qué se decidió.

# SUBAGENTES — quién hace qué

## Fase 0 — Andamiaje (1 subagente, secuencial)
- **S0 · scaffolding** — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`,
  `src/core/{constants,rng}.ts`, `src/render/RenderCore.ts`, `src/ui/{boot,menu}.ts`, `tools/shot.ts`,
  y el esqueleto de `src/main.ts` con el bucle. Verifica que el WebGPU arranca y reporta el backend.

## Fase 1 — Cielo / luz / niebla (2 subagentes en paralelo, tras F0 integrar)
- **S1a · Environment** — `src/render/Environment.ts` (luna direccional, sombra ±42 con **snap a texel**,
  `shadow.camera.layers.enable(2)`, hemisférica, oscilador de `gust`) + `src/assets/env.ts` (IBL
  procedural → PMREM).
- **S1b · Sky + Fog** — `src/render/Sky.ts` (domo, gradiente nocturno, nubes fbm, disco/halo lunar,
  calima, término de rayo) + `src/render/Fog.ts` (nodo TSL de doble Beer–Lambert + altura + suelo de
  distancia, §4 de la referencia).
- Ambos comparten los uniforms de `shared`. El orquestador define la forma de `shared` ANTES de lanzarles
  (es el contrato entre fases) y lo documenta en `src/core/constants.ts`.

## Fase 2 — Altura / terreno (2 subagentes tras F1 integrar; el segundo espera al `heightNode` del primero)
- **S2a · Heightfield** — `src/assets/noise.ts` (horneado 512² half-float del LUT) + `src/world/Heightfield.ts`
  (`raw/height/normal/noise` en JS **y** `heightNode` en TSL) + `tools/verify-height.mjs`.
- **S2b · Terrain** — `src/world/Terrain.ts` (pool de 121 tiles de 32 m, update con early-out) + el material
  de suelo TSL con splat de 4 capas, modulación macro y wetness nocturno. Depende de S2a → **lanza S2b
  en cuanto S2a exponga `heightNode`**.

## Fase 3 — Césped (1 subagente + 1 spike; secuencial)
- **S3a · spike (primero, pequeño)** — `tools/spike-instance.ts`: comprobar si `instanceIndex` funciona con
  `InstancedBufferGeometry` + `Mesh` en WebGPU. **Decisión documentada** antes de escribir el material.
- **S3b · Grass** — `src/world/bladeGeometry.ts` + `src/world/Grass.ts` (§6 de la referencia completo:
  índice→celda, hash PCG uint, densidad, fade radial, viento, corrección de longitud, color).
  + `tools/bench.ts`.

## Fase 4 — Árboles / props (3 subagentes en paralelo tras F3; comparten `Scatter.ts`, así que S4a va primero)
- **S4a · Scatter (motor de streaming)** — `src/world/Scatter.ts`: early-out 3 m, cadena de aceptación,
  **pool de slots sin asignaciones** (claves numéricas + free-list + compose directo en
  `instanceMatrix.array`), landmarks/`EB`, colisionadores (tronco + elipse→círculos). **Contrato para S4b/S4c.**
- **S4b · Árboles** — `src/world/treeGeometry.ts` (4 especies procedurales × 3 LODs, portando utilidades del
  proyecto horror: `mergeGeos`, `taperedTube`, `droopPlane`) + `src/world/Trees.ts` (tabla de especies,
  `sway` como `positionNode` con `positionPrevious`, capas 2 y sombras solo en LOD0/1).
- **S4c · Props** — `src/world/propsGeometry.ts` (8 tipos) + `src/world/Props.ts` (tabla con `patch`, `align`,
  `sink`, `solid`).
- S4b y S4c arrancan cuando S4a exponga la API del motor.

## Fase 5 — Lluvia / clima / rayos (2 subagentes en paralelo tras F4; comparten `Weather.ts`)
- **S5a · Weather + Rain** — `src/weather/Weather.ts` (presets, rampas de nubes) +
  `src/weather/Rain.ts` (rachas y salpicaduras con wrap de volumen en el shader; **adaptación nocturna
  sin faros**: cono de linterna + brillo lunar + realce pálido de punta, §9.2 y T5.2.4).
- **S5b · Lightning** — `src/weather/Lightning.ts` (pulsos, rayo de cinta, `PointLight`, callback de trueno).
  Se engancha a `uFlash` del cielo y la niebla (Fase 1).

## Fase 6 — Post (1 subagente; secuencial)
- **S6 · Post** — `src/render/Post.ts`: MRT `{output, normal, velocity}`, GTAO, Sharpen, TAA/TRAA, bloom,
  motion blur, `renderOutput` (AgX), grade, CA, viñeta, grano, `outputColorTransform=false`.
  Params `?post=`, `?view=`, `?taa=`, `?ao=`. **Integrar en `main.ts`.**

## Fase 7 — Cierre (2 subagentes en paralelo)
- **S7a · Calidad + HUD + audio** — `src/core/quality.ts` (persistente, `?q=`), `src/ui/hud.ts` (barras `▮`,
  stats, teclas 1/2/3/4/P/G), extender `src/core/audio.ts` (lluvia 3 capas, viento con ráfagas, trueno).
- **S7b · QA** — barrido de consola, tabla de fps por tier, capturas de regresión, `npm run build`,
  limpieza de hitches de streaming, `dispose()` global.

# CONTRATOS COMPARTIDOS (el orquestador los define antes de lanzar subagentes)

Para que los subagentes trabajen en paralelo sin colisionar, el orquestador fija **antes** de la fase
correspondiente:

- **F0** → la forma de `src/core/constants.ts` (nombres de las tablas `QUALITY/SUN/HEMI/SKY/FOG/GRASS/
  TREES/WORLD/POST/RAIN/WIND/CAMERA`) y de `__dbg`.
- **F1** → el contrato de `shared` (la bolsa de uniforms que comparten cielo, niebla, césped, árboles y
  lluvia): `uTime, uMoonDir, uGust, uWindDir, uWindStrength, uFlash, uFlashDir, uHorizonColor,
  uFogDensity, uFogNearFar, uFogHeightRef, uClouds, uRainAmount, uWetness, uNightDim, uHeightNode, uClear`.
- **F2** → la firma de `HeightfieldEx` (la consumen F3/F4/F5).
- **F4** → la API de `ScatterSystem` (la consumen S4b/S4c).
- **F5** → cómo `Weather` expone `rainAmount/wind/cloud` (los consumen Rain y Lightning).

# ESTILO DE LOS INFORMES DE SUBAGENTE

Cada subagente devuelve, en este orden:
1. **Qué hice** — lista de ficheros creados/modificados con una línea de propósito cada uno.
2. **Decisiones** — sobre todo lo que la referencia no fijaba, con el porqué.
3. **Verificación** — comando ejecutado + salida real (no "debería funcionar").
4. **Riesgos abiertos** — lo que quedó flojo o sin probar.
5. **No lo hice** — tareas del doc que quedaron fuera y por qué.

# ORDEN DE EJECUCIÓN

```
F0 ──▶ F1 ──▶ F2 ──┬──▶ F3 ──┐
                    ├──▶ F4 ──┼──▶ F6 ──▶ F7
                    └──▶ F5 ──┘
```
- F0, F1, F2, F3, F6 son **secuenciales**.
- F4 y F5 admiten subagentes **en paralelo** (F4b/F4c entre sí tras F4a; F5a/F5b entre sí).
- Cada flecha es una **puerta**: checklist de la fase + evidencia de verificación.

# REGLAS DE ARRANQUE

Al empezar:
1. Si `/Users/edavg/www/test/nightwoods` está vacío o solo tiene `docs/` y `PLAN.md`, empieza por **Fase 0**.
2. Si ya tiene código, **lee el estado actual y las checklists de `docs/`** para determinar en qué fase estás
   y continúa desde ahí. No rehagas fases ya verificadas.
3. Al empezar cada fase, **dime en una línea qué vas a hacer y qué subagentes vas a lanzar**.
4. Al terminar cada fase, **dame el checklist marcado** (✅/❌) y la ruta de la captura de regresión.

# NO HACER

- No implementes gameplay (colisión de jugador, IA, objetivos, inventario). Es la v1 "solo mundo".
- No añadas agua. En RW la escena `woods` **no tiene agua**; está documentado como stretch en la referencia.
- No copies assets de Rainy Worlds.
- No saltes la puerta de verificación de una fase para "avanzar más rápido".
- No introduzcas TAA/motion blur si el buffer de velocity no es fiable; documenta la decisión y sigue.
````

---

## Notas de uso

- **Fase por fase**: si quieres revisar entre fases, edita el prompt para terminar en un punto concreto
  (p. ej. "ejecuta hasta el final de la Fase 2 y para").
- **Subagentes**: el orquestador decide cuántos lanzar y con qué reparto según el grafo. El bloque
  "SUBAGENTES" fija **quién hace qué**, no necesariamente cuántos a la vez.
- **Reanudar**: si la sesión se corta, el prompt arranca leyendo el estado y continúa.
- **Referencia viva**: `docs/00-referencia-tecnica.md` es el contrato. Si un subagente discrepa de él,
  gana el doc.
