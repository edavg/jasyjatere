// Espejo CPU puro del nodo de niebla de src/render/Fog.ts (§4 de la referencia).
// Sin imports (solo `node tools/verify-fog.ts` con type-stripping de Node 22).

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Factor de niebla §4 (dos Beer–Lambert + altura + suelo de distancia).
 * Defaults = FOG de constants.ts y zB de §4.
 */
export function fogFactor(
  dist: number,
  worldY: number,
  heightRef: number,
  density = 0.0062,
  near = 120,
  far = 185,
): number {
  const h = 1 - Math.exp(-dist * density);
  const g = clamp01(Math.exp(-0.9 * (worldY - heightRef))) * (1 - smoothstep(200, 600, dist));
  const w = 1 - smoothstep(heightRef - 220, heightRef - 60, worldY);
  const v = 1 - Math.exp(-dist * density * (g * 0.45 + w * 0.9));
  const y = smoothstep(near, far, dist);
  return clamp01(Math.max(1 - (1 - h) * (1 - v), y));
}
