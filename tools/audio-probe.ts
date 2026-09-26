import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * Probe de audio (T7.2.3): verificacion REAL del audio procedural. Abre
 * tools/audio-probe.html (sin three.js), hace click en #go (gesto de usuario →
 * unlock()) y mide el RMS del bus master con un AnalyserNode (FFT 2048) en
 * varias configuraciones de lluvia / viento / trueno. Comprueba las relaciones
 * de la spec y sale con PASS/FAIL (exitCode=1 si falla).
 *
 *   node tools/audio-probe.ts [--url http://127.0.0.1:5174/tools/audio-probe.html] [--timeout 120000]
 *
 * Auto-spawn de `npm run dev -- --port <puerto de --url>` si la URL no responde.
 * OJO: a proposito NO se pasa --mute-audio (el probe necesita oir el grafo).
 *
 * Método: cada medida aplica el clima con `update()` durante ~1 s (asentar las
 * rampas de setTargetAtTime) y luego promedia el RMS de ~400 ms con ventanas
 * de 2048 muestras.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_URL = 'http://127.0.0.1:5174/tools/audio-probe.html';
const VIEWPORT = { width: 1280, height: 720 };
const RMS_SILENCE = 1e-4;
const SAMPLE_MS = 400;

interface ProbeWeather {
  rain: number;
  wind: number;
  gust: number;
}

interface ProbeStats {
  ctx: string;
  enabled: boolean;
  muted: boolean;
  volume: number;
  rainLayers: number;
  windGain: number;
  thunderActive: number;
  burstMs: number;
}

interface ProbeApi {
  unlock(): Promise<void>;
  update(dt: number, w: ProbeWeather): void;
  thunder(intensity: number, delay: number): void;
  stats(): ProbeStats;
  analyserRms(w: ProbeWeather, ms: number): Promise<number>;
}

interface Row {
  label: string;
  rms: number;
  stats: ProbeStats;
}

const argv = process.argv.slice(2);

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

async function measure(page: Page, label: string, w: ProbeWeather): Promise<Row> {
  const rms = await page.evaluate(async (weather: ProbeWeather, ms: number) => {
    return (window as unknown as { __audioProbe: ProbeApi }).__audioProbe.analyserRms(weather, ms);
  }, w, SAMPLE_MS);
  const stats = await page.evaluate(() => {
    return (window as unknown as { __audioProbe: ProbeApi }).__audioProbe.stats();
  });
  return { label, rms, stats };
}

const baseUrl = value('--url') ?? DEFAULT_URL;
const timeout = num('--timeout', 120000);
const consoleErrors: string[] = [];

let server: ChildProcess | null = null;
let browser: Browser | null = null;

const killServer = (): void => {
  if (!server || !server.pid) return;
  const pid = server.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* ya habia terminado */
  }
  try {
    // npm re-ejecuta vite en el mismo grupo (detached); matar el grupo asegura
    // que no quede un vite huerfano escuchando el puerto.
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* el grupo ya no existe */
  }
  server = null;
};

/**
 * Arranca la pagina y hace el gesto de usuario. Vite dispara un full-reload
 * cuando termina de optimizar deps en frio (three, escaneado del index.html)
 * aunque esta pagina no lo importe: si el reload cae a mitad del boot, el
 * contexto de ejecucion muere y se reintenta.
 */
async function boot(page: Page, url: string, timeout: number): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForFunction(
        () => (window as unknown as { __audioProbe?: unknown }).__audioProbe !== undefined,
        { timeout },
      );
      // Deja pasar un posible full-reload de optimizeDeps antes de interactuar.
      await sleep(800);
      await page.waitForFunction(
        () => (window as unknown as { __audioProbe?: unknown }).__audioProbe !== undefined,
        { timeout },
      );
      await page.click('#go');
      await page.waitForFunction(
        () => (window as unknown as { __audioProbe: ProbeApi }).__audioProbe.stats().ctx === 'running',
        { timeout, polling: 100 },
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

try {
  if (!(await respondsTo(baseUrl))) {
    const port = new URL(baseUrl).port || '5173';
    server = spawn('npm', ['run', 'dev', '--', '--port', port], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
    });
    server.unref();
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline) {
      await sleep(400);
      if (await respondsTo(baseUrl)) {
        up = true;
        break;
      }
    }
    if (!up) throw new Error('el dev server no respondio en 30 s');
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) consoleErrors.push(`${res.status()} ${res.url()}`);
  });

  await boot(page, baseUrl, timeout);

  const probe = await page.evaluate(() => {
    const p = (window as unknown as { __audioProbe: ProbeApi }).__audioProbe;
    return { stats: p.stats() };
  });

  const rainCfg: ProbeWeather[] = [
    { rain: 0.05, wind: 1.64, gust: 0.15 },
    { rain: 0.45, wind: 1.64, gust: 0.15 },
    { rain: 1.0, wind: 1.64, gust: 0.15 },
    { rain: 1.9, wind: 1.64, gust: 0.15 },
  ];
  const windCfg: ProbeWeather[] = [
    { rain: 0, wind: 0.3, gust: 0.85 },
    { rain: 0, wind: 2.3, gust: 0.85 },
  ];

  console.log(`audio-probe · ${baseUrl}`);
  console.log(`${'config'.padEnd(30)} ${'rms'.padEnd(12)} ${'rainLayers'.padEnd(11)} windGain`);

  const rainRows: Row[] = [];
  for (const w of rainCfg) {
    const label = `lluvia rain=${w.rain.toFixed(2)}`;
    const row = await measure(page, label, w);
    rainRows.push(row);
    console.log(
      `${label.padEnd(30)} ${row.rms.toExponential(3).padEnd(12)} ${row.stats.rainLayers
        .toFixed(4)
        .padEnd(11)} ${row.stats.windGain.toFixed(4)}`,
    );
  }
  const windRows: Row[] = [];
  for (const w of windCfg) {
    const label = `viento wind=${w.wind.toFixed(2)}`;
    const row = await measure(page, label, w);
    windRows.push(row);
    console.log(
      `${label.padEnd(30)} ${row.rms.toExponential(3).padEnd(12)} ${row.stats.rainLayers
        .toFixed(4)
        .padEnd(11)} ${row.stats.windGain.toFixed(4)}`,
    );
  }

  // F9: preset `clear` (rain=0) → puerta de silencio: las 3 capas a 0.
  const clearRow = await measure(page, 'clear rain=0.00', { rain: 0, wind: 1.64, gust: 0.15 });
  console.log(
    `${clearRow.label.padEnd(30)} ${clearRow.rms.toExponential(3).padEnd(12)} ${clearRow.stats.rainLayers
      .toFixed(4)
      .padEnd(11)} ${clearRow.stats.windGain.toFixed(4)}`,
  );

  await page.evaluate(() => {
    (window as unknown as { __audioProbe: ProbeApi }).__audioProbe.thunder(0.9, 0);
  });
  await sleep(1000);
  const thunderRow = await measure(page, 'trueno thunder(0.9,0)', { rain: 0, wind: 0.3, gust: 0.15 });
  console.log(
    `${thunderRow.label.padEnd(30)} ${thunderRow.rms.toExponential(3).padEnd(12)} ${thunderRow.stats.rainLayers
      .toFixed(4)
      .padEnd(11)} ${thunderRow.stats.windGain.toFixed(4)}  thunderActive=${thunderRow.stats.thunderActive} burstMs=${thunderRow.stats.burstMs}`,
  );

  const rainMin = Math.min(...rainRows.map((r) => r.stats.rainLayers));
  const rainMax = Math.max(...rainRows.map((r) => r.stats.rainLayers));
  const checks: Array<[string, boolean, string]> = [
    ['ctx=running tras click #go', probe.stats.ctx === 'running', `ctx=${probe.stats.ctx}`],
    ['enabled y volume por defecto', probe.stats.enabled, `enabled=${probe.stats.enabled} volume=${probe.stats.volume}`],
    [
      'RMS lluvia fuerte (1.9) > RMS lluvia fina (0.05)',
      rainRows[3].rms > rainRows[0].rms,
      `${rainRows[3].rms.toExponential(3)} > ${rainRows[0].rms.toExponential(3)}`,
    ],
    [
      'RMS lluvia fina (0.05) > umbral de silencio',
      rainRows[0].rms > RMS_SILENCE,
      `${rainRows[0].rms.toExponential(3)} > ${RMS_SILENCE.toExponential(1)}`,
    ],
    [
      'RMS viento fuerte (2.3) > RMS viento flojo (0.3)',
      windRows[1].rms > windRows[0].rms,
      `${windRows[1].rms.toExponential(3)} > ${windRows[0].rms.toExponential(3)}`,
    ],
    [
      'RMS trueno > umbral de silencio',
      thunderRow.rms > RMS_SILENCE,
      `${thunderRow.rms.toExponential(3)} > ${RMS_SILENCE.toExponential(1)}`,
    ],
    [
      'stats().rainLayers cambia con la lluvia',
      rainMax - rainMin > 0.05 && rainRows[3].stats.rainLayers > rainRows[0].stats.rainLayers,
      `min=${rainMin.toFixed(4)} max=${rainMax.toFixed(4)}`,
    ],
    [
      'clear (rain=0) silencia las capas de lluvia',
      clearRow.stats.rainLayers < 0.005,
      `rainLayers=${clearRow.stats.rainLayers.toFixed(4)}`,
    ],
    ['sin errores de consola', consoleErrors.length === 0, `${consoleErrors.length} errores`],
  ];

  if (consoleErrors.length > 0) console.log(JSON.stringify({ consoleErrors }));
  let fails = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) fails += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} · ${detail}`);
  }
  console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
  if (fails > 0) process.exitCode = 1;
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err), consoleErrors }));
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* el navegador ya estaba cerrado */
    }
  }
  killServer();
}
