import type { LngLat } from './types';

export function haversineMeters(a: LngLat, b: LngLat): number {
  const earthRadiusM = 6371008.8;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Preserve the current coordinate-field behavior: accept any finite number. */
export function parseCoordinateInput(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Return an updated coordinate, or the original value when the input is not a
 * finite number. A missing coordinate starts from [0, 0], matching App.tsx's
 * established controlled-input behavior.
 */
export function updateCoordinateValue(
  current: LngLat | null,
  axis: 0 | 1,
  text: string,
): LngLat | null {
  const value = parseCoordinateInput(text);
  if (value === null) return current;
  const next: LngLat = current ? [...current] as LngLat : [0, 0];
  next[axis] = value;
  return next;
}
