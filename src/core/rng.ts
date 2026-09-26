// Hash PCG-avalanche idéntico bit a bit al de Rainy Worlds.
export function hash3(x: number, z: number, salt: number): number {
  let r = (x * 374761393 + z * 668265263 + salt * 1274126177) | 0;
  r = Math.imul(r ^ (r >>> 13), 1274126177);
  return ((r ^ (r >>> 16)) >>> 0) / 4294967296;
}

// hash2(x, salt) delega en hash3 desplazando el salt al eje z con una constante
// impar para que hash3(x, salt) y hash2(x, salt) no colisionen entre sí.
export function hash2(x: number, salt: number): number {
  return hash3(x, salt + 68268263, salt);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rand01(seed) es un hash3 determinista para semillas sueltas: mezcla la parte
// entera del seed con una constante de Knuth vía imul (sin perder bits) y la
// usa como coordenada z, con x = entero del seed.
export function rand01(seed: number): number {
  const xi = seed | 0;
  return hash3(xi, Math.imul(xi, 0x9e3779b1), 0);
}

// Ruido de valor 2D con interpolación bilineal y fade quíntico t³(t(6t−15)+10),
// rango ~[0,1]. La fuente canónica del LUT de altura (Fase 2) se implementará en
// src/assets/noise.ts siguiendo §5.1 de la referencia (5 octavas, semillas 11+i*7).
export function snoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fz);
  const a = hash3(ix, iz, seed);
  const b = hash3(ix + 1, iz, seed);
  const c = hash3(ix, iz + 1, seed);
  const d = hash3(ix + 1, iz + 1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
