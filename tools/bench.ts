import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * Bench del césped (T3.2.5): ms/frame por tier con `?grass=0` y activo.
 *
 * OJO: el harness headless usa SwiftShader (WebGPU sobre CPU) — los ms absolutos
 * NO representan una GPU real; solo sirven como comparación relativa
 * grass on/off y entre tiers en la misma máquina. En una GPU de escritorio el
 * objetivo del doc es high < 8 ms.
 *
 *   node tools/bench.ts [--url http://127.0.0.1:5174/] [--frames 24] [--warmup 6] [--saturate 4000]
 *   node tools/bench.ts --probe    # solo la prueba de estabilidad (T3.2.2)
 *
 * Método: Chrome sin vsync (`--disable-frame-rate-limit`), espera de saturación
 * de la cola de WebGPU (`--saturate` ms) y deltas de rAF. Sin esa espera rAF se
 * dispara a ~0.3 ms (solo encode CPU) y no mide nada.
 *
 * `--probe`: en ?q=medium comprueba durante 3 s que el conteo y
 * `instanceCount` no cambian, que no existe `instanceMatrix` (attrs solo
 * position/uv/normal) y que `renderer.info.memory.geometries/textures` y las
 * draw calls quedan estables (no hay uploads de buffer por frame).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1440, height: 900 };
const TIERS = ['low', 'medium', 'high'] as const;

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

function urlFor(base: string, q: string, grass: boolean): string {
  const u = new URL(base);
  u.searchParams.set('q', q);
  if (!grass) u.searchParams.set('grass', '0');
  return u.toString();
}

async function bootPage(page: Page, url: string, timeout: number): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction('window.__dbg !== undefined', { timeout });
  await page.waitForSelector('#start:not([disabled])', { timeout });
  await page.click('#start:not([disabled])');
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout });
}

interface FrameStats {
  count: number;
  median: number;
  mean: number;
  min: number;
  max: number;
}

async function measure(page: Page, frames: number, warmup: number, saturateMs: number): Promise<FrameStats> {
  const start = (await page.evaluate(() => (window as unknown as { __dbg: { frame: number } }).__dbg.frame)) as number;
  await page.waitForFunction(
    (target: number) => (window as unknown as { __dbg: { frame: number } }).__dbg.frame >= target,
    { timeout: 600000 },
    start + warmup,
  );
  // Sin vsync, rAF se dispara antes que la GPU: hay que dejar que la cola de
  // WebGPU se sature para que los deltas de rAF reflejen el coste sostenido.
  await sleep(saturateMs);
  return page.evaluate(async (n: number) => {
    const times: number[] = [];
    let last = performance.now();
    await new Promise<void>((resolvePromise) => {
      const tick = (): void => {
        // performance.now() en ambos extremos: el timestamp de rAF es el inicio
        // del frame y puede ser anterior al now() del callback previo.
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (times.length >= n) resolvePromise();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...times].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    let sum = 0;
    for (const t of times) sum += t;
    return {
      count: times.length,
      median,
      mean: sum / times.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }, frames);
}

interface GrassDbg {
  count: number;
  R: number;
  cell: number;
  tier: string;
  visible: boolean;
  effective: number;
  instanceCount: number;
  attrs: string[];
}

interface ProbeSnapshot {
  count: number;
  instanceCount: number;
  attrs: string[];
  memoryGeometries: number;
  memoryTextures: number;
  drawCalls: number;
  triangles: number;
  frame: number;
}

interface InfoLike {
  memory: { geometries: number; textures: number };
  render: { frameCalls: number; triangles: number; frame: number };
}

async function probe(page: Page, timeout: number): Promise<void> {
  await bootPage(page, urlFor(baseUrl, 'medium', true), timeout);
  const snap = (): Promise<ProbeSnapshot> =>
    page.evaluate(() => {
      const d = (window as unknown as {
        __dbg: { grass: GrassDbg; gl: InfoLike; frame: number };
      }).__dbg;
      return {
        count: d.grass.count,
        instanceCount: d.grass.instanceCount,
        attrs: d.grass.attrs,
        memoryGeometries: d.gl.memory.geometries,
        memoryTextures: d.gl.memory.textures,
        drawCalls: d.gl.render.frameCalls,
        triangles: d.gl.render.triangles,
        frame: d.frame,
      };
    });

  const a = await snap();
  await sleep(3000);
  const b = await snap();

  const expected = 160 * 160 * 6;
  const checks: Array<[string, boolean, string]> = [
    ['count == n*n*k (153600)', b.count === expected, `count=${b.count}`],
    ['instanceCount == count', b.instanceCount === expected, `instanceCount=${b.instanceCount}`],
    ['attrs sin instanceMatrix', !b.attrs.includes('instanceMatrix'), `attrs=[${b.attrs.join(',')}]`],
    ['count constante en 3 s', a.count === b.count, `${a.count} → ${b.count}`],
    ['instanceCount constante en 3 s', a.instanceCount === b.instanceCount, `${a.instanceCount} → ${b.instanceCount}`],
    ['geometries estable', a.memoryGeometries === b.memoryGeometries, `${a.memoryGeometries} → ${b.memoryGeometries}`],
    ['textures estable', a.memoryTextures === b.memoryTextures, `${a.memoryTextures} → ${b.memoryTextures}`],
    ['draw calls estable', a.drawCalls === b.drawCalls, `${a.drawCalls} → ${b.drawCalls}`],
    ['triangles estable', a.triangles === b.triangles, `${a.triangles} → ${b.triangles}`],
    ['frames avanzan', b.frame > a.frame, `${a.frame} → ${b.frame}`],
  ];

  console.log('PROBE T3.2.2/T3.2.3 (?q=medium, ventana 3 s)');
  let fails = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) fails += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} · ${detail}`);
  }
  console.log(fails === 0 ? 'PROBE OK' : `PROBE FAIL (${fails})`);
  if (fails > 0) process.exitCode = 1;
}

const baseUrl = value('--url') ?? 'http://127.0.0.1:5174/';
const frames = Math.max(4, Math.round(num('--frames', 24)));
const warmup = Math.max(0, Math.round(num('--warmup', 6)));
const saturateMs = Math.max(0, Math.round(num('--saturate', 4000)));
const timeout = num('--timeout', 600000);

let server: ChildProcess | null = null;
let browser: Browser | null = null;

const killServer = (): void => {
  if (!server || !server.pid) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* ya había terminado */
  }
  server = null;
};

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
    if (!up) throw new Error('el dev server no respondió en 30 s');
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--hide-scrollbars',
      '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      // Sin vsync: si no, rAF queda clavado a 16.7 ms y no se ve el coste real.
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  if (flag('--probe')) {
    await probe(page, timeout);
  } else {
    console.log(`bench · SwiftShader (CPU), NO es una GPU real · ${frames} frames/config · url ${baseUrl}`);
    console.log(
      `${'tier'.padEnd(7)} ${'grass'.padEnd(5)} ${'count'.padEnd(8)} ${'median'.padEnd(9)} ${'mean'.padEnd(9)} ${'min'.padEnd(9)} max`,
    );
    for (const q of TIERS) {
      for (const grass of [false, true]) {
        await bootPage(page, urlFor(baseUrl, q, grass), timeout);
        const stats = await measure(page, frames, warmup, saturateMs);
        const info = await page.evaluate(() => {
          const d = (window as unknown as { __dbg: { grass: GrassDbg } }).__dbg;
          return d.grass;
        });
        console.log(
          `${q.padEnd(7)} ${(grass ? 'on' : 'off').padEnd(5)} ${String(info.count).padEnd(8)} ${stats.median
            .toFixed(2)
            .padEnd(9)} ${stats.mean.toFixed(2).padEnd(9)} ${stats.min.toFixed(2).padEnd(9)} ${stats.max.toFixed(2)}`,
        );
      }
    }
    console.log(JSON.stringify({ swiftshader: true, frames, warmup, consoleErrors }));
  }

  if (consoleErrors.length > 0) {
    console.log(JSON.stringify({ consoleErrors }));
    process.exitCode = 1;
  }
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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
