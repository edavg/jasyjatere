/**
 * T8.1 (§1): entrada unificada para el walker y la cámara de vuelo de dev.
 *
 * Teclas (WASD/Shift/flechas) + mirada:
 * - ratón por **pointer lock** (click en el canvas) con caída a **arrastre** si
 *   el navegador rechaza el lock; sensibilidad 0.0019 rad/px (§1).
 * - táctil: un dedo arrastra, sensibilidad 0.0019 × 1.8 (§1). No hay joystick
 *   virtual (alcance de escritorio de F8).
 *
 * Los deltas de mirada se acumulan ya escalados y se consumen una vez por frame
 * con `consumeLook(out)` (sin allocs: `out` es un objeto scratch del llamante).
 * El módulo no crea nada en el bucle.
 */
export interface LookDelta {
  /** Píxeles de ratón/táctil escalados a radianes; el consumidor los resta. */
  yaw: number;
  pitch: number;
}

export interface Input {
  isDown(code: string): boolean;
  /** Consume el delta acumulado desde la última llamada (lo pone a cero). */
  consumeLook(out: LookDelta): void;
  /** `false` limpia teclas/deltas y suelta el pointer lock (menú abierto). */
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  readonly pointerLocked: boolean;
  dispose(): void;
}

/** Rad/px de §1: ratón 0.0019; táctil ×1.8. */
const MOUSE_SENS = 0.0019;
const TOUCH_SENS = MOUSE_SENS * 1.8;

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let enabled = true;
  let dragging = false;
  let pointerLocked = false;
  // Scratch táctil: posición previa del dedo.
  let lastTouchX = 0;
  let lastTouchY = 0;

  function onKeyDown(e: KeyboardEvent): void {
    if (!enabled) return;
    // Evita el scroll de flechas/espacio sin romper al HUD (que escucha sus
    // propias teclas en window).
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    keys.add(e.code);
  }

  function onKeyUp(e: KeyboardEvent): void {
    keys.delete(e.code);
  }

  function onBlur(): void {
    keys.clear();
    dragging = false;
    yaw = 0;
    pitch = 0;
  }

  function onMouseDown(e: MouseEvent): void {
    if (!enabled || e.button !== 0) return;
    dragging = true;
    if (document.pointerLockElement !== canvas) {
      try {
        const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (p !== undefined && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        /* sin lock: queda el arrastre */
      }
    }
  }

  function onMouseUp(): void {
    dragging = false;
  }

  function onMouseMove(e: MouseEvent): void {
    if (!enabled) return;
    const locked = document.pointerLockElement === canvas;
    if (!locked && !dragging) return;
    yaw -= e.movementX * MOUSE_SENS;
    pitch -= e.movementY * MOUSE_SENS;
  }

  function onPointerLockChange(): void {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) dragging = false;
  }

  function onTouchStart(e: TouchEvent): void {
    if (!enabled || e.touches.length !== 1) return;
    dragging = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  }

  function onTouchMove(e: TouchEvent): void {
    if (!enabled || !dragging || e.touches.length !== 1) return;
    const t = e.touches[0];
    yaw -= (t.clientX - lastTouchX) * TOUCH_SENS;
    pitch -= (t.clientY - lastTouchY) * TOUCH_SENS;
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
    e.preventDefault();
  }

  function onTouchEnd(): void {
    dragging = false;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);

  function setEnabled(on: boolean): void {
    enabled = on;
    if (on) return;
    keys.clear();
    yaw = 0;
    pitch = 0;
    dragging = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', onTouchEnd);
    keys.clear();
  }

  return {
    isDown(code: string): boolean {
      return enabled && keys.has(code);
    },
    consumeLook(out: LookDelta): void {
      out.yaw = yaw;
      out.pitch = pitch;
      yaw = 0;
      pitch = 0;
    },
    setEnabled,
    get enabled(): boolean {
      return enabled;
    },
    get pointerLocked(): boolean {
      return pointerLocked;
    },
    dispose,
  };
}
