import type { Quality } from './constants';
import { qualityParam } from './params';

const STORE_KEY = 'nightwoods-quality';

function isQuality(v: string | null): v is Quality {
  return v === 'low' || v === 'medium' || v === 'high';
}

export function detectQuality(): Quality {
  if (matchMedia('(pointer: coarse)').matches) return 'low';
  const cores = navigator.hardwareConcurrency;
  if (cores >= 10) return 'high';
  if (cores >= 6) return 'medium';
  return 'low';
}

export function initialQuality(): Quality {
  const fromUrl = qualityParam();
  if (fromUrl !== null) return fromUrl;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    stored = null;
  }
  if (isQuality(stored)) return stored;
  return detectQuality();
}

export function persistQuality(q: Quality): void {
  try {
    localStorage.setItem(STORE_KEY, q);
  } catch {
    /* storage blocked (private mode): quality stays in-memory */
  }
}
