import type { LngLat, Maneuver, OsrmStep } from './types';

interface NarrationPoiIdentity {
  poiId: string;
  sourceNodeId: string;
  name: string;
  coordinate: LngLat;
}

export function normalizeNarrationText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function maneuverInstructionTexts(maneuver: Maneuver): string[] {
  const values = [maneuver.instruction, maneuver.verbal_pre_transition_instruction]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

export function instructionContainsName(instruction: string, name: string): boolean {
  const normalizedInstruction = ` ${normalizeNarrationText(instruction)} `;
  const normalizedName = normalizeNarrationText(name);
  return normalizedName.length >= 3 && normalizedInstruction.includes(` ${normalizedName} `);
}

export function hasStrongLandmarkCue(instruction: string, name: string): boolean {
  const normalizedInstruction = ` ${normalizeNarrationText(instruction)} `;
  const normalizedName = normalizeNarrationText(name);
  if (!normalizedName) return false;
  return normalizedInstruction.includes(` at ${normalizedName} `) ||
    normalizedInstruction.includes(` at the ${normalizedName} `);
}

export function narrationPoiKey(item: NarrationPoiIdentity): string {
  if (item.poiId) return `poi:${item.poiId}`;
  if (item.sourceNodeId) return `node:${item.sourceNodeId}`;
  return `name:${normalizeNarrationText(item.name)}|${item.coordinate[0].toFixed(7)}|${item.coordinate[1].toFixed(7)}`;
}

export function osrmInstructionText(step: OsrmStep): string {
  const detailed = String(step.maneuver?.instruction ?? '').trim();
  if (detailed) return detailed;

  const shortInstruction = String(step.maneuver?.short_instruction ?? '').trim();
  if (shortInstruction) return shortInstruction;

  const structured = [
    String(step.maneuver?.type ?? '').trim(),
    String(step.maneuver?.modifier ?? '').trim(),
  ].filter(Boolean).join(' ');

  if (structured) return structured;
  return String(step.name ?? '').trim() || 'Unnamed OSRM step';
}
