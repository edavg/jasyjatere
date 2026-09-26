import { Vector2, Vector3, type Node } from 'three/webgpu';
import { Fn, float, uniform } from 'three/tsl';

/**
 * Contrato `shared` (F1–F5): bolsa única de uniforms/nodos compartidos entre
 * cielo, niebla, césped, árboles, props y lluvia. El orquestador fija la forma;
 * las fases solo escriben `.value` (o reemplazan `uHeightNode`, que es el único
 * campo mutado por F2). Cualquier consumidor debe leer `shared.x`, nunca
 * desestructurar al cargar el módulo (ver `uHeightNode`).
 */
/** Firma del nodo de altura: `(vec2 worldXZ) -> float`. */
export interface HeightNodeFn {
  (xz: Node<'vec2'>): Node<'float'>;
}

const uHeightNode: HeightNodeFn = Fn((_xz: [Node<'vec2'>]) => float(0));

export const shared = {
  /** tiempo acumulado en segundos (lo avanza `Environment.update`) */
  uTime: uniform(0),
  /** dirección normalizada de la luna, = normalize(SUN.offset) */
  uMoonDir: uniform(new Vector3(38, 78, 26).normalize()),
  /** racha de viento 0..1 (oscilador §2.5) */
  uGust: uniform((0.15 + 0.85) * 0.5),
  /** dirección XZ del viento, normalizada (§6.6 HB) */
  uWindDir: uniform(new Vector2(0.82, 0.38).normalize()),
  /** fuerza del viento (UB), WIND.strength por defecto */
  uWindStrength: uniform(1.64),
  /** destello de rayo 0..1 (F5) */
  uFlash: uniform(0),
  /** acimut XZ del rayo, normalizado (F5) */
  uFlashDir: uniform(new Vector2(0, 1)),
  /** color de horizonte/niebla (VB) */
  uHorizonColor: uniform(new Vector3(0.02, 0.023, 0.032)),
  /** densidad de niebla (zB), FOG.density por defecto */
  uFogDensity: uniform(0.0062),
  /** (near, far) del suelo de distancia de niebla (BB) */
  uFogNearFar: uniform(new Vector2(120, 185)),
  /** referencia de altura de niebla (KB), suavizada hacia la cámara */
  uFogHeightRef: uniform(0),
  /** nubosidad rV 0..1 (F5 Weather) */
  uClouds: uniform(0.6),
  /** densidad/umbral de lluvia GB 0..2 (F5 Weather) */
  uRainAmount: uniform(1.0),
  /** mojado/precipitación iV 0..1 (F5 Weather) */
  uWetness: uniform(0.7),
  /** atenuación nocturna de la lluvia XB */
  uNightDim: uniform(0.12),
  /** claro de landmark (x, z, radio) para el fade del césped (F3/F4) */
  uClear: uniform(new Vector3(0, 0, 0)),
  /**
   * (vec2 worldXZ) -> float altura. Por defecto plano; la Fase 2 lo sustituye
   * por el nodo del Heightfield. ¡Leer siempre `shared.uHeightNode(...)`, no
   * capturarlo en una variable al importar!
   */
  uHeightNode,
};

export type Shared = typeof shared;