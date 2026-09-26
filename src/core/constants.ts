export type Quality = 'low' | 'medium' | 'high';

// grass.n es el lado de la rejilla (celdas) y grass.k las briznas por celda:
// instancias = n*n*k -> low 37 632 · medium 153 600 · high 256 000.
export const QUALITY = {
  low:    { grass:{n:112,k:3},  trees:0.62, props:0.6, rain:{streaks:5000, splashes:900},   shadow:1024, dpr:1.0,  ao:{samples:0, scale:0},    mb:0, taau:0.66 },
  medium: { grass:{n:160,k:6},  trees:0.8,  props:0.8, rain:{streaks:10000,splashes:1800}, shadow:1536, dpr:1.25, ao:{samples:8, scale:0.55}, mb:6, taau:0.75 },
  high:   { grass:{n:160,k:10}, trees:1,    props:1,   rain:{streaks:16000,splashes:2800}, shadow:2048, dpr:1.5,  ao:{samples:12,scale:0.65}, mb:8, taau:0.75 },
} as const;

export const SUN = { offset:[38,78,26] as const, color:[0.55,0.65,0.90] as const, intensity:0.14,
  shadowR:42, near:4, far:220, bias:-6e-4, normalBias:0.08, radius:4 } as const;
export const HEMI = { sky:[0.55,0.60,0.70] as const, ground:[0.12,0.11,0.09] as const, intensity:0.04 } as const;
export const SKY = { radius:470, segments:[48,24] as const, zenith:[0.028,0.032,0.042] as const, horizon:[0.010,0.012,0.018] as const, envIntensity:0.06 } as const;
export const FOG = { color:[0.02,0.023,0.032] as const, density:0.0062, near:120, far:185 } as const;
export const GRASS = { cell:0.5, tiers:{ low:QUALITY.low.grass, medium:QUALITY.medium.grass, high:QUALITY.high.grass } } as const;
export const TREES = { lodScale:{ low:QUALITY.low.trees, medium:QUALITY.medium.trees, high:QUALITY.high.trees } } as const;
export const WORLD = { tile:32, grid:11, terrainSegs:32, noiseRes:512, amplitude:[6.5,0.55] as const, periods:[384,47] as const, rot:0.62, uvOff:[0.37,0.11] as const } as const;
export const POST = { exposure:0.8, bloom:0.05, bloomRadius:0.35, bloomThreshold:1.4, motion:0, ca:0.006, grain:0.022, vignette:0.12, sharpen:0.14, ao:1, saturation:1.58, contrast:1.13, fog:1, rain:1.48, wind:1.64, aa:'traa' } as const;
export const RAIN = { tiers:{ low:QUALITY.low.rain, medium:QUALITY.medium.rain, high:QUALITY.high.rain }, box:[24,16,24] as const, splashBox:22, nightDim:0.12 } as const;
export const WIND = { dir:[0.82,0.38] as const, strength:1.64, gustMin:0.15, gustMax:0.85, everyMin:3, everyMax:10, gustLerp:0.35, heightRefLerp:2 } as const;
export const CAMERA = { fov:62, near:0.08, far:520, eye:1.70, radius:0.32 } as const;
