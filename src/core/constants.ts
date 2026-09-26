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
// Linterna en primera persona (T5.2.4.1). RW ilumina la noche con los faros del
// coche: cono ancho y cálido (ámbar), borde muy suave, caída rapide y con el
// punto caliente lejos (la carretera, no los pies). Aquí el MISMO haz va montado
// en el rig de la cámara, así que no hay coche: una linterna en la mano derecha.
// Constantes medidas sobre capturas de `?q=medium&scene=drive` y afinadas con el
// A/B de artifacts/torch-*. NUNCA copiadas de su bundle: algoritmo y números.
//   cosIn/cosOut  cono del shader (lluvia/niebla): 12° interior, 22° exterior.
//   falloff       1/(1+d²·k) del shader; 0.71 a 10 m, 0.38 a 20 m.
//   angle/penumbra del SpotLight: 39° medios, penumbra 0.7 = borde sin aro duro.
//   intensity/decay  candelas y exponente de caída. decay 1.0 (NO el 2 físico):
//                 un faro es un haz colimado, no una vela; con 2 el haz muere a
//                 12 m y RW llega a 30. Con 1.0 el perfil medido sale 28/37/35/42
//                 a 20/12/8/6 m y 78-98 en el primer plano (fila 3 m), que es lo
//                 más cercano al wash de RW con el que se puede comparar (el de
//                 RW está medido desde el asiento, 12 km/h, con el capó tapando
//                 el suelo cercano: el A/B está en artifacts/torch-*.png).
//                 OJO: `?torchi` es MULTIPLICADOR de este valor, no absoluto.
//   distance      corte de la ventana física; a 70 m el borde se apaga solo.
//   tilt          caída del objetivo por metro de alcance (0 = haz horizontal,
//                  como el RW de la captura). Se midió que inclinarlo hacia abajo
//                  amplify el primer plano (el cono abre más cerca) sin ganancia.
//   color         3000 K lineal; el ámbar de RW se nota sobre suelo oscuro.
//   fogGain       cuánto brilla la niebla dentro del haz (RW: el cono se ve en la
//                 lluvia, no solo en las gotas).
export const TORCH = { color:[1.0,0.84,0.60] as const, cosIn:0.978, cosOut:0.925, falloff:0.004,
  intensity:48, distance:70, angle:0.68, penumbra:0.7, decay:1.0, tilt:0,
  offset:[0.22,-0.14,0] as const, bias:-6e-4, normalBias:0.08, radius:3,
  streakGain:2.2, splashGain:2.5, fogGain:0.35 } as const;
export const CAMERA = { fov:62, near:0.08, far:520, eye:1.70, radius:0.32 } as const;
