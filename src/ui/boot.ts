import type { Quality } from '../core/constants';

// Etapas ponderadas de §12: renderer .08 / world .6 / placing .1 / shaders .22.
const STAGE_END = [8, 68, 78, 100];
const DEFAULT_MS = [900, 7000, 700, 3000];
const MEMO_PREFIX = 'nightwoods-load-';

export interface Boot {
  showLoading(label: string, pct: number): void;
  ready(): void;
  hidden: boolean;
}

function loadMemo(key: string): number[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const out: number[] = [];
    for (const v of parsed) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      out.push(v);
    }
    return out;
  } catch {
    return null;
  }
}

function saveMemo(key: string, values: number[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* storage bloqueado: el loader usa los defaults la próxima vez */
  }
}

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`boot: falta #${id}`);
  return el as T;
}

export function createBoot(quality: Quality): Boot {
  const root = need<HTMLDivElement>('boot');
  const labelEl = need<HTMLDivElement>('bootLabel');
  const fillEl = need<HTMLDivElement>('bootFill');
  const pctEl = need<HTMLDivElement>('bootPct');

  const memoKey = MEMO_PREFIX + quality;
  const memo = loadMemo(memoKey) ?? [...DEFAULT_MS];
  const measured = [0, 0, 0, 0];

  let hidden = false;
  let stage = -1;
  let display = 0;
  let target = 0;
  let stageStart = 0;
  let estimate = DEFAULT_MS[0];
  let raf = 0;
  let shownPct = -1;

  function step(now: number): void {
    raf = requestAnimationFrame(step);
    const t = (now - stageStart) / estimate;
    const e = t < 1 ? (t > 0 ? t : 0) : 1;
    const raw = display + (target - display) * e;
    const pct = stage === STAGE_END.length - 1 && raw > 99 ? 99 : raw;
    const n = Math.round(pct);
    if (n !== shownPct) {
      shownPct = n;
      pctEl.textContent = 'LOADING ' + n + '%';
      fillEl.style.width = n + '%';
    }
  }

  function showLoading(label: string, pct: number): void {
    const now = performance.now();
    if (stage >= 0) measured[stage] += now - stageStart;
    const t = (now - stageStart) / estimate;
    const e = t < 1 ? (t > 0 ? t : 0) : 1;
    display += (target - display) * e;
    if (display < pct) display = pct;
    if (stage < STAGE_END.length - 1) stage += 1;
    target = STAGE_END[stage];
    estimate = Math.max(1, memo[stage]);
    stageStart = now;
    labelEl.textContent = label;
    if (raf === 0) raf = requestAnimationFrame(step);
  }

  function ready(): void {
    if (hidden) return;
    const now = performance.now();
    if (stage >= 0) measured[stage] += now - stageStart;
    const out: number[] = [];
    for (let i = 0; i < 4; i += 1) out.push(measured[i] > 0 ? measured[i] : memo[i]);
    saveMemo(memoKey, out);
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    shownPct = 100;
    pctEl.textContent = 'LOADING 100%';
    fillEl.style.width = '100%';
    root.classList.add('hidden');
    hidden = true;
  }

  return {
    showLoading,
    ready,
    get hidden(): boolean {
      return hidden;
    },
  };
}
