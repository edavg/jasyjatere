# Fase 1 — Cielo, luz, sombra y niebla (define el look nocturno)

**Objetivo**: un mundo vacío con luna, cielo nublado, niebla y sombras que no titilan. Este es el look
de referencia; todo lo demás se juzga contra él.
**Depende de**: Fase 0. **Bloquea**: 2, 3, 4, 5, 6.
**Esfuerzo**: medio.

Fuente de verdad: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §2, §3, §4, §12.

---

## 1.1 Objetivo verificable

1. Domo de cielo visible desde la cámara, con gradiente nocturno, dos capas de nubes en movimiento,
   disco + halo lunar en la dirección `normalize(38,78,26)` y calima en el horizonte.
2. Una malla de cajas de prueba proyecta sombra de la luna **sin shimmer** cuando la cámara se mueve
   lateralmente (comprobación con capturas a 0.1 s de diferencia).
3. `window.__dbg.snap = true` y el bloque de snap a texel está activo (se puede desactivar con `?snap=0`).
4. Niebla que satura a 185 m: cualquier geometría a >200 m es invisible; a 100 m apenas se distingue.
5. Losftest determinista: con `?seed=` fijo el frame es reproducible.

---

## 1.2 Tareas

### T1.2.1 `src/render/Environment.ts`
Implementar **completo** el bloque §2 de la referencia.

```ts
export function createEnvironment(scene, quality, shared): EnvironmentEx
```
- **Sol/luna**: `DirectionalLight(new Color(...SUN.color), SUN.intensity)`, `castShadow = true`.
  Configurar `shadow.mapSize` (`QUALITY[quality].shadow`), `shadow.camera` ortográfica ±`SUN.shadowR`,
  `near/far`, `bias`, `normalBias`, `radius`. **Y `sun.shadow.camera.layers.enable(2)`** (no opcional:
  sin esto el renderer de sombras WebGPU hereda la máscara de la cámara y el césped/lluvia proyectan).
- **Snap a texel** (§2.2): `lightRot = Matrix4.lookAt(SUN_OFFSET, ORIGIN, Y_UP)`, `lightRotInv`, y en
  `update(dt, focus)`: `texel = 2*shadowR/mapSize.width`, anchor → `lightRotInv` → `Math.round` de x/y →
  `lightRot` → `sun.position = anchor + SUN_OFFSET`, `sun.target.position = anchor`, `updateMatrixWorld()`.
  Respeta `?snap=0`.
- **Hemisférica**: `HemisphereLight(SKY_HEMI, GROUND_HEMI, HEMI.intensity)`.
- **Entorno IBL procedural**: generar un equirectangular nocturno (ver T1.2.3) → `PMREMGenerator` →
  `scene.environment` con `EquirectangularReflectionMapping`; `scene.environmentIntensity = 0.06`;
  `scene.background = null`.
- **Racha + KB**: oscilador de `gust` (§2.5) y suavizado de la referencia de altura de niebla.
- Exponer en `shared`: `uMoonDir` (vector normalizado), `uGust`, `uFlash`, `uFlashDir`, `uWindDir`,
  `uWindStrength`, `uFogHeightRef`, `uHorizonColor`, `uFogDensity`, `uFogNearFar`, `uTime`.

### T1.2.2 `src/render/Sky.ts`
Domo de cielo con el grafo TSL exacto de §3.
- `SphereGeometry(470, 48, 24)`, material `MeshBasicNodeMaterial`, `side: BackSide`, `depthWrite: false`,
  `fog: false`, `renderOrder: -10`, `frustumCulled: false`.
- `colorNode` = grafo completo: gradiente → nubes (2 fbm, uv proyectada, scroll `t*.006`) →
  oscurecimiento por nube → disco/halo lunar → calima de horizonte (`uHorizonColor`) → término de rayo.
- `position` sigue a la cámara cada frame (`dome.position.copy(cameraPos)`).
- Usar `mx_fractal_noise_float` de TSL con los parámetros exactos (octavas/lacunarity/diminish de §3).

### T1.2.3 `src/assets/env.ts` — HDRI nocturno procedural
- Construir un `DataTexture` equirect (p. ej. 256×128, half-float) que represente el cielo nocturno:
  gradiente cenit→horizonte, una fuente de luz luna suave en la dirección de la luna, y un suelo
  oscuro. Alimentar `PMREMGenerator.fromEquirectangular()`.
- Objetivo: contribution IBL sutil (intensity 0.06) para dar un sheen a superficies wet. No es crítico
  que sea bonito, pero debe ser **muy** suave (nada de disco duro).
- Alternativa si `PMREMGenerator` con `DataTexture` da problemas: generar un `CubeTexture` 6 caras de
  gradiente. Verificar en runtime.

### T1.2.4 `src/render/Fog.ts`
Nodo de niebla TSL con las dos extinciones Beer–Lambert + término de altura + suelo de distancia (§4).
- `export const fogNode = /* fog(colorNode, factorNode) para materiales */`.
- Debe funcionar en **todos** los materiales de mundo (terreno, césped, árboles, props) vía
  `material.fogNode = fogNode` (o el mecanismo de nodos equivalente para `MeshStandardNodeMaterial`).
- **Prueba visual clave**: el factor debe ser 0 a 100 m, ~0.5 a 150 m, 1.0 a ≥185 m.

### T1.2.5 `src/world/Probe.ts` (temporal, se elimina al cerrar la fase)
Malla de cajas de prueba (p. ej. 40 cajas en una retícula de 20×20 m) con material simple lit, sólo para
validar sombras. Registrar en `__dbg.probe` un toggle. **Eliminar al terminar la fase 1.**

### T1.2.6 Integración en `main.ts`
- Tras crear `Environment`, `Sky`, `Fog`: añadir la `DirectionalLight`, su `target`, la `HemisphereLight`,
  y el domo a la escena.
- Llamar `environment.update(dt, playerFocus)` cada frame antes del render.
- Añadir los params de depuración: `?snap=0`, `?fog=N`, `?fogcol=r,g,b`, `?sun=N`, `?env=N`.

---

## 1.3 Criterios de aceptación

- [ ] `npm run typecheck` limpio.
- [ ] Screenshot de noche: se ve el domo con gradiente, nubes y disco lunar.
- [ ] 3 capturas con la cámara desplazada lateralmente 0.3 m → las sombras se ven **estables** (sin
      moteado/crepúsculo). Con `?snap=0` se ve claramente peor (demuestra que el snap está activo).
- [ ] Caja de prueba a 250 m completamente oculta por niebla; a 120 m visible pero apagada.
- [ ] `?sun=0.5` duplica el brillo de la superficie; `?env=0.2` cambia el sheen.
- [ ] `__dbg` expone `moonDir`, `gust`, `flash`.

---

## 1.4 Notas / trampas
- El **snap a texel** es el detalle que más se nota: sin él las sombras "hierven". No lo omitas.
- `shadow.camera.layers.enable(2)` debe hacerse **después** de crear la luz y antes del primer render.
- El domo tiene `renderOrder = -10` y `depthWrite:false` para que nunca ocluya el mundo.
- `scene.environment` NO afecta al domo (es `MeshBasicNodeMaterial`); solo da IBL a los materiales PBR.
- La niebla propia de RW es un **nodo**, no `scene.fog`. No la reemplaces por `THREE.FogExp2`: perderías
  el término de altura y el doble Beer–Lambert, que es lo que da el look.
- Fog `smoothstep(600, 200, dist)` es un smoothstep de bordes invertidos (= `1 - smoothstep(200,600,dist)`);
 Ojo: en GLSL/TSL `smoothstep` con `edge0 > edge1` está bien definido (invierte), pero verifica.

---

## Estado de implementación (Fase 1) — ✅ verificada por el orquestador

**Ficheros**: `src/render/Environment.ts`, `src/assets/env.ts`, `src/world/Probe.ts` (temporal),
`src/render/Sky.ts`, `src/render/Fog.ts`, `src/render/fogMath.ts`, `tools/verify-fog.ts`, y la
integración de todo ello en `src/main.ts`.

**Decisiones**
- **Niebla en `scene.fogNode`**, no `material.fogNode`: en r186 el renderer lee
  `scene.fogNode || this.get(scene).fogNode` (`three.webgpu.js:58077`). `@types/three` 0.186 no declara
  `Scene.fogNode`; el cast está documentado en `Fog.ts`.
- **IBL**: `createNightEquirect()` (DataTexture equirect 256×128 half-float, lóbulo gaussiano suave) →
  `PMREMGenerator.fromEquirectangular()` → `scene.environment` (CubeUV). Sin disco duro.
- **Snapshot del reloj**: `shared.uTime` lo avanza `Environment.update`; el cielo y (F3+) el césped lo
  consumen. Con el menú abierto `dt=0` y todo queda congelado en el frame 0.
- **`?sun=N` / `?env=N`** dividen (`?sun=0.5` = ×2 brillo, criterio 1.3). `?snap=0` desactiva el snap.
- **§4 literal gana al criterio de este doc**: a 100 m el factor real es 0.593, no 0. La frase "0 a
  100 m" describe solo el término de suelo `y = smoothstep(120,185,f)`. Lo imprime `tools/verify-fog.ts`.
- `Probe.ts` y sus pilares a 120/250 m son **temporales**: se retiran al integrar el terreno (F2).

**Evidencia**
- `npm run typecheck` limpio; `npm run build` ✓; `node tools/verify-fog.ts` → `OK` (monotonía,
  saturación a 185 m, altura y densidad).
- **Snap a texel (prueba independiente del orquestador, texel = 0.041015625)**: con `?snap=1` las
  coordenadas de luz de `sun.target` son múltiplos exactos del grid (residuo ≤ 1e-13) para cualquier
  posición de cámara; mover la cámara 0.01/0.02 m (< 1 téxel) deja las coordenadas idénticas. Con
  `?snap=0` las coordenadas derivan con la cámara (shimmer).
- Capturas: `fase-1-world.png`, `fase-1-sky-moon.png`, `fase-1-moon-disk.png`,
  `fase-1-fog-pillars.png`, `fase-1-snap-on/off.png`, `fase-1-sun05.png`, `fase-1-env02.png`
  (todas con `consoleErrors:[]`, backend WebGPU).
- `__dbg`: `snap`, `moonDir`, `gust`, `flash`, `sunTarget`, `shadowTexel`.
- El pilar a 250 m desaparece con el factor de niebla = 1 a ≥185 m; el de 120 m se ve atenuado.

**Pendiente/deuda**
- El "disco" lunar es un halo ancho (pow(e,8)·0.03 domina sobre pow(e,60)·0.12); si F6/F7 pide un disco
  más marcado, subir el peso de `pow(e,60)`.
- Valores de niebla a 100–175 m pendientes de contraste contra capturas de RW en la fase de post.
