import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1440, height: 900 };

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

function withQuality(rawUrl: string, q: string | undefined): string {
  const u = new URL(rawUrl);
  if (q !== undefined) u.searchParams.set('q', q);
  return u.toString();
}

async function respondsTo(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const url = value('--url') ?? 'http://127.0.0.1:5173/';
  const q = value('--q');
  const out = resolve(ROOT, value('--out') ?? 'artifacts/shot.png');
  const waitMs = num('--wait', 2500);
  const timeout = num('--timeout', 60000);
  const start = !flag('--no-start');

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
    if (!(await respondsTo(url))) {
      // El puerto sale de --url (por defecto 5173, el de vite.config.ts), así el
      // auto-spawn funciona aunque 5173 esté ocupado por otro proceso.
      const port = new URL(url).port || '5173';
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
        if (await respondsTo(url)) {
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

    await page.goto(withQuality(url, q), { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction('window.__dbg !== undefined', { timeout });
    if (start) {
      await page.waitForSelector('#start:not([disabled])', { timeout });
      await page.click('#start:not([disabled])');
    }
    await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout });
    await sleep(waitMs);

    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out });

    const info = await page.evaluate(() => {
      const d = (window as unknown as {
        __dbg?: { backend?: string; dpr?: number; quality?: string; frame?: number };
      }).__dbg;
      return {
        backend: d?.backend ?? '',
        dpr: d?.dpr ?? 0,
        quality: d?.quality ?? '',
        frame: d?.frame ?? 0,
      };
    });

    console.log(JSON.stringify({
      backend: info.backend,
      dpr: info.dpr,
      quality: info.quality,
      frame: info.frame,
      isWebGPU: info.backend === 'webgpu',
      out,
      consoleErrors,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      consoleErrors,
    }));
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

await main();
