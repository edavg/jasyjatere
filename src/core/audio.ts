import { pbool, pnum } from './params';
import { mulberry32 } from './rng';

/**
 * T7.2.3 (§12): audio ambiente 100 % procedural. Esqueleto de buses del
 * proyecto horror (`master` → `destination`, con `sfx` y `music` colgando de
 * `master`) + las tres capas de Rainy Worlds: lluvia (3 bandas), viento (rumor
 * + silbido) y trueno (sub-bursts solapados + sub). Cero assets: todo el ruido
 * sale de `AudioBuffer` generados una vez con `mulberry32` sembrado con `?seed=`.
 *
 * Política de autoplay: el `AudioContext` se crea de forma perezosa en
 * `unlock()` (el click de START); antes de eso `update()` solo cachea el clima.
 * Los `thunder()` recibidos antes de `unlock()` se descartan (todavía no hay
 * grafo al que conectarlos).
 *
 * `update()` no asigna: solo escribe `AudioParam` con `setTargetAtTime` sobre
 * nodos preasignados y avanza el paseo del jitter (arrays fijos).
 */
export interface AudioWeather {
  rain: number;
  wind: number;
  gust: number;
}

export interface AudioStats {
  ctx: string;
  enabled: boolean;
  muted: boolean;
  volume: number;
  rainLayers: number;
  windGain: number;
  thunderActive: number;
  burstMs: number;
  /** Pasos sintetizados disparados (F8). */
  steps: number;
}

export interface AudioEx {
  unlock(): Promise<void>;
  update(dt: number, w: AudioWeather): void;
  thunder(intensity: number, delay: number): void;
  /** Paso sintetizado del walker (F8): ruido corto filtrado. */
  step(run: boolean): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  toggleMute(): boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly enabled: boolean;
  readonly contextState: string;
  stats(): AudioStats;
  dispose(): void;
}

/** Frecuencias y Q de las 3 bandas de lluvia (T7.2.3: 500/1500/3200 Hz). El Q
 * sube con la banda (0.9/1.0/1.1) para que el ancho relativo BW = f/Q quede
 * ~1×f0 en las tres: bandas de ~1–3 kHz de ancho que se tocan/solapan
 * ligeramente (cubren ~220 Hz–4.6 kHz) sin que la de 3.2 kHz se vuelva un tono. */
const RAIN_FREQ = [500, 1500, 3200] as const;
const RAIN_Q = [0.9, 1.0, 1.1] as const;
/** Centros de las campanas gaussianas sobre rainAmount (0..2): llovizna, lluvia
 * media y lluvia fuerte (§T7.2.3). */
const RAIN_CENTER = [0.35, 1.0, 1.75] as const;
/** σ de cada campana: la grave cae rápido (a rain=0.05 la capa 1 es la única
 * audible), la aguda se ensancha para que la lluvia fuerte conserve cuerpo. */
const RAIN_SIGMA = [0.5, 0.55, 0.6] as const;
/** Exponente de la curva de potencia (max(rain,.05)/1.5)^.55 de §T7.2.3. El
 * suelo .05 es de la spec: evita pow(0). F9: se añade la puerta
 * `smoothstep(0, 0.05, rain)` que el texto de la spec dejaba como opción, para
 * que el preset `clear` (rain=0) sea silencio real y no una cama audible. */
const RAIN_POW = 0.55;
/** Ancho de la puerta de silencio de la lluvia (GB). */
const RAIN_GATE = 0.05;
/** Paseo aleatorio del jitter ±6 % sobre ganancia y frecuencia del filtro de
 * cada capa: nuevo objetivo cada 0.35–1.2 s (nunca un valor nuevo por frame). */
const JITTER = 0.06;
const JITTER_MIN = 0.35;
const JITTER_MAX = 1.2;
/** Constantes de suavizado (s) de `setTargetAtTime`: evitan zipper noise al
 * teclear 1/2/3/4 y al cambiar de preset. */
const TAU_RAIN = 0.25;
const TAU_WIND = 0.3;
const TAU_VOL = 0.05;
/** Silbido del viento: ganancia pico 0.05 (~−26 dB sobre el bus `sfx`) para que
 * sea un armónico fino sobre el rumor ((0.015+gust·0.11)·wind, hasta ~0.2) sin
 * enmascarar la lluvia. Puerta en gust 0.55 con caída lineal hasta 1.0. */
const WHISTLE_MAX = 0.05;
const WHISTLE_GATE = 0.55;
const WHISTLE_SPAN = 0.45;
/** Ruido blanco: un único buffer estéreo de 2 s, canales independientes. Cada
 * fuente arranca en un offset aleatorio (mulberry32) para que las capas no
 * queden en fase al compartir buffer. */
const NOISE_SECONDS = 2;
/** Ganancia de los buses `sfx`/`music` (music sin uso en v1, presente). */
const SFX_GAIN = 1;
const MUSIC_GAIN = 0.5;
/** Umbral de trueno "cercano": por debajo solo rumor de baja frecuencia, sin el
 * sub 55→32 Hz (en truenos lejanos el lowpass ya barre a 70 Hz y el sub solo
 * embarraría el bus). */
const CLOSE_THUNDER = 0.6;
/** Semillas derivadas de ?seed= (mismo criterio que Lightning: seed + salt). */
const SEED_BUFFER = 3301;
const SEED_JITTER = 3307;
const SEED_BURST = 3313;
const SEED_STEP = 3319;
/** Paso sintetizado (F8): bandpass grave + lowpass, envolvente ~90 ms. */
const STEP_BP_WALK = 170;
const STEP_BP_RUN = 220;
const STEP_PEAK_WALK = 0.1;
const STEP_PEAK_RUN = 0.16;
const STEP_LIFE = 0.11;
const VOLUME_KEY = 'nightwoods-volume';
const DEFAULT_VOLUME = 0.7;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Volumen persistido (nightwoods-volume); 0.7 si no hay nada válido. */
function storedVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw !== null) {
      const v = Number.parseFloat(raw);
      if (Number.isFinite(v)) return clamp(v, 0, 1);
    }
  } catch {
    /* localStorage no disponible (privacidad, file://) */
  }
  return DEFAULT_VOLUME;
}

function persistVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* localStorage no disponible */
  }
}

/** Ruido blanco estéreo con canales independientes, rng = mulberry32. */
function makeNoise(ctx: AudioContext, seconds: number, rng: () => number): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1;
  }
  return buf;
}

export function createAudio(): AudioEx {
  const enabledFlag = pbool('audio', true);
  const seed = pnum('seed', 1337);
  const volumeParam = pnum('volume', Number.NaN);
  const bufRng = mulberry32(seed + SEED_BUFFER);
  const jitterRng = mulberry32(seed + SEED_JITTER);
  const burstRng = mulberry32(seed + SEED_BURST);
  const stepRng = mulberry32(seed + SEED_STEP);

  let volume = Number.isFinite(volumeParam) ? clamp(volumeParam, 0, 1) : storedVolume();
  let mutedFlag = false;
  let disposed = false;
  let started = false;
  let ctx: AudioContext | null = null;
  let ctxState = 'none';
  let master: GainNode | null = null;
  let sfx: GainNode | null = null;
  let music: GainNode | null = null;
  let noise: AudioBuffer | null = null;

  // Clima cacheado: `update()` lo refresca siempre (aunque esté desactivado o
  // bloqueado) para que `stats()` funcione y al desbloquear arranque el valor.
  let rain = 0;
  let wind = 0;
  let gust = 0;
  // Ganancias objetivo calculadas por `update()` (stats sin leer el grafo).
  const layerOut = [0, 0, 0];
  let windOut = 0;
  // Jitter por capa (paseo aleatorio lento).
  const jitterTarget = [1, 1, 1];
  const jitterTimer = [0, 0, 0];

  // Nodos persistentes (preasignados; `update()` solo escribe sus params).
  const sources: AudioBufferSourceNode[] = [];
  const layerGain: GainNode[] = [];
  const layerFilter: BiquadFilterNode[] = [];
  let windLow: BiquadFilterNode | null = null;
  let windLowGain: GainNode | null = null;
  let windWhistle: BiquadFilterNode | null = null;
  let windWhistleGain: GainNode | null = null;
  // Timers vivos (delays de trueno + limpiezas) para dispose().
  const timers: number[] = [];
  let burstActive = 0;
  let burstMs = 0;
  let steps = 0;

  function ensure(): AudioContext {
    if (ctx) return ctx;
    const c = new window.AudioContext();
    ctx = c;
    // master = PRIMER createGain y único GainNode conectado a destination.
    // Los probes externos (tools/audio-probe.html) se enganchan aquí.
    master = c.createGain();
    master.gain.value = mutedFlag ? 0 : volume;
    master.connect(c.destination);
    sfx = c.createGain();
    sfx.gain.value = SFX_GAIN;
    sfx.connect(master);
    music = c.createGain();
    music.gain.value = MUSIC_GAIN;
    music.connect(master);
    noise = makeNoise(c, NOISE_SECONDS, bufRng);

    // Lluvia: ruido → bandpass (500/1500/3200) → gain de capa → sfx.
    for (let i = 0; i < 3; i++) {
      const src = c.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = RAIN_FREQ[i];
      bp.Q.value = RAIN_Q[i];
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(bp);
      bp.connect(g);
      g.connect(sfx);
      sources.push(src);
      layerFilter.push(bp);
      layerGain.push(g);
      jitterTarget[i] = 1 + (jitterRng() * 2 - 1) * JITTER;
      jitterTimer[i] = JITTER_MIN + jitterRng() * (JITTER_MAX - JITTER_MIN);
    }

    // Viento: rumor (lowpass 200+gust·520) + silbido (bandpass Q6).
    const windSrc = c.createBufferSource();
    windSrc.buffer = noise;
    windSrc.loop = true;
    windLow = c.createBiquadFilter();
    windLow.type = 'lowpass';
    windLow.frequency.value = 200 + gust * 520;
    windLow.Q.value = 0.7;
    windLowGain = c.createGain();
    windLowGain.gain.value = 0;
    windSrc.connect(windLow);
    windLow.connect(windLowGain);
    windLowGain.connect(sfx);
    sources.push(windSrc);

    const whistleSrc = c.createBufferSource();
    whistleSrc.buffer = noise;
    whistleSrc.loop = true;
    windWhistle = c.createBiquadFilter();
    windWhistle.type = 'bandpass';
    windWhistle.frequency.value = 560 + gust * 420;
    windWhistle.Q.value = 6;
    windWhistleGain = c.createGain();
    windWhistleGain.gain.value = 0;
    whistleSrc.connect(windWhistle);
    windWhistle.connect(windWhistleGain);
    windWhistleGain.connect(sfx);
    sources.push(whistleSrc);

    ctxState = c.state;
    return c;
  }

  /** Arranca las capas (una sola vez); offsets distintos para decorrelacionar. */
  function startLayers(): void {
    if (started) return;
    started = true;
    for (const src of sources) src.start(0, jitterRng() * NOISE_SECONDS);
  }

  async function unlock(): Promise<void> {
    if (!enabledFlag || disposed) return;
    const c = ensure();
    startLayers();
    if (c.state === 'suspended') {
      try {
        await c.resume();
      } catch {
        /* sin gesto válido el navegador puede rechazar; queda suspendido */
      }
    }
    ctxState = c.state;
  }

  /**
   * Trueno (T7.2.3): programa el burst con delay en segundos. 3–5 sub-bursts
   * solapados de ruido → lowpass con barrido 240→70 Hz durante 1.5–3 s, AM a
   * 1.5–3 Hz (oscilador LFO sumado a la envolvente) y pico ∝ (0.5+intensity);
   * el primer sub-burst es el golpe fuerte. Si intensity ≥ 0.6 (cercano) añade
   * un seno 55→32 Hz en ~1.2 s. Los bursts son raros: asignar aquí es aceptable.
   */
  function fireBurst(intensity: number): void {
    const c = ctx;
    if (!c || disposed || !sfx) return;
    const t0 = c.currentTime + 0.02;
    const n = 3 + Math.floor(burstRng() * 3);
    const basePeak = 0.5 + intensity;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];
    let end = 0;

    for (let i = 0; i < n; i++) {
      const offset = i === 0 ? 0 : (0.04 + burstRng() * 0.22) * i;
      const dur = 1.5 + burstRng() * 1.5;
      const peak = basePeak * (i === 0 ? 0.62 : 0.22 + burstRng() * 0.2);
      const start = t0 + offset;

      const src = c.createBufferSource();
      src.buffer = noise;
      src.loop = false;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(240 + burstRng() * 60, start);
      lp.frequency.exponentialRampToValueAtTime(70, start + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.02 + burstRng() * 0.04);
      g.gain.exponentialRampToValueAtTime(0.0006, start + dur);
      g.gain.setValueAtTime(0, start + dur + 0.05);
      const lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 1.5 + burstRng() * 1.5;
      const lfoGain = c.createGain();
      lfoGain.gain.value = peak * 0.28;
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);

      src.connect(lp);
      lp.connect(g);
      g.connect(sfx);
      src.start(start, burstRng() * NOISE_SECONDS);
      src.stop(start + dur + 0.05);
      lfo.start(start);
      lfo.stop(start + dur + 0.05);
      srcs.push(src, lfo);
      nodes.push(src, lp, g, lfo, lfoGain);
      end = Math.max(end, start + dur + 0.05 - t0);
    }

    if (intensity >= CLOSE_THUNDER) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      const start = t0;
      osc.frequency.setValueAtTime(55, start);
      osc.frequency.exponentialRampToValueAtTime(32, start + 1.2);
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, start);
      og.gain.exponentialRampToValueAtTime(0.3 + intensity * 0.35, start + 0.06);
      og.gain.exponentialRampToValueAtTime(0.0005, start + 1.3);
      og.gain.setValueAtTime(0, start + 1.4);
      osc.connect(og);
      og.connect(sfx);
      osc.start(start);
      osc.stop(start + 1.45);
      srcs.push(osc);
      nodes.push(osc, og);
      end = Math.max(end, 1.45);
    }

    burstActive += 1;
    burstMs = Math.round(end * 1000);
    const id = window.setTimeout(() => {
      for (const s of srcs) {
        try {
          s.stop();
        } catch {
          /* ya parado */
        }
      }
      for (const nd of nodes) {
        try {
          nd.disconnect();
        } catch {
          /* ya desconectado */
        }
      }
      burstActive -= 1;
    }, (end + 0.1) * 1000);
    timers.push(id);
  }

  function thunder(intensity: number, delay: number): void {
    if (!enabledFlag || disposed || !ctx) return;
    const i = clamp(intensity, 0, 1);
    const wait = Math.max(0, delay) * 1000;
    const id = window.setTimeout(() => {
      fireBurst(i);
    }, wait);
    timers.push(id);
  }

  /**
   * Paso sintetizado (F8): ruido corto → lowpass → bandpass grave (~170 Hz
   * marcha / ~220 Hz carrera) con envolvente exponencial de ~90 ms y jitter
   * ±20 % en pico/filtros para no sonar a metralleta. Asignación puntual
   * (pasos a ~2 Hz de media, nunca por frame).
   */
  function step(run: boolean): void {
    const c = ctx;
    if (!c || disposed || !sfx || !noise) return;
    const t0 = c.currentTime + 0.005;
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = false;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + stepRng() * 500;
    lp.Q.value = 0.6;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (run ? STEP_BP_RUN : STEP_BP_WALK) * (0.9 + stepRng() * 0.2);
    bp.Q.value = 1.1;
    const g = c.createGain();
    const peak = (run ? STEP_PEAK_RUN : STEP_PEAK_WALK) * (0.8 + stepRng() * 0.4);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + STEP_LIFE);
    g.gain.setValueAtTime(0, t0 + STEP_LIFE + 0.01);
    src.connect(lp);
    lp.connect(bp);
    bp.connect(g);
    g.connect(sfx);
    src.start(t0, stepRng() * NOISE_SECONDS);
    src.stop(t0 + STEP_LIFE + 0.02);
    steps += 1;
    const id = window.setTimeout(() => {
      try {
        src.stop();
      } catch {
        /* ya parado */
      }
      src.disconnect();
      lp.disconnect();
      bp.disconnect();
      g.disconnect();
    }, 400);
    timers.push(id);
  }

  /**
   * Cero asignaciones: solo `setTargetAtTime` sobre params preasignados y el
   * paseo del jitter (arrays fijos). Las ganancias jittereadas se guardan en
   * `layerOut`/`windOut` para que `stats()` no lea el grafo.
   */
  function update(dt: number, w: AudioWeather): void {
    rain = w.rain;
    wind = w.wind;
    gust = w.gust;
    if (!enabledFlag || disposed || !ctx || !windLow || !windLowGain || !windWhistleGain) return;

    const now = ctx.currentTime;
    const rainPow = Math.pow(Math.max(rain, 0.05) / 1.5, RAIN_POW);
    // Puerta de silencio: `clear` (rain=0) no debe dejar cama de ruido.
    const t = Math.min(1, Math.max(0, rain / RAIN_GATE));
    const gate = t * t * (3 - 2 * t);
    for (let i = 0; i < 3; i++) {
      jitterTimer[i] -= dt;
      if (jitterTimer[i] <= 0) {
        jitterTarget[i] = 1 + (jitterRng() * 2 - 1) * JITTER;
        jitterTimer[i] = JITTER_MIN + jitterRng() * (JITTER_MAX - JITTER_MIN);
      }
      const d = (rain - RAIN_CENTER[i]) / RAIN_SIGMA[i];
      const bell = Math.exp(-0.5 * d * d);
      const out = bell * rainPow * gate * jitterTarget[i];
      layerOut[i] = out;
      layerGain[i].gain.setTargetAtTime(out, now, TAU_RAIN);
      layerFilter[i].frequency.setTargetAtTime(RAIN_FREQ[i] * jitterTarget[i], now, TAU_RAIN);
    }

    windLow.frequency.setTargetAtTime(200 + gust * 520, now, TAU_WIND);
    windOut = (0.015 + gust * 0.11) * wind;
    windLowGain.gain.setTargetAtTime(windOut, now, TAU_WIND);
    if (windWhistle) windWhistle.frequency.setTargetAtTime(560 + gust * 420, now, TAU_WIND);
    const whistle = Math.max(0, (gust - WHISTLE_GATE) / WHISTLE_SPAN) * WHISTLE_MAX * wind;
    windWhistleGain.gain.setTargetAtTime(whistle, now, TAU_WIND);
  }

  function setVolume(v: number): void {
    volume = clamp(v, 0, 1);
    if (ctx && master) master.gain.setTargetAtTime(mutedFlag ? 0 : volume, ctx.currentTime, TAU_VOL);
    persistVolume(volume);
  }

  function setMuted(m: boolean): void {
    mutedFlag = m;
    if (ctx && master) master.gain.setTargetAtTime(m ? 0 : volume, ctx.currentTime, TAU_VOL);
  }

  function toggleMute(): boolean {
    setMuted(!mutedFlag);
    return mutedFlag;
  }

  function stats(): AudioStats {
    return {
      ctx: ctxState,
      enabled: enabledFlag,
      muted: mutedFlag,
      volume,
      rainLayers: layerOut[0] + layerOut[1] + layerOut[2],
      windGain: windOut,
      thunderActive: burstActive,
      burstMs,
      steps,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const id of timers) window.clearTimeout(id);
    timers.length = 0;
    if (started) {
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          /* ya parado */
        }
        src.disconnect();
      }
    }
    started = false;
    sources.length = 0;
    layerGain.length = 0;
    layerFilter.length = 0;
    windLow = null;
    windLowGain = null;
    windWhistle = null;
    windWhistleGain = null;
    master = null;
    sfx = null;
    music = null;
    noise = null;
    burstActive = 0;
    burstMs = 0;
    steps = 0;
    if (ctx) {
      void ctx.close().catch(() => undefined);
      ctx = null;
    }
    ctxState = 'none';
  }

  return {
    unlock,
    update,
    thunder,
    step,
    setVolume,
    setMuted,
    toggleMute,
    get volume() {
      return volume;
    },
    get muted() {
      return mutedFlag;
    },
    get enabled() {
      return enabledFlag;
    },
    get contextState() {
      return ctxState;
    },
    stats,
    dispose,
  };
}
