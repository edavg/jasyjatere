import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser, ConsoleMessage } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * QA de cierre (T7.2.5): una sesión real headless que valida el HUD (barras,
 * flash, stats con P, ESC menú, log ?debug=1), el audio tras el gesto de START
 * (contextState running, capas con ganancia, burst de trueno con ?bolt=1) y la
 * consola durante `--seconds` (por defecto 180 s = 3 min): CERO errores y CERO
 * warnings. Al final llama a `window.__nightwoods.dispose()` y comprueba que no
 * aparezcan errores nuevos.
 *
 *   node tools/qa-session.ts [--url http://127.0.0.1:5176/] [--q low] [--seconds 180]
 *                            [--viewport 960x540] [--json]
 *
 * La vista es pequeña y el tier `low` a propósito: el QA es de consola/HUD, no
 * de rendimiento (para eso están `bench.ts` y `frame-probe.ts`). Los ms de
 * SwiftShader no representan una GPU real.
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

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface QaDbg {
  frame: number;
  backend?: string;
  gust?: number;
  scatterStats?: { lastScanMs?: number; scans?: number };
  post?: Record<string, unknown>;
}

interface QaAudio {
  contextState: string;
  muted: boolean;
  stats(): { rainLayers: number; windGain: number; thunderActive: number; burstMs: number };
}

interface QaGlobal {
  audio?: QaAudio;
}

const baseUrl = value('--url') ?? 'http://127.0.0.1:5176/';
const quality = value('--q') ?? 'low';
const seconds = Math.max(10, Math.round(num('--seconds', 180)));
const warmup = Math.max(1, Math.round(num('--warmup', 3)));
const viewportRaw = value('--viewport') ?? '960x540';
const [vw, vh] = viewportRaw.split('x').map((v) => Math.max(320, Math.round(Number.parseFloat(v) || 0)));
const jsonOut = flag('--json');

const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  return ok;
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

interface ConsoleEvent {
  type: string;
  text: string;
  t: number;
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

  const events: ConsoleEvent[] = [];
  const push = (type: string, text: string): void => {
    if (events.length < 200) events.push({ type, text, t: Math.round(performance.now()) });
  };
  page.on('console', (msg: ConsoleMessage) => push(msg.type(), msg.text()));
  page.on('pageerror', (err) => push('pageerror', String(err)));
  page.on('error', (err) => push('pagecrash', String(err)));
  page.on('close', () => push('pageclose', 'page closed/crashed'));
  page.on('requestfailed', (req) => push('requestfailed', `${req.url()} ${req.failure()?.errorText ?? ''}`));

  const consoleErrors = (): ConsoleEvent[] => events.filter((e) => e.type === 'error' || e.type === 'pageerror');
  const consoleWarnings = (): ConsoleEvent[] => events.filter((e) => e.type === 'warning' || e.type === 'warn' || e.type === 'requestfailed');

  const url = new URL(baseUrl);
  url.searchParams.set('q', quality);
  url.searchParams.set('debug', '1');
  url.searchParams.set('bolt', '1');
  url.searchParams.set('seed', '1337');

  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__dbg !== undefined', { timeout: 120000 });
  await page.waitForSelector('#start:not([disabled])', { timeout: 120000 });
  await page.click('#start:not([disabled])');
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout: 120000 });
  await sleep(warmup * 1000);

  // --- Monitor de frames (para el soak) ------------------------------------
  await page.evaluate(() => {
    const g = window as unknown as { __qa?: { max: number; count: number; last: number } };
    g.__qa = { max: 0, count: 0, last: performance.now() };
    const tick = (): void => {
      const now = performance.now();
      const d = now - g.__qa!.last;
      if (d > g.__qa!.max) g.__qa!.max = d;
      g.__qa!.last = now;
      g.__qa!.count += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // --- HUD: barras + nota de backend + log ---------------------------------
  const hud = await page.evaluate(() => {
    const el = (id: string): HTMLElement | null => document.getElementById(id);
    return {
      visible: el('hud') !== null && !el('hud')!.classList.contains('hidden'),
      backend: el('hudBackend')?.textContent ?? '',
      rain: el('hudRainNum')?.textContent ?? '',
      wind: el('hudWindNum')?.textContent ?? '',
      vol: el('hudVol')?.textContent ?? '',
      debugShown: ((el('debugLog') as HTMLElement | null)?.style.display ?? '') === 'block',
      debugText: el('debugLog')?.textContent ?? '',
    };
  });
  check('HUD visible tras START', hud.visible, `visible=${String(hud.visible)}`);
  check('nota de backend persistente', /WEBGPU|WEBGL2/.test(hud.backend), hud.backend);
  check('log ?debug=1 activo y con datos', hud.debugShown && hud.debugText.includes('nightwoods q='), `${hud.debugShown ? '' : 'oculto '}len=${hud.debugText.length}`);

  // Barras: lluvia (2 sube 0.15) y viento (4 sube 0.2) con flash 1.8 s.
  const before = { rain: hud.rain, wind: hud.wind };
  await page.keyboard.press('Digit2');
  await page.keyboard.press('Digit4');
  await sleep(250);
  const after = await page.evaluate(() => {
    const el = (id: string): HTMLElement | null => document.getElementById(id);
    return {
      rain: el('hudRainNum')?.textContent ?? '',
      wind: el('hudWindNum')?.textContent ?? '',
      rainFlash: el('hudRainBar')?.classList.contains('hud-flash') ?? false,
      windFlash: el('hudWindBar')?.classList.contains('hud-flash') ?? false,
      rainBar: el('hudRainBar')?.textContent ?? '',
    };
  });
  check('tecla 2 sube lluvia', after.rain !== before.rain, `${before.rain} → ${after.rain}`);
  check('tecla 4 sube viento', after.wind !== before.wind, `${before.wind} → ${after.wind}`);
  check('barra de lluvia con ▮', after.rainBar.includes('▮'), `«${after.rainBar.slice(0, 24)}…»`);
  check('flash 1.8 s activado al cambiar', after.rainFlash && after.windFlash, `rain=${String(after.rainFlash)} wind=${String(after.windFlash)}`);

  // Stats con P (alterna) + volumen con - y mute con M.
  await page.keyboard.press('KeyP');
  await sleep(400);
  const statsOn = await page.evaluate(() => {
    const el = document.getElementById('stats') as HTMLElement | null;
    return { display: el === null ? '' : getComputedStyle(el).display, text: el?.textContent ?? '' };
  });
  check('P muestra stats con datos', statsOn.display !== 'none' && statsOn.text.includes('FPS') && statsOn.text.includes('GRASS'), `display=${statsOn.display} lines=${statsOn.text.split('\n').length}`);
  await page.keyboard.press('KeyP');
  await sleep(150);
  const statsOff = await page.evaluate(() => getComputedStyle(document.getElementById('stats') as HTMLElement).display);
  check('P oculta stats', statsOff === 'none', `display=${statsOff}`);

  await page.keyboard.press('Minus');
  await sleep(200);
  const volAfter = await page.evaluate(() => document.getElementById('hudVol')?.textContent ?? '');
  check('tecla - baja el volumen', volAfter !== hud.vol, `${hud.vol} → ${volAfter}`);
  await page.keyboard.press('KeyM');
  await sleep(200);
  const muted = await page.evaluate(() => document.getElementById('hudVol')?.textContent ?? '');
  check('M mutea', muted.includes('MUTED'), muted);
  await page.keyboard.press('KeyM');

  // ESC alterna menú/HUD.
  await page.keyboard.press('Escape');
  await sleep(300);
  const esc1 = await page.evaluate(() => ({
    menu: !document.getElementById('ui')!.classList.contains('hidden'),
    hud: document.getElementById('hud')!.classList.contains('hidden'),
  }));
  await page.keyboard.press('Escape');
  await sleep(300);
  const esc2 = await page.evaluate(() => ({
    menu: !document.getElementById('ui')!.classList.contains('hidden'),
    hud: document.getElementById('hud')!.classList.contains('hidden'),
  }));
  check('ESC abre menú y oculta HUD', esc1.menu && esc1.hud, JSON.stringify(esc1));
  check('ESC cierra menú y muestra HUD', !esc2.menu && !esc2.hud, JSON.stringify(esc2));

  // --- Audio (gesto ya hecho con START) ------------------------------------
  await sleep(1500);
  const audio = await page.evaluate(() => {
    const a = (window as unknown as { __nightwoods?: QaGlobal }).__nightwoods?.audio;
    if (a === undefined) return null;
    const s = a.stats();
    return { state: a.contextState, muted: a.muted, rain: s.rainLayers, wind: s.windGain, thunderActive: s.thunderActive, burstMs: s.burstMs };
  });
  check('audio desbloqueado (contextState running)', audio !== null && audio.state === 'running', JSON.stringify(audio));
  check('capa de lluvia con ganancia', audio !== null && audio.rain > 0.01, `rainLayers=${audio?.rain ?? 'n/a'}`);
  check('viento con ganancia', audio !== null && audio.wind > 0, `windGain=${audio?.wind ?? 'n/a'}`);
  const thunder = audio !== null && audio.burstMs > 0;
  check('trueno disparado (?bolt=1)', thunder, `burstMs=${audio?.burstMs ?? 0} active=${audio?.thunderActive ?? 0}`);

  // --- Soak: consola limpia + frames avanzando ------------------------------
  const frame0 = await page.evaluate(() => (window as unknown as { __dbg: QaDbg }).__dbg.frame);
  const heap0 = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const started = Date.now();
  let lastFrame = frame0;
  let stalled = 0;
  let crashed = false;
  while ((Date.now() - started) / 1000 < seconds) {
    await sleep(5000);
    let f: number;
    try {
      f = await page.evaluate(() => (window as unknown as { __dbg: QaDbg }).__dbg.frame);
    } catch (err) {
      // Un frame detached (crash/recarga) no debe colgar el QA: se registra y
      // se corta la ventana con el frame alcanzado.
      push('qadetached', String(err));
      crashed = true;
      break;
    }
    if (f === lastFrame) stalled += 1;
    lastFrame = f;
    if (!jsonOut) process.stderr.write(`  … soak ${Math.round((Date.now() - started) / 1000)}s frame=${f}\n`);
  }
  let soak = { frame: lastFrame, maxFrameGapMs: 0, frames: 0, gust: 0, scanMs: 0, scans: 0 };
  let heap1 = heap0;
  let disposed = false;
  if (!crashed) {
    soak = await page.evaluate(() => {
      const d = (window as unknown as { __dbg: QaDbg }).__dbg;
      const g = (window as unknown as { __qa?: { max: number; count: number } }).__qa;
      return {
        frame: d.frame,
        maxFrameGapMs: g?.max ?? 0,
        frames: g?.count ?? 0,
        gust: d.gust ?? 0,
        scanMs: d.scatterStats?.lastScanMs ?? 0,
        scans: d.scatterStats?.scans ?? 0,
      };
    });
    heap1 = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

    // --- dispose global -----------------------------------------------------
    await page.evaluate(() => {
      const g = window as unknown as { __nightwoods?: { dispose(): void } };
      g.__nightwoods?.dispose();
    });
    await sleep(800);
    disposed = true;
  }
  const elapsed = (Date.now() - started) / 1000;
  const fps = (soak.frame - frame0) / elapsed;
  check(`consola sin errores en ${seconds}s`, consoleErrors().length === 0, `${consoleErrors().length} errores`);
  check(`consola sin warnings en ${seconds}s`, consoleWarnings().length === 0, `${consoleWarnings().length} warnings`);
  check('la sesión no se interrumpe (sin crash/recarga)', !crashed, crashed ? 'frame detached durante el soak' : `frame ${frame0} → ${soak.frame}`);
  check('el bucle avanza durante el soak', !crashed && stalled === 0, `frame ${frame0} → ${soak.frame} · fps≈${fps.toFixed(1)} · stalls=${stalled}`);
  check('reloj de viento (gust) vivo', soak.gust > 0, `gust=${soak.gust.toFixed(3)}`);
  check('streaming ha reescaneado', soak.scans > 0, `scans=${soak.scans} lastScanMs=${soak.scanMs}`);
  check('dispose() sin errores nuevos', disposed && consoleErrors().length === 0, `${consoleErrors().length} errores tras dispose`);

  const result = {
    url: url.toString(),
    quality,
    seconds,
    viewport: `${vw}x${vh}`,
    backend: crashed ? '' : await page.evaluate(() => (window as unknown as { __dbg?: QaDbg }).__dbg?.backend ?? ''),
    fps: Math.round(fps * 10) / 10,
    frameGapMaxMs: Math.round(soak.maxFrameGapMs),
    heapDeltaMB: Math.round(((heap1 - heap0) / 1048576) * 10) / 10,
    events,
    checks,
    pass: checks.every((c) => c.ok),
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`qa-session · ${result.url} · ${seconds}s · backend ${result.backend} · fps≈${result.fps} (SwiftShader)`);
    for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} · ${c.detail}`);
    const bad = events.filter((e) => e.type !== 'log' && e.type !== 'info' && e.type !== 'debug');
    if (bad.length > 0) {
      console.log('eventos de consola:');
      for (const e of bad.slice(0, 20)) console.log(`  [${e.type}] ${e.text.slice(0, 240)}`);
    }
    console.log(result.pass ? 'QA PASS' : `QA FAIL (${checks.filter((c) => !c.ok).length})`);
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
  // Salida explícita: con la pestaña detached pueden quedar handles vivos
  // (websocket CDP) y el proceso se colgaría hasta el timeout del CI.
  process.exit(process.exitCode ?? 0);
}

/**
 * Cierre fuera de `main()`: evita el narrowing a `never` del CFA en `finally`.
 * Con la página detached `browser.close()` puede colgarse: se le pone techo de
 * 8 s y, si no cierra, se mata el proceso (el QA nunca debe quedarse colgado).
 */
async function closeBrowser(): Promise<void> {
  const b: Browser | null = browser;
  if (b === null) return;
  const proc = b.process();
  try {
    await Promise.race([b.close(), sleep(8000)]);
  } catch {
    /* el navegador ya estaba cerrado */
  }
  try {
    proc?.kill('SIGKILL');
  } catch {
    /* ya había muerto */
  }
}
