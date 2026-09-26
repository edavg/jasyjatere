# Fase 9 — QA en hardware real y pulido (post-v1)

**Objetivo**: medir en GPU real sin DevTools, cerrar las deudas de la v1 y fijar el look con evidencia.
**Depende de**: F8 (walker) y de la linterna (`src/render/Torch.ts`, §9.5 de la referencia).

---

## 9.1 Tareas

- **T9.1 `?perf=N`** (`src/core/perf.ts` + `main.ts` + HUD): muestrea el `dt` **sin capar** durante N s
  tras 1.5 s de warmup y publica p50/p95/p99/max (ms), fps, draws, tris y `scanMs` en `console.log`,
  `window.__dbg.perf` y una línea `PERF …` en el HUD. Muestras en `Float32Array` preasignado; el `sort`
  final asigna una vez (no está en el bucle).
- **T9.2 Protocolo** `docs/qa-hardware.md`: matriz de escenarios, qué reportar y criterios de fallo.
- **T9.3 Deuda de audio**: puerta de silencio `smoothstep(0, 0.05, rain)` sobre las 3 capas (el preset
  `clear` ya no deja cama audible). El trueno anterior a `unlock()` sigue descartándose: el flash tampoco
  era visible tras el menú. Verificado en `tools/audio-probe.ts`.
- **T9.4 Look**: A/B con `?tune=` a pose fija. Se mantienen las constantes de RW (`POST`, §11): ninguna
  variante aportó y el doc es la fuente de verdad. Capturas `artifacts/fase-9-look-*.png`.
- **T9.5 Integración**: la linterna de §9.5 pasó la batería completa de F9 (`?torch=0/1`,
  `?torchshadow=1`) sin errores ni warnings, y sigue al rig del walker. **`F` la alterna** con la luz
  siempre en el grafo (apagada a intensidad 0) para que no recompile materiales; `qa-session` comprueba
  `false → true → false` y el HUD (`TORCH ON/OFF`). Captura `artifacts/torch-toggle-f.png`.

## 9.2 Criterios de aceptación

- [x] `npm run typecheck` y `npm run build` limpios.
- [x] `?perf=N` entrega JSON en consola + `__dbg.perf` + línea en HUD (`fase-9-perf.png`).
- [x] `docs/qa-hardware.md` con matriz y criterios.
- [x] `clear` (rain=0) silencia las capas de lluvia (`audio-probe`: `rainLayers=0.0000`).
- [x] Look A/B fijado; `POST` sin cambios (gana la referencia).
- [x] Batería de regresión: `walk-probe` 13/13, `frame-probe` PASS, `audio-probe` PASS, `qa-session`
      180 s con 0 errores/0 warnings y `dispose()` limpio.
- [x] Capturas de la fase en `artifacts/fase-9-*.png`.

## 9.3 Evidencia (headless SwiftShader; ver `qa-hardware.md` para GPU real)

```
node tools/walk-probe.ts        # 13/13 (velocidades §1, bob, colisión r+0.32, pasos, consola)
node tools/frame-probe.ts --q high --seconds 8   # PASS · lastScanMs p95 3.3 ms · 0 warnings
node tools/audio-probe.ts       # PASS · clear sin capas
node tools/qa-session.ts --seconds 180           # 24/24 · 0 errores · 0 warnings
node tools/bench.ts             # tabla por tier (relativa)
```

`?perf` de muestra en headless `high` 1440×900: `p50 33.3 ms · p95 33.4 · max 50.1 · 304 frames ·
draws 21 · tris 2.09M` (SwiftShader: no extrapolable, sirve para comparar cambios).

## 9.4 Notas / trampas

- No medir con el clima libre: fijar `?rain=1&wind=1.64&flash=0&seed=1337` (el relámpago movió la misma
  escena de 174 a 90 de luma en un barrido de la linterna).
- `?perf` mide `rAF`; con la pestaña en segundo plano el navegador lo estrangula (números basura).
- El `dt` de simulación está capado a 50 ms, pero el bench usa el delta crudo: si sale `max 50.0` en el
  JSON nuevo, revisa que no sea el cap (se eliminó: ahora son picos reales).
- WebGL2 (`?gl=1`) degrada post/sombras: úsalo como sanity de fallback, no para la tabla de fps.
