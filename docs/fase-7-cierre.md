# Fase 7 — Cierre v1: selector de calidad, HUD, audio, QA

**Objetivo**: cerrar la v1 "solo mundo" — calidad persistente, HUD de clima, audio ambiente (lluvia/viento/
trueno), ajustes de la lógica de streaming, y un pase de QA/performance. **No añade gameplay.**
**Depende de**: Fases 0–6. **Esfuerzo**: medio.

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §12.

---

## 7.1 Objetivo verificable

1. Selector LOW/MEDIUM/HIGH persistente, con detección automática y recarga (como RW: cambian el
   `location.search` y recargan).
2. HUD mínimo: barras de lluvia/viento `▮`, nota de backend, toggle de stats (tecla `P`), log de debug
   (`?debug=1`).
3. Audio ambiente: lluvia (3 capas de ruido filtrado), viento (con ráfagas), trueno (rumor + sub al
   relámpago). Reutilizar la arquitectura de bus del proyecto horror (`src/core/audio.ts`) como esqueleto.
4. Lógica de streaming: el bosque sigue denso al caminar rápido y en `?fly=1` sin tirón.
5. QA completo: sin errores de consola, performance medida, capturas de referencia guardadas.

---

## 7.2 Tareas

### T7.2.1 Calidad persistente (`src/core/quality.ts`)
- `pickQuality()`: `hardwareConcurrency >= 10 ? high : >= 6 ? medium : low`; `matchMedia('(pointer: coarse)')`
  → low. Permitir `?q=` override. Persistir en `localStorage['nightwoods-quality']`.
- Al cambiar en el menú: `location.search = '?q=<q>'` → recarga (como RW).
- Tabla `QUALITY` (Fase 0) leída por todos los subsistemas (césped, árboles, props, lluvia, post, sombras, DPR).

### T7.2.2 HUD (`src/ui/hud.ts`)
- Barras de clima (lluvia/viento) con `▮` y pattern de flash 1.8 s al cambiar, estilo RW.
- Teclas: `1/2` lluvia, `3/4` viento, `P` stats, `G` tuner GUI (opcional), `ESC` menú, `?debug=1` log.
- Nota de backend persistente (WebGPU / WebGL2 fallback).
- Stats: fps, draw calls, triángulos, `renderer.info.memory`, conteo de césped/árboles.
- Reutilizar el estilo del HUD del proyecto horror (`src/ui/hud.ts`, 315 líneas) como base.

### T7.2.3 Audio ambiente (`src/core/audio.ts` — extender)
Esqueleto del proyecto horror (buses master/sfx/music, `ensure()`, `tone()`, `noiseBurst()`) + capas RW:
- **Lluvia**: 3 capas de ruido estéreo procedural con densidades 500/1500/3200 Hz (filtros distintos),
  ganancias re-escaladas por `rainAmount` (curva de 3 campanas: 500 Hz en llovizna, 3200 Hz en lluvia fuerte),
  jitter ±6 %, curva de potencia `(max(rain,.05)/1.5)^.55`.
- **Viento**: ruido → lowpass(`200 + gust*520`) → gain(`(0.015+gust*0.11)*wind`); más un bandpass silbante
  (`560+gust*420`, Q6) cuando `gust > 0.55`.
- **Trueno**: al `onThunder`, ráfaga de ruido filtrada (3–5 bursts, modulación 1.5–3 Hz, barrido lowpass
  70–240 Hz) + sub 55→32 Hz si es cercano; delay `0.35 + intensity*3.4` (ya en el callback).
- **Opcional (si hay tiempo)**: muestras deAnimales/ pasos (copyright — solo sintetizar o usar fuentes
  libres). Para v1 "solo mundo", la lluvia/viento/trueno sintetizado basta.
- Persistir volumen en `localStorage`.

### T7.2.4 Perfeccionamiento del streaming
- **Coste de rebuild**: con `?fly=1` volando rápido, el `scatter.update` (3 m threshold) puede procesar
  miles de celdas de golpe. Medir; si hay hitch, **limitar celdas por frame** o **subdividir** el escaneo
  (rebuild incremental). Objetivo: sin frame > 16 ms al volar.
- **Limpieza de referencias**: los `BufferGeometry` de los tiles no se liberan nunca (se reutilizan), OK.
  Los `InstancedMesh` de árboles/props tampoco. `dispose()` global al final (tests).

### T7.2.5 QA y performance
- **Consola limpia**: cero errores/warnings en una sesión de 3 min.
- **Performance objetivo** (escritorio de referencia con WebGPU): 60 fps en high a 1080p; medium en
  portátil integrado; low en móvil/coarse pointer.
- **Capturas de referencia** (`artifacts/`): menú, bosque de día(noche aquí), con lluvia, con relámpago,
  A/B de `?grass=0`, A/B de `?snap=0`. Son la regresión visual.
- **Pruebas de consistencia** (reusar de fases previas): `verify-height` (F2), `spike-instance` (F3),
  `mem-probe` (F4), `bench` (F3).
- `npm run build` limpio (bundle size reporta; esperar ~1–1.5 MB por three + shaders).

---

## 7.3 Criterios de aceptación

- [x] `npm run typecheck` y `npm run build` limpios. *(1 028 kB / gzip 290 kB)*
- [x] Selector de calidad persiste entre recargas; `?q=` funciona. *(localStorage + recarga con `?q=`, §7.5)*
- [x] HUD: barras de lluvia/viento reaccionan a 1/2/3/4; stats con `P`. *(qa-session 24/24)*
- [x] Audio: lluvia suave audible, viento con ráfagas, trueno en relámpago. Volumen ajustable. *(`audio-probe` RMS + volumen `-`/`=`/`M`)*
- [x] Sin errores de consola en 3 min de juego. *(qa-session: 0 errores, 0 warnings)*
- [x] Performance: tabla de fps por tier documentada. *(§7.5, con el caveat de SwiftShader)*
- [x] Capturas de referencia guardadas en `artifacts/`. *(`fase-7-*.png`)*
- [x] Volando (`?fly=1`) rápido: sin hitch de streaming. *(`frame-probe` PASS: `lastScanMs` ≤ 5.6 ms, Δ de frame imputable 1.9 ms)*

---

## 7.4 Notas / trampas
- El audio debe arrancar **tras un gesto de usuario** (política de autoplay): el botón START lo desbloquea.
- La ráfaga de viento debe seguir la `gust` real de la Fase 1 (compartida), no un valor fijo.
- El HUD del proyecto horror es reutilizable casi tal cual para el estilo; adaptar colores al `--ink` de RW.
- La "regresión visual" (capturas fijas) es lo que detecta que una fase rota algo. Captura SIEMPRE al
  terminar cada fase, no solo aquí.
- No añadir gameplay en esta fase. Si aparece la tentación de poner colisión de jugador, guárdalo para
  una "fase 8+".

---

## 8. Resumen de entregables por fase

| Fase | Entregable principal | Verificación clave |
|---|---|---|
| 0 | Arranque + `RenderCore` + menú + loader | frame pinta, backend reportado, `__dbg` |
| 1 | Cielo + luna + sombra con snap + niebla | sombras estables, niebla a 185 m, disco lunar |
| 2 | LUT de altura + 121 tiles + material de suelo | sin costuras, JS==shader, sin popping |
| 3 | Césped RW (1 draw, 37–256k, `uOrigin`) | conteo correcto, 0 uploads, bench |
| 4 | Árboles+props procedurales con pool de slots | 0 GC, 3 LODs, sombras LOD0/1 |
| 5 | Lluvia + salpicaduras + relámpagos | lluvia visible de noche, trueno |
| 6 | Cadena de post TSL completa | look correcto, sin doble tonemap, `?post/view` |
| 7 | Calidad + HUD + audio + QA | 60fps high, consola limpia, capturas |

---

## 7.5 Estado de implementación (F7 ejecutada)

### Qué se implementó

- **Calidad (T7.2.1)**: `src/core/quality.ts` sigue siendo la fuente (`?q=` > localStorage > `detectQuality()`).
  Al pulsar un tier en el menú se persiste y se **recarga** con `?q=` (como RW). Decisión: `location.replace`
  con el resto de la query preservada (`?seed`, `?fly`… de QA) en vez de `location.search='?q=…'`.
- **HUD (T7.2.2)**: `src/ui/hud.ts` + markup/CSS en `index.html`.
  - Barras `RAIN`/`WIND` de 20 celdas `▮` con flash CSS de 1.8 s al cambiar, nota de backend persistente
    (`WEBGPU · dpr · q`) y línea `VOL n% · MUTED · AUDIO OFF`.
  - Stats (P) a 4 Hz: fps/frame, draws/tris, geo/tex, grass (inst), scatter (live/`lastScanMs`/scans/blockers),
    trees, props, tiles, post (AO/MB/TAA) y clima. Log `?debug=1` a 2 Hz.
  - Teclas: `1/2` lluvia ±0.15, `3/4` viento ±0.2, `-`/`=` volumen ±0.05, `M` mute, `P` stats; `ESC` menú/HUD
    en `main.ts` (el mundo sigue animándose detrás del menú). Las teclas 1/2/3/4 y `P` salieron de
    `Weather.ts` (P ya no cicla preset; `cyclePreset()` queda como API).
  - Params nuevos de QA: `?hud=0` (capturas limpias) y `?stats=1` (panel abierto al arrancar).
  - **Excepción documentada** al cero-allocs: el DOM de stats/log se recompone a 4 y 2 Hz y solo visible.
- **Audio (T7.2.3)**: `src/core/audio.ts` (fábrica, buses `master`→`sfx`/`music`). Lluvia 3 capas
  (bandpass 500/1500/3200 Hz, campanas en 0.35/1.0/1.75 con σ 0.5/0.55/0.6, jitter ±6 % con mulberry32),
  viento `lowpass(200+gust·520)` + silbido `bandpass(560+gust·420, Q6)` con puerta en `gust>0.55`, trueno
  3–5 sub-bursts (lowpass 240→70 Hz, AM 1.5–3 Hz) + sub 55→32 Hz si `intensity ≥ 0.6`. Volumen en
  `localStorage['nightwoods-volume']`, `?audio=0`/`?volume=N`. `unlock()` en el click de START (autoplay).
- **Streaming (T7.2.4)**: medido; **no se toca `Scatter.ts`** (ver evidencia). Limpieza: `dispose()` global
  expuesto como `window.__nightwoods.dispose()` (orden inverso de construcción) para tests.
- **QA extra**: `geometryUtils.mergeGeos` solo llama `toNonIndexed()` si `index !== null` — en r186 salían
  1015 warnings «already non-indexed» por sesión (T7.2.5 exige consola limpia).

### Evidencia (comandos y números reales)

```bash
npm run typecheck                                  # limpio
npm run build                                      # 1 028 kB JS · gzip 290 kB · 50 módulos
node tools/bench.ts                                # tabla por tier (SwiftShader, 1440×900)
node tools/frame-probe.ts --q high --seconds 12    # estrés de vuelo (640×400, W+Shift ×5)
node tools/audio-probe.ts                          # RMS de las capas de audio
node tools/qa-session.ts --seconds 180 --json      # sesión de 3 min (HUD + audio + consola + dispose)
node tools/shot.ts ...                             # capturas fase-7-*.png
```

**FPS por tier** (`bench.ts`, mediana de 24 frames, SwiftShader **CPU** — no es una GPU real; el objetivo
de §7.2.5 se refiere a WebGPU de escritorio: 60 fps en high a 1080p):

| tier | grass | mediana | media | min | max |
|---|---|---|---|---|---|
| low | off/on | 4.05 / **5.40** ms | 4.06 / 5.57 | 3.60 / 4.80 | 4.70 / 6.80 |
| medium | off/on | 5.40 / **8.65** ms | 5.52 / 9.50 | 4.80 / 5.00 | 7.60 / 25.40 |
| high | off/on | 5.60 / **14.10** ms | 5.78 / 13.83 | 4.60 / 6.20 | 7.20 / 29.30 |

**Vuelo rápido** (`frame-probe`, `?q=high&fly=1&cam=0,60,0`, 100 m/s durante 12 s): 330 escaneos
(27.5/s), `lastScanMs` media **2.26 ms** (p95 3.20, max 5.60), Δ de frame imputable al escaneo **1.87 ms**;
los 5 peores frames son `no-scan` (scheduler/SwiftShader) → **PASS**. Conclusión: el coste por escaneo es
constante (~7.3k celdas en 12 capas) y < 3 ms, así que no procede presupuesto incremental.

**Sesión de 3 min** (`qa-session`, `?q=low&debug=1&bolt=1`): **24/24 checks**, 0 errores, 0 warnings,
`frame 389 → 11194` (59.7 fps, vsync), heap Δ −2.1 MB, `dispose()` sin errores. Evidencia completa en
`artifacts/fase-7-qa-session.json`.

**Audio** (`audio-probe`, RMS del máster): lluvia 0.05 → 7.6e-3, 0.45 → 3.6e-2, 1.0 → 8.0e-2,
1.9 → 1.3e-1; viento 0.3 → 7.7e-3, 2.3 → 1.7e-2; trueno → 7.3e-3. PASS.

### Capturas de regresión (`artifacts/`)

`fase-7-menu.png` · `fase-7-forest.png` · `fase-7-hud-stats.png` · `fase-7-rain.png` ·
`fase-7-lightning.png` · `fase-7-grass-on.png` / `fase-7-grass-off.png` · `fase-7-snap-on.png` /
`fase-7-snap-off.png` · `fase-7-webgl2.png` (fallback) · `fase-7-smoke.png`.

### Fuera de esta fase

- Sin gameplay, sin agua (v1 "solo mundo"): intacto.
- `G` (tuner GUI) no se añadió: el doc lo marca opcional y `?tune=` ya permite iterar el look del post.
- No hay capa de pasos/animales/música (opcional y descartado para v1).
