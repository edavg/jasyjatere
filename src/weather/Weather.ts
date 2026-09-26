import { WIND, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pnum, pstr } from '../core/params';
import type { Shared } from '../core/shared';

declare module '../core/dbg' {
  interface Dbg {
    weather?: Record<string, unknown>;
  }
}

/**
 * T5.2.1 (§9/§12): driver de clima. Escribe los uniforms compartidos que leen
 * los materiales: `uRainAmount` (GB, umbral de densidad de lluvia 0..2),
 * `uWindStrength` (UB 0..2.5), `uClouds` (rV 0..1), `uWetness` (iV 0..1) y
 * `uNightDim` (XB). Rain.ts los lee en vivo desde su shader.
 */
export interface WeatherState {
  rain: number;
  wind: number;
  preset: string;
  clouds: number;
  wet: number;
}

export interface WeatherEx {
  update(dt: number): void;
  readonly rain: number;
  readonly wind: number;
  readonly preset: string;
  setRain(v: number): void;
  setWind(v: number): void;
  cyclePreset(): void;
  state(): WeatherState;
  dispose(): void;
}

const RAIN_MIN = 0;
/** Techo de GB (lluvia) para el HUD/barras (§12: 0..2). */
export const RAIN_MAX = 2;
const WIND_MIN = 0;
/** Techo de UB (viento) para el HUD/barras (§12: 0..2.5). */
export const WIND_MAX = 2.5;

/** Valores canónicos del preset `rain` (el default): GB, UB y rV base. */
const CANON = { rain: 1, wind: WIND.strength, clouds: 0.6 } as const;

/**
 * Presets T5.2.1: multiplicadores sobre `CANON` (= `rain`). El doc no da la
 * tabla numérica, así que estos son los valores elegidos (ver capturas
 * `artifacts/fase-5-*`). GB resultante: 0 / 0.45 / 1 / 1.9; UB: 0.49 / 1.07 /
 * 1.64 / 2.30; rV: 0.09 / 0.42 / 0.69 / 0.99.
 */
const PRESETS = [
  { name: 'clear', rain: 0, wind: 0.3, clouds: 0.15 },
  { name: 'drizzle', rain: 0.45, wind: 0.65, clouds: 0.7 },
  { name: 'rain', rain: 1, wind: 1, clouds: 1.15 },
  { name: 'storm', rain: 1.9, wind: 1.4, clouds: 1.65 },
] as const;

const DEFAULT_PRESET = 2; // 'rain'
/** Oscilador de nubes T5.2.1: rampa 0→1 al 90 % en ~4.6 s (k = 0.5). */
const CLOUDS_K = 0.5;
/** El mojado iV sigue a la lluvia con una rampa corta (sin saltos al teclear). */
const WET_K = 3;
/**
 * T5.2.4.4: XB subido de `RAIN.nightDim` (0.12) a 0.35 — decisión de arte tras
 * el bucle captura-ajuste de la fase. El color y la opacidad de §9.2 multiplican
 * ambos XB, así que el brillo efectivo va con XB² (0.014 → 0.12): la lluvia se
 * ve contra el cielo negro sin parecer cal blanca. Ver `fase-5-rain*.png`.
 */
const NIGHT_DIM = 0.35;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dbgRef(): Dbg | null {
  return (window as unknown as { __dbg?: Dbg }).__dbg ?? null;
}

export function createWeather(shared: Shared, _quality: Quality): WeatherEx {
  let rain = CANON.rain * PRESETS[DEFAULT_PRESET].rain;
  let wind = CANON.wind * PRESETS[DEFAULT_PRESET].wind;
  let cloudsTarget = CANON.clouds * PRESETS[DEFAULT_PRESET].clouds;
  let clouds = 0; // arranca en 0 y rampa hacia el target (§T5.2.1)
  let wet = 0;
  let presetIdx = DEFAULT_PRESET;
  let label: string = PRESETS[DEFAULT_PRESET].name;

  function applyPreset(): void {
    const p = PRESETS[presetIdx];
    rain = clamp(CANON.rain * p.rain, RAIN_MIN, RAIN_MAX);
    wind = clamp(CANON.wind * p.wind, WIND_MIN, WIND_MAX);
    cloudsTarget = CANON.clouds * p.clouds;
  }

  // Params de URL: ?preset= aplica el preset; ?rain=N y ?wind=N lo sobrescriben
  // (los overrides numéricos pasan a `custom`). `?rain=0` además hace que Rain
  // no cree mallas (lo comprueba por su cuenta con el mismo param).
  const presetParam = pstr('preset', '');
  if (presetParam !== '') {
    const idx = PRESETS.findIndex((p) => p.name === presetParam);
    if (idx >= 0) {
      presetIdx = idx;
      label = PRESETS[idx].name;
    }
  }
  applyPreset();
  const rainParam = pnum('rain', Number.NaN);
  if (Number.isFinite(rainParam)) {
    rain = clamp(rainParam, RAIN_MIN, RAIN_MAX);
    label = 'custom';
  }
  const windParam = pnum('wind', Number.NaN);
  if (Number.isFinite(windParam)) {
    wind = clamp(windParam, WIND_MIN, WIND_MAX);
    label = 'custom';
  }
  if (pnum('rain', 1) <= 0) rain = 0;

  function setRain(v: number): void {
    rain = clamp(v, RAIN_MIN, RAIN_MAX);
    label = 'custom';
  }

  function setWind(v: number): void {
    wind = clamp(v, WIND_MIN, WIND_MAX);
    label = 'custom';
  }

  function cyclePreset(): void {
    presetIdx = (presetIdx + 1) % PRESETS.length;
    label = PRESETS[presetIdx].name;
    applyPreset();
  }

  // T7.2.2: las teclas 1/2/3/4 (lluvia/viento) y P (stats) pasan al HUD; aquí
  // solo queda la API (`setRain`/`setWind`/`cyclePreset`) que el HUD invoca.
  const dbg = dbgRef();
  const dbgWeather: Record<string, unknown> = {
    rain,
    wind,
    preset: label,
    clouds,
    wet,
  };
  if (dbg) dbg.weather = dbgWeather;

  function update(dt: number): void {
    // Oscilador de nubes (§2.5/T5.2.1): aproximación exponencial acotada.
    clouds += (cloudsTarget - clouds) * Math.min(1, dt * CLOUDS_K);
    // iV: mojado ~ precipitación (§9.2: 1.0 por defecto con lluvia `rain`).
    const wetTarget = clamp(0.3 + rain * 0.7, 0, 1);
    wet += (wetTarget - wet) * Math.min(1, dt * WET_K);

    shared.uRainAmount.value = rain;
    shared.uWindStrength.value = wind;
    shared.uClouds.value = clouds;
    shared.uWetness.value = wet;
    shared.uNightDim.value = NIGHT_DIM;

    dbgWeather.rain = rain;
    dbgWeather.wind = wind;
    dbgWeather.preset = label;
    dbgWeather.clouds = clouds;
    dbgWeather.wet = wet;
  }

  function state(): WeatherState {
    return { rain, wind, preset: label, clouds, wet };
  }

  function dispose(): void {
    /* sin recursos propios: la API queda viva hasta el desmontaje global */
  }

  return {
    update,
    get rain() {
      return rain;
    },
    get wind() {
      return wind;
    },
    get preset() {
      return label;
    },
    setRain,
    setWind,
    cyclePreset,
    state,
    dispose,
  };
}
