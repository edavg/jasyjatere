# nightwoods — Rainy Worlds "Exploring Woods" (nocturno) desde 0

Reproduce la escena **woods** (el capítulo 1 de https://rainyworlds.com) con su sistema de césped, árboles,
luz y perspectiva **pero de noche**, en un proyecto nuevo con **three.js WebGPURenderer + TSL** y assets
**100 % procedurales**.

**Alcance de la v1**: SOLO EL MUNDO (escena, terreno, vegetación, luz, clima, post). Sin gameplay.
**Fuente de verdad**: [`docs/00-referencia-tecnica.md`](docs/00-referencia-tecnica.md) — constantes y
algoritmos decodificados del bundle de producción de Rainy Worlds.

---

## Documentación

| Doc | Contenido |
|---|---|
| [00-referencia-tecnica.md](docs/00-referencia-tecnica.md) | Constantes, algoritmos y parámetros exactos de RW (leyenda TSL, cámara, luz, cielo, niebla, altura, césped, árboles, props, lluvia, post, calidad) |
| [fase-0-andamiaje.md](docs/fase-0-andamiaje.md) | Scaffolding, `RenderCore` WebGPU, bucle, menú, loader, `tools/shot.ts` |
| [fase-1-cielo-luz-niebla.md](docs/fase-1-cielo-luz-niebla.md) | Luna direccional + **snap a texel**, domo de cielo, IBL procedural, niebla TSL de doble Beer–Lambert |
| [fase-2-altura-terreno.md](docs/fase-2-altura-terreno.md) | LUT de altura 512² half-float, streaming de 121 tiles de 32 m, material de suelo splat |
| [fase-3-cesped.md](docs/fase-3-cesped.md) | El sistema estrella: 1 draw call, 37k–256k briznas, `uOrigin`, hash PCG uint, viento |
| [fase-4-arboles-props.md](docs/fase-4-arboles-props.md) | 4 especies procedurales × 3 LODs, pool de slots sin GC, props, balanceo, colisión |
| [fase-5-lluvia-clima-rayos.md](docs/fase-5-lluvia-clima-rayos.md) | Rachas/salpicaduras con wrap de volumen, relámpagos, adaptación nocturna sin faros |
| [fase-6-post.md](docs/fase-6-post.md) | Cadena TSL: GTAO → TAA → bloom → motion blur → AgX → grade → CA/viñeta/grano |
| [fase-7-cierre.md](docs/fase-7-cierre.md) | Calidad persistente, HUD, audio ambiente, QA y performance |
| [PROMPT-EJECUCION.md](PROMPT-EJECUCION.md) | **Prompt maestro** para ejecutar las fases con subagentes |

---

## Grafo de dependencias

```
                     ┌─────────────────────┐
                     │  F0 Andamiaje       │
                     │  RenderCore WebGPU  │
                     └──────────┬──────────┘
                                ▼
                     ┌─────────────────────┐
                     │  F1 Cielo/Luz/Niebla│  ← define el LOOK
                     └──────────┬──────────┘
                                ▼
                     ┌─────────────────────┐
                     │  F2 Altura/Terreno  │  ← define la FUENTE DE ALTURA
                     └──────────┬──────────┘
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
     ┌────────────────┐ ┌──────────────┐ ┌────────────────┐
     │ F3 Césped      │ │ F4 Árboles   │ │ F5 Lluvia      │
     └────────┬───────┘ └──────┬───────┘ └────────┬───────┘
              └────────────────┴─────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  F6 Post-procesado  │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │  F7 Cierre / QA     │
                    └─────────────────────┘
```

- **F0 → F1 → F2 son estrictamente secuenciales.**
- **F3, F4 y F5 son paralelizables** en cuanto exista F2 (ahí es donde conviene desplegar subagentes).
- F6 necesita todo lo anterior (los MRT velocity deben cubrir la escena completa).
- F7 cierra.

---

## Convenciones del proyecto

- **Fábricas, no clases**: `createX(...)` devuelve un objeto con getters y `dispose()`.
- **Constantes centralizadas** en `src/core/constants.ts` (frozen, `as const`), importadas por shaders vía
  template literals GLSL/TSL.
- **Determinismo total**: mismo `seed` → mismo frame. `rng.ts` con hashes idénticos bit a bit a RW.
- **Cero assets externos**: texturas, HDRI, geometría y atlases se generan en runtime. Nada de ficheros
  binarios (salvo el que holgura). **Cero material de Rainy Worlds** (copyright) — solo el algoritmo.
- **Rendimiento**: sin asignaciones en el bucle (matrices escritas directo en `instanceMatrix.array`,
  buffers SoA preasignados, scratch a nivel de módulo), `frustumCulled` gestionado, DPR cap por calidad.
- **Verificación por fase**: `npm run typecheck` + capturas con `tools/shot.ts` + los tests de la fase
  (spike de instancias, coherencia altura JS/shader, sonda de memoria, bench de césped).

---

## Comandos

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run typecheck
npm run build
node tools/shot.ts --q high --out artifacts/menu.png
```

## Parámetros de depuración

`?q=low|medium|high` · `?snap=0` · `?grass=0` · `?trees=0` · `?props=0` · `?rain=0` · `?wind=N` ·
`?fog=N` · `?fogcol=r,g,b` · `?sun=N` · `?env=N` · `?post=N` · `?taa=off|traa|taau` ·
`?view=normal|depth|velocity` · `?ao=0` · `?aoView=1` · `?gl=1` · `?fly=1` · `?nowarm=1` · `?debug=1` ·
`?seed=<n>` · `?preset=clear|drizzle|rain|storm` · `?flash=N` · `?bolt=1|hold` · `?hud=0` · `?stats=1` ·
`?audio=0` · `?volume=N`

## Convenciones de captura

`artifacts/` guarda una captura de referencia por fase. **Al terminar cada fase, capturar y versionar**:
es lo que detecta que una fase posterior rompió algo.
