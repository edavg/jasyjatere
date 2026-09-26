# Fase 3 — Césped (sistema estrella)

**Objetivo**: la hierba de Rainy Worlds — un único draw call, 37k–256k briznas, cero atributos por
instancia, posiciones derivadas en el vertex shader desde `uOrigin`, con viento, doblez y densidad.
**Depende de**: Fase 2 (necesita `heightNode` + la niebla).
**Esfuerzo**: alto. Es la fase con más riesgo técnico.

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §6. Referencia: la investigación del
subagente de césped (el agente que decodificó `QV`).

---

## 3.1 Objetivo verificable

1. Un `InstancedMesh` (o `InstancedBufferGeometry`+`Mesh`) con el conteo exacto del tier activo.
2. `mesh.count` constante; por frame **solo** se escribe `uOrigin` (un Vector2). Cero uploads de buffer.
3. La hierba sigue a la cámara: al moverla, la brizna en una posición de pantalla dada cambia de forma
   coherente (rejilla de 0.5 m, hash determinista por celda) sin "saltos" individuales.
4. Viento visible (olas viajando) + doblez por altura² + conservação de longitud.
5. Las briznas se descartan por densidad (ruido) y se atenúan en el borde radial; nunca se ve un anillo
   duro de aparición.
6. Coste medido: `?grass=0` vs activo → delta de ms/frame en la tabla de tiers.

---

## 3.2 Tareas

### T3.2.1 `src/world/bladeGeometry.ts` — geometría de brizna
- `buildGrassBlade()`: exactamente la función `eH()` de §6.4 — 5 filas, 9 verts, 7 tris, indexada,
  `normal` = (0,0,1) en todos (se sobrescribe con `normalNode`). UV: filas laterales `(0|1, r)`, punta
  `(0.5, 1)`.
- `buildWheatBlade()`: opcional, perfil de 7 puntos (15 verts, 13 tris) con espiga ensanchada. Solo si
  `?wheat=1` (no usado en woods, pero trivial desde `eH`).
- Sin atributos por instancia. Solo `position`, `uv`, `normal`, `index`.

### T3.2.2 `src/world/Grass.ts` — la clase
```ts
export function createGrass(scene, heightNode, shared, quality): GrassEx
```
- **Conteo**: `const { n, k } = GRASS.tiers[quality]; count = n*n*k; R = n*GRASS.cell/2;`
- **Malla**: preferir `InstancedBufferGeometry` copiando `bladeGeometry`, con `instanceCount = count`, y un
  `THREE.Mesh` (no `InstancedMesh`, para no pagar los ~16 MB de `instanceMatrix` identidad en high). Verificar
  que con WebGPU/TSL el `instanceIndex` (`gl_InstanceID`) funciona con un `Mesh` + `InstancedBufferGeometry`;
  si no, cae a `InstancedMesh` (como RW) y acepta la memoria. **Decisión medida, documéntala.**
- **Material**: `MeshStandardNodeMaterial` con:
  - `positionNode` = todo el grafo de §6.2–6.6 (índice → celda → hash → posición → viento).
    Construirlo con `Fn(...)` leyendo `instanceIndex`, los uniforms (`uOrigin`, `uTime`, `uWind*`, y
    `heightNode`), y los atributos `position`/`uv`/`normal` de la brizna.
  - `normalNode` = `normalize(mix(facing, up, 0.6))` en espacio de mundo, luego a vista.
  - `colorNode` / `roughness` / `metalness=0` / `envMapIntensity=0.35` según §6.7.
  - `side: DoubleSide`, `shadowSide: FrontSide`, `castShadow=false`, `receiveShadow=true`.
  - `material.fogNode = fogNode` (Fase 1).
  - Capas: `mesh.layers.set(1)`.
- **`update(camPos, dt)`** (una vez por frame):
  ```ts
  uOrigin.value.set(
    Math.floor((camPos.x - R) / CELL) + 1e6,
    Math.floor((camPos.z - R) / CELL) + 1e6);
  ```
  (uniform compartido si se quiere; si no, local a la hierba). Es **lo único** por frame.
- Exponer en `__dbg.grass`: `{ count, R, cell, tier }` y un toggle `?grass=0`.

### T3.2.3 Detalles criptográficos (revisar contra §6)
- Índice de instancia (uint): `f = i/k; p = i%k; m = f%n; h = f/n; gx = uOrigin.x + m; gz = uOrigin.y + h;`
- Hash de celda uint32: `cell = (gx*73856093) ^ (gz*19349663) ^ ((p+1)*83492791)`.
- `pcg_hash` (función `hash` de three): `t = seed*747796405 + 2891336453; n = ((t >> ((t>>28)+4)) ^ t)*277803737; return float((n>>22)^n) / 2^32`.
  Usar el `hash` de TSL o replicarlo; los 11 valores `y(1..11) = pcg(cell + salt*7919)`.
- Densidad: `E = smoothstep(0.38, 0.62, w + (T-0.5)*0.35)` con `w = n01(S*0.06 + (13.1,4.4))`,
  `T = n01(S*0.28 + (1.7,9.9))`. Descartar si `y(3) >= E` → brizna de área 0 (multiplicar `oe`/`se` por 0).
- Fade radial: `1 - smoothstep(R*0.72, R*0.97, dist(S, camXZ))`.
- Claro de landmark: `1 - smoothstep(clearR-1.5, clearR, dist(S, landmark))` (en woods: el sitio de
  piedras por defecto en `(-35,-54)`, clear de hierba 0 → no hace falta, pero deja el hueco para la fase 4).
- Posición final (idéntica a §6.6, **no reinterpretar**):
  ```
  world = vec3(Sx + ue.x*px*se + ge.x*bw*oe,
               C  + py*oe*lf - 0.01,
               Sz + ue.y*px*se + ge.y*bw*oe)
  ```

### T3.2.4 Validación de `instanceIndex` en WebGPU (tarea previa obligatoria)
Antes de escribir el `positionNode`, hacer un spike: `InstancedBufferGeometry` + `Mesh` + un material cuyo
`positionNode` imprima `instanceIndex` como color → screenshot. Si el patrón **no** instancia (todos los
vértices con el mismo index 0) o el backend no soporta `instanceIndex` en `Mesh`, cambiar a
`InstancedMesh` como RW. Dejar el spike en `tools/spike-instance.ts` o documentar el resultado.

### T3.2.5 Medición de rendimiento
- `tools/bench.ts`: comparar `?grass=0` vs `?q=low|medium|high` con y sin, capturando ms/frame medio
  (mínimo sobre N frames). Objetivo: high (256k) < 8 ms de GPU en una GPU de escritorio de referencia;
  si no baja a `medium` automáticamente en equipos modestos.
- Registrar en `__dbg.grass` el conteo efectivo estimado (conteo × densidad media ≈ 0.5).

---

## 3.3 Criterios de aceptación

- [ ] `tools/spike-instance.ts` (o el doc) confirma cómo funciona `instanceIndex`; decisión registrada.
- [ ] `npm run typecheck` limpio.
- [ ] `__dbg.grass.count` == `n*n*k` del tier; `count` constante entre frames (solo cambia `uOrigin`).
- [ ] Ningún upload de `instanceMatrix`/`position` por frame (verificable: no hay `setMatrixAt` en el
      bucle; el buffer de instancias no se toca).
- [ ] Screenshot: hierba densa cubriendo el suelo cerca, afinando hacia el borde; sin anillo duro.
- [ ] Al caminar, la hierba bajo los pies se aplana (si añades pisado; ver T3.2.6) — opcional en v1.
- [ ] Bench: delta `?grass=0` vs activo registrado y publicable; medium fluido en portátil integrado.

### T3.2.6 (Opcional, mismo día) Pisado del jugador
- `shared.uPlayerPos`, `shared.uPlayerSpeed`; en el `positionNode`, si `dist(S, playerXZ) < reach` y
  `speed > umbral`, inclinar la brizna en dirección opuesta al movimiento y reducir altura (como el
  trample del proyecto horror). Multiplicador por `smoothstep`.

---

## Estado de implementación (Fase 3) — ✅ verificada por el orquestador

**Decisión S3a (spike, verificada en WebGPU real):** `instanceIndex` **funciona** con
`InstancedBufferGeometry` + `Mesh` (8/8 instancias con color y posición distintos; ver
`tools/spike-instance.ts` + `spike.html`). Se usa esa vía: **sin `InstancedMesh`** y sin los ~16 MB de
`instanceMatrix` identidad en high.

**Ficheros**: `src/world/bladeGeometry.ts`, `src/world/Grass.ts`, `tools/bench.ts`, integración en
`src/main.ts`.

**Decisiones**
- `n01(x)` no está definido en la referencia: se usa `mx_noise_float(vec3(x,0))*0.5+0.5` (documentado en
  `Grass.ts`).
- Nuevo uniform local `uCamXZ`: el fade radial `te` debe centrarse en la cámara, no en `uOrigin` (que
  solo cambia al cruzar la celda). Es el único añadido de contrato.
- `y(1..11)` con hash uint32 real (`uint`, `bitXor`, `hash` PCG); nunca hash float.
- `landNode(S)` = 1 (woods no tiene máscara de terreno); `uClear` ya respeta radio 0 → sin claro.
- Varyings `grassT/Le/Y10/Y11` para no reevaluar hash/Perlin por píxel en el fragment.
- `?grass=0` oculta la malla; `?wind=N` escala `WIND.strength` (uniform local).

**Evidencia**
- `npm run typecheck`/`build` limpios; `verify-height` OK.
- Conteos exactos: low 37 632 (R=28) · medium 153 600 (R=40) · high 256 000 (R=40); `attrs=[position,uv,normal]`.
- Probe de estabilidad (3 s, medium): `count`/`instanceCount` constantes, geometrías/texturas/draw calls
  estables, 0 errores.
- Capturas: `fase-3-grass-ground.png`, `fase-3-grass-close.png` (bases hundidas 1 cm, sin flotar),
  `fase-3-grass-fly.png`, `fase-3-grass-off.png`. Sin anillo duro.
- Bench (SwiftShader, mediana): delta grass on−off = +0.85 ms low, +3.30 ms medium, +6.30 ms high.
  **No representa una GPU real**; objetivo <8 ms high sin validar en hardware.

**Pendiente/deuda**
- T3.2.6 pisado del jugador (opcional) no implementado.
- `tools/bench.ts` mide en el harness headless (CPU); falta una pasada en GPU real en F7.

## 3.4 Notas / trampas
- **El mayor riesgo**: que `gl_InstanceID` / `instanceIndex` no funcione con `Mesh` + `InstancedBufferGeometry`
  en el backend WebGPU. Haz el spike (T3.2.4) PRIMERO.
- `hash` de uint en TSL:asegúrate de usar la versión `uint` (32 bits), no una de float, o el hash se degrada y
  el patrón de briznas se ve repetido/bandeado. Es el bug clásico.
- El desplazamiento `- 0.01` hunde la base 1 cm: sin él se ven "flotando".
- La corrección `lf = 1 - |ge|²*0.35` (no 0.5) es intencionada (rigidez visual); no la "corrijas".
- 11 evaluaciones de hash por **vértice** (no por brizna) → 9–15× el coste. Es lo que permite no usar
  atributos por instancia. A 256k briznas × 9 verts = 2.3M invocaciones de hash; es viable pero caro.
  Si va lento, baja `k` antes que la geometría.
- La hierba **no proyecta sombra** (`castShadow=false`) ni va en la cámara de sombras (capa 1).
- No apliques el AO `mix(0.60,1.0,...)` del proyecto horror encima: el `mix(0.38,1,uvY)` de RW ya oscurece
  la base. Se duplicaría el oscurecimiento.
