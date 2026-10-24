import type { LngLat } from './types';

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
