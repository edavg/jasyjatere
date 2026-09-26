import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

/**
 * Probe de post (S6): mide brillo real (mean y región central) de una captura
 * decodificada en la propia página (canvas 2D auxiliar) y comprueba el buffer
 * de velocity con la cámara en movimiento. Sustituye a mirar solo la captura:
 *
 *   node tools/post-probe.ts [--base http://127.0.0.1:5174] [--q medium]
 *     [--out artifacts/fase-6-velocity.png]
 *
 * - `stats`: brillo medio de `?post=0`, `?post=1`, full y variantes (detecta
 *   doble tonemap: full no debe ser ~2× más claro que `?post=0`).
 * - `velocity`: `?view=velocity&fly=1`, screenshot en reposo y tras 1 s con W
 *   pulsada; el mean debe pasar de ~0 (negro) a >0 (buffer con movimiento).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1440, height: 900 };

const argv = process.argv.slice(2);

function value(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

const BASE = value('--base') ?? 'http://127.0.0.1:5174';
const Q = value('--q') ?? 'medium';
const OUT = resolve(ROOT, value('--out') ?? 'artifacts/fase-6-velocity.png');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

interface Stats {
  mean: number;
  center: number;
  width: number;
  height: number;
}

interface LumaReport {
  mean: number;
  center: number;
  post: unknown;
}

async function shoot(page: Page): Promise<string> {
  return page.screenshot({ encoding: 'base64' });
}

async function statsOf(page: Page, png: string): Promise<Stats> {
  return page.evaluate(async (b64: string): Promise<Stats> => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('sin canvas 2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let center = 0;
    let n = 0;
    const x0 = Math.floor(canvas.width * 0.3);
    const x1 = Math.floor(canvas.width * 0.7);
    const y0 = Math.floor(canvas.height * 0.3);
    const y1 = Math.floor(canvas.height * 0.7);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          center += l;
          n++;
        }
      }
    }
    return { mean: sum / (canvas.width * canvas.height), center: center / n, width: canvas.width, height: canvas.height };
  }, png);
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dbg !== undefined', { timeout: 60000 });
  await page.waitForSelector('#start:not([disabled])', { timeout: 60000 });
  await page.click('#start:not([disabled])');
  await page.waitForFunction('window.__dbg && window.__dbg.frame > 20', { timeout: 60000 });
  await sleep(700);
}

async function luma(page: Page, url: string): Promise<LumaReport> {
  await open(page, url);
  const stats = await statsOf(page, await shoot(page));
  const post = await page.evaluate(
    () => (window as unknown as { __dbg?: { post?: unknown } }).__dbg?.post ?? null,
  );
  return {
    mean: Math.round(stats.mean * 100) / 100,
    center: Math.round(stats.center * 100) / 100,
    post,
  };
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
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
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => {
      errors.push(String(e));
    });

    const cam = 'cam=0,0,0&look=0,0.1';
    const reports: Record<string, LumaReport> = {};
    for (const [name, extra] of [
      ['nopost', 'post=0'],
      ['post1', 'post=1'],
      ['post1Neutral', 'post=1&tune=contrast:1,saturation:1'],
      ['full', ''],
      ['fullNeutral', 'tune=contrast:1,saturation:1,ca:0,vignette:0,grain:0'],
      ['viewNormal', 'view=normal'],
      ['flashNoBloom', 'post=5&flash=0.9'],
      ['flashBloom', 'post=6&flash=0.9'],
      ['tuneExposure', 'tune=exposure:0.5'],
    ] as const) {
      const query = `${cam}${extra !== '' ? `&${extra}` : ''}`;
      reports[name] = await luma(page, `${BASE}/?q=${Q}&${query}`);
    }

    const low = await luma(page, `${BASE}/?q=low&${cam}`);

    // Resize: cambia el viewport y comprueba que el frame avanza y `post.size`
    // se actualiza (listener propio de Post + setSize del pase).
    await open(page, `${BASE}/?q=${Q}&${cam}`);
    const frameBefore = await page.evaluate(() => (window as unknown as { __dbg: { frame: number } }).__dbg.frame);
    await page.setViewport({ width: 1000, height: 700 });
    await sleep(600);
    const resize = await page.evaluate(() => {
      const d = (window as unknown as { __dbg: { frame: number; post?: { size?: number[] } } }).__dbg;
      return { frame: d.frame, size: d.post?.size ?? null };
    });

    // Velocity: reposo vs 1 s con W (fly).
    await open(page, `${BASE}/?q=${Q}&view=velocity&fly=1`);
    const rest = await statsOf(page, await shoot(page));
    await page.keyboard.down('KeyW');
    await sleep(1000);
    const movingPng = await shoot(page);
    await page.keyboard.up('KeyW');
    const moving = await statsOf(page, movingPng);
    mkdirSync(dirname(OUT), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUT, Buffer.from(movingPng, 'base64'));

    // Ghosting de TAA: misma maniobra (W + giro con flechas) con traa y off.
    const motionShots: Record<string, string> = {};
    for (const [name, extra] of [
      ['moveTraa', ''],
      ['moveTaaOff', 'taa=off'],
    ] as const) {
      await open(page, `${BASE}/?q=${Q}&fly=1&${cam}${extra !== '' ? `&${extra}` : ''}`);
      await page.keyboard.down('KeyW');
      await page.keyboard.down('ArrowLeft');
      await sleep(900);
      const png = await shoot(page);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.up('KeyW');
      const file = resolve(ROOT, `artifacts/fase-6-${name}.png`);
      writeFileSync(file, Buffer.from(png, 'base64'));
      motionShots[name] = file;
    }

    console.log(
      JSON.stringify(
        {
          reports,
          low,
          resize: { frameBefore, ...resize, advanced: resize.frame > frameBefore },
          velocity: {
            rest: Math.round(rest.mean * 100) / 100,
            moving: Math.round(moving.mean * 100) / 100,
            moved: Math.round((moving.mean - rest.mean) * 100) / 100,
            out: OUT,
          },
          motionShots,
          consoleErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

await main();
