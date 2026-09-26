import * as THREE from 'three/webgpu';
import { dot, float, length, normalize, smoothstep, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { QUALITY, TORCH, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool, pnum } from '../core/params';

declare module '../core/dbg' {
  interface Dbg {
    torch?: Record<string, unknown>;
  }
}

/**
 * T5.2.4.1: la linterna del jugador. RW ilumina la noche con los faros del coche
 * (§9.2 `headlight`); aquí el mismo haz va colgado del rig de la cámara, sin
 * coche: una linterna en la mano derecha que sigue la mirada.
 *
 * El módulo es la **única fuente** del haz: la `SpotLight` real (ilumina terreno,
 * árboles, césped y props) y los tres uniforms (`pos`, `dir`, `gain`) que leen
 * el shader de lluvia y el de niebla. `beamAt(wp)` evalúa el cono una sola vez
 * para todos, de modo que la lluvia iluminada y la niebla coinciden con el
 * haz que se ve en pantalla.
 *
 * `?torch=0` (default) no crea la luz: sin luz no hay permutación de shader
 * extra, y los uniformes quedan a 0 (el término se compila pero no se ve).
 * `?torchi=N` escala la intensidad, `?torchshadow=1` enciende su shadow map.
 */
export interface TorchEx {
  /** Estado del interruptor (no es el mismo que `gain`, que es el uniforme). */
  readonly on: boolean;
  /** Posición del foco en el mundo. */
  readonly pos: Node<'vec3'>;
  /** Dirección del haz en el mundo, normalizada. */
  readonly dir: Node<'vec3'>;
  /** 1 encendida / 0 apagada. */
  readonly gain: Node<'float'>;
  /** `beamAt(wp)`: cono 0..1 del haz en un punto del mundo (0 si está apagada). */
  beamAt(wp: Node<'vec3'>): Node<'float'>;
  /** `SpotLight` en el rig, o null si `?torch=0`. */
  readonly light: THREE.SpotLight | null;
  /** Escribe los uniforms desde el rig. Sin argumentos ni asignaciones. */
  update(): void;
  dispose(): void;
}

// Scratch de módulo: update() no asigna por frame.
const _pos = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createTorch(rig: THREE.Object3D, quality: Quality): TorchEx {
  const on = pbool('torch', false);
  const gain = uniform(on ? 1 : 0);
  const uPos = uniform(new THREE.Vector3());
  const uDir = uniform(new THREE.Vector3(0, 0, -1));

  /**
   * `beamAt(wp)`: cono `smoothstep(cosOut, cosIn, dot(dir, normalize(wp-pos)))`
   * por la caída `1/(1+d²·k)`, igual que el `headlight` de RW pero con la
   * posición/dirección de la linterna (§T5.2.4.1). Cero allocs (grafo TSL).
   */
  function beamAt(wp: Node<'vec3'>): Node<'float'> {
    const toP = wp.sub(uPos);
    const d = length(toP);
    const cone = smoothstep(TORCH.cosOut, TORCH.cosIn, dot(normalize(toP), uDir));
    const fall = float(1).div(d.mul(d).mul(TORCH.falloff).add(1));
    return cone.mul(fall).mul(gain);
  }

  if (!on) {
    const dbg = dbgRef();
    if (dbg) dbg.torch = { on: false, light: false, shadow: false };
    return {
      on: false,
      pos: uPos,
      dir: uDir,
      gain,
      beamAt,
      light: null,
      update(): void {},
      dispose(): void {},
    };
  }

  // Params de captura: `?torchi=N` MULTIPLICA la intensidad, `?torchangle=deg`
  // fija el medio cono, `?torchdecay=N` el exponente de caída y `?torchtilt=N`
  // la caída del objetivo por metro de alcance. Los cuatro existen por el bucle
  // de captura de §T5.2.4.1 (con decay 2, el físico, el haz muere a 12 m y RW
  // llega a 30: por eso el decaimiento es 1).
  const scale = Math.max(0, pnum('torchi', 1));
  const angle = Math.max(0.02, Math.min(1.5, pnum('torchangle', (TORCH.angle * 180) / Math.PI) * (Math.PI / 180)));
  const decay = Math.max(0, pnum('torchdecay', TORCH.decay));
  const light = new THREE.SpotLight(
    new THREE.Color(...TORCH.color),
    TORCH.intensity * scale,
    TORCH.distance,
    angle,
    TORCH.penumbra,
    decay,
  );
  light.name = 'torch:spot';
  light.position.set(TORCH.offset[0], TORCH.offset[1], TORCH.offset[2]);
  // El objetivo es hijo del MISMO rig: así el haz hereda el yaw/pitch sin CPU.
  // Ojo: el target debe estar en el grafo para que se actualice su matriz.
  // `target.x = offset.x` deja el haz paralelo a la vista (linterna en la mano,
  // no unida a la mirada). `tilt` baja el objetivo: se probó inclinarlo para
  // alejar el punto caliente de los pies y NO compensa (el cono se abre más
  // cerca), así que el default es 0; queda el param por si se retoca.
  const tilt = pnum('torchtilt', TORCH.tilt);
  light.target.name = 'torch:target';
  light.target.position.set(TORCH.offset[0], TORCH.offset[1] - tilt, -1);
  rig.add(light);
  rig.add(light.target);

  // `?torchshadow=1`: segunda shadow map (512–2048 según tier). La cámara de
  // sombras habilita la capa 2 (troncos/hojas de árbol, §2.3) y NO la 1
  // (césped y lluvia nunca proyectan). Cuesta un pase extra: opt-in.
  const shadow = pbool('torchshadow', false);
  if (shadow) {
    light.castShadow = true;
    light.shadow.mapSize.set(QUALITY[quality].shadow, QUALITY[quality].shadow);
    light.shadow.camera.near = 0.4;
    light.shadow.camera.far = TORCH.distance;
    light.shadow.camera.layers.enable(2);
    light.shadow.bias = TORCH.bias;
    light.shadow.normalBias = TORCH.normalBias;
    light.shadow.radius = TORCH.radius;
    light.shadow.camera.updateProjectionMatrix();
  }

  const dbg = dbgRef();
  if (dbg) {
    dbg.torch = {
      on: true,
      light: true,
      shadow,
      intensity: light.intensity,
      angle,
      penumbra: TORCH.penumbra,
      distance: TORCH.distance,
      decay,
      tilt,
      cosIn: TORCH.cosIn,
      cosOut: TORCH.cosOut,
      falloff: TORCH.falloff,
    };
  }

  function update(): void {
    // La posición/dirección reales del foco (no las de la cámara): así el cono
    // del shader y el de la SpotLight no se separan por el offset de la mano.
    light.getWorldPosition(_pos);
    light.target.getWorldPosition(_aim);
    uPos.value.copy(_pos);
    uDir.value.copy(_dir.copy(_aim).sub(_pos).normalize());
  }

  function dispose(): void {
    rig.remove(light);
    rig.remove(light.target);
    // SpotLight.dispose() existe en r186 (three/src/lights/SpotLight.js:148) pero
    // @types/three no lo declara; el shadow sí está tipado.
    light.shadow.dispose();
  }

  return { on: true, pos: uPos, dir: uDir, gain, beamAt, light, update, dispose };
}
