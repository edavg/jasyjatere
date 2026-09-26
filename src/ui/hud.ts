import type { AudioEx } from '../core/audio';
import { QUALITY, type Quality } from '../core/constants';
import type { Dbg } from '../core/dbg';
import { pbool } from '../core/params';
import type { WeatherEx } from '../weather/Weather';
import { RAIN_MAX, WIND_MAX } from '../weather/Weather';

/**
 * T7.2.2 (§12): HUD mínimo. Barras de lluvia/viento con `▮` y flash de 1.8 s al
 * cambiar (estilo RW), nota de backend persistente, teclas 1/2 lluvia, 3/4
 * viento, `-`/`=` volumen, `M` mute, `P` stats y log con `?debug=1`. ESC vive en
 * `main.ts` porque es quien conoce el menú.
 *
 * Presupuesto: `update()` corre cada frame pero solo escribe en el DOM cuando el
 * valor cuantizado cambia (lluvia/viento son teclazos, no rampas de frame) y
 * refresca stats/log a 4 y 2 Hz respectivamente, y solo si están visibles. Las
 * cadenas que genera ese refresco (y `renderer.info`) son la excepción
 * documentada al "cero allocs del bucle": es una ruta de depuración opt-in.
 */
export interface HudDeps {
  quality: Quality;
  backend: string;
  dpr: number;
  info: RendererInfoLike;
  dbg: Dbg;
  weather: WeatherEx;
  audio: AudioEx;
}

interface RendererInfoLike {
  render: { frameCalls: number; triangles: number };
  memory: { geometries: number; textures: number };
}

export interface Hud {
  update(dt: number): void;
  setVisible(v: boolean): void;
  readonly statsVisible: boolean;
  dispose(): void;
}

/** Celdas de las barras (lluvia 0..2, viento 0..2.5). */
const BAR_N = 20;
const RAIN_STEP = 0.15;
const WIND_STEP = 0.2;
const VOL_STEP = 0.05;
const STATS_HZ = 4;
const DEBUG_HZ = 2;

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`hud: falta #${id}`);
  return el as T;
}

/** `▮` para las celdas llenas, `·` para las vacías (monoespaciado). */
function bar(filled: number): string {
  let s = '';
  for (let i = 0; i < BAR_N; i++) s += i < filled ? '▮' : '·';
  return s;
}

/** Reinicia la animación CSS de flash de 1.8 s (reflow puntual, no por frame). */
function flash(el: HTMLElement): void {
  el.classList.remove('hud-flash');
  void el.offsetWidth;
  el.classList.add('hud-flash');
}

function num(v: unknown, def = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function fmt(v: number, digits = 2): string {
  return v.toFixed(digits);
}

function dbgRef(): Dbg | null {
  return (typeof window === 'undefined' ? null : (window as unknown as { __dbg?: Dbg }).__dbg) ?? null;
}

export function createHud(deps: HudDeps): Hud {
  const { quality, backend, info, weather, audio } = deps;
  const dbg = dbgRef() ?? deps.dbg;

  const root = need<HTMLDivElement>('hud');
  const backendEl = need<HTMLDivElement>('hudBackend');
  const rainBar = need<HTMLSpanElement>('hudRainBar');
  const rainNum = need<HTMLSpanElement>('hudRainNum');
  const windBar = need<HTMLSpanElement>('hudWindBar');
  const windNum = need<HTMLSpanElement>('hudWindNum');
  const volEl = need<HTMLDivElement>('hudVol');
  const perfEl = need<HTMLDivElement>('hudPerf');
  const torchEl = need<HTMLDivElement>('hudTorch');
  const statsEl = need<HTMLDivElement>('stats');
  const logEl = document.getElementById('debugLog');
  const debug = pbool('debug', false);

  backendEl.textContent = `${backend === 'webgpu' ? 'WEBGPU' : 'WEBGL2 FALLBACK'} · dpr ${fmt(deps.dpr)} · q ${quality}`;
  if (debug && logEl !== null) {
    logEl.style.display = 'block';
  }

  let visible = false;
  let statsVisible = false;
  let statsTimer = 0;
  let debugTimer = 0;
  let fps = 0;
  let frameMs = 0;
  let rainCells = -1;
  let windCells = -1;
  let volKey = -1;
  let torchOn: boolean | null = null;
  let perfShown: unknown = null;

  function setVisible(v: boolean): void {
    visible = v;
    root.classList.toggle('hidden', !v);
    // El panel de stats acompaña al HUD: con el menú abierto no debe flotar.
    statsEl.style.display = v && statsVisible ? 'block' : 'none';
  }

  function setStats(v: boolean): void {
    statsVisible = v;
    statsEl.style.display = visible && v ? 'block' : 'none';
    statsTimer = STATS_HZ; // refresca en el siguiente frame visible
  }

  // ?stats=1 abre el panel al arrancar (capturas de regresión del HUD).
  if (pbool('stats', false)) setStats(true);

  function refreshBars(): void {
    const r = weather.rain;
    const rCells = Math.max(0, Math.min(BAR_N, Math.round((r / RAIN_MAX) * BAR_N)));
    if (rCells !== rainCells) {
      rainCells = rCells;
      rainBar.textContent = bar(rCells);
      rainNum.textContent = fmt(r);
      flash(rainBar);
    }
    const w = weather.wind;
    const wCells = Math.max(0, Math.min(BAR_N, Math.round((w / WIND_MAX) * BAR_N)));
    if (wCells !== windCells) {
      windCells = wCells;
      windBar.textContent = bar(wCells);
      windNum.textContent = fmt(w);
      flash(windBar);
    }
    // Linterna (F): estado leído de __dbg.torch; parpadea al cambiar.
    const torch = dbg.torch;
    if (torch !== undefined && typeof torch.on === 'boolean' && torch.on !== torchOn) {
      torchOn = torch.on;
      torchEl.textContent = torchOn ? 'TORCH ON' : 'TORCH OFF';
      torchEl.classList.toggle('hud-torch-on', torchOn);
      flash(torchEl);
    }

    // F9: resultado de ?perf=N (una sola vez; se compara por referencia).
    if (dbg.perf !== undefined && dbg.perf !== perfShown) {
      perfShown = dbg.perf;
      const p = dbg.perf;
      perfEl.style.display = 'block';
      perfEl.textContent = `PERF ${p.fps} fps · p50 ${fmt(p.p50)} · p95 ${fmt(p.p95)} · max ${fmt(p.max)} ms\n${p.quality} · ${p.backend} · dpr ${fmt(p.dpr)} · ${p.frames} frames`;
      flash(perfEl);
    }

    // Clave numérica: volumen + flags en un solo entero (el texto solo se
    // recompone cuando cambia algo, no cada frame).
    const vp = Math.round(audio.volume * 100);
    const vk = vp * 4 + (audio.muted ? 2 : 0) + (audio.enabled ? 0 : 1);
    if (vk !== volKey) {
      volKey = vk;
      volEl.textContent = `VOL ${vp}%${audio.muted ? ' · MUTED' : ''}${audio.enabled ? '' : ' · AUDIO OFF'}`;
      flash(volEl);
    }
  }

  function refreshStats(): void {
    const q = QUALITY[quality];
    const grass = dbg.grass;
    const sc = dbg.scatterStats;
    const props = dbg.props;
    const post = dbg.post;
    const ao = post === undefined ? q.ao.samples : num((post.samples as Record<string, unknown> | undefined)?.ao, 0);
    const mb = post === undefined ? q.mb : num((post.samples as Record<string, unknown> | undefined)?.mb, 0);
    const taa = post === undefined ? '-' : String(post.taa);
    const lines = [
      `FPS ${fmt(fps, 1)} · ${fmt(frameMs, 2)} ms`,
      `DRAW ${num(info.render.frameCalls)} · TRIS ${(num(info.render.triangles) / 1000).toFixed(1)}k`,
      `GEO ${num(info.memory.geometries)} · TEX ${num(info.memory.textures)}`,
      `GRASS ${num(grass?.count)} (inst ${num(grass?.instanceCount)})`,
      `SCAT ${num(sc?.live)} live · ${fmt(num(sc?.lastScanMs))} ms · ${num(sc?.scans)} sc · blk ${num(sc?.blockers)}`,
      `TREES ${num(dbg.trees?.drawCalls)} dc · shadows ${num(dbg.trees?.shadowMeshes)} · lod2 ${num(dbg.trees?.lod2Meshes)}`,
      `PROPS ${num(props?.count)} · solids ${num(props?.solids)}`,
      `TERR ${num(dbg.tiles)} tiles · ${num(dbg.terrainTriangles)} tri`,
      `AO ${ao} @ ${q.ao.scale} · MB ${mb} · ${taa.toUpperCase()}`,
      `RAIN ${fmt(weather.rain)} · WIND ${fmt(weather.wind)} · preset ${weather.preset}`,
      `AUDIO ${audio.contextState} · vol ${fmt(audio.volume)}${audio.muted ? ' muted' : ''}`,
    ];
    statsEl.textContent = lines.join('\n');
  }

  function refreshDebug(): void {
    if (logEl === null) return;
    const a = audio.stats();
    const w = weather.state();
    const sc = dbg.scatterStats;
    logEl.textContent =
      `nightwoods q=${quality} ${backend} dpr=${fmt(deps.dpr)} fps=${fmt(fps, 1)} frame=${fmt(frameMs, 2)}ms ` +
      `gust=${fmt(num(dbg.gust), 2)} rain=${fmt(w.rain)} wind=${fmt(w.wind)} preset=${w.preset} clouds=${fmt(w.clouds)} wet=${fmt(w.wet)} ` +
      `scan=${fmt(num(sc?.lastScanMs))}ms scans=${num(sc?.scans)} live=${num(sc?.live)} checksum=${num(dbg.scatterChecksum)} ` +
      `tiles=${num(dbg.tiles)} grass=${num(dbg.grass?.count)} audio=${a.ctx} vol=${fmt(a.volume)} muted=${audio.muted ? 1 : 0} ` +
      `frame#${dbg.frame}`;
  }

  function onKey(e: KeyboardEvent): void {
    switch (e.code) {
      case 'Digit1':
        weather.setRain(weather.rain - RAIN_STEP);
        break;
      case 'Digit2':
        weather.setRain(weather.rain + RAIN_STEP);
        break;
      case 'Digit3':
        weather.setWind(weather.wind - WIND_STEP);
        break;
      case 'Digit4':
        weather.setWind(weather.wind + WIND_STEP);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        audio.setVolume(audio.volume - VOL_STEP);
        break;
      case 'Equal':
      case 'NumpadAdd':
        audio.setVolume(audio.volume + VOL_STEP);
        break;
      case 'KeyM':
        if (e.repeat) return;
        audio.toggleMute();
        break;
      case 'KeyP':
        if (e.repeat) return;
        setStats(!statsVisible);
        break;
      default:
        return;
    }
  }
  window.addEventListener('keydown', onKey);

  function update(dt: number): void {
    frameMs += (dt * 1000 - frameMs) * Math.min(1, dt * 6);
    if (dt > 1e-5) fps += (1 / dt - fps) * Math.min(1, dt * 2.5);

    refreshBars();

    if (statsVisible) {
      statsTimer += dt;
      if (statsTimer >= 1 / STATS_HZ) {
        statsTimer = 0;
        refreshStats();
      }
    }
    if (debug) {
      debugTimer += dt;
      if (debugTimer >= 1 / DEBUG_HZ) {
        debugTimer = 0;
        refreshDebug();
      }
    }
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKey);
  }

  return {
    update,
    setVisible,
    get statsVisible(): boolean {
      return statsVisible;
    },
    dispose,
  };
}
