# AGENTS.md — nightwoods

Procedural night forest in three.js WebGPURenderer + TSL. v1 scope: world only, no gameplay, no water. Zero external assets.

## Commands

```bash
npm install
npm run dev        # http://127.0.0.1:5173 (strictPort, host 127.0.0.1)
npm run typecheck  # tsc --noEmit — gate for every change
npm run build      # = typecheck + vite build
node tools/verify-height.ts   # CPU check of height LUT (no GPU needed)
node tools/verify-fog.ts      # CPU check of fog formula
node tools/shot.ts --q high --out artifacts/<name>.png [--url ...] [--no-start] [--wait 2500]
node tools/qa-session.ts --seconds 180   # HUD + audio + consola limpia 3 min + dispose global
node tools/frame-probe.ts    # estrés de streaming volando (?fly=1, puerto 5175)
node tools/audio-probe.ts    # RMS de las capas de audio (puerto 5174)
node tools/bench.ts          # fps por tier (SwiftShader, relativo) / --probe
```

`tools/shot.ts` auto-spawns `npm run dev` if the URL is down, drives headless Chrome via `puppeteer-core` (`CHROME` env, default macOS path, needs `--enable-unsafe-webgpu` flags baked in), clicks `#start`, waits for `window.__dbg.frame > 20`, then screenshots. Inspect `window.__dbg` (`src/core/dbg.ts`) for backend/dpr/frame/tiles.

## TypeScript strictness (tsconfig)

`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are on — unused vars fail `typecheck`. Plus:
- `erasableSyntaxOnly`: no enums, namespaces, parameter properties.
- `verbatimModuleSyntax`: type imports must use `import type`.
- `allowImportingTsExtensions`: `tools/*.ts` import sources with explicit `.ts` extension (Node 22 type-stripping, e.g. `../src/world/heightMath.ts`). Keep that pattern in tools.

## Source of truth for numbers

`docs/00-referencia-tecnica.md` + `src/core/constants.ts` (frozen, `as const`). Never invent a numeric value: copy from the doc, else decide and document in code. Phase plans live in `docs/fase-N-*.md`; execution order and parallelization rules in `PLAN.md` / `PROMPT-EJECUCION.md`.

## Architecture contracts

- Entry: `src/main.ts` → canvas `#gl`. Camera lives in a nested rig (`yawGroup`/`pitchGroup`); never transform the camera directly.
- `src/core/shared.ts` is the uniform bag shared by sky/fog/grass/trees/rain (`uTime, uMoonDir, uGust, uWindDir, uFlash, ...`). Read `shared.uHeightNode(...)` live — never destructure/capture it at import; Phase 2 replaces it.
- `src/world/heightMath.ts` is pure math with **zero imports** (shared by JS, bake, and Node verify scripts). Mirror rules: texel centers `((i+.5)/res)`, bilinear + RepeatWrapping emulating `LinearFilter`; shader side must use the same LUT texture or grass floats/sinks.
- Height LUT: 512², 5 octaves, normalized [0,1], half-float on GPU; `?seed=N` shifts octaves (`0` → `1337`).
- Terrain: 11×11 pool (121 tiles of 32 m), `update()` early-outs unless the 32 m tile changed; keep the bounding-sphere patch `max(r*1.05, 31.04)` or tiles get wrongly culled. Material is world-space UV.
- Factories, not classes: `createX(...)` returns object with getters + `dispose()`. Zero allocations in the render loop (module scratch, preallocated SoA, write direct to `instanceMatrix.array`).

## Render quirks

- `three/webgpu` + `three/tsl` only. `RenderCore` falls back to WebGL2 by cloning the canvas (old context can't be reused); `?gl=1` forces fallback.
- `PCFSoftShadowMap` does not exist in r186 WebGPURenderer — use `PCFShadowMap`. Tone mapping is AgX (`=6`) with ACES fallback.
- DPR cap (`QUALITY[q].dpr`) applies only on quality change, never on resize. Quality precedence: `?q=` > localStorage > `detectQuality()`.
- Dev URL params: `?q=low|medium|high ?fly=1 ?cam=x,y,z ?look=yaw,pitch ?seed=N ?gl=1 ?nowarm=1 ?debug=1` (+ fog/sun/grass toggles in `PLAN.md`). `?cam` disables ground-follow; `?fly` is the dev fly camera.

## Conventions

- Copyright: replicate Rainy Worlds **algorithms + constants only** — never copy its files, textures, models, or bundle fragments.
- After each phase: `npm run typecheck` clean + `tools/shot.ts` capture versioned in `artifacts/` (regression baseline). `dist/` is build output, don't hand-edit.
