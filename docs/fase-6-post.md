# Fase 6 — Post-procesado

**Objetivo**: la cadena de post de Rainy Worlds en TSL nativo — GTAO, TAA/TRAA, bloom, motion blur,
AgX, grade, CA, viñeta, grano — con los mismos parámetros y los mismos params de depuración.
**Depende de**: Fases 1–5. **Esfuerzo**: medio.

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §11.

---

## 6.1 Objetivo verificable

1. Cadena completa montada y con el orden correcto (AO→sharpen→AA→bloom→motion→tonemap→grade→CA→viñeta→grano).
2. Sin doble tone-mapping: el color final pasa por AgX **exactamente una vez**.
3. `?post=N` corta la cadena en los mismos niveles que RW (3=AO, 5=AA, 6=bloom, 7=motion, 8=CA, 9=viñeta, 10=grano).
4. `?view=normal|depth|velocity` muestra los buffers MRT.
5. El look final (AgX + sat 1.58 + contraste 1.13 + bloom 0.05 + viñeta 0.12 + grano 0.022) coincide
   visualmente con las capturas de referencia de RW.
6. `low` desactiva GTAO y motion blur; `medium`/`high` los activan con samples correctos.

---

## 6.2 Tareas

### T6.2.1 `src/render/Post.ts`
```ts
export function createPost(renderer, scene, camera, quality): PostEx
```
- Crear el `PostProcessing` de TSL. **Renderizar la escena en un MRT** `{ output, normal, velocity }`
  (todos los materiales de mundo deben escribir normal/velocity; usar `mrt()` en sus nodos, o el
  `MRTNode` por defecto si three lo inyecta).
- Encadenar en orden (§11):
  1. **GTAO** (si quality≠low): `radius .7`, `thickness .6`, `scale 1`, `samples 12/8`,
     `resolutionScale .65/.55`. Mezclar: `mix(1, ao, smoothstep(45, 95, viewZ))`.
  2. **Sharpen** `0.14`.
  3. **TAA**: `traa` (full-res) por defecto; `taau` a `resolutionScale .66/.75`. (También exponer `off`.)
  4. **Bloom**(`input, 0.05, 0.35, 1.4`) — aditivo, **antes** del tonemap.
  5. **Motion blur** (si quality≠low): 8/6 muestras a lo largo de la velocidad.
  6. `renderOutput` (AgX + exposure 0.8 + sRGB).
  7. **Grade**: `(mix(vec3(luma), rgb, 1.58) - 0.5) * 1.13 + 0.5`.
  8. **CA** radial `0.006` (centro .5,.5, escala 1.1).
  9. **Viñeta** `smoothstep(.55,1.25, |uv-.5|*1.4142) * 0.12`.
  10. **Grano** `0.022 * (1 - luma*0.7)`.
- `outputColorTransform = false` (tonemap/encoding una vez).
- `setSize`, `render(dt)`, `dispose`.

### T6.2.2 MRT (normal/velocity)
- rw escribe `normalView` y `velocity` en el MRT. En TSL, conectar `mrt({ output, normal: normalView, velocity })`
  en el material del mundo, o confiar en el `MRTNode` global.
- **El motion blur y el TAA necesitan velocity.** Si el MRT de velocity no se rellena bien, el motion blur
  no hará nada y el TAA ghostingea. Verificar con `?view=velocity` (debe mostrar el movimiento de cámara).
- Para MVP, si el velocity es problemático: dejar motion blur en `off` y usar solo TAAU o SMAA. Documentar.

### T6.2.3 Params de depuración
- `?post=N`, `?taa=off|traa|taau`, `?view=normal|depth|velocity`, `?ao=0`, `?aoView=1`.
- `?tune=exposure:0.5,saturation:1.2,...` para override rápido sin GUI (y así no persistir).
- Un mini-GUI (lil-gui) con tecla `G` es opcional pero muy útil para iterar el look. Añadir si tiempo.

### T6.2.4 Calibración del look (iterativo)
- Meta: capturas nocturnas (camino, al caminar por el bosque con lluvia) que se parezcan a RW.
- Ajustar en este orden si no cuadra: exposición → saturación/contraste → bloom threshold → viñeta → grano.
- **Comparar lado a lado** con capturas de referencia de rainyworlds.com (woods de día sirve para la
  estructura del pipeline; el look de noche es el objetivo, la calibración es propia).

---

## 6.3 Criterios de aceptación

- [ ] `npm run typecheck` limpio.
- [ ] `?view=normal|depth|velocity` muestra los 3 buffers correctamente.
- [ ] `?post=3` solo AO; `?post=6` añade bloom; `?post=99` (default) cadena completa.
- [ ] Histograma: sin recorte de altas luces en zonas de la luna, sin shadows Relevantemente todos.
- [ ] No hay ghosting excesivo con TAA/TRAA al caminar (comprobar con capturas en movimiento).
- [ ] Screenshot final de noche: coherent, con profundidad de niebla, sin banding, look cohesionado.
- [ ] `low` desactiva GTAO/motion sin errores.

---

## Estado de implementación (Fase 6) — ✅ verificada por el orquestador

**Ficheros**: `src/render/Post.ts`, integración en `src/main.ts` (`post.render` salvo `?post=0`),
`tools/post-probe.ts`.

**Decisiones**
- `RenderPipeline` (no el `PostProcessing` deprecado) con MRT `{output, normal, velocity}`.
- Orden real: `pass(MRT) → AO → Sharpen(0.14) → traa/taau → Bloom → [motion] → renderOutput →
  grade(sat 1.58/contraste 1.13) → CA → viñeta → grano`. Sharpen **antes** del TAA (cadena numerada);
  en TAAU se aplica tras el upscale (si no, mezcla beauty full-res con velocity low-res).
- `bloom()` devuelve solo el término aditivo; con threshold 1.4 apenas actúa de noche (salvo rayos).
- `viewZ` es negativo en three: la rampa de AO y `?view=depth` usan `-viewZ`.
- **Motion blur OFF por defecto** (autorizado por el doc): el velocity es correcto para terreno/árboles/
  props/cielo, pero **roto para lluvia y césped** (`positionNode` procedural sin `positionPrevious`;
  `?view=velocity` los muestra saturados). `?motion=1` lo activa con smear visible. TRAA sí queda
  activo (history rechazada donde el velocity falla → sin ghosting).
- `?post=N` activa niveles ≤ N (3 AO · 4 sharpen · 5 AA · 6 bloom · 7 motion · 8 CA · 9 viñeta · 10 grano);
  tonemap+grade estructurales. `?tune=clave:valor` sobrescribe POST. `?view=normal|depth|velocity`,
  `?ao=0`, `?aoView=1`, `?taa=off|traa|taau`.

**Evidencia**
- `npm run typecheck`/`build` limpios; `bench` + `--probe` OK.
- **Sin doble tonemap**: brillo medio `?post=0` (22.51) ≈ full-neutral (22.45); la diferencia full/neutral
  es solo el grade.
- `?view=normal|depth|velocity` muestran los 3 buffers; `velocity` en movimiento cam+5.96 sobre reposo.
- `?taa=off` vs `traa` en movimiento: diff 6.3 % px, sin ghosting. Luna sin clipping.
- `low`: chain sin AO ni motion (`samples {ao:0,mb:0}`). `?gl=1` sin errores.
- Capturas: `fase-6-full.png`, `fase-6-nopost.png`, `fase-6-ao.png`, `fase-6-bloom.png`,
  `fase-6-{view-normal,view-depth,velocity}.png`, `fase-6-{taau,taa-off,motion,moon,webgl2}.png`.

**Pendiente/deuda**
- Cambiar calidad en runtime no reconstruye la cadena (MRT/AO/TAAU del tier inicial).
- `positionPrevious` en `Grass.ts`/`Rain.ts` si F7 quiere motion blur perfecto.
- AO poco visible en campo abierto nocturno (por diseño; rampa 45–95 m).

## 6.4 Notas / trampas
- **El orden importa**: bloom ANTES del tonemap (si no, se pierde el HDR); grade/CA/viñeta/grano DESPUÉS
  del tonemap/encode (en display-referred). Es el error clásico.
- `outputColorTransform=false` + un `renderOutput` explícito = tonemap una vez. Si el `RenderPipeline` de
  three envuelve solo, se aplica dos veces → imagen lavada. Verificar.
- Los nodos de post de TSL son sensibles a que los materiales escriban los MRT correctos. Si GTAO sale negro,
  probablemente falta el buffer de normal.
- TAAU a `resolutionScale` baja toda la pasada a 0.66/0.75: la imagen se ve más suave (esperado). En
  `low` a 0.66 puede quedar bastante blanda; es el trade-off de RW.
- No confundir `TRAA` (con velocity, sin subpíxel) con `TAAU` (subpíxel, sin resize). `traa` es el default
  de RW y el más estable para el ACE con velocity.
