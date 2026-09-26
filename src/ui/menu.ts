import type { Quality } from '../core/constants';
import { initialQuality } from '../core/quality';

export interface Menu {
  selectQuality(q: Quality): void;
  enableStart(backendLabel: string): void;
  onStart(cb: () => void): void;
  onQuality(cb: (q: Quality) => void): void;
  hide(): void;
  show(): void;
  isVisible(): boolean;
}

function isQuality(v: string | undefined): v is Quality {
  return v === 'low' || v === 'medium' || v === 'high';
}

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`menu: falta #${id}`);
  return el as T;
}

export function createMenu(): Menu {
  const root = need<HTMLDivElement>('ui');
  const startBtn = need<HTMLButtonElement>('start');
  const note = need<HTMLDivElement>('backendNote');
  const qualRoot = need<HTMLDivElement>('qualOpts');

  const startCbs: Array<() => void> = [];
  const qualityCbs: Array<(q: Quality) => void> = [];
  const buttons = qualRoot.querySelectorAll<HTMLButtonElement>('button[data-q]');

  function selectQuality(q: Quality): void {
    buttons.forEach((b) => {
      b.classList.toggle('sel', b.dataset.q === q);
    });
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const q = b.dataset.q;
      if (!isQuality(q)) return;
      selectQuality(q);
      for (const cb of qualityCbs) cb(q);
    });
  });

  startBtn.addEventListener('click', () => {
    if (startBtn.disabled) return;
    for (const cb of startCbs) cb();
  });

  selectQuality(initialQuality());

  return {
    selectQuality,
    enableStart(backendLabel: string): void {
      note.textContent = backendLabel;
      startBtn.disabled = false;
      startBtn.textContent = 'START';
    },
    onStart(cb: () => void): void {
      startCbs.push(cb);
    },
    onQuality(cb: (q: Quality) => void): void {
      qualityCbs.push(cb);
    },
    hide(): void {
      root.classList.add('hidden');
    },
    show(): void {
      root.classList.remove('hidden');
    },
    isVisible(): boolean {
      return !root.classList.contains('hidden');
    },
  };
}
