# Fase 4 — Árboles y props con streaming y pool de slots

**Objetivo**: bosque denso procedural con 3 LODs por especie, streaming por celdas que se reconstruye
solo cada 3 m, pool de slots sin asignaciones en runtime, y balanceo de viento.
**Depende de**: Fase 2 (altura) + Fase 1 (capas/sombra). **Bloquea**: cierre.
**Esfuerzo**: muy alto (la fase más larga).

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §7, §8.

---

## 4.1 Objetivo verificable

1. 4 especies de árbol (`fir`, `pine`, `firsap`, `sapling`) procedurales con 3 LODs cada una, y
   8 tipos de prop (los `shoreOnly` no se generan en `woods`).
2. El bosque aparece/desaparece al caminar sin pops visibles (la niebla a 185 m tapa el LOD2 a 175 m).
3. **Cero asignaciones en runtime**: tras el calentamiento, la memoria es plana durante 10 min de
   caminata y no hay `GC sawtooth`.
4. Sombras solo de LOD0/LOD1, en la capa 2; LOD2 sin sombra.
5. Colisionadores de tronco y de prop `solid` disponibles para el jugador (futuro).
6. Draw calls acotados (~especies × LOD × primitivas) y documentados.

---

## 4.2 Tareas

### T4.2.1 `src/world/treeGeometry.ts` — constructores procedurales con LOD
Construir, **por código**, las 4 especies con 3 LODs:
- `fir` (conífera alta, tronco recto, ramas en espiral), `pine` (tronco más grueso, copa alta),
  `firsap` / `sapling` (sotobosque, sin colisión fuerte).
- **LOD0**: detalle completo. **LOD1**: menos segmentos radiales, menos racimos de hoja.
  **LOD2**: silueta muy baja (impostor: 1 quad con silueta en atlas, o malla de <100 triángulos).
- Reutilizar/portar utilidades del proyecto horror (`/Users/edavg/www/test/horror/src/world/Vegetation.ts`):
  `mergeGeos()`, `taperedTube()` (Catmull-Rom + Frenet), `droopPlane()`, `displaceRadial()`. Son código
  propio, se pueden copiar/adaptar libremente.
- Normalizar cada variante: centrar en XZ, base en `y=0`, altura de referencia `h0 = max(1, bbox.maxY)`.
- Tabla de especies (§7 referencia) con `lodScale` por calidad.

### T4.2.2 `src/world/Scatter.ts` — motor de streaming compartido (árboles + props)
Clase base reutilizable:
```ts
class ScatterSystem<T> {
  update(camX: number, camZ: number): void;   // early-out si no se movió ≥3 m
  // species/grass/... registros
}
```
- **Hash**: `hash3(cellX, cellZ, salt)` idéntico a `rng.ts` (Fase 0) — el mismo `imul` avalanche.
- **Posición de celda**: `(cell + 0.12 + hash*0.76) * cellSize` (árboles) o `+0.1 + hash*0.8` (props).
- **Cadena de aceptación** (árboles, §7.2): probabilidad (`hash(1) > prob * treeScale * density(x,z,field)`
  → saltar) → `EB(x,z, field0?'tree':'low')` (landmarks) → `land < 0.6` → `roadDist < (field0 ? 6.2+hash*2.5 : 4.4)`
  → `shape && normal.y < 0.82` → `field0 && speciesPick != idx`. Luego distancia, LOD, cap, variante.
- **densidad**: `field0: smoothstep(noise(x*0.55+311, z*0.55+97), 0.30, 0.55)`;
  `field1: smoothstep(noise(x*1.1+311, z*1.1+97), 0.38, 0.70)`.
- **speciesPick**: `+(noise(x*0.35+47, z*0.35+5) > 0.5)` (reparte fir/pine).
- **Pool de slots** por (variante, LOD, primitiva):
  - `slots: (number|null)[]`, `slotOf: Map<number, number>` (clave numérica), `used: Set<number>`.
  - Liberar: claves no aceptadas → borrar slot.
  - Asignar: slot existente, o `free.pop()` (free-list, O(1), **mejor que `indexOf(null)` de RW**), o push.
  - Escribir la matriz **directamente** en `mesh.instanceMatrix.array` con un compose inline
    (sin `new Matrix4()`, sin `.clone()`).
  - Huecos → matriz degenerada `scale(0.001) pos(0,-500,0)`. Podar nulos finales.
  - `count = slots.length`; un `instanceMatrix.needsUpdate = true` por pool.
- **Colisionadores**: `trunks[]` y `blockers[]` reutilizables (`length = 0` cada escaneo).
  - Árbol: `trunkR>0 && dist<40` → `{x, z, r: trunkR*escala}`.
  - Prop `solid` (<36 m): cadena elíptica→círculos (§8 referencia).
- **Landmarks / EB**: implementar `vB = {cabin:{tree:14,low:8,grass:4.5}, stones:{tree:22,low:12,grass:0}}`,
  sitio por defecto `(-35,-54, stones)`, retícula de 320 m con 20 % de ocupación determinista.

### T4.2.3 `src/world/Trees.ts`
- Construir en `load()`: por especie × variante × LOD × primitiva (tronco / follaje) un `InstancedMesh`
  con capacidad `cap[lod]`. Nada se crea después.
- `material()` por primitiva: si es follaje (nombre/flag) → balanceo con 2 octavas extra + `alphaTest`
  + `DoubleSide`; si es tronco → balanceo suave, sin alpha. Aplicar `sway` como `positionNode` (Fase 1 fog,
  `lights: true`). Escribir también `positionPrevious` con `t - dt` para TAA.
- `layers.set(2)` + `castShadow` solo en LOD0/LOD1; LOD2 en capa 0 sin sombra.
- Actualizar con `scatter.update(camX, camZ)`.

### T4.2.4 `src/world/Props.ts` + `propsGeometry.ts`
- 8 props procedurales: `fern`, `grass_medium`, `shrub`, `rock_moss_set_01/02`, `tree_stump`,
  `dead_tree_trunk`, `dry_branches`. Variantes (2–4) por tipo.
- Tabla §8: `cell/prob/radius/cap/scale/align/sink/foliage/patch/solid`.
- `patch` agrupa con ruido; `align` inclina según normal; `sink` entierra/alza; rocas escalan
  `lerp(0.55,1, distRoad)` y drops de variantes "upright".
- `rScale = QUALITY[quality].props`.
- `frustumCulled=false`, `castShadow = solid`, `receiveShadow=true`, `userData.perfGroup='Scatter'`.

### T4.2.5 Colisión expuesta
`world.getBlockers(): { trunks, props }` (o un unificado) para que la futura fase de jugador los use.
También exponer un `debug` que dibuje los círculos en `__dbg`.

### T4.2.6 Rendimiento y memoria
- `tools/mem-probe.ts`: `performance.memory` (si existe) o `renderer.info.memory` antes/después de
  10 min de caminata simulada. Debe ser **plano** (sin crecimiento).
- Objetivo draw calls en high: ~90 (árboles) + ~46 (props) + 1 (terreno) + 1 (césped) + domo.

---

## 4.3 Criterios de aceptación

- [ ] `npm run typecheck` limpio.
- [ ] 4 especies visibles con silueta distinta; 3 LODs discernibles al acercarse (silueta consistente).
- [ ] Caminar/correr 500 m: sin pops dentro de la niebla; sin crecimiento de memoria.
- [ ] `?trees=0` / `?props=0` toggles para A/B (añadir params).
- [ ] Sombras: cerca los árboles proyectan sombra; a >175 m (LOD2) no.
- [ ] `__dbg.scatter` expone conteos por especie/LOD, y `__dbg.blockers` la lista de colisión.
- [ ] Screenshot a nivel de suelo en el bosque: se ve densidad, profundidad y niebla; nada "flota".

---

## Estado de implementación (Fase 4) — ✅ verificada por el orquestador

**Ficheros**: `src/world/geometryUtils.ts` (contrato orquestador: `mergeGeos`, `taperedTube`,
`droopPlane`, `displaceRadial`, `scaledIcosa`, `fitToBase`), `src/world/treeGeometry.ts`,
`src/world/Trees.ts`, `src/world/propsGeometry.ts`, `src/world/Props.ts`, `tools/mem-probe.ts`,
`src/world/Scatter.ts` (motor), `src/main.ts` (integración) y artículos temporales de verificación
(`tools/spike-instance.ts`, `props-check.*` borrado).

**Decisiones**
- Motor `Scatter`: claves numéricas 53-bit, free-list, `Uint32Array` de sellos por escaneo, compose
  inline en `instanceMatrix.array`, colisionadores high-water. Cadena de aceptación §7.2 literal;
  `normal.y<0.82` se aplica siempre (documentado). `land≡1`, `roadDist≡∞`, `speciesPick` por `noise` a 64 m.
- Árboles: LOD2 = impostor de silueta sólida (<100 tris: fir 75, pine 18, firsap 75, sapling 30); sway §7.4
  con `positionPrevious` (uniform `uPrevTime` copiado antes de que Environment avance `uTime`); LOD0/1 en
  capa 2 con sombra, LOD2 capa 0 sin sombra.
- Props: LOD único (`lodDist=[r,r,r]`, `cap=[cap,0,0]`), patch vía `density`, align vía `orient` con
  `heightfield.normal(...,1.0)`, `solidRadius` por bbox. Rocas musgosas sin factor `distRoad` (no hay
  caminos en woods; hook documentado).
- `?trees=0` / `?props=0` desactivan capas. `window.__nightwoodsWorld = { trunks, blockers }` (T4.2.5,
  arrays vivos reutilizados por el motor).

**Evidencia**
- `npm run typecheck`/`build` limpios; `verify-height`/`verify-fog` OK.
- Conteos (high, vuelo): 12 capas, 99 pools, 226–315 vivos; LOD [19, 66, 224]/[20,54,241];
  `__dbg.blockers` 9; checksum determinista 2 cargas.
- **mem-probe** (`?q=low&fly=1`, 10+10 s): heap retenido **+23.16 KB** tras GC, 0 GC en ventana,
  heap muestreado plano; 223 geometrías, 8 texturas.
- Capturas: `fase-4-forest.png`, `fase-4-forest-fly.png`, `fase-4-forest-noprops.png`, `fase-4-landmark.png`,
  `fase-4-trees-*.png`, `fase-4-props-check.png`.
- Draw calls de árboles: 75 pools (60 con sombra) + 24 de props (tier único).

**Pendiente/deuda**
- `positionPrevious` no se consume hasta F6 (velocity MRT); validar ghosting ahí.
- Densidad percibida en `low` baja (treeScale .62); revisar en calibración de F6/F7.

## 4.4 Notas / trampas
- **La asignación en runtime es la trampa principal**: el código de RW crea `{L, key, m: m.clone()}` por
  árbol placement y strings de clave. Usa claves **numéricas** (`(species<<20)|(cellZ<<10)|cellX` o
  `hashCombine`) y un buffer SoA preasignado para los pendientes. Objetivo: 0 GC por escaneo.
- El early-out de 3 m es lo que hace aceptable el coste; pero a `?fly=1` (volar rápido) puede haber tirones.
  Considera limitar el número de celdas procesadas por frame si vuela muy rápido.
- `speciesPick` reparte fir/pine por hemisferios de ruido: se ven dos "biomas" con dominancia distinta. Es
  intencional (más variedad). Si se ve demasiado abrupto, suaviza el ruido (no lo quites).
- Los **capa 2** es obligatorio para que la cámara de sombras vea solo LOD0/1 y no el césped/lluvia.
- El LOD2 (impostor) es tu seguro contra el popping a 175 m: la niebla a 185 m lo cubre casi siempre.
  Si se nota popping en los bordes, sube la niebla o empuja LOD2 a 165 m.
- **No copies assets** (GLTF/texturas) de Rainy Worlds: son copyright. Solo el algoritmo y las constantes.
