# QA en hardware real — protocolo

Los probes de `tools/` corren en **headless Chrome sobre SwiftShader (CPU)**: sirven para detectar
regresiones y costes relativos, pero **no** representan una GPU real. Esta es la pasada que sí lo hace,
y la hace una persona con el navegador delante.

## 1. Arrancar

```bash
npm install
npm run build && npm run preview      # o `npm run dev` para depurar
```

Abre la URL, elige tier en el menú (o fuerza `?q=`) y pulsa **START**. El primer arranque compila
shaders (el loader lo tapa); espera a que el HUD aparezca.

## 2. Bench in-app (`?perf=N`)

Añade `?perf=30` a la URL (N = segundos de muestreo, ≥ 10 recomendado). Tras el calentamiento (1.5 s)
el juego mide el `dt` real de cada frame y al terminar muestra una línea `PERF …` en el HUD y publica el
JSON en la consola:

```
[perf] {"seconds":30.02,"frames":1798,"fps":59.9,"p50":16.7,"p95":17.9,"p99":21.2,"max":48.1,
        "draws":21,"tris":2091150,"scanMs":2.9,"quality":"high","backend":"webgpu","dpr":1.5}
```

`p50/p95/p99/max` son ms de frame **sin capar** (los hitches reales no se ocultan tras el techo de
simulación). `draws/tris` son del último frame; `scanMs` es el último escaneo del scatter.

## 3. Matriz mínima

| Escenario | URL | Objetivo (§7.2.5) |
|---|---|---|
| Escritorio WebGPU, 1080p | `?q=high&perf=30` | 60 fps (p50 ≈ 16.7 ms, p95 ≤ 20 ms) |
| Portátil iGPU | `?q=medium&perf=30` | fluido (p50 ≤ 20 ms) |
| Móvil / puntero grueso | `?q=low&perf=30` | jugable; el tier se autodetecta |
| Fallback WebGL2 | `?gl=1&q=low&perf=30` | ok, sin errores; el HUD lo marca |

Con `?stats=1` el panel de stats queda abierto (fps, draws, tris, geo/tex, césped, scatter, audio).

## 4. Qué reportar

1. Hardware y navegador: CPU/GPU, SO, Chrome/Edge/Safari + versión.
2. **El JSON de `[perf]`** de cada fila de la matriz que hayas corrido.
3. Capturas si algo se ve raro (`artifacts/`).
4. Cualquier warning/error de consola (Meta+Alt+I → Console). Los criterios de F7 exigen 0.

## 5. Criterios de fallo

- `p95 > 25 ms` en `high` en un equipo de referencia ⇒ investigar (¿DPR? ¿post? ¿sombras?).
  Bajar `?post=6`, `?taa=taau` o `?ao=0` aísla la causa; `?grass=0`/`?trees=0` aíslan el mundo.
- Cualquier error de consola ⇒ bug.
- Comparar tiers con el mismo `?seed=1337` y **clima fijado** (`?rain=1&wind=1.64&flash=0`): con el
  clima libre las capturas no son reproducibles (ver PLAN.md).

## 6. Referencias ya medidas (headless SwiftShader — solo relativas)

- `tools/bench.ts`: mediana por tier con césped on/off (1440×900).
- `tools/frame-probe.ts`: estrés de streaming volando; `lastScanMs` es JS puro y sí es extrapolable.
- `tools/qa-session.ts --seconds 180`: consola limpia + HUD + audio + dispose.
