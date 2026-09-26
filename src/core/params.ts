import type { Quality } from './constants';

export const url = new URLSearchParams(location.search);

export function pstr(name: string, def = ''): string {
  const v = url.get(name);
  return v === null ? def : v;
}

export function pnum(name: string, def: number): number {
  const raw = url.get(name);
  if (raw === null) return def;
  const v = Number.parseFloat(raw);
  return Number.isNaN(v) ? def : v;
}

export function pbool(name: string, def = true): boolean {
  const raw = url.get(name);
  if (raw === null) return def;
  const s = raw.toLowerCase();
  return s !== '0' && s !== 'false';
}

export function qualityParam(): Quality | null {
  const q = url.get('q');
  return q === 'low' || q === 'medium' || q === 'high' ? q : null;
}
