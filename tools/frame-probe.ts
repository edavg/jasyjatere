import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, KeyInput, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * frame-probe — estrés de streaming al volar (T7.2.4).
 *
 * Con `?fly=1` + Shift (boost ×5 → 100 m/s) el rig cruza el umbral de 3 m del
 * `scatter.update` casi cada frame: este harness mide el coste del escaneo y el
 * pico de frame frente al régimen, antes/después de tocar `Scatter.ts`.
 *
 *   node tools/frame-probe.ts [--url http://127.0.0.1:5175/] [--q high]
 *                             [--seconds 12] [--warmup 2] [--viewport 640x400]
 *                             [--no-boost] [--saturate 4000] [--json]
 *
 * Método: auto-spawn del dev server en el puerto de `--url` si no responde →
 * `?q=<q>&fly=1&cam=0,60,0&look=0,0` (WASD sin ground-follow, rumbo -Z fijo) →
 * click START → `__dbg.frame > 20` → `--warmup` s de asentamiento → `--saturate`
 * ms para saturar la cola de WebGPU (como `bench.ts`; sin eso rAF solo mide el
 * encode CPU) → snapshot de `__dbg.scatterStats` → W (+ Shift salvo
 * `--no-boost`) y muestreo DENTRO de la página (un `page.evaluate`) de los
 * deltas de rAF y de `scatterStats.lastScanMs` cada vez que `scans` avanza →
 * snapshot final.
 *
 * OJO: headless corre sobre SwiftShader (WebGPU en CPU), así que los ms
 * absolutos de frame NO representan una GPU real. La señal fiable del escaneo es
 * `lastScanMs` (JS puro: celdas + matrices + reconcile) y el pico de frame
 * relativo al régimen.
 *
 * Criterios PASS/WARN/FAIL (documentados aquí y repetidos en la salida):
 *   1. 0 errores de consola (warnings solo se cuentan). → FAIL.
 *   2. `p95(lastScanMs) < 16 ms` y `max(lastScanMs) < 16 ms` — un escaneo no
 *      debe comerse un frame de 60 fps. → FAIL.
 *   3. `max(delta de frame) <= 3 · p95(delta) + 1 ms` (tolerancia de scheduler).
 *      Si se incumple pero el peor frame CON escaneo no supera al peor frame SIN
 *      escaneo (ni el umbral 3·p95+1), el pico es del entorno (SwiftShader/
 *      scheduler/máquina compartida), no del streaming: → WARN, no FAIL.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_URL = 'http://127.0.0.1:5175/';

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(name);
}

function value(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

function num(name: string, def: number): number {
  const raw = value(name);
  if (raw === undefined) return def;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

async function respondsTo(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function parseViewport(raw: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (m === null) throw new Error(`--viewport inválido: ${raw} (usa WxH)`);
  return { width: Number.parseInt(m[1], 10), height: Number.parseInt(m[2], 10) };
}

/** Percentil sobre un array ya ordenado (ceil: p50 devuelve muestra real). */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Pearson sobre el prefijo común; 0 si no hay varianza suficiente. */
function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const den = Math.sqrt(saa * sbb);
  return den === 0 ? 0 : sab / den;
}

interface ScatterStatsLike {
  scans?: number;
  lastScanMs?: number;
  [key: string]: unknown;
}

interface DbgLike {
  backend?: string;
  dpr?: number;
  frame?: number;
  scatterStats?: ScatterStatsLike;
  scatterChecksum?: number;
}

interface Snapshot {
  frame: number;
  backend: string;
  dpr: number;
  checksum: number | null;
  stats: Record<string, number> | null;
}

async function bootPage(page: Page, url: string, timeout: number): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction('window.__dbg !== undefined', { timeout });
  await page.waitForSelector('#start:not([disabled])', { timeout });
  await page.click('#start:not([disabled])');
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout });
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const d = (window as unknown as { __dbg?: DbgLike & { scatterStats?: Record<string, number> } })
      .__dbg;
    return {
      frame: d?.frame ?? 0,
      backend: d?.backend ?? '',
      dpr: d?.dpr ?? 0,
      checksum: d?.scatterChecksum ?? null,
      stats: d?.scatterStats ?? null,
    };
  });
}

interface RawProbe {
  deltas: number[];
  scanMs: number[];
  /** Índice (en `deltas`) del frame en que se detectó cada escaneo. */
  scanIdx: number[];
  /** Estado del pool publicado en cada escaneo (para atribuir el coste). */
  scanLive: number[];
  scanSlots: number[];
  scanAccepted: number[];
  frameStart: number;
  frameEnd: number;
  scans0: number;
  scansEnd: number;
}

/** Muestreo in-page (sin ida/vuelta por frame) de deltas de rAF y escaneos. */
async function measureFlight(page: Page, seconds: number): Promise<RawProbe> {
  return page.evaluate(async (secs: number) => {
    interface DbgInPage {
      frame?: number;
      scatterStats?: {
        scans?: number;
        lastScanMs?: number;
        live?: number;
        slots?: number;
        accepted?: number;
      };
    }
    const d = (window as unknown as { __dbg?: DbgInPage }).__dbg;
    const deltas: number[] = [];
    const scanMs: number[] = [];
    const scanIdx: number[] = [];
    const scanLive: number[] = [];
    const scanSlots: number[] = [];
    const scanAccepted: number[] = [];
    const frameStart = d?.frame ?? 0;
    const scans0 = d?.scatterStats?.scans ?? 0;
    let scansPrev = scans0;
    const t0 = performance.now();
    let prev = t0;
    let done = false;
    await new Promise<void>((resolvePromise) => {
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolvePromise();
      };
      // Red de seguridad: si rAF se detiene (pestaña oculta, crash suave) no colgar.
      const guard = setTimeout(finish, (secs + 10) * 1000);
      const tick = (): void => {
        const now = performance.now();
        deltas.push(now - prev);
        prev = now;
        const st = d?.scatterStats;
        if (st !== undefined && typeof st.scans === 'number' && st.scans > scansPrev) {
          scanMs.push(st.lastScanMs ?? 0);
          scanIdx.push(deltas.length - 1);
          scanLive.push(st.live ?? 0);
          scanSlots.push(st.slots ?? 0);
          scanAccepted.push(st.accepted ?? 0);
          scansPrev = st.scans;
        }
        if (done || (now - t0) / 1000 >= secs) finish();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      deltas,
      scanMs,
      scanIdx,
      scanLive,
      scanSlots,
      scanAccepted,
      frameStart,
      frameEnd: d?.frame ?? 0,
      scans0,
      scansEnd: d?.scatterStats?.scans ?? scans0,
    };
  }, seconds);
}

interface FrameTop {
  ms: number;
  scan: boolean;
  lastScanMs: number;
}

interface Summary {
  url: string;
  q: string;
  viewport: string;
  boost: boolean;
  seconds: number;
  warmup: number;
  backend: string;
  dpr: number;
  frames: number;
  fps: number;
  frameMean: number;
  frameP50: number;
  frameP90: number;
  frameP95: number;
  frameP99: number;
  frameMax: number;
  scans: number;
  scansPerS: number;
  scanCount: number;
  scanMean: number;
  scanP50: number;
  scanP95: number;
  scanMax: number;
  /** Media de lastScanMs en la 1ª y 2ª mitad de la ventana (¿crece con slots?). */
  scanFirstHalfMean: number;
  scanSecondHalfMean: number;
  /** Pool al primer y último escaneo muestreado. */
  scanLiveFirst: number;
  scanLiveLast: number;
  scanSlotsFirst: number;
  scanSlotsLast: number;
  /** Correlación de lastScanMs con live/slots (¿el coste depende del pool?). */
  corrScanLive: number;
  corrScanSlots: number;
  /** Máx./p95/media de delta de frame en frames CON escaneo y SIN escaneo. */
  frameScanMax: number;
  frameScanP95: number;
  frameScanMean: number;
  frameNoScanMax: number;
  frameNoScanP95: number;
  frameNoScanMean: number;
  /** Delta medio imputable al escaneo (media con scan − media sin scan, ms). */
  frameScanDelta: number;
  top: Array<{ ms: number; scan: boolean; lastScanMs: number }>;
  acceptedBefore: number;
  acceptedAfter: number;
  liveBefore: number;
  liveAfter: number;
  slotsBefore: number;
  slotsAfter: number;
  checksumBefore: number | null;
  checksumAfter: number | null;
  consoleErrors: string[];
  consoleWarnings: number;
  consoleWarningSamples: string[];
  fails: string[];
  warns: string[];
  verdict: 'PASS' | 'WARN' | 'FAIL';
  pass: boolean;
}

async function finish(proc: { browser: Browser | null; server: ChildProcess | null }): Promise<void> {
  if (proc.browser) {
    try {
      await proc.browser.close();
    } catch {
      /* el navegador ya estaba cerrado */
    }
  }
  if (proc.server?.pid) {
    try {
      process.kill(-proc.server.pid, 'SIGTERM');
    } catch {
      /* el server ya había terminado */
    }
  }
}

async function main(): Promise<void> {
  const baseUrl = value('--url') ?? DEFAULT_URL;
  const q = value('--q') ?? 'high';
  const seconds = Math.max(1, num('--seconds', 12));
  const warmupS = Math.max(0, num('--warmup', 2));
  const saturateMs = Math.max(0, Math.round(num('--saturate', 4000)));
  const viewport = parseViewport(value('--viewport') ?? '640x400');
  const boost = !flag('--no-boost');
  const timeout = num('--timeout', 600000);
  const jsonOnly = flag('--json');

  const url = new URL(baseUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('fly', '1');
  url.searchParams.set('cam', '0,60,0');
  url.searchParams.set('look', '0,0');

  const proc: { browser: Browser | null; server: ChildProcess | null } = {
    browser: null,
    server: null,
  };
  const consoleErrors: string[] = [];
  const warningSamples: string[] = [];
  let consoleWarnings = 0;

  try {
    if (!(await respondsTo(baseUrl))) {
      const port = new URL(baseUrl).port || '5175';
      proc.server = spawn('npm', ['run', 'dev', '--', '--port', port], {
        cwd: ROOT,
        stdio: 'ignore',
        detached: true,
      });
      proc.server.unref();
      const deadline = Date.now() + 30000;
      let up = false;
      while (Date.now() < deadline) {
        await sleep(400);
        if (await respondsTo(baseUrl)) {
          up = true;
          break;
        }
      }
      if (!up) throw new Error('el dev server no respondió en 30 s');
    }

    proc.browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--no-sandbox',
        '--hide-scrollbars',
        '--mute-audio',
        `--window-size=${viewport.width},${viewport.height}`,
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
        // Como bench.ts: sin vsync los deltas de rAF miden coste real, no 16.7.
        '--disable-frame-rate-limit',
        '--disable-gpu-vsync',
      ],
    });

    const page = await proc.browser.newPage();
    await page.setViewport(viewport);
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      else if (msg.type() === 'warn') {
        consoleWarnings++;
        if (warningSamples.length < 3) warningSamples.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(String(err));
    });

    await bootPage(page, url.toString(), timeout);
    if (warmupS > 0) await sleep(warmupS * 1000);
    // Saturación de la cola de WebGPU con la escena quieta (bench.ts): sin esto
    // rAF puede dispararse a <1 ms porque solo encola CPU.
    if (saturateMs > 0) await sleep(saturateMs);

    const before = await snapshot(page);
    if (before.stats === null) throw new Error('__dbg.scatterStats no existe (¿motor sin capas?)');
    if (before.backend !== 'webgpu') {
      console.log(`aviso: backend ${before.backend} (se esperaba webgpu; SwiftShader)`);
    }

    const keys: KeyInput[] = boost ? ['KeyW', 'ShiftLeft'] : ['KeyW'];
    for (const k of keys) await page.keyboard.down(k);
    const raw = await measureFlight(page, seconds);
    for (const k of keys) await page.keyboard.up(k);
    const after = await snapshot(page);

    const frameSorted = [...raw.deltas].sort((a, b) => a - b);
    const scanSorted = [...raw.scanMs].sort((a, b) => a - b);
    const frames = Math.max(0, raw.frameEnd - raw.frameStart);
    const scans = Math.max(0, raw.scansEnd - raw.scans0);
    const scanMean = mean(raw.scanMs);
    const scanP50 = percentile(scanSorted, 0.5);
    const scanP95 = percentile(scanSorted, 0.95);
    const scanHalf = Math.floor(raw.scanMs.length / 2);
    const scanFirstHalfMean = mean(raw.scanMs.slice(0, scanHalf));
    const scanSecondHalfMean = mean(raw.scanMs.slice(scanHalf));
    const scanMax = scanSorted.length > 0 ? scanSorted[scanSorted.length - 1] : 0;
    const frameP50 = percentile(frameSorted, 0.5);
    const frameP90 = percentile(frameSorted, 0.9);
    const frameP95 = percentile(frameSorted, 0.95);
    const frameP99 = percentile(frameSorted, 0.99);
    const frameMax = frameSorted.length > 0 ? frameSorted[frameSorted.length - 1] : 0;

    // Atribución: ¿los picos caen en frames con escaneo o fuera de ellos?
    const scanMsAt = new Map<number, number>();
    for (let i = 0; i < raw.scanIdx.length; i++) scanMsAt.set(raw.scanIdx[i], raw.scanMs[i]);
    const scanFrameDeltas: number[] = [];
    const noScanFrameDeltas: number[] = [];
    for (let i = 0; i < raw.deltas.length; i++) {
      if (scanMsAt.has(i)) scanFrameDeltas.push(raw.deltas[i]);
      else noScanFrameDeltas.push(raw.deltas[i]);
    }
    const scanFrameSorted = [...scanFrameDeltas].sort((a, b) => a - b);
    const frameScanMax = scanFrameSorted.length > 0 ? scanFrameSorted[scanFrameSorted.length - 1] : 0;
    const frameScanP95 = percentile(scanFrameSorted, 0.95);
    const frameScanMean = mean(scanFrameDeltas);
    let frameNoScanMax = 0;
    for (const d of noScanFrameDeltas) if (d > frameNoScanMax) frameNoScanMax = d;
    const noScanFrameSorted = [...noScanFrameDeltas].sort((a, b) => a - b);
    const frameNoScanP95 = percentile(noScanFrameSorted, 0.95);
    const frameNoScanMean = mean(noScanFrameDeltas);
    const top: FrameTop[] = [];
    for (let i = 0; i < raw.deltas.length; i++) {
      top.push({ ms: raw.deltas[i], scan: scanMsAt.has(i), lastScanMs: scanMsAt.get(i) ?? 0 });
    }
    top.sort((a, b) => b.ms - a.ms);
    top.length = Math.min(5, top.length);

    const fails: string[] = [];
    const warns: string[] = [];
    if (consoleErrors.length > 0) fails.push(`consola con ${consoleErrors.length} error(es)`);
    if (!(scanP95 < 16)) fails.push(`p95(lastScanMs)=${scanP95.toFixed(2)} >= 16 ms`);
    if (!(scanMax < 16)) fails.push(`max(lastScanMs)=${scanMax.toFixed(2)} >= 16 ms`);
    const frameLimit = 3 * frameP95 + 1;
    if (frameSorted.length > 0 && frameMax > frameLimit) {
      const attributable = frameScanMax > Math.max(frameNoScanMax + 1, frameLimit);
      const detail = `max(frame)=${frameMax.toFixed(2)} > 3·p95=${(3 * frameP95).toFixed(2)} (+1 ms)`;
      if (attributable) {
        fails.push(`${detail} y cae en frame CON escaneo (max con scan=${frameScanMax.toFixed(2)})`);
      } else {
        warns.push(`${detail} pero el pico no es imputable al escaneo (max con scan=${frameScanMax.toFixed(2)} ≤ max sin scan=${frameNoScanMax.toFixed(2)})`);
      }
    }
    const verdict: 'PASS' | 'WARN' | 'FAIL' =
      fails.length > 0 ? 'FAIL' : warns.length > 0 ? 'WARN' : 'PASS';

    const summary: Summary = {
      url: url.toString(),
      q,
      viewport: `${viewport.width}x${viewport.height}`,
      boost,
      seconds,
      warmup: warmupS,
      backend: before.backend,
      dpr: before.dpr,
      frames,
      fps: seconds > 0 ? frames / seconds : 0,
      frameMean: mean(raw.deltas),
      frameP50,
      frameP90,
      frameP95,
      frameP99,
      frameMax,
      scans,
      scansPerS: seconds > 0 ? scans / seconds : 0,
      scanCount: raw.scanMs.length,
      scanMean,
      scanP50,
      scanP95,
      scanMax,
      scanFirstHalfMean,
      scanSecondHalfMean,
      scanLiveFirst: raw.scanLive[0] ?? 0,
      scanLiveLast: raw.scanLive[raw.scanLive.length - 1] ?? 0,
      scanSlotsFirst: raw.scanSlots[0] ?? 0,
      scanSlotsLast: raw.scanSlots[raw.scanSlots.length - 1] ?? 0,
      corrScanLive: correlation(raw.scanMs, raw.scanLive),
      corrScanSlots: correlation(raw.scanMs, raw.scanSlots),
      frameScanMax,
      frameScanP95,
      frameScanMean,
      frameNoScanMax,
      frameNoScanP95,
      frameNoScanMean,
      frameScanDelta: frameScanMean - frameNoScanMean,
      top,
      acceptedBefore: Number(before.stats.accepted ?? 0),
      acceptedAfter: Number(after.stats?.accepted ?? 0),
      liveBefore: Number(before.stats.live ?? 0),
      liveAfter: Number(after.stats?.live ?? 0),
      slotsBefore: Number(before.stats.slots ?? 0),
      slotsAfter: Number(after.stats?.slots ?? 0),
      checksumBefore: before.checksum,
      checksumAfter: after.checksum,
      consoleErrors,
      consoleWarnings,
      consoleWarningSamples: warningSamples,
      fails,
      warns,
      verdict,
      pass: fails.length === 0,
    };

    if (!jsonOnly) {
      const f = (v: number): string => v.toFixed(2);
      console.log(
        `FRAME-PROBE · ${url.toString()} · q=${q} · ${viewport.width}x${viewport.height} · boost=${boost ? '×5 (W+Shift)' : 'no'} · ${seconds}s`,
      );
      console.log(`  backend            ${summary.backend} · dpr ${summary.dpr}`);
      console.log(`  frames             ${summary.frames} (${f(summary.fps)} fps) · p50 ${f(summary.frameP50)} · p90 ${f(summary.frameP90)} · p95 ${f(summary.frameP95)} · p99 ${f(summary.frameP99)} · max ${f(summary.frameMax)} ms`);
      console.log(`  escaneos           ${summary.scans} (${f(summary.scansPerS)}/s) · lastScanMs media ${f(summary.scanMean)} · p50 ${f(summary.scanP50)} · p95 ${f(summary.scanP95)} · max ${f(summary.scanMax)} ms (${summary.scanCount} muestras)`);
      console.log(`  tendencia scan     1ª mitad ${f(summary.scanFirstHalfMean)} ms · 2ª mitad ${f(summary.scanSecondHalfMean)} ms`);
      console.log(`  pool por escaneo   live ${summary.scanLiveFirst}→${summary.scanLiveLast} · slots ${summary.scanSlotsFirst}→${summary.scanSlotsLast} · corr(ms,live) ${f(summary.corrScanLive)} · corr(ms,slots) ${f(summary.corrScanSlots)}`);
      console.log(`  frame: con scan    media ${f(summary.frameScanMean)} · p95 ${f(summary.frameScanP95)} · max ${f(summary.frameScanMax)} ms`);
      console.log(`  frame: sin scan    media ${f(summary.frameNoScanMean)} · p95 ${f(summary.frameNoScanP95)} · max ${f(summary.frameNoScanMax)} ms · Δ imputable ${f(summary.frameScanDelta)} ms`);
      const topStr = summary.top.map((t) => `${f(t.ms)}${t.scan ? `(scan ${f(t.lastScanMs)}ms)` : '(no-scan)'}`).join(' ');
      console.log(`  top 5 frames       ${topStr}`);
      console.log(`  scatter antes      accepted ${summary.acceptedBefore} · live ${summary.liveBefore} · slots ${summary.slotsBefore} · checksum ${summary.checksumBefore}`);
      console.log(`  scatter después    accepted ${summary.acceptedAfter} · live ${summary.liveAfter} · slots ${summary.slotsAfter} · checksum ${summary.checksumAfter}`);
      console.log(`  consola            errores ${summary.consoleErrors.length} · warnings ${summary.consoleWarnings}`);
      for (const e of summary.consoleErrors) console.log(`    error: ${e}`);
      for (const w of summary.consoleWarningSamples) console.log(`    warn: ${w}`);
      console.log(
        `  criterios          console=0 · max/p95 lastScanMs < 16 ms · max(frame) <= 3·p95(frame)+1 ms (o WARN si el pico no es de un frame con escaneo)`,
      );
      if (summary.verdict === 'PASS') console.log('  VERDICT PASS');
      else if (summary.verdict === 'WARN') console.log(`  VERDICT WARN · ${summary.warns.join(' · ')}`);
      else console.log(`  VERDICT FAIL · ${summary.fails.join(' · ')}`);
    }
    console.log(JSON.stringify({ frameProbe: summary }));
    if (!summary.pass) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  } finally {
    await finish(proc);
  }
}

await main();
