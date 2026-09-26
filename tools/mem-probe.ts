import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import type { InstancedMesh } from 'three/webgpu';
import type { HeightfieldEx } from '../src/world/Heightfield.ts';
import type { ScatterLayer, ScatterSystem } from '../src/world/Scatter.ts';

// Vite resuelve imports sin extensión (`../core/constants`); Node ESM no. Este
// hook añade `.ts` a los especificadores relativos sin extensión para que el
// modo `--cpu` importe el motor en Node sin duplicar código.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[a-z]+$/i.test(specifier) &&
      context.parentURL !== undefined
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL).href;
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }
    return nextResolve(specifier, context);
  },
});

/**
 * mem-probe — sonda de memoria/GC del scatter (T4.2.6).
 *
 * Modos:
 *   node tools/mem-probe.ts                        # app real: 20 s de calentamiento + 10 s W+Shift
 *   node tools/mem-probe.ts --determinism          # dos cargas de ?q=high, compara checksum
 *   node --expose-gc tools/mem-probe.ts --cpu      # motor en Node (capas sintéticas, 0 GPU)
 *
 * Flags: `--url`, `--q`, `--seconds` (10), `--warmup` (20 s de vuelo antes de
 * medir; 0 para medir desde el arranque), `--idle` (sin teclas), `--scans`
 * (400 en `--cpu`), `--no-start`. El base URL por defecto es el de `bench.ts`
 * (5174) y el dev server se auto-arranca si no responde.
 *
 * Modo browser (por defecto): arranca el dev server si no responde, abre Chrome
 * headless, pulsa START, mantiene W+Shift y muestrea
 * `performance.memory.usedJSHeapSize` (si existe) cada 250 ms; además toma dos
 * snapshots con GC forzado por CDP (`HeapProfiler.collectGarbage`) antes y
 * después del vuelo para leer el heap RETENIDO (debe ser plano). Reporta draw
 * calls (`renderer.info`) y `__dbg.scatter`/`__dbg.blockers` si el motor está
 * integrado (S4b/S4c); hoy, sin capas, ambos son null y el heap debe ser plano.
 *
 * Modo `--cpu`: monta el motor con 4 capas de árbol y 4 de props sintéticas
 * sobre un heightfield real (`heightMath.bakeHeightMap`, sin LUT de GPU) y
 * simula un vuelo de `--scans` pasos de 6 m. Mide heap retenido (con
 * `--expose-gc`), evento de GC (`PerformanceObserver`) y `stats()`. Además:
 *   1) valida el caso "sin capas" (el motor no debe romper),
 *   2) compara dos instancias con el mismo camino (checksum + hash de todas las
 *      matrices de instancia) → determinismo.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_URL = 'http://127.0.0.1:5174/';

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

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function respondsTo(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

interface PageDbg {
  backend?: string;
  quality?: string;
  frame?: number;
  gl?: {
    memory: { geometries: number; textures: number };
    render: { frameCalls: number; triangles: number; frame?: number };
  };
  scatter?: unknown;
  scatterStats?: unknown;
  scatterChecksum?: number;
  blockers?: unknown;
}

interface PerfMemoryLike {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}

async function bootPage(page: Page, url: string, timeout: number, start: boolean): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction('window.__dbg !== undefined', { timeout });
  if (start) {
    await page.waitForSelector('#start:not([disabled])', { timeout });
    await page.click('#start:not([disabled])');
  }
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout });
}

interface HeapSample {
  t: number;
  heap: number;
  frame: number;
}

function slopeBytesPerSecond(samples: HeapSample[]): number {
  const valid = samples.filter((s) => s.heap > 0);
  if (valid.length < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const n = valid.length;
  for (const s of valid) {
    const x = s.t;
    sx += x;
    sy += s.heap;
    sxx += x * x;
    sxy += x * s.heap;
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

async function browserProbe(): Promise<void> {
  const baseUrl = value('--url') ?? DEFAULT_URL;
  const q = value('--q') ?? 'high';
  const seconds = Math.max(2, num('--seconds', 10));
  // Sin calentamiento el primer tramo mide la creación de caches de three/
  // Chrome (pipelines, tiles subidos, Map rehash): no es el régimen estable.
  const warmupS = Math.max(0, num('--warmup', 20));
  const idle = flag('--idle');
  const timeout = num('--timeout', 600000);
  const start = !flag('--no-start');

  const url = new URL(baseUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('fly', '1');

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
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
      const port = new URL(baseUrl).port || '5174';
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
      ],
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(String(err));
    });

    await bootPage(page, url.toString(), timeout, start);
    const cdp: CDPSession = await page.createCDPSession();
    const forceGc = async (): Promise<void> => {
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(120);
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(120);
    };
    const heapNow = (): Promise<number> =>
      page.evaluate(() => {
        const m = (performance as unknown as PerfMemoryLike).memory;
        return m ? m.usedJSHeapSize : -1;
      });

    const press = async (down: boolean): Promise<void> => {
      if (idle) return;
      if (down) {
        await page.keyboard.down('KeyW');
        await page.keyboard.down('ShiftLeft');
      } else {
        await page.keyboard.up('KeyW');
        await page.keyboard.up('ShiftLeft');
      }
    };

    const hasMemory = (await heapNow()) > 0;
    console.log(
      `MEM-PROBE browser · ${url.toString()} · ${idle ? 'IDLE' : `${warmupS ? `${warmupS}s calentamiento + ` : ''}${seconds}s W+Shift`} · performance.memory=${hasMemory ? 'sí' : 'NO'}`,
    );

    if (warmupS > 0) {
      await press(true);
      await sleep(warmupS * 1000);
      await press(false);
    }

    // Heap retenido antes del vuelo (con GC forzado).
    await forceGc();
    const retainedBefore = await heapNow();

    // Muestreo DENTRO de la página (un solo evaluate): los page.evaluate por
    // muestra sesgarían el heap que queremos medir.
    await page.evaluate(() => {
      const w = window as unknown as {
        __memSamples?: Array<{ t: number; heap: number; frame: number }>;
      };
      const arr: Array<{ t: number; heap: number; frame: number }> = [];
      w.__memSamples = arr;
      const t0 = performance.now();
      const tick = (): void => {
        const m = (performance as unknown as PerfMemoryLike).memory;
        const d = (window as unknown as { __dbg?: { frame?: number } }).__dbg;
        arr.push({
          t: (performance.now() - t0) / 1000,
          heap: m ? m.usedJSHeapSize : -1,
          frame: d?.frame ?? 0,
        });
        if (arr.length < 400 && (performance.now() - t0) / 1000 < 120) setTimeout(tick, 250);
      };
      tick();
    });

    await press(true);
    await sleep(seconds * 1000);
    await press(false);
    await forceGc();
    const retainedAfter = await heapNow();
    const rawSamples = await page.evaluate(
      () =>
        (window as unknown as { __memSamples?: Array<{ t: number; heap: number; frame: number }> })
          .__memSamples ?? [],
    );
    const samples: HeapSample[] = [];
    for (const s of rawSamples) samples.push({ t: s.t, heap: s.heap, frame: s.frame });

    const final = await page.evaluate(() => {
      const d = (window as unknown as { __dbg?: PageDbg }).__dbg;
      return {
        frame: d?.frame ?? 0,
        drawCalls: d?.gl?.render.frameCalls ?? 0,
        triangles: d?.gl?.render.triangles ?? 0,
        geometries: d?.gl?.memory.geometries ?? 0,
        textures: d?.gl?.memory.textures ?? 0,
        scatter: d?.scatter ?? null,
        stats: d?.scatterStats ?? null,
        checksum: d?.scatterChecksum ?? null,
        blockers: d?.blockers ?? null,
      };
    });

    let first = 0;
    let last = 0;
    let minH = Number.POSITIVE_INFINITY;
    let maxH = 0;
    for (const s of samples) {
      if (s.heap <= 0) continue;
      if (first === 0) first = s.heap;
      last = s.heap;
      if (s.heap < minH) minH = s.heap;
      if (s.heap > maxH) maxH = s.heap;
    }
    const slope = slopeBytesPerSecond(samples);
    const retainedDelta = retainedAfter - retainedBefore;

    console.log(`  frame final        ${final.frame}`);
    if (hasMemory) {
      console.log(
        `  heap muestreado    ${mb(first)} → ${mb(last)} · pendiente ${(slope / 1024).toFixed(2)} KB/s · min ${mb(minH)} · max ${mb(maxH)}`,
      );
      console.log(
        `  heap tras GC       antes ${mb(retainedBefore)} → después ${mb(retainedAfter)} · retenido ${(retainedDelta / 1024).toFixed(2)} KB`,
      );
    } else {
      console.log('  performance.memory no disponible: solo draw calls/memoria del renderer');
    }
    console.log(
      `  draw calls         ${final.drawCalls} · triángulos ${final.triangles} · geometries ${final.geometries} · textures ${final.textures}`,
    );
    console.log(
      `  __dbg.scatter      ${final.scatter === null ? 'null (motor sin capas integradas todavía)' : JSON.stringify(final.scatter)}`,
    );
    console.log(
      `  __dbg.scatterStats ${final.stats === null ? 'null' : JSON.stringify(final.stats)}`,
    );
    console.log(`  __dbg.blockers     ${final.blockers === null ? 'null' : JSON.stringify(final.blockers)}`);
    console.log(`  checksum           ${final.checksum === null ? 'null' : String(final.checksum)}`);
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
}

async function browserDeterminism(): Promise<void> {
  const baseUrl = value('--url') ?? DEFAULT_URL;
  const timeout = num('--timeout', 600000);
  const waitMs = num('--wait', 1500);
  const url = new URL(baseUrl);
  url.searchParams.set('q', value('--q') ?? 'high');

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
      const port = new URL(baseUrl).port || '5174';
      server = spawn('npm', ['run', 'dev', '--', '--port', port], {
        cwd: ROOT,
        stdio: 'ignore',
        detached: true,
      });
      server.unref();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(400);
        if (await respondsTo(baseUrl)) break;
      }
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
      ],
    });
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const load = async (): Promise<string> => {
      await bootPage(page, url.toString(), timeout, true);
      await sleep(waitMs);
      return page.evaluate(() =>
        JSON.stringify({
          scatter: (window as unknown as { __dbg?: PageDbg }).__dbg?.scatter ?? null,
          checksum: (window as unknown as { __dbg?: PageDbg }).__dbg?.scatterChecksum ?? null,
          blockers: (window as unknown as { __dbg?: PageDbg }).__dbg?.blockers ?? null,
        }),
      );
    };
    const a = await load();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout });
    const b = await load();
    console.log('MEM-PROBE determinism (2 cargas de la misma URL)');
    console.log(`  carga A  ${a}`);
    console.log(`  carga B  ${b}`);
    console.log(a === b ? '  DETERMINISM OK' : '  DETERMINISM FAIL');
    if (a !== b) process.exitCode = 1;
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
}

// --- Modo CPU: motor real en Node, sin GPU ---------------------------------

async function cpuProbe(): Promise<void> {
  const scans = Math.max(20, Math.round(num('--scans', 400)));
  const warmup = Math.max(0, Math.round(num('--warmup', 120)));

  const THREE = await import('three/webgpu');
  const { createScatter } = await import('../src/world/Scatter.ts');
  const { shared } = await import('../src/core/shared.ts');
  const { bakeHeightMap, RES, rawHeight, normalFrom, noiseFrom } = await import(
    '../src/world/heightMath.ts'
  );

  // Heightfield mínimo sobre el LUT real (sin params.ts ni GPU). `heightNode`
  // y `texture` no los usa el motor en CPU: se rellenan con centinelas.
  const data = bakeHeightMap();
  const hf: HeightfieldEx = {
    height: (x, z) => rawHeight(data, RES, x, z),
    normal: (x, z, out, eps) => {
      normalFrom(data, RES, x, z, out, eps ?? 0.4);
      return out;
    },
    noise: (x, z) => noiseFrom(data, RES, x, z),
    heightNode: (() => {
      throw new Error('mem-probe: heightNode no se usa en CPU');
    }) as unknown as HeightfieldEx['heightNode'],
    raw: (x, z) => rawHeight(data, RES, x, z),
    texture: null as unknown as HeightfieldEx['texture'],
    data,
    dispose: () => {},
  };

  const geometry = new THREE.BoxGeometry(0.6, 1, 0.6);
  const bark = new THREE.MeshBasicMaterial();
  const leaf = new THREE.MeshBasicMaterial();

  function treeLayer(
    id: number,
    o: {
      cell: number;
      prob: number;
      variants: number;
      lod: readonly [number, number, number];
      cap: readonly [number, number, number];
      scale: readonly [number, number];
      sink: number;
      trunk: number;
    },
  ): ScatterLayer {
    return {
      id,
      field: 0,
      cellSize: o.cell,
      prob: o.prob,
      variants: o.variants,
      lodDist: o.lod,
      cap: o.cap,
      scale: o.scale,
      sink: o.sink,
      trunkRadius: o.trunk,
      primitives: (_variant, lod) => [
        { key: 0, geometry, material: bark, shadow: lod < 2, layer: lod < 2 ? 2 : 0 },
        { key: 1, geometry, material: leaf, shadow: lod < 2, layer: lod < 2 ? 2 : 0 },
      ],
    };
  }

  function propLayer(
    id: number,
    o: { cell: number; prob: number; cap: number; radius: number; solid?: readonly [number, number]; align: boolean },
  ): ScatterLayer {
    const layer: ScatterLayer = {
      id: id + 10,
      field: 1,
      cellSize: o.cell,
      prob: o.prob,
      variants: 3,
      lodDist: [o.radius, o.radius, o.radius],
      cap: [0, 0, o.cap],
      scale: [0.8, 1.4],
      sink: 0.03,
      inset: 0.1,
      span: 0.8,
      lodScale: 1,
      probScale: 1,
      density: () => 1,
      primitives: () => [{ key: 0, geometry, material: leaf, shadow: false }],
      acceptExtra: (_x, _z, h) => h(7) > 0.35,
    };
    if (o.solid !== undefined) layer.solidRadius = o.solid;
    if (o.align) {
      layer.orient = (_x, _z, out) => {
        out.set(0, 0, 0, 1);
        return true;
      };
    }
    return layer;
  }

  function addAll(sys: ScatterSystem): void {
    sys.addLayer(treeLayer(0, { cell: 8.5, prob: 0.64, variants: 3, lod: [22.5, 60, 175], cap: [30, 90, 300], scale: [0.85, 1.2], sink: 0.08, trunk: 0.34 }));
    sys.addLayer(treeLayer(1, { cell: 8.5, prob: 0.64, variants: 6, lod: [22.5, 60, 175], cap: [30, 90, 300], scale: [0.85, 1.2], sink: 0.7, trunk: 0.36 }));
    sys.addLayer(treeLayer(2, { cell: 6.5, prob: 0.42, variants: 3, lod: [32.5, 75, 110], cap: [40, 100, 240], scale: [0.8, 1.3], sink: 0.08, trunk: 0.07 }));
    sys.addLayer(treeLayer(3, { cell: 4.5, prob: 0.38, variants: 3, lod: [25, 56.25, 85], cap: [50, 140, 300], scale: [0.9, 1.5], sink: 0.08, trunk: 0 }));
    sys.addLayer(propLayer(0, { cell: 3.2, prob: 0.5, cap: 140, radius: 55, align: false }));
    sys.addLayer(propLayer(1, { cell: 7.5, prob: 0.32, cap: 60, radius: 60, align: false }));
    sys.addLayer(propLayer(2, { cell: 12, prob: 0.3, cap: 30, radius: 90, solid: [1.0, 0.8], align: true }));
    sys.addLayer(propLayer(3, { cell: 40, prob: 0.4, cap: 8, radius: 60, solid: [3.0, 0.5], align: true }));
  }

  function walk(sys: ScatterSystem, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const s = i * 6;
      sys.update(s * 0.55 + Math.sin(s * 0.013) * 55, s * 0.83 + Math.cos(s * 0.011) * 55);
    }
  }

  /** FNV-1a sobre los bits de todas las matrices de instancia (pos/esc/rot). */
  function matrixHash(sys: ScatterSystem): number {
    let h = 0x811c9dc5 | 0;
    const f32 = new Float32Array(1);
    const i32 = new Int32Array(f32.buffer);
    const children = sys.group.children;
    for (let c = 0; c < children.length; c++) {
      const mesh = children[c] as InstancedMesh;
      if (mesh.isInstancedMesh !== true) continue;
      const arr = mesh.instanceMatrix.array as Float32Array;
      const n = mesh.count * 16;
      h = Math.imul(h ^ mesh.count, 2654435761) | 0;
      for (let k = 0; k < n; k++) {
        f32[0] = arr[k];
        h = Math.imul(h ^ i32[0], 16777619) | 0;
      }
    }
    return h >>> 0;
  }

  // 1) Caso "sin capas": el motor no debe romper ni colocar nada.
  const empty = createScatter(hf, 'high', new THREE.Scene(), shared);
  empty.update(0, 0);
  empty.update(1, 1);
  empty.update(40, 40);
  const emptyStats = empty.stats();
  const emptyOk =
    emptyStats.pools === 0 && emptyStats.slots === 0 && emptyStats.accepted === 0;
  empty.dispose();

  // 2) Instancia A: ventana medida de GC.
  const a = createScatter(hf, 'high', new THREE.Scene(), shared);
  addAll(a);
  walk(a, 0, warmup);
  const gcFn = (globalThis as unknown as { gc?: () => void }).gc;
  const gcAvailable = typeof gcFn === 'function';
  if (gcFn) gcFn();
  const retainedBefore = process.memoryUsage().heapUsed;

  let gcCount = 0;
  let gcPauseMs = 0;
  const obs = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    for (let i = 0; i < entries.length; i++) {
      gcCount++;
      gcPauseMs += entries[i].duration;
    }
  });
  obs.observe({ entryTypes: ['gc'] });

  let maxScanMs = 0;
  const wall0 = performance.now();
  for (let i = warmup; i < warmup + scans; i++) {
    const s = i * 6;
    const before = performance.now();
    a.update(s * 0.55 + Math.sin(s * 0.013) * 55, s * 0.83 + Math.cos(s * 0.011) * 55);
    const dt = performance.now() - before;
    if (dt > maxScanMs) maxScanMs = dt;
  }
  const wallMs = performance.now() - wall0;
  obs.disconnect();
  if (gcFn) gcFn();
  const retainedAfter = process.memoryUsage().heapUsed;

  const statsA = a.stats();
  const hashA = matrixHash(a);

  // 3) Instancia B: mismo camino → mismo resultado (determinismo).
  const b = createScatter(hf, 'high', new THREE.Scene(), shared);
  addAll(b);
  walk(b, 0, warmup + scans);
  const statsB = b.stats();
  const hashB = matrixHash(b);

  console.log(
    `MEM-PROBE cpu · 8 capas (4 árbol + 4 props) · ${warmup} de calentamiento + ${scans} escaneos (paso ~6 m) · gc=${gcAvailable ? 'disponible' : 'NO (usa --expose-gc)'}`,
  );
  console.log(
    `  sin capas          pools ${emptyStats.pools} · slots ${emptyStats.slots} · accepted ${emptyStats.accepted} · ${emptyOk ? 'ok' : 'FAIL'}`,
  );
  console.log(
    `  stats A            pools ${statsA.pools} · slots ${statsA.slots} (live ${statsA.live}) · accepted ${statsA.accepted} · trunks ${statsA.trunks} · blockers ${statsA.blockers} · landmarks ${statsA.landmarks}`,
  );
  if (statsA.live !== statsA.accepted) {
    console.log('  FAIL invariante live == accepted (tras reconciliar)');
    process.exitCode = 1;
  }
  console.log(
    `  escaneo            ${(wallMs / scans).toFixed(2)} ms de media · ${maxScanMs.toFixed(2)} ms máx · ${(wallMs / (scans * 6)).toFixed(2)} ms/m`,
  );
  console.log(
    `  heap retenido      antes ${mb(retainedBefore)} → después ${mb(retainedAfter)} · Δ ${((retainedAfter - retainedBefore) / 1024).toFixed(2)} KB`,
  );
  console.log(
    `  GC en la ventana   ${gcCount} eventos · pausa total ${gcPauseMs.toFixed(2)} ms`,
  );
  console.log(
    `  determinismo       checksum ${statsA.checksum} vs ${statsB.checksum} · matrixHash ${hashA} vs ${hashB}`,
  );
  const same = statsA.checksum === statsB.checksum && hashA === hashB && statsA.accepted === statsB.accepted;
  console.log(same ? '  DETERMINISM OK' : '  DETERMINISM FAIL');
  if (!same || !emptyOk) process.exitCode = 1;
  a.dispose();
  b.dispose();
}

async function main(): Promise<void> {
  if (flag('--cpu')) {
    await cpuProbe();
  } else if (flag('--determinism')) {
    await browserDeterminism();
  } else {
    await browserProbe();
  }
}

await main();
