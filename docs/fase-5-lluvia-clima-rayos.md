# Fase 5 — Lluvia, clima y rayos

**Objetivo**: lluvia nocturna visible (el problema artístico más difícil de RW: iluminar agua sin faros),
salpicaduras en el suelo, y relámpagos que iluminen cielo + niebla + geometría.
**Depende de**: Fases 1 y 2. **Esfuerzo**: medio-alto.

Fuente: [`00-referencia-tecnica.md`](00-referencia-tecnica.md) §9.

---

## 5.1 Objetivo verificable

1. 5k–16k rachas + 900–2800 salpicaduras, ambos en un volumen envolvente que sigue a la cámara.
2. La lluvia es **visible** contra el cielo nocturno sin faros de coche (el gran reto, ver T5.2.4).
3. Salpicaduras ancladas a la altura del terreno (siguen la superficie).
4. Relámpagos: destello de cielo/niebla + `PointLight` + rayo visible + trueno (hook de audio).
5. Intensidad de lluvia y viento ajustables en vivo (los "sliders" 1/2 y 3/4 de RW → teclas).

---

## 5.2 Tareas

### T5.2.1 `src/weather/Weather.ts` — driver
- `rV` (nubes 0→1), `GB` (densidad/umbral de lluvia), `UB` (fuerza de viento), `WB` (racha, desde
  Environment), `iV` (mojado/precipitación), `XB` (atenuación nocturna de la lluvia).
- Oscilador de nubes: rampa 0→1 en ~4–5 s (RW), para transiciones "llueve más fuerte".
- Presets: `clear`, `drizzle`, `rain`, `storm` (multiplican `GB`, `UB`, `rV`).
- Exponerlos en `shared` para todos los materiales.

### T5.2.2 `src/weather/Rain.ts` — rachas + salpicaduras
Volumen envolvente con `fold` (no hay movemento de CPU):
```ts
// wrap en el shader: p += round((cam - p)/box) * box
//   rachas:     box = (24, 16, 24), centrado en (cam.x, cam.y+4, cam.z)
//   salpicaduras: box = (22, 22), en el suelo bajo la cámara
```
- **Geometría**: `PlaneGeometry(1,1)` (rachas) / rotada horizontal (salpicaduras), `InstancedMesh`,
  `frustumCulled=false`, `transparent`, `depthWrite=false`, `renderOrder 20/19`, `layers.set(1)`.
- **Rachas** (§9.2): `hash(k)=hash(instanceIndex*4 + k + 17)`, visibilidad `hash(7) < rain`, longitud
  `s = mix(8.5,12.5,hash(3))*(1-wet*0.45)`, viento `c = HB*(gust*1.4+0.6)*wind`, advección por
  `time*c*0.8`, dirección `normalize(vec3(c.x*0.8, -s, c.y*0.8)).negate()`, lado
  `normalize(cross(g, normalize(cam-p)))`, largo `b = mix(0.2,0.48,hash(4))*s/10*(1-wet*0.4)`, ancho
  `x = mix(0.007,0.012,hash(5)) + b*0.0012`, opacidad y color según §9.2.
- **Salpicaduras** (§9.3): fase `p = fract(time*mix(1.4,2.2,h2)+h3)`, radio `m = mix(0.04,0.12,h4)*(p*0.85+0.15)*visible`,
  anillos + centro, `(1-p)²`, fade a 9–13 m, `y = heightNode + 0.015`, `renderOrder 19`.
- Material sin luces (como RW): solo `colorNode` + `opacityNode`, con blending aditivo/normal.
  Alimentar del bloom (fase 6) para el brillo.

### T5.2.3 `src/weather/Lightning.ts` — relámpagos
- `PointLight((0.85,0.90,1.0), 0)`, en `strike + dir*120`.
- `strike()`: `dir = (cos r, 0.55+rand*0.3, sin r).normalize()`, 2–4 pulsos con `t0` acumulado
  (gap 0.08–0.30), `amp = (i==1?1 : 0.45+rand*0.5)*(1.15 - intensity*0.6)`, `decay = 0.08+rand*0.12`.
  `hasBolt = intensity < 0.8`.
- `update()`: primer rayo a los 8–18 s, "small" cada `(15+20r)*pace` (intensidad 0.35–1.0),
  "big" cada `(30+10r)*pace` (0.04–0.24, pero **siempre** genera rayo). `pace` por preset.
  `flash = min(1, Σ amp*exp(-t/decay)*(0.75 + 0.25*sin(140t + t0*50)))`; `qB = flash`;
  `PointLight.intensity = flash*6`.
- **Rayo visible**: `BufferGeometry` con `Float32Array(768)` positions, `setDrawRange(0,n)`;
  tronco de 15 puntos (radio 180+260i, alto +110+90i sobre el suelo, jitter `(1-t*0.5)*(4+6i)`),
  5 ramas desde `3+rand*4`; extrusión por segmento:
  `side = normalize(cross(segDir, normalize(origin - pt))) * width*(1 - r/len*0.5)`,
  índices `[0,1,2,1,3,2]`. Material `AdditiveBlending`, `depthWrite=false`, `fog=false`,
  `color (18,19,24)`, `opacity = clamp(flash*6,0,1)`, `renderOrder 15`.
- Alimentar el cielo (Fase 1) y la niebla con `qB` (ya Tenían el término; conectar `uFlash`).
- `onThunder(intensity, delay)` callback → **hook de audio** (Fase 7 o stub).

### T5.2.4 La lluvia de noche sin faros (decisión clave de arte)
RW ilumina la lluvia con un término `headlit` (faros del coche). Aquí:
1. **Cono de linterna** del jugador: sustituir `$B/eV/tV` por la posición/dirección de la linterna y su
   estado. El mismo `headlit()` da lluvia iluminada por la linterna gratis.
2. **Brillo lunar** para la lluvia fuera del cono: `moonSheen = pow(max(dot(normalize(cam-p), moonDir), 0),
   8) * moonColor`. Añadirlo al color de la racha. Sin esto la lluvia se pierde en el cielo negro.
3. **Realce pálido de la punta** (ya en RW): mantener `mix(..., vec3(0.85,0.87,0.9), wet*0.6)` para las
   estrías que miran a cámara.
4. `XB` (atenuación nocturna) Subir de 0.12 a ~0.35 en bosque nocturno para que se vea sin Washout.
   Ajustar con capturas hasta que "llueva visible pero no cartoonsco".
5. Las salpicaduras: subir su color base (`VB*1.9 + 0.1`) o elBloom lasxw. Ajustar con capturas.

### T5.2.5 Controles en vivo
- Teclas `1/2` lluvia -0.15/+0.15 (0..2), `3/4` viento -0.2/+0.2 (0..2.5) (como RW).
- HUD de barras `▮` (reutilizar el patrón de `ui/hud` del proyecto horror, o el de RW).
- Presets rápidos: tecla `P` cicla clear→drizzle→rain→storm (para QA).

---

## 5.3 Criterios de aceptación

- [ ] `npm run typecheck` limpio.
- [ ] Con lluvia ON de noche, la lluvia es claramente visible en captura (no punts blancos).
- [ ] Salpicaduras se anclan al terreno (siguen la altura al caminar cuesta arriba/abajo).
- [ ] Relámpago: destello de cielo + niebla + geometría en un frame; rayo visible; `PointLight` ilumina.
- [ ] `?rain=0` desactiva; `1/2/3/4` ajustan en vivo; barra HUD refleja el valor.
- [ ] Volando rápido: la lluvia no "se queda atrás" (el wrap funciona).
- [ ] Bench: coste de lluvia en high despreciable (< 2 ms).

---

## 5.4 Notas / trampas
- **El wrap de volumen en el shader es la clave**; si olvidas el `fold`, la lluvia se queda en un cubo
  fijo. Es el error #1.
- `smoothstep(7,15,dist)` en las rachas **desvanece la lluvia muy cerca** (para no tapar la cámara);
  respectarlo o la cámara queda empañada.
- El destello de rayo debe multiplicar **la niebla** (`color *= flash*2.2+1`) además del cielo, o el
  relámpago no "ilumina" el mundo.
- `PointLight` en el rayo con `intensity = flash*6` es puntual; para iluminar un bosque grande, además
  subir la direccional de la luna brevemente (o añadir un `DirectionalLight` de destello). Opcional.
- Volver a legible la lluvia de noche es un **bucle de captura-ajuste**, no un valor único. Itera con
  screenshots hasta que se vea bien.
