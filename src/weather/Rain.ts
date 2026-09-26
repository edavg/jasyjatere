import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  round,
  select,
  sin,
  smoothstep,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { QUALITY, RAIN, TORCH, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pnum } from '../core/params';
import type { Shared } from '../core/shared';
import type { TorchEx } from '../render/Torch';

declare module '../core/dbg' {
  interface Dbg {
    rain?: Record<string, unknown>;
  }
}

/**
 * T5.2.2 (§9.1–§9.3): lluvia de noche = rachas + salpicaduras, ambas en un
 * volumen envolvente que sigue a la cámara (`fold`, plegado en el shader; la
 * CPU no mueve nada). Material `MeshBasicNodeMaterial` sin luces, solo
 * `colorNode`/`opacityNode`; los colores son HDR para que el bloom de F6 los
 * levante. Cero allocs por frame: `update()` copia la posición de cámara.
 *
 * Adaptación nocturna (T5.2.4, RW ilumina con faros de coche):
 *  1. cono de linterna (`torch.beamAt`, `?torch=1`, default off) que ilumina las
 *     rachas/salpicaduras dentro del haz; la linterna real es el `SpotLight` de
 *     `render/Torch.ts`, así que el agua y el terreno se ven iluminados por lo
 *     mismo (el shader solo hace el término que `MeshBasicNodeMaterial` no puede);
 *  2. brillo lunar `pow(max(dot(V, uMoonDir), 0), 8)` sumado al color: sin él
 *     la lluvia se pierde en el cielo negro;
 *  3. realce pálido `mix(..., (0.85,0.87,0.9), wet*0.6)` de §9.2;
 *  4. `uNightDim` = 0.35 (Weather.ts), subido desde 0.12 de §9.2.
 */
export interface RainEx {
  group: THREE.Group;
  /** Solo uniforms. La linterna los escribe `torch.update()`. Cero allocs. */
  update(camPos: THREE.Vector3): void;
  dispose(): void;
}

// Colores §9/T5.2.4 (lineales, HDR). El pálido de punta es literal de §9.2;
// el de luna copia el halo de §3, con ganancia ajustada en capturas. El color y
// el cono de la linterna viven en TORCH (constants.ts) y llegan por `torch`.
const PALE = [0.85, 0.87, 0.9] as const;
const MOON_COLOR = [0.55, 0.62, 0.8] as const;
const SPLASH_COLOR = [0.85, 0.9, 1.0] as const;
/** Ganancia del brillo lunar sobre la lluvia (≈ ×2 para verse de noche). */
const MOON_SHEEN_GAIN = 2.0;
/** Salpicaduras: color base elevado para el bloom de F6 (§T5.2.4.5). */
const SPLASH_GAIN = 5.0;
/** `y = height + 0.015` (§9.3): por encima del terreno, sin z-fighting. */
const SPLASH_LIFT = 0.015;

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createRain(
  scene: THREE.Scene,
  shared: Shared,
  quality: Quality,
  torch: TorchEx,
): RainEx {
  const counts = QUALITY[quality].rain;
  const group = new THREE.Group();
  group.name = 'rain';
  scene.add(group);

  const dbg = dbgRef();
  const off = pnum('rain', 1) <= 0;
  if (off) {
    // ?rain=0: ni mallas ni draw calls (A/B de las capturas). Weather pone GB=0.
    if (dbg) dbg.rain = { off: true, streaks: 0, splashes: 0, torch: torch.on };
    return {
      group,
      update: () => {},
      dispose(): void {
        scene.remove(group);
      },
    };
  }

  // Uniforms locales (no están en el contrato `shared`): cámara para el `fold`.
  // Los de la linterna los posee `render/Torch.ts` (los comparte con la niebla).
  const uCam = uniform(new THREE.Vector3());

  /** PCG de §9.2: `hash(instanceIndex*4 + k + 17)` (acepta uint directamente). */
  const hasher = (k: number): Node<'float'> =>
    hash(instanceIndex.mul(uint(4)).add(uint(k + 17)));

  // --- Rachas (§9.2) --------------------------------------------------------
  function buildStreaks(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    material.name = 'rain:streaks';

    const h0 = hasher(0);
    const h1 = hasher(1);
    const h2 = hasher(2);
    const h3 = hasher(3);
    const h4 = hasher(4);
    const h5 = hasher(5);
    const h6 = hasher(6);
    const h7 = hasher(7);

    const wet = shared.uWetness;
    const t = shared.uTime;
    const box = vec3(RAIN.box[0], RAIN.box[1], RAIN.box[2]);
    const center = uCam.add(vec3(0, 4, 0));

    // visible = hash(7) < GB
    const vis = select(h7.lessThan(shared.uRainAmount), float(1), float(0));
    // s = mix(8.5,12.5,hash(3))·(1-wet·0.45) — velocidad de caída (m/s).
    const s = mix(8.5, 12.5, h3).mul(wet.mul(0.45).oneMinus());
    // c = HB·(gust·1.4+0.6)·UB (viento XZ).
    const c = shared.uWindDir.mul(shared.uGust.mul(1.4).add(0.6)).mul(shared.uWindStrength);
    // base aleatoria advectada: viento en XZ (·0.8) y caída libre en Y.
    // Decisión documentada: §9.2 solo escribe «advectado por time*c*0.8» (c es
    // vec2, el viento); la componente Y que hace caer la lluvia es -t·s, que es
    // lo que da sentido a que `s` sea la longitud/velocidad de la racha.
    const base = vec3(
      h0.mul(RAIN.box[0]).add(t.mul(c.x).mul(0.8)),
      h1.mul(RAIN.box[1]).sub(t.mul(s)),
      h2.mul(RAIN.box[2]).add(t.mul(c.y).mul(0.8)),
    );
    // fold(p, cam, box) = p + round((cam-p)/box)·box (§9.1/T5.2.2, clave).
    const folded = base.add(round(center.sub(base).div(box)).mul(box));
    // g = normalize(vec3(c.x·0.8, -s, c.y·0.8)).negate() (apunta hacia arriba).
    const g = normalize(vec3(c.x.mul(0.8), s.negate(), c.y.mul(0.8))).negate();
    const side = normalize(cross(g, normalize(uCam.sub(folded))));
    // b = mix(0.2,0.48,h4)·s/10·(1-wet·0.4) — longitud real de la estría (m).
    const b = mix(0.2, 0.48, h4).mul(s.div(10)).mul(wet.mul(0.4).oneMinus());
    const x = mix(0.007, 0.012, h5).add(b.mul(0.0012)).mul(wet.mul(1.2).add(1));

    const uvv = uv();
    const world = folded
      .add(g.mul(uvv.y).mul(b))
      .add(side.mul(uvv.x.sub(0.5)).mul(x));
    material.positionNode = world;

    // Varyings por instancia (instanceIndex solo existe en el vertex shader).
    const visV = vis.toVarying('rainVis');
    const h6V = h6.toVarying('rainH6');
    const gV = g.toVarying('rainG');

    // --- Fragment: opacidad §9.2 ---
    // bordesUV: suaviza lados y extremos del quad (el doc no da la fórmula).
    const uv2 = uv();
    const borderX = smoothstep(0, 0.5, uv2.x).mul(smoothstep(0.5, 1, uv2.x).oneMinus());
    const borderY = smoothstep(0, 0.12, uv2.y).mul(smoothstep(0.88, 1, uv2.y).oneMinus());
    const dist = length(uCam.sub(positionWorld));
    const lit = torch.beamAt(positionWorld);
    const opacity = borderX
      .mul(borderY)
      .mul(smoothstep(0.3, 1.8, dist))
      .mul(smoothstep(7, 15, dist).oneMinus())
      .mul(mix(0.25, 0.5, h6V))
      .mul(visV)
      .mul(max(shared.uNightDim, lit.mul(1.4)));
    material.opacityNode = opacity;

    // --- Fragment: color §9.2 + T5.2.4 ---
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const facing = abs(dot(viewDir, gV));
    const vb = shared.uHorizonColor;
    const baseColor = mix(
      mix(vb.mul(2.1).add(0.12), vb.mul(0.8), facing),
      vec3(PALE[0], PALE[1], PALE[2]),
      shared.uWetness.mul(0.6),
    );
    const moonSheen = pow(max(dot(viewDir, shared.uMoonDir), 0), 8).mul(
      vec3(MOON_COLOR[0], MOON_COLOR[1], MOON_COLOR[2]),
    );
    material.colorNode = baseColor
      .mul(shared.uNightDim)
      .add(vec3(TORCH.color[0], TORCH.color[1], TORCH.color[2]).mul(lit).mul(TORCH.streakGain))
      .add(moonSheen.mul(MOON_SHEEN_GAIN));

    return material;
  }

  // --- Salpicaduras (§9.3) --------------------------------------------------
  function buildSplashes(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      // Aditivo: el agua brilla sobre el suelo oscuro y alimenta el bloom.
      blending: THREE.AdditiveBlending,
    });
    material.name = 'rain:splashes';

    const h0 = hasher(0);
    const h1 = hasher(1);
    const h2 = hasher(2);
    const h3 = hasher(3);
    const h4 = hasher(4);
    const h5 = hasher(5);
    const h6 = hasher(6);
    const h7 = hasher(7);

    const vis = select(h7.lessThan(shared.uRainAmount), float(1), float(0));
    const box = RAIN.splashBox;
    // Posición: hash en la caja 22×22 plegada sobre la cámara (solo XZ; la Y
    // sale del heightNode). fold aplicado por eje para reutilizar `round`.
    const bx = h0.mul(box);
    const bz = h1.mul(box);
    const fx = bx.add(round(uCam.x.sub(bx).div(box)).mul(box));
    const fz = bz.add(round(uCam.z.sub(bz).div(box)).mul(box));
    const fy = shared.uHeightNode(vec2(fx, fz)).add(SPLASH_LIFT);

    // Fase p = fract(t·mix(1.4,2.2,h2)+h3); radio m = mix(.04,.12,h4)·(p·.85+.15).
    const p = fract(shared.uTime.mul(mix(1.4, 2.2, h2)).add(h3));
    const m = mix(0.04, 0.12, h4).mul(p.mul(0.85).add(0.15)).mul(vis);

    // Plano horizontal (rotado al construir la geometría): local XZ → mundo XZ.
    // El quad cubre ±m; `r` normalizado vale 1 en el borde (anillo ~0.55–0.86 m).
    const wob = mix(0.75, 1.25, h5);
    const rot = h6.mul(6.2832);
    const cs = cos(rot);
    const sn = sin(rot);
    const lx = positionGeometry.x;
    const lz = positionGeometry.z;
    const rx = lx.mul(cs).sub(lz.mul(sn));
    const rz = lx.mul(sn).add(lz.mul(cs));
    const scale = m.mul(2);
    material.positionNode = vec3(fx.add(rx.mul(scale)), fy, fz.add(rz.mul(scale)));

    const rV = length(vec2(rx, rz.mul(wob))).mul(2).toVarying('rainSR');
    const fadeV = p.oneMinus().pow(2).toVarying('rainSFade');
    const wobV = mix(0.8, 1.15, h5).toVarying('rainSWob');
    const visV = vis.toVarying('rainSVis');

    // --- Fragment: opacidad §9.3 ---
    // ring = smoothstep(.55,.8,r)·(1-smoothstep(.86,1,r)); center en r→0.
    const ring = smoothstep(0.55, 0.8, rV).mul(smoothstep(0.86, 1, rV).oneMinus());
    const center = smoothstep(0, 0.35, rV).oneMinus().mul(0.7);
    const dist = length(uCam.sub(positionWorld));
    const lit = torch.beamAt(positionWorld);
    material.opacityNode = ring
      .add(center)
      .mul(fadeV)
      .mul(smoothstep(9, 13, dist).oneMinus())
      .mul(0.3)
      .mul(wobV)
      .mul(visV)
      .mul(max(shared.uNightDim, lit.mul(1.4)));

    // --- Fragment: color (el doc no lo fija; subido para el bloom) ---
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const moonSheen = pow(max(dot(viewDir, shared.uMoonDir), 0), 8);
    material.colorNode = vec3(SPLASH_COLOR[0], SPLASH_COLOR[1], SPLASH_COLOR[2])
      .mul(SPLASH_GAIN)
      .mul(shared.uNightDim)
      .add(vec3(TORCH.color[0], TORCH.color[1], TORCH.color[2]).mul(lit).mul(TORCH.splashGain))
      .add(vec3(MOON_COLOR[0], MOON_COLOR[1], MOON_COLOR[2]).mul(moonSheen).mul(0.8));

    return material;
  }

  const streakGeo = new THREE.PlaneGeometry(1, 1);
  const splashGeo = new THREE.PlaneGeometry(1, 1);
  splashGeo.rotateX(-Math.PI / 2);

  const streakMat = buildStreaks();
  const splashMat = buildSplashes();

  const streakMesh = new THREE.InstancedMesh(streakGeo, streakMat, counts.streaks);
  streakMesh.name = 'rain:streaks';
  streakMesh.frustumCulled = false;
  streakMesh.renderOrder = 20;
  streakMesh.layers.set(1); // capa 1: fuera del shadow map y de reflejos (§2.3)
  streakMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  group.add(streakMesh);

  const splashMesh = new THREE.InstancedMesh(splashGeo, splashMat, counts.splashes);
  splashMesh.name = 'rain:splashes';
  splashMesh.frustumCulled = false;
  splashMesh.renderOrder = 19;
  splashMesh.layers.set(1);
  splashMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  group.add(splashMesh);

  if (dbg) {
    dbg.rain = {
      off: false,
      streaks: counts.streaks,
      splashes: counts.splashes,
      box: [...RAIN.box],
      splashBox: RAIN.splashBox,
      torch: torch.on,
    };
  }

  function update(camPos: THREE.Vector3): void {
    // Lo único que se escribe por frame: uniforms (cero allocs, cero buffers).
    // La linterna no está aquí: sus tres uniforms los escribe `torch.update()`.
    uCam.value.copy(camPos);
  }

  function dispose(): void {
    scene.remove(group);
    streakGeo.dispose();
    splashGeo.dispose();
    streakMat.dispose();
    splashMat.dispose();
    streakMesh.dispose();
    splashMesh.dispose();
  }

  return { group, update, dispose };
}
