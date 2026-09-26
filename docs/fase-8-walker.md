# Fase 8 — Walker: movimiento, colisión y pasos (post-v1)

**Objetivo**: convertir la demo en un mundo explorable en primera persona con los números exactos de
§1 de [`00-referencia-tecnica.md`](00-referencia-tecnica.md), reutilizando los colisionadores que F4 ya
expone. **Solo escritorio** (decisión de alcance: el touch-look queda preparado en `input.ts`, sin
joystick virtual). **Depende de**: F0–F7 (v1 cerrada). **Esfuerzo**: medio.

---

## 8.1 Especificación (de §1, sin inventar nada)

```ts
speed = { walk: 1.75, run: 3.9 }          // m/s; Shift = run, sin stamina
vel.lerp(wish, 1 - exp(-9 * dt))          // aceleración exponencial pura
groundY += (target - groundY) * min(1, dt*14)
colisión = push-out de círculos (r * escala + 0.32), deslizamiento eje a eje
ratón 0.0019 rad/px · táctil ×1.8 · pitch ±1.45
bob: φ' = 6 + 5.5u · Y = sin(2φ)*0.02*amp*(0.5+0.9u) · roll = sin(φ)*0.005*amp
     respiración = sin(t*1.25)*0.004        // sin FOV kick ni shake
pasos cada 0.8 m (walk) / 1.35 m (run)
```

Decisiones documentadas (la referencia no las fija):
- `u = |vel| / 3.9` y `amp = u`: parado no hay bob; a run el bob es pleno. La respiración es siempre ±4 mm.
- `walkable(x,z)` = sin solape con `trunks()/blockers()` **y** `normal.y ≥ 0.82` (mismo umbral que el
  scatter). El terreno de woods es suave: no genera muros.
- Radio del jugador = `CAMERA.radius` (0.32), no un literal.
- El paso de audio (F8.5) es ruido → lowpass (900–1400 Hz) → bandpass (170/220 Hz) con envolvente de
  ~90 ms y jitter ±20 %; suena cada umbral de distancia, no por frame.

## 8.2 Tareas

- **T8.1 `src/core/input.ts`** (nuevo): teclas WASD/Shift/flechas, pointer lock en click con caída a
  arrastre, táctil un dedo ×1.8, deltas ya escalados en scratch, `setEnabled(false)` limpia estado
  (menú abierto), `dispose()`. Unifica walker y `?fly`.
- **T8.2 `src/world/Walker.ts`** (nuevo): física §1 + bob/respiración + pasos por distancia.
- **T8.3 Colisión**: contra las listas vivas del scatter (`r + 0.32`), deslizamiento X/Z por ejes y
  push-out anti-atasco.
- **T8.4 `main.ts`**: modo normal = walker; `?cam` desactiva input y física (capturas intactas);
  `?fly=1` manda; ESC/menú neutraliza el input; `__nightwoods.walker` expuesto para tests.
- **T8.5 `audio.step(run)`** + contador `AudioStats.steps`.
- **T8.6 `tools/walk-probe.ts`** (nuevo): velocidad, carrera, bob, colisión determinista (teleport a
  2 m de un tronco y empuje), pasos, consola limpia.

## 8.3 Criterios de aceptación

- [x] `npm run typecheck` limpio.
- [x] Física §1 exacta: W 2 s ⇒ 3.45 m (esperado 3.5) · Shift+W 1.5 s ⇒ 5.83 m (esperado 5.85).
- [x] Bob activo en carrera (`y ∈ [1.671, 1.730]` con eye 1.7) y velocidad ~0 al soltar.
- [x] Colisión determinista: parado en `r + 0.32` (0.746 vs límite 0.744), 0 penetraciones y 0.000 m de
  avance tras 0.8 s empujando.
- [x] Pasos sintetizados disparados (`steps` crece al caminar) y AudioContext `running`.
- [x] Cero errores/warnings de consola; `?fly`/`?cam` y los probes de F7 siguen verdes.
- [x] Capturas `artifacts/fase-8-walk.png` y `artifacts/fase-8-collide.png`.

## 8.4 Notas

- El input pertenece a `core/` (el mapa de §13 ya lo preveía) y no usa three.
- `?cam` + `?fly` siguen permitiendo teclado (lo necesitan `frame-probe` y las capturas).
- El walker no colisiona con el terreno (solo snap de suelo + pendiente en `walkable`): el doc no pide
  más y el terreno de woods no tiene acantilados.
- No hay pisado de césped (T3.2.6 sigue fuera): el jugador atraviesa la hierba.
- Fuera de F8: móvil táctil completo, pasos con material (barro/hierba), agacharse/saltar.
