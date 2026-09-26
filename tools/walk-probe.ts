import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, ConsoleMessage, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * walk-probe (T8.6): valida el caminante de F8 en headless.
 *
 *   node tools/walk-probe.ts [--url http://127.0.0.1:5177/] [--q low]
 *                            [--viewport 960x540] [--json]
 *
 * Comprueba, sobre el modo normal (sin `?cam` ni `?fly`):
 *   1. W 2 s avanza ≈ 1.75 m/s (margen por la rampa exponencial).
 *   2. Shift+W 2 s avanza bastante más (≈ 3.9 m/s).
 *   3. Al ir contra el tronco más cercano el jugador se detiene a
 *      `r + CAMERA.radius` (0.32) sin penetrar, con deslizamiento (se mueve
 *      hacia él antes de bloquearse).
 *   4. Al soltar, la velocidad cae a ~0; los pasos sintetizados suenan
 *      (`audio.stats().steps`) y el AudioContext quedó desbloqueado.
 *   5. Cero errores/warnings de consola.
 *
 * SwiftShader: los ms no importan aquí; todo es cinemática y estado.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(name);
}

function value(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Collider {
  x: number;
  z: number;
  r: number;
}
interface WalkerLike {
  speed: number;
}
interface AudioLike {
  contextState: string;
  stats(): { steps: number };
}
interface NightwoodsLike {
  rig: { position: Vec3; rotation: { y: number } };
  walker: WalkerLike;
  audio: AudioLike;
}
interface WorldLike {
  trunks: Collider[];
  blockers: Collider[];
}

const RADIUS = 0.32;
const EYE = 1.7;
const WALK_SPEED = 1.75;
const RUN_SPEED = 3.9;

const baseUrl = value('--url') ?? 'http://127.0.0.1:5177/';
const quality = value('--q') ?? 'low';
const viewportRaw = value('--viewport') ?? '960x540';
const [vw, vh] = viewportRaw.split('x').map((v) => Math.max(320, Math.round(Number.parseFloat(v) || 0)));
const jsonOut = flag('--json');

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

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

async function readRig(page: Page): Promise<Vec3> {
  return page.evaluate(() => {
    const n = (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods;
    return { x: n.rig.position.x, y: n.rig.position.y, z: n.rig.position.z };
  });
}

async function readSpeed(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods.walker.speed);
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

async function walkFor(page: Page, ms: number, shift: boolean): Promise<void> {
  await page.keyboard.down('KeyW');
  if (shift) await page.keyboard.down('ShiftLeft');
  await sleep(ms);
  if (shift) await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await sleep(120);
}

async function overlapCount(page: Page): Promise<number> {
  return page.evaluate((radius: number) => {
    const n = (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods;
    const w = (window as unknown as { __nightwoodsWorld: WorldLike }).__nightwoodsWorld;
    const p = n.rig.position;
    let hits = 0;
    for (const c of [...w.trunks, ...w.blockers]) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < c.r + radius - 0.02) hits += 1;
    }
    return hits;
  }, RADIUS);
}

async function main(): Promise<void> {
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
      `--window-size=${vw},${vh}`,
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh });
  const events: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    const type = String(msg.type());
    if (type === 'error' || type === 'warning' || type === 'warn') events.push(`${type}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => events.push(`pageerror: ${String(err)}`));

  const u = new URL(baseUrl);
  u.searchParams.set('q', quality);
  u.searchParams.set('nowarm', '1');
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__dbg !== undefined', { timeout: 120000 });
  await page.waitForSelector('#start:not([disabled])', { timeout: 120000 });
  await page.click('#start:not([disabled])');
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout: 120000 });
  await sleep(1500); // asentar snap de suelo + unlock de audio

  // 1) Marcha: W 2 s.
  const p0 = await readRig(page);
  await walkFor(page, 2000, false);
  const p1 = await readRig(page);
  const dWalk = distXZ(p0, p1);
  const expectWalk = WALK_SPEED * 2;
  check('W 2 s avanza ~1.75 m/s', dWalk > expectWalk * 0.75 && dWalk < expectWalk * 1.2, `${dWalk.toFixed(2)} m (esperado ≈${expectWalk.toFixed(2)})`);

  // 2) Carrera: Shift+W 2 s + muestreo del bob (±0.02·1 → amplitud ~0.028 a run).
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await sleep(600);
  const bob = await page.evaluate(async (duration: number) => {
    const n = (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods;
    const eye = (): number => (n.rig as unknown as { children: Array<{ position: Vec3 }> }).children[0].position.y;
    let min = eye();
    let max = min;
    const t0 = performance.now();
    await new Promise<void>((res) => {
      const tick = (): void => {
        const v = eye();
        if (v < min) min = v;
        if (v > max) max = v;
        if (performance.now() - t0 < duration) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
    return { min, max };
  }, 900);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await sleep(120);
  const p2 = await readRig(page);
  const dRun = distXZ(p1, p2);
  // La carrera del test dura 600 + 900 ms (asentado + muestreo del bob).
  const expectRun = RUN_SPEED * 1.5;
  check('Shift+W corre ~3.9 m/s', dRun > expectRun * 0.85 && dRun < expectRun * 1.2, `${dRun.toFixed(2)} m (esperado ≈${expectRun.toFixed(2)})`);
  check('correr avanza claramente más que andar', dRun > dWalk * 1.5, `run ${dRun.toFixed(2)} vs walk ${dWalk.toFixed(2)}`);
  check(
    'bob vertical activo en carrera',
    bob.max - bob.min > 0.02 && bob.min > EYE - 0.05 && bob.max < EYE + 0.05,
    `y ∈ [${bob.min.toFixed(4)}, ${bob.max.toFixed(4)}] (eye=${EYE})`,
  );

  // 3) Colisión: teleport determinista a 2 m de un tronco grande y empujar
  // contra él (elegir la dirección con más hueco libre). Así el test no depende
  // de la geometría del spawn ni de vecinos imprevisibles.
  const target = await page.evaluate((radius: number) => {
    const w = (window as unknown as { __nightwoodsWorld: WorldLike }).__nightwoodsWorld;
    const all = w.trunks.filter((c) => c.r > 0.2);
    if (all.length === 0) return null;
    const c = all[0];
    // 16 direcciones: elegir la que deja el start más lejos de todo colisionador.
    let best: { x: number; z: number; yaw: number } | null = null;
    let bestClear = -1;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const d = c.r + radius + 2;
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      let clear = Number.POSITIVE_INFINITY;
      for (const o of [...w.trunks, ...w.blockers]) {
        if (o === c) continue;
        const od = Math.hypot(o.x - x, o.z - z) - (o.r + radius);
        if (od < clear) clear = od;
      }
      if (clear > bestClear) {
        bestClear = clear;
        // forward = (-sin yaw, -cos yaw) debe apuntar del start al tronco.
        const yaw = Math.atan2(-(c.x - x), -(c.z - z));
        best = { x, z, yaw };
      }
    }
    return { c, place: best as { x: number; z: number; yaw: number } };
  }, RADIUS);

  if (target === null) {
    check('hay algún tronco con r > 0.2', false, 'no se encontró ningún tronco');
  } else {
    const c = target.c;
    await page.evaluate((p: { x: number; z: number; yaw: number }) => {
      const n = (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods;
      n.rig.position.x = p.x;
      n.rig.position.z = p.z;
      n.rig.rotation.y = p.yaw;
    }, target.place);
    await sleep(600); // rescan del scatter + snap de suelo
    const before = await readRig(page);
    const dBefore = Math.hypot(c.x - before.x, c.z - before.z);
    await walkFor(page, 2500, false);
    const after = await readRig(page);
    const dAfter = Math.hypot(c.x - after.x, c.z - after.z);
    const limit = c.r + RADIUS;
    // 800 ms más empujando: si está bloqueado, apenas avanza.
    await page.keyboard.down('KeyW');
    await sleep(400);
    const pA = await readRig(page);
    await sleep(800);
    const pB = await readRig(page);
    await page.keyboard.up('KeyW');
    await sleep(600);
    const slid = distXZ(pA, pB);
    const overlaps = await overlapCount(page);
    check('se acerca al tronco', dAfter < dBefore - 1, `${dBefore.toFixed(2)} → ${dAfter.toFixed(2)} m (r=${c.r.toFixed(2)})`);
    check('se detiene en r + 0.32 sin penetrar', dAfter >= limit - 0.03 && dAfter <= limit + 0.12, `dist ${dAfter.toFixed(3)} (límite ${limit.toFixed(3)})`);
    check('bloqueado por colisión mientras empuja', slid < 0.15, `avance en 0.8 s = ${slid.toFixed(3)} m`);
    check('sin penetrar ningún colisionador', overlaps === 0, `overlaps=${overlaps}`);
  }

  // 4) Parada + pasos + audio.
  const speed = await readSpeed(page);
  check('velocidad ~0 al soltar', speed < 0.1, `speed=${speed.toFixed(3)}`);
  const audio = await page.evaluate(() => {
    const a = (window as unknown as { __nightwoods: NightwoodsLike }).__nightwoods.audio;
    return { state: a.contextState, steps: a.stats().steps };
  });
  check('pasos sintetizados disparados', audio.steps > 3, `steps=${audio.steps}`);
  check('audio desbloqueado', audio.state === 'running', `ctx=${audio.state}`);

  const y = (await readRig(page)).y;
  check('altura finita y sobre el terreno', Number.isFinite(y) && y > -50 && y < 200, `y=${y.toFixed(2)}`);

  check('consola sin errores/warnings', events.length === 0, `${events.length} eventos`);

  const result = {
    url: u.toString(),
    checks,
    events,
    walkM: Math.round(dWalk * 100) / 100,
    runM: Math.round(dRun * 100) / 100,
    pass: checks.every((c) => c.ok),
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`walk-probe · ${result.url}`);
    for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} · ${c.detail}`);
    for (const e of events.slice(0, 10)) console.log(`  [console] ${e.slice(0, 200)}`);
    console.log(result.pass ? 'WALK PASS' : `WALK FAIL (${checks.filter((c) => !c.ok).length})`);
  }
  if (!result.pass) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
} finally {
  await closeBrowser();
  killServer();
  process.exit(process.exitCode ?? 0);
}

/** Cierre fuera de `main()` (el CFA de `finally` narrowa `browser` a `never`). */
async function closeBrowser(): Promise<void> {
  const b: Browser | null = browser;
  if (b === null) return;
  const proc = b.process();
  try {
    await Promise.race([b.close(), sleep(8000)]);
  } catch {
    /* ya cerrado */
  }
  try {
    proc?.kill('SIGKILL');
  } catch {
    /* ya muerto */
  }
}
