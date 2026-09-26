# Fase 2 — Campo de altura y terreno en streaming

**Objetivo**: un suelo infinito con relieve suave, 121 tiles reciclados, costuras invisibles, y una
fuente de altura (`heightAt` en JS + `heightNode` en TSL) que consumirán césped, lluvia y props.
**Depende de**: Fase 1. **Bloquea**: 3, 4, 5.
**Esfuerzo**: medio-alto.

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §5.

---

## 2.1 Objetivo verificable

1. Al mover la cámara por el mundo, el terreno se recycle sin costuras ni popping.
2. El relieve coincide con la fórmula: ±6.5 m a periodo 384 m + ±0.55 m a periodo 47 m rotado.
3. El terreno recibe la sombra lunar sin artefactos.
4. La niebla oculta siempre el borde del anillo de tiles (185 m niebla vs ~176 m de semiextensión de tile).
5. `heightAt(x,z)` en JS **coincide** con `heightNode` en el shader (validar con un test numérico).

---

## 2.2 Tareas

### T2.2.1 `src/assets/noise.ts` — horneado del LUT de altura
- Generar **512×512** `Float32Array` (262 144 muestras) de ruido de valor, 5 octavas:
  - frecuencias `l = 3, 6, 12, 24, 48` (ciclos por textura), amplitudes `1, .5, .25, .125, .0625`,
    semilla por octava `11 + i*7`, fade quíntico `t³(t(6t−15)+10)`.
  - `hash` de valor con wrap `(x%n + n)%n` (patrón de `jV` de §5 referencia).
- Normalizar min/max a `[0,1]`, convertir a **half-float** (`THREE.DataUtils.toHalfFloat`), empaquetar en
  `Uint16Array`.
- `DataTexture(data, 512, 512, RedFormat, HalfFloatType)` con `magFilter: LinearFilter`,
  `minFilter: LinearMipmapLinearFilter`, `wrapS/wrapT: RepeatWrapping`, `generateMipmaps: true`.
- **Clave**: el wrap (Repeat) es lo que hace el terreno infinito sin costuras. No lo quites.
- Exportar la `DataTexture` **y** el `Float32Array` original (para muestreo exacto en JS).

### T2.2.2 `src/world/Heightfield.ts` — la fuente de verdad
```ts
export interface HeightfieldEx {
  height(x: number, z: number): number;
  normal(x: number, z: number, out: THREE.Vector3, eps?: number): THREE.Vector3;
  noise(x: number, z: number): number;        // muestreo a 64 m, para densidad de árbol/prop
  heightNode: TSLNode;                        // (vec2) => float, para shaders
  raw(x: number, z: number): number;
  texture: THREE.DataTexture;
}
```
- `raw(x,z)`: las **dos** octavas de §5.1, con la rotación 0.62 rad y el offset `(0.37, 0.11)`:
  ```ts
  const OV = Math.cos(0.62), kV = Math.sin(0.62);
  const a = (sample(x/384, z/384) - 0.5) * 2 * 6.5;
  const r = x*OV - z*kV, i = x*kV + z*OV;
  const b = (sample(r/47 + 0.37, i/47 + 0.11) - 0.5) * 2 * 0.55;
  return a + b;
  ```
- `height(x,z) = raw(x,z)` (en `woods` no hay shape subclass; solo las dos octavas).
- `normal(x,z,out,eps=0.4)`: diferencias finitas centradas → `normalize(vec3(h(x-e)-h(x+e), 2e, h(z-e)-h(z+e)))`.
- `heightNode`: nodo TSL que hace el **mismo** muestreo bilinear con wrap. Opciones:
  - (preferida) `texture(tHeight, uv)` con `uv = (x/384, z/384)` y `texture(tHeight, uv2)` para la 2ª octava,
    combinando con los mismos pesos/amplitudes. El sampler `RepeatWrapping` + Linear da el wrap gratis.
  - Reutilizar `mx_noise_float` en shader **no** es equivalente al LUT horneado (el LUT es el mismo
    valor de ruido que JS, y son crucialmente consistentes). Usa la textura.
- **Test de consistencia** (obligatorio): `tools/verify-height.mjs` que evalúe `height()` en 2000 puntos
  aleatorios y los compara contra una lectura equivalente de la `DataTexture` en CPU; assert |diff| < 1e-3.

### T2.2.3 `src/world/Terrain.ts` — pool de tiles
```ts
export function createTerrain(scene, heightfield, material, quality): TerrainEx
```
- `PlaneGeometry(32, 32, 32, 32)` rotado `-PI/2`, **una geometría por tile** (121 en woods), un material compartido.
- `update(cx, cz)`:
  - `tile = Math.floor(x/32)`; si `(tileX,tileZ)` no cambió, `return` (early-out barato).
  - Construir el conjunto deseado de celdas `GRID×GRID` centradas en el tile actual.
  - Calcular `missing` (deseadas no asignadas) y `freed` (asignadas no deseadas); emparejar 1:1.
  - Para cada par, reconstruir el mesh: reescribir `position.y` y `normal` de cada vértice desde
    `heightfield`, `position.set(tileX*32+16, 0, tileZ*32+16)`, `computeBoundingSphere()` con
    `radius = max(r*1.05, 31.04)`.
- `receiveShadow = true`, `castShadow = false`, `frustumCulled` gestionado por el bounding sphere.
- Devolver `{ group, update, dispose, tileCount }`.

### T2.2.4 Material de suelo (TSL, procedural — sin texturas externas)
`MeshStandardNodeMaterial` con nodos custom:
- **Splat de 4 capas con UVs de mundo independientes** (RW usa 4 tríos diff/nor/arm; aquí se generan
  proceduralmente). Escala/offset por capa (réf §5 referencia, terreno `qV`):
  - `forrest_ground_03`: `xz / 2.4`
  - `brown_mud_leaves_01`: `xz / 3.1 + (0.31, 0.77)`
  - `aerial_grass_rock`: `xz / 4.2 + (0.5, 0.1)`
  - `forest_leaves_04`: `(z,x) / 2.8 + (0.13, 0.62)`
  - Como no hay archivos, **generar 4 "tripletes" procedurales** en `src/assets/textures.ts`: para cada
    capa, un color base + un mapa de normales derivado de fbm + (roughness/AO constantes). Puedes
    reusar generadores de ruido del proyecto horror (`src/assets/textures.ts`) o escribir los tuyos.
    **Alternativa más simple y fiel al look RW:** usar la rampa de color por capa (3 stops) y perturbar
    con fbm de alta frecuencia — sin triplete de textura. Elige una y documéntala.
- **Pesos de mezcla** con ruido: 4 máscaras `smoothstep` a frecuencias `0.043 / 0.19 / 0.075 / 0.11`
  ciclos/m con offsets `(3.1,7.7)/(9.2,1.4)/(41.3,15.2)/(23.3,61.2)`, composición alfa secuencial
  (como `te()` en RW).
- **Modulación macro**: `× mix(0.7,1.1, noise(xz*0.35))` y `× mix(0.75,1, noise(xz*0.02))`.
- **Wetness** (importante de noche): oscurecer según `smoothstep` del `normal.y` y de la altura del agua
  relativa; bajar `roughness` a ~0.03 en zonas mojadas (RW: `roughness→0.03` cuando wet). Usar
  `smoothstep(0.02,0.003, 1-normalY)` y un factor de "lluvia" global.
- `metalness = 0`, `aoNode` desde la máscara de AO, `envMapIntensity ~0.75`.
- Conectar `material.fogNode = fogNode` (Fase 1).

### T2.2.5 Integración y navegación de prueba
- Añadir `terrain` + `heightfield` a la escena en `main.ts`; `terrain.update(camX, camZ)` cada frame
  (o cuando cruce 32 m).
- **Cámara de vuelo libre temporal** para inspeccionar el terreno en dev (o mover el "walker" stub de la
  Fase 0 con WASD). Añadir un modo `?fly=1` que suba la cámara a 40 m y permita volar con WASD + ratón.
  Se mantiene en dev, no afecta release.

---

## 2.3 Criterios de aceptación

- [ ] `tools/verify-height.mjs` pasa: JS vs textura, |diff| < 1e-3 en 2000 puntos.
- [ ] `npm run typecheck` limpio.
- [ ] Volando en círculo 360° a 60 m de altura: **ninguna costura** visible (el material es world-space).
- [ ] Avance recto 500 m: los tiles se recyclan sin crudos `console` ni hitch perceptible (< 16 ms/frame).
- [ ] `__dbg.tiles` muestra 121 activos; `__dbg.terrainTriangles` ≈ 121 × 2048.
- [ ] Captura a ras de suelo: el terreno tiene relieve y recibe sombras lunares sin banding.

---

## 2.4 Notas / trampas
- El **early-out por tile de 32 m** es lo que hace barato el streaming. No lo quites.
- El bounding sphere `max(r*1.05, 31.04)` es un parche de RW: sin él, tiles cuyo relieve "cava" por debajo
  del origen pueden cullse. Replícalo.
- `PlaneGeometry` con `rotateX` — la UV del plano no se usa (material world-space). No te confundas.
- La 2ª octana (47 m, rotada) es la que da el microrrelieve visible; sin ella el suelo parece goma.
- `heightAt` se llama porCesped/lluvia en el **vertex shader** (vía `heightNode`); el coste de esa lectura
  de textura por vértice importa (1 muestra, es barato, pero no añadas más).
- Coherencia JS/shader es **crítica**: si divergen, el césped flotará o se hundirá. El test de T2.2.2 lo
  atrapa.
