# Referencia técnica — Rainy Worlds "Exploring Woods" (nocturno)

> Fuente: ingeniería inversa del bundle de producción `https://rainyworlds.com/assets/index-Cn6kC2PA.js`
> (three.js **WebGPURenderer + TSL**). Todos los valores de este documento están **verificados contra el
> código minificado** y son la especificación que deben replicar las fases 0–7.
>
> Decisiones del proyecto: **WebGPU + TSL**, **proyecto nuevo desde 0**, **assets 100 % procedurales**,
> alcance v1 = **solo el mundo** (sin gameplay).

---

## 0. Leyenda de identificadores TSL (minificado → real)

Al decodificar el bundle, estos alias corresponden a la API de nodos de three.js. Sirve para leer el
código original y para saber qué nodo TSL usar al portar.

| Minificado | TSL real | Nota |
|---|---|---|
| `X` | `mix` | |
| `Y` | `float` | |
| `Z` | `smoothstep` | |
| `Q` | `vec2` | |
| `$` | `vec3` | |
| `XF` | `abs` | |
| `CI` | `length` | |
| `uI` | `dot` | |
| `aI` | `cross` | |
| `zI` | `normalize` | |
| `nI` | `clamp` | |
| `DI` | `max` | |
| `OI` | `min` | |
| `iI` | `cos` | |
| `sL` | `sin` | |
| `hI` | `fract` | **no es floor** |
| `nL` | `round` | |
| `dI` | `exp` | |
| `YI` | `pow` | |
| `MI` | `mx_fractal_noise_float` | (p, octaves, lacunarity, diminish) |
| `NI` | `mx_noise_float` | devuelve ~[-1,1] |
| `dL` | `texture` | |
| `tB` | carga de textura por ruta | |
| `GF` | `Fn(() => …)` | |
| `hL` | `transformNormalToView` | |
| `yL` | `uv` | |
| `yI` | `hash` | PCG |
| `gL` | `uint` | |
| `bI` | `instanceIndex` | `gl_InstanceID` |
| `mL` | `time` | **es el tiempo, no el viento** |
| `cI` | `deltaTime` | |
| `GI` | `positionGeometry` | |
| `KI` | `positionLocal` | |
| `qI` | `positionPrevious` | |
| `JI` | `positionWorld` | |
| `tI` | `cameraPosition` | |
| `_L` | `uniform` | |
| `mI` | `fog(color, factor)` | nodo de niebla propio (no `scene.fog`) |
| `qL` | `TRAANode` | |
| `BL` | `TAAUNode` | |
| `NL` | `GTAONode` | |
| `tR` | `BloomNode` | |
| `aR` | `motionBlur()` | |
| `iR` | `ChromaticAberrationNode` | |
| `nR` | `FilmNode` (grano) | |
| `uR` | `SharpenNode` | |
| `tL` | `renderOutput` | tonemap + espacio de color |
| `AI`/`BI`/`LI`/`SL` | `mrt`/`output`/`normalView`/`velocity` | |
| `eL` | `reflector({target, resolutionScale})` | |
| `HS` | `MeshStandardNodeMaterial` | |
| `Ab` | `MeshBasicNodeMaterial` | |
| `WS` | `MeshPhysicalNodeMaterial` | |
| `na` | `InstancedMesh` | |
| `ri` | `BufferGeometry` | |
| `Gr` | `Float32BufferAttribute` | |
| `Vr` | `BufferAttribute` | |
| `YR` | `GLTFLoader` | |

Clases del juego: `ER`=render core · `NR`=caminante · `PV`=campo de altura · `GV`=tiles de terreno ·
`QV`=césped · `oH`=árboles · `pH`=props · `YV`=luz/cielo/entorno · `hH`=lluvia · `gH`=rayos ·
`JV`=agua · `XH`=cargador · `qH`=reproductor de canción.

---

## 1. Cámara y perspectiva

```ts
camera = new THREE.PerspectiveCamera(62, innerWidth/innerHeight, 0.08, 520);
camera.layers.enable(1);
camera.layers.enable(2);
```

- FOV 62 vertical, near 0.08, far 520. Sin `antialias` (el AA va en post).
- `pass` (alpine) sobrescribe `far = 4200`; `drive` fov 72; `canyon` fov 78. Para `woods` no hay override.
- **Rig anidado** (la cámara nunca recibe transformada directa):
  `yawGroup (rotation.y) → pitchGroup (position.y = 1.70, rotation.x) → camera (rotation.z solo)`
- Pitch clamp ±1.45 rad. Sin FOV kick, sin shake de cámara en el caminante.
- `eye = 1.70 m`, radio de colisión jugador `0.32 m`.

Movimiento (para referencia futura de gameplay, fuera del alcance v1):
- `speed = {walk: 1.75, run: 3.9}` m/s; run = Shift, sin stamina.
- Aceleración: `vel.lerp(wish, 1 - exp(-9*dt))` (exponencial pura, 9/s).
- Snap al suelo: `groundY += (target - groundY) * min(1, dt*14)`.
- Colisión: push-out de círculos (`trunkR*escala + 0.32`); deslizamiento eje a eje con predicado `walkable`.
- Ratón: `0.0019 rad/px`; táctil `×1.8`.
- Bob: fase `6 + 5.5u` rad/s, vertical `sin(2φ)*0.02*amp*(0.5+0.9u)`, roll `sin(φ)*0.005*amp`,
  respiración `sin(t*1.25)*0.004`. Pasos por distancia acumulada 0.8 m (walk) / 1.35 m (run).

---

## 2. Luz (nocturna)

### 2.1 Sol/luna
```ts
const sun = new THREE.DirectionalLight(new THREE.Color(0.55, 0.65, 0.90), 0.14); // NIGHT
// DAY:   (0.84,0.88,0.97) × 1.15     STORM: (0.90,0.86,0.78) × 0.95
sun.castShadow = true;
const SUN_OFF = new THREE.Vector3(38, 78, 26);   // |v|≈90.6, elevación 59.4°, azimut 55.6°
```
- El color es **lineal** (working space). La luna vive en la misma dirección que el sol.

### 2.2 Sombra + snap a texel (CRÍTICO — mata el shimmer)
```ts
sun.shadow.mapSize.set(2048|1536|1024);
sun.shadow.camera.left = sun.shadow.camera.right = 42;   // shadowR = 42 (±42)
sun.shadow.camera.top = sun.shadow.camera.bottom = 42;
sun.shadow.camera.near = 4; sun.shadow.camera.far = 220;
sun.shadow.bias = -6e-4; sun.shadow.normalBias = 0.08; sun.shadow.radius = 4;
// renderer.shadowMap.type = PCFSoftShadowMap (2)

const lightRot    = new THREE.Matrix4().lookAt(SUN_OFF, ORIGIN, Y_UP);
const lightRotInv = lightRot.clone().invert();

function updateShadow(focus: Vector3) {
  const texel = (2 * 42) / sun.shadow.mapSize.width;
  const anchor = focus.clone();
  anchor.applyMatrix4(lightRotInv);
  anchor.x = Math.round(anchor.x / texel) * texel;   // redondea X e Y al grid de téxeles
  anchor.y = Math.round(anchor.y / texel) * texel;
  anchor.applyMatrix4(lightRot);
  sun.position.copy(anchor).add(SUN_OFF);
  sun.target.position.copy(anchor);
  sun.target.updateMatrixWorld();
}
```
- Solo se redondea x/y (la profundidad no importa en proyección ortográfica).
- `focus` = posición del jugador (o cámara). Se llama cada frame.

### 2.3 Capas (trampa conocida del renderer de sombras WebGPU)
- `sun.shadow.camera.layers.enable(2)` — **imprescindible**: sin esto el renderer copia la máscara de la
  cámara principal (que incluye capas 1/2) y el césped/lluvia proyectarían sombra.
- Árboles LOD0/LOD1 → `layers.set(2)` + `castShadow = true`. LOD2 → capa 0, sin sombra.
- Césped/lluvia → `layers.set(1)` (excluidos de reflejos).

### 2.4 Hemisférica y entorno (IBL)
```ts
const hemi = new THREE.HemisphereLight(
  new THREE.Color(0.55, 0.60, 0.70),
  new THREE.Color(0.12, 0.11, 0.09),
  0.04);                              // NIGHT (día/tormenta: 0.18)
scene.environmentIntensity = 0.06;    // NIGHT (tormenta 0.42, día 0.55)
scene.background = null;              // el domo dibuja el cielo
```
- RW usa `/assets/hdri/belfast_open_field_1k.hdr` (EquirectangularReflectionMapping=303).
  **Nosotros lo generamos proceduralmente** (equirect nocturno → PMREM) para evitar copyright.

### 2.5 Racha (gust) y referencias de niebla
```ts
// cada frame:
KB.value += (playerY - KB.value) * min(1, dt*2);       // ref. de altura de niebla
gustTimer -= dt;
if (gustTimer <= 0) { gustTimer = 3 + rand*7; gustTarget = 0.15 + rand*0.85; }
gust.value += (gustTarget - gust.value) * min(1, dt*0.35);
```

---

## 3. Cielo (domo) — TSL

- `SphereGeometry(470, 48, 24)`, escala 1, `BackSide`, `depthWrite:false`, `fog:false`,
  `renderOrder = -10`, `frustumCulled:false`, sigue a la cámara cada frame.
- `w = normalize(positionLocal)`, `T = clamp(w.y, -0.05, 1)`.

```ts
const horizon = NIGHT ? vec3(0.010,0.012,0.018) : vec3(0.27,0.30,0.35);
const zenith  = NIGHT ? vec3(0.028,0.032,0.042) : vec3(0.45,0.48,0.52);
let D = mix(zenith, horizon, pow(max(T,0), 0.5));

// nubes (2 capas fbm, uv proyectada en el plano, scroll con el tiempo)
const ee = w.xz / (max(w.y, 0.06) + 0.08);
const t  = time * 0.006;
const O  = mx_fractal_noise_float(vec3(ee*0.55 + vec2(t, t*0.5), time*0.004), 4, 2.1, 0.55);
const ne = mx_fractal_noise_float(vec3(ee*1.7  + vec2(t*1.8, 3.3), 7.1),        3, 2.0, 0.5);
D *= (1 + (O*0.3 + ne*0.09));
D *= mix(1, 0.7, smoothstep(0.05, 0.30, O));

// disco + halo lunar (solo night)
if (NIGHT) {
  const e = max(dot(w, normalize(SUN_OFF)), 0);
  D += vec3(0.5,0.58,0.75) * (pow(e,60)*0.12 + pow(e,8)*0.03)
       * mix(1.2, 0.5, smoothstep(0, 0.30, O));
}

// calima de horizonte
D = mix(VB * (smoothstep(-0.12, 0.45, w.y)*0.5 + 0.85), D, smoothstep(-0.03, 0.22, w.y));

// destello de rayo
D += flash * mix(0.45, 1.5, smoothstep(-0.4, 1, dot(normalize(w.xz), JB)))
     * vec3(1.1,1.15,1.3) * ((1 - smoothstep(0.35, 0.9, w.y))*0.7 + 0.3);
```

---

## 4. Niebla (nodo TSL propio, no `scene.fog`)

```ts
// Globales: VB=color(.3,.34,.4) [noche:(.02,.023,.032)], zB=densidad, BB=(120,185), KB=ref altura
const d  = positionWorld - cameraPosition;
const f  = length(d);
const p  = d.y / max(f, 0.001);

const h = 1 - exp(-f * zB);                                       //ulineal
const g = clamp(exp(-0.9*(positionWorld.y - KB)), 0, 1)
        * (1 - smoothstep(200, 600, f));                          // alto cerca, se apaga a 200–600 m
const w = 1 - smoothstep(KB-220, KB-60, positionWorld.y);         // bajo el agua
const v = 1 - exp(-f * zB * (g*0.45 + w*0.9));                   //altura
const y = smoothstep(BB.x, BB.y, f);                              //suelo de distancia
const factor = clamp(max(1 - (1-h)*(1-v), y), 0, 1);             // dos Beer–Lambert combinados

let color = VB * (smoothstep(-0.12, 0.45, p)*0.5 + 0.85);
color *= (flash * 2.2 + 1);
fogNode = fog(color, factor);
```
- Densidad base `zB = 0.0062`; por escena: woods ×1.0 (`.0062`), drive ×1.3 (`.00806`), etc.
- Niebla **satura exactamente a 185 m** (coincide con el borde del anillo de tiles de 32 m: 11×11).

---

## 5. Campo de altura (LUT) y terreno en streaming

### 5.1 LUT de altura (una sola fuente de verdad, JS + TSL)
- Se hornea **512×512** `Float32` → normaliza min/max → `DataTexture` **half-float**, `RedFormat`,
  `LinearFilter`, `LinearMipmapLinearFilter`, `RepeatWrapping`, mipmaps.
- Ruido de **valor**, 5 octavas, frecuencias `l = 3,6,12,24,48` (ciclos por textura),
  amps `1, .5, .25, .125, .0625`, fade quíntico `t³(t(6t−15)+10)`, semilla por octava `11 + i*7`.
- Hash espacial: `jV(x,y,n) = imul(374761393*x + 668265263*y + 1274126177*n)`.
- Muestreo bilineal con wrap (permite terreno infinito).

Dos octavas de **forma** (metros, período):
```
raw(x,z) = (N(x/384, z/384) − 0.5)·2·6.5                         // periodo 384 m, ±6.5 m
         + (N(R(x,z)/47 + (0.37,0.11)) − 0.5)·2·0.55             // periodo 47 m, ±0.55 m
R(x,z)   = (x·cos0.62 − z·sin0.62,  x·sin0.62 + z·cos0.62)       // rotado 0.62 rad
```
- `height(x,z) = raw`; `normal(x,z)` por diferencias finitas (ε≈0.4 JS, ε=1.0 al construir tiles);
  `noise(x,z) = N(x/64, z/64)` (usado para densidad de árboles/props).
- Versión TSL: mismo muestreo como nodo de textura (`heightNode(vec2)`), leída en shaders de
  césped/lluvia.

### 5.2 Tiles de terreno (pool en anillo)
- `PlaneGeometry(32, 32, 32, 32)` rotado plano → 1089 verts, 2048 tris. **Un material compartido**.
- `GRID = 11` (woods) → 121 tiles. `GRID = 15` (playas) → 225 tiles.
- `update(cx,cz)`: `tile = floor(x/32)`; si no cambia, return. Construye el conjunto deseado de
  `GRID×GRID` celdas,Calcula tiles faltantes y tiles liberados, los empareja 1:1, y **reconstruye**
  (reescribe `position.y` + `normal` por diferencias finitas). bounding sphere
  `radius = max(r*1.05, 31.04)`.
- `receiveShadow = true`, `castShadow = false`. Semilla 0 por tile (no usan uv de geometría; el
  material es 100 % world-space → sin costuras).

---

## 6. Césped (sistema estrella)

### 6.1 Rejilla y conteos
```ts
const XV = 0.5;                                              // tamaño de celda (m)
const ZV = { low:{n:112,k:3}, medium:{n:160,k:6}, high:{n:160,k:10} };
// instancias = n*n*k ; radio = n*XV/2
// low:  37 632(raw) → ~18.8k visibles   R=28 m
// med: 153 600      → ~76.8k            R=40 m
// high:256 000      → ~128k             R=40 m
```
- **Un solo `InstancedMesh`** para todo el mundo. `instanceMatrix` se deja identidad (nunca se escribe);
  la posición se deriva en el vertex shader. `frustumCulled=false`, `castShadow=false`,
  `receiveShadow=true`, `layers.set(1)`, `side=DoubleSide`, `shadowSide=FrontSide`.
- Por frame: `mesh.count = n*n*k` constante; solo se escribe `uOrigin` (un Vector2).

### 6.2 Índice de instancia → celda (en el shader)
```
i = gl_InstanceID
f = i / k ; p = i % k ; m = f % n ; h = f / n        // p = slot de brizna en la celda
gx = uint(uOrigin.x) + m ;  gz = uint(uOrigin.y) + h
cell = (gx*73856093) ^ (gz*19349663) ^ ((p+1)*83492791)   // uint32
y(salt) = float(pcg_hash(cell + uint(salt*7919)))          // salt 1..11
worldX = (float(gx) - 1e6)*XV + y(1)*XV
worldZ = (float(gz) - 1e6)*XV + y(2)*XV
C      = heightNode(worldX, worldZ)
```
- `pcg_hash` (three `hash`): `t = seed*747796405 + 2891336453; n = ((t >> ((t>>28)+4)) ^ t)*277803737; return float((n>>22)^n)/2^32`.
- `uOrigin` (por frame): `floor((cam - R)/XV) + 1e6` en X y Z.

### 6.3 Densidad y culling (multiplican altura y ancho → punto degenerado)
```
w  = n01(S*0.06 + (13.1,4.4))
T  = n01(S*0.28 + (1.7,9.9))
E  = smoothstep(0.38, 0.62, w + (T-0.5)*0.35)      // ~50% se conserva
te = 1 - smoothstep(R*0.72, R*0.97, |S - camXZ|)    // fade radial centrado en cámara
O  = smoothstep(clearR-1.5, clearR, |S - clearXZ|)  // claro alrededor de landmarks
ie = (y(3) < E) ? 1 : 0  *  te * O * landNode(S)
```
- Las briznas descartadas son triángulos de área 0 (no `discard`).

### 6.4 Geometría de brizna (`eH()`) — 9 verts, 7 tris, indexada
```
para row n=0..4:  r = n/4 ; i = n===4 ? 0 : 1 - r*0.55
  n===4: pos(0,1,0)              uv(0.5,1)
  otro : pos(-i,r,0),(i,r,0)     uv(0,r),(1,r)
indices: [0,1,2, 1,3,2, 2,3,4, 3,5,4, 4,5,6, 5,7,6, 6,7,8]
normals: (0,0,1) en todos (se sobrescribe con normalNode)
```
Trigo opcional (`$V()`): perfil 7 puntos, 15 verts, 13 tris, la "espiga" ensancha a x=±2.4/±2.6.

### 6.5 Aleatoriedad por brizna
```
oe = mix(0.22, 0.62, y(4)) * mix(0.7, 1.0, w)   // altura (m)  ×ie
se = mix(0.011, 0.020, y(5))                      // semianchura (m) ×ie
ce = y(6) * 6.2832 ; le = vec2(cos ce, sin ce) ; ue = vec2(-le.y, le.x)
de = mix(0.12, 0.42, y(7))                        // doblez estático
```

### 6.6 Viento (idéntico al de RW)
```
fe = n01(S*0.018 - HB*(t*0.11))*0.7 + 0.3 ;  fe *= (gust*0.6 + 0.4)
pe = sin(t*1.9 + worldX*0.7 + worldZ*0.5 + y(8)*6.28) * 0.06
me = sin(t*11 + y(9)*60) * 0.002
he = (fe*0.3 + pe + me) * wind * 1.3            // (trigo ×2.4)
ge = le*de + HB*he                              // vector de doblez
bw = (position.y)^2                              // altura²: la punta dobla más
lf = 1 - |ge|^2 * 0.35                          // conservación de longitud
world = ( worldX + ue.x*position.x*se + ge.x*bw*oe,
          C       + position.y*oe*lf - 0.01,     // -1 cm hunde la base
          worldZ + ue.y*position.x*se + ge.y*bw*oe )
```
- `HB = normalize(vec2(0.82, 0.38))` (dirección del viento). `wind` (fuerza) ×1.64 por defecto.

### 6.7 Normal y color
```
normalNode = transformNormalToView( normalize( mix(vec3(le.x,0,le.y), vec3(0,1,0), 0.6) ) )
color: base = mix((0.03,0.078,0.013), (0.068,0.16,0.026), y(10)) * mix(0.38,1,uvY)
        → punta seca mix→(0.15,0.125,0.036) por smoothstep(0.72,1,uvY)*y(11)*0.55
        → tinte de densidad ×mix(0.8,1.15, T)
roughness = clamp(mix(0.8, 0.6, uvY), 0, 1) ; metalness 0 ; envMapIntensity 0.35
```

---

## 7. Árboles (streaming por celdas + pool de slots)

### 7.1 Tabla de especies (producción RW = "camper" `nH`; replicamos esta)
```
fir      variants 3  lod[22.5,60,175]  trunkR .34  scale[.85,1.2]  cell 8.5  prob .64  cap[30,90,300] field 0
pine     variants 6  lod[22.5,60,175]  trunkR .36  scale[.85,1.2]  cell 8.5  prob .64  cap[30,90,300] field 0
firsap   variants 3  lod[32.5,75,110]  trunkR .07  scale[.8,1.3]   cell 6.5  prob .42  cap[40,100,240] field 1
sapling  variants 3  lod[25,56.25,85]   trunkR  0   scale[.9,1.5]   cell 4.5  prob .38  cap[50,140,300] field 1
lodScale = {low:.62, medium:.8, high:1}
```
- `field 0` = árboles grandes (colisionan, votan especie, proyectan sombra). `field 1` = sotobosque
  (sin/biombo colisión, sin voto de especie, sin sombra en RW camper).
- `speciesPick(x,z) = +(noise(x*0.35+47, z*0.35+5) > 0.5)` reparte fir/pine en dos "biomas".

### 7.2 Streaming `update(cx,cz)` (reconstruye solo si la cámara se movió ≥3 m)
```
hash(cellX,cellZ,salt) = imul avalanche de (374761393, 668265263, 1274126177)
posición celda = (cell + 0.12 + hash*0.76) * cellSize        // 12–88% del interior
aceptar si NO se cumple ninguno:
  hash(1) > prob * treeScale * density(x,z,field)
  EB(x,z, field==0 ? 'tree' : 'low')                          // bloqueos de landmarks
  land(x,z) < 0.6
  roadDist < (field==0 ? 6.2 + hash*2.5 : 4.4)
  shape && normal.y < 0.82
  field==0 && speciesPick != especie
LOD por distancia, luego cap, luego variants.
escala = mix(scale[0], scale[1], hash) ; rot = hash*2π ; sink = .08 (o .7 para pine camper)
y = height - sink*escala
```

### 7.3 Pool de slots (sin asignar memoria en runtime)
- Un `InstancedMesh` por (variante, LOD, primitiva) con capacidad fija `cap[lod]`.
- `slots[]` (clave o null) + `slotOf` Map (clave→slot) + `used` Set (por escaneo).
- Liberar claves no aceptadas → `slotOf.delete(key); slots[slot]=null`.
- Asignar → reutiliza slot existente o `slots.indexOf(null)` o `slots.length`.
- Huecos → matriz degenerada `scale(.001,.001,.001) pos(0,-500,0)`. `count = slots.length`. Un
  `instanceMatrix.needsUpdate` por pool.
- Bloqueadores de tronco: `trunkR>0 && dist<40` → `{x, z, r: trunkR*escala}`.
- `variants/lods/primitivas` se construyen una vez en `load()`; nada se crea en runtime.

### 7.4 Balanceo (sway) — nodo `positionNode`
```
c = clamp(positionLocal.y / alturaLOD0, 0, 1)
phase = hash(instanceIndex+3) * 2π
n = (noise(posLocal.xz*0.018 - windDir*(t*0.11))*.5+.5)*0.7+.3 * (gust*.6+.4)
r = cos(t*0.5 + phase)*0.35 + 0.65
despl = windDir * (n * r * 1.7 * c * c)                       // base rígida, copa flexible
+ follaje: f1 = sin(t*1.9 + phase*2 + y*0.9 + x*0.6)*0.27*c*n
          f2 = sin(t*6.5 + x*3.1 + z*2.7 + y*4.3)*0.055*n
  → suma en los 3 ejes con reparto (0.6, 0.35/0.4, 0.5)
* wind
```
- Se escribe también `positionPrevious` (mismo desplazamiento con `t - dt`) para que TAA no haga ghosting.

---

## 8. Props (submata) — tabla y reglas

```
id                 cell  prob  radius cap  scale        align sink  foliage patch        solid shore
fern_02            3.2   .50   55     140  [0.8,1.4]    no     .02  yes     [0.9,0.45]  -     -
grass_medium_01    2.6   .45   42     60   [0.9,1.5]    no     .03  yes     [1.2,0.40]  -     -
shrub_02           7.5   .32   60     60   [0.8,1.3]    no     .03  yes     [0.7,0.42]  -     -
rock_moss_set_01  12     .30   90     30   [0.8,1.6]    yes    .06  no      -            yes   yes
rock_moss_set_02  13     .30   90     30   [0.8,1.6]    yes    .06  no      -            yes   yes
tree_stump_01     26     .35   90     24   [0.9,1.3]    no     .04  no      -            yes   -
dead_tree_trunk   40     .40   60     8    [0.9,1.2]    yes    .05  no      -            yes   -
dry_branches      6      .30   50     70   [0.9,1.4]    yes    .01  no      -            -     -
(los shoreOnly: rock_face_02/01, boulder_01 → solo con shape.sea; en woods NO se cargan)
rScale = {low:.6, medium:.8, high:1}
```
- `patch` agrupa: `prob *= smoothstep(noise(x*s+700+n*31, z*s+33), thr, thr+0.25)`.
- Posición celda `(cell + 0.1 + hash*0.8)*cellSize`. `align` inclina según normal del terreno.
  `sink` entierra (positivo) o alza (negativo) · escala. Rocas musgosas escalan `lerp(0.55,1, distRoad)`.
- Colisionadores `solid` (≤36 m): elipse → cadena de círculos de radio `max(.25, minExtent*0.85*escala)`.
- `EB`/landmarks: `vB = {cabin:{tree:14,low:8,grass:4.5}, stones:{tree:22,low:12,grass:0}}`;
  sitio por defecto en `(-35,-54)` tipo `stones`; retícula de 320 m con 20 % de ocupación.

---

## 9. Lluvia, clima y rayos

### 9.1 Conteos
```ts
const mH = { low:{streaks:5e3, splashes:900},
             medium:{streaks:1e4, splashes:1800},
             high:{streaks:1.6e4, splashes:2800} };
```
- Ambos en un volumen envolvente. `fold(p, cam, box) = p + round((cam - p)/box)*box`
  (rachas: caja 24×16×24 centrada en `cam.y+4`; salpicaduras: 22×22 en el suelo).

### 9.2 Rachas
```
hash(k) = hash(instanceIndex*4 + k + 17)
visible = hash(7) < rain                              // umbral de densidad
len  s  = mix(8.5, 12.5, hash(3)) * (1 - wet*0.45)
wind c  = HB * (gust*1.4 + 0.6) * wind
base = hash(0)*24 , hash(1)*16 , hash(2)*24   advectado por time*c*0.8 ; luego fold()
dir  g  = normalize(vec3(c.x*0.8, -s, c.y*0.8)).negate()
side v  = normalize(cross(g, normalize(cam - p)))
largo b = mix(0.2,0.48,hash(4)) * s/10 * (1 - wet*0.4)
ancho x = mix(0.007,0.012,hash(5)) + b*0.0012 , * (wet*1.2+1)
opacity = bordesUV * smoothstep(0.3,1.8,dist) * (1-smoothstep(7,15,dist))
        * mix(0.25,0.5,hash(6)) * visible * max(nightDim, headlight*1.4)
color  = mix(mix(VB*2.1+0.12, VB*0.8, facing), vec3(.85,.87,.9), wet*0.6) * nightDim
       + headlightColor * headlight * 2.2
renderOrder 20, transparent, depthWrite false, layers 1
```
- `wet = iV` (precipitación, `.7` en pas; nosotros 1.0 por defecto). `nightDim = XB` = `.12` en noche.
- **Adaptación nocturna (obligatoria, ver fase 5):** RW ilumina con faros de coche. Aquí sustituimos
  `headlight` por un cono de linterna del jugador y un brillo lunar `pow(max(dot(V,moonDir),0),8)`.

### 9.3 Salpicaduras
```
p = fract(time*mix(1.4,2.2,h2) + h3) ; m = mix(0.04,0.12,h4)*(p*0.85+0.15)*visible
ring = smoothstep(.55,.8,r)*smoothstep(1,.86,r) ; center ; fade=(1-p)^2 ; dist 1-smoothstep(9,13,d)
opacity = (ring+center)*fade*dist*0.3*rotWobble*max(nightDim, headlight*1.4)
y = height(x,z) + 0.015 ; renderOrder 19
```

### 9.4 Rayos
```ts
// Strike: dir=(cos r, 0.55+rand*0.3, sin r).normalize(); 2–4 pulsos
//   t0 acumulado (gap .08–.30), amp = (i==1?1:.45+rand*.5)*(1.15 - intensity*0.6), decay .08–.20
//   hasBolt = intensity < 0.8 ; onThunder(intensity, 0.35 + intensity*3.4)
// Update: next=8+rand*10 (1er), small cada (15+20r)*pace, big cada (30+10r)*pace
//   flash = min(1, Σ amp*exp(-t/decay)*(0.75 + 0.25*sin(140t + t0*50)))
//   qB = flash ; PointLight.intensity = flash*6 en strike + dir*120
// Rayo: 15 pts tronco (radio 180+260i, alto +110+90i, jitter (1-t*.5)*(4+6i)) + 5 ramas
//   extrusión = cross(segDir, normalize(origin-p)) * width*(1 - r/len*.5) ; renderOrder 15
//   color (18,19,24), opacity = clamp(flash*6, 0, 1)
```

---

## 10. Agua (opcional/stretch — `woods` NO tiene agua)

`woods` en RW no crea `JV`. Se documenta por si se añade: plano 1600×1600 (400 seg) o 500 (160 seg) a
`y=LV=1.2`, 4 octavas Gerstner `[[42,.55,.55,0],[23,.3,.6,.45],[12,.16,.7,-.6],[6,.07,.8,.9]]`,
`ω=sqrt(9.81*k)`, normal por diferencias finitas, foam por profundidad, reflexión planar a
`resolutionScale {low:.18, med:.22, high:.28}`, cámara virtual sin capa 1. Variante `calm` (nocturna)
usa refracción de pantalla + reflejo.

---

## 11. Post-procesado (cadena TSL)

```ts
const TR = { exposure:0.8, bloom:0.05, bloomRadius:0.35, bloomThreshold:1.4, motion:0,
             ca:0.006, grain:0.022, vignette:0.12, sharpen:0.14, ao:1,
             saturation:1.58, contrast:1.13, fog:1, rain:1.48, wind:1.64, aa:'traa' };
renderer.toneMapping = AgXToneMapping;  // = 6
renderer.toneMappingExposure = TR.exposure;
renderer.setPixelRatio(min(devicePixelRatio, {low:1, medium:1.25, high:1.5}));
```

Cadena (en orden, sobre un MRT `{output, normal, velocity}`):
1. **GTAO** (si `quality != 'low'`): radius .7, thickness .6, scale 1, samples 12/8,
   resolutionScale .65/.55. Mezcla: `mix(1, ao, smoothstep(45, 95, viewZ))`.
2. **Sharpen** 0.14 (después del AA).
3. **TAA/TRAA**: `traa` (full res) por defecto; `taau` a resolutionScale .66(low)/.75(med,high).
4. **Bloom**(`input`, 0.05, 0.35, 1.4) — aditivo, antes del tonemap.
5. **Motion blur** (si `quality != 'low'`): 8/6 muestras a lo largo de la velocidad.
6. `renderOutput` (AgX + exposure 0.8 + sRGB). Aquí y después se gradúa en display-referred:
   `sat/contraste = (mix(vec3(luma), rgb, 1.58) - 0.5) * 1.13 + 0.5`.
7. **CA** radial 0.006 (centro .5,.5, escala 1.1) · **viñeta** `smoothstep(.55,1.25, |uv-.5|*1.4142)*0.12`
   · **grano** `0.022 * (1 - luma*0.7)`.
8. `outputColorTransform = false` (tonemap/encoding exactamente una vez).

Gating de depuración: `?post=N` (3=AO, 5=AA, 6=bloom, 7=motion, 8=CA, 9=viñeta, 10=grano),
`?taa=traa|taau|off`, `?view=normal|depth|velocity`, `?ao=0`, `?aoView=1`, `?snap=0`, `?grass=0`,
`?rain=0`, `?wind=N`, `?fog=N`, `?sun=N`, `?env=N`, `?nowarm=1`, `?debug=1`.

---

## 12. Calidad, arranque y globales

**Detección:** `hardwareConcurrency >= 10 → high`, `>= 6 → medium`, si no `low`; puntero grueso (táctil) → `low`.

**Tiers completos:**
| | low | medium | high |
|---|---|---|---|
| césped instancias | 37 632 | 153 600 | 256 000 |
| árbol lodScale | .62 | .8 | 1 |
| prop rScale | .6 | .8 | 1 |
| lluvia (rachas/salpicaduras) | 5k/900 | 10k/1.8k | 16k/2.8k |
| sombra mapa | 1024 | 1536 | 2048 |
| DPR cap | 1.0 | 1.25 | 1.5 |
| GTAO | off | 8 (.55) | 12 (.65) |
| motion blur | off | 6 | 8 |
| TAAU scale | .66 | .75 | .75 |

**Etapas de carga (ponderadas):** renderer .08 / world .6 / placing .1 / shaders .22.
**localStorage:** `quality`, `scene`, `tune` (v2), `load-<scene>-<quality>` (memo de tiempos), `song`.
**Atajos:** 1/2 lluvia, 3/4 viento, P stats, T teletransporte a landmark, G GUI, Y/M canción, ESC menú.

**Uniformes globales (nombres del proyecto RW → nuestros):**
`VB` color horizonte/niebla · `zB` densidad niebla · `BB` (near,far) niebla · `HB` dir viento ·
`UB` fuerza viento · `WB` racha · `GB` umbral lluvia · `KB` ref altura niebla · `qB` flash rayo ·
`JB` acimut rayo · `YB` claro (x,z,radio) · `XB` atenuación lluvia nocturna · `rV` nubes · `iV` mojado.

---

## 13. Mapa de archivos objetivo

```
nightwoods/
├── index.html                 # canvas + overlay + loader
├── package.json  vite.config.ts  tsconfig.json
├── src/
│   ├── main.ts                # arranque + bucle + params URL
│   ├── core/{constants,rng,input}.ts
│   ├── assets/{index,noise,textures,env}.ts
│   ├── render/{RenderCore,Environment,Sky,Fog,Post}.ts
│   ├── world/{index,Heightfield,Terrain,Grass,Trees,Props,Scatter,Water}.ts
│   ├── weather/{Rain,Lightning,Weather}.ts
│   └── ui/{boot,menu,hud}.ts
├── tools/shot.ts              # harness puppeteer
├── docs/00-referencia-tecnica.md  (este archivo)
└── docs/fase-{0..7}-*.md
```
