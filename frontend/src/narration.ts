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

export type OsrmLandmarkCue = 'at' | 'after' | 'prefix-after';

export type OsrmLandmarkMatch = {
  name: string;
  cue: OsrmLandmarkCue;
};

const GENERIC_SINGLE_WORD_POI_NAMES = new Set([
  'bank', 'college', 'hospital', 'petrol', 'pump', 'school', 'station',
  'store', 'temple', 'tower', 'university', 'destination', 'waypoint', 'road', 'street',
]);

function isSpecificPoiName(name: string): boolean {
  const normalized = normalizeNarrationText(name);
  if (normalized.length < 4) return false;
  const words = normalized.split(' ');
  return words.length > 1 || !GENERIC_SINGLE_WORD_POI_NAMES.has(normalized);
}

const GENERIC_NAVIGATION_FEATURES = /^(?:the\s+)?(?:fork|roundabout|intersection|junction|crossroads?|ramp|(?:left|right|middle)?\s*lanes?|(?:(?:next|first|second|third|unnamed|\d+(?:st|nd|rd|th))\s+)?exit(?:\s+(?:on\s+)?(?:the\s+)?(?:left|right))?)$/;

function extractOsrmLandmarkSlot(instruction: string): OsrmLandmarkMatch | null {
  const prefixText = instruction.match(/^\s*after\s+(?:the\s+)?(.+?)\s*:\s*/i)?.[1]?.trim();
  if (prefixText && isSpecificPoiName(prefixText)) return { name: prefixText, cue: 'prefix-after' };

  if (!/^\s*(turn|keep|merge|take|make|bear|use|enter|exit|continue|stay|fork)\b/i.test(instruction)) return null;

  const cuePattern = /\b(at|after)(?:\s+the)?\s+/gi;
  let lastMatch: RegExpExecArray | null = null;
  for (let match = cuePattern.exec(instruction); match; match = cuePattern.exec(instruction)) lastMatch = match;
  if (!lastMatch) return null;
  const name = instruction.slice(lastMatch.index + lastMatch[0].length).replace(/[\s.,;!?]+$/g, '').trim();
  if (!isSpecificPoiName(name)) return null;
  return { name, cue: lastMatch[1].toLowerCase() as 'at' | 'after' };
}

export function parseOsrmLandmarkInstruction(instruction: string): OsrmLandmarkMatch | null {
  const match = extractOsrmLandmarkSlot(instruction);
  if (!match || GENERIC_NAVIGATION_FEATURES.test(normalizeNarrationText(match.name))) return null;
  return match;
}

/**
 * Matches only the POI slot in OSRM's supported landmark grammar. This is
 * deliberately stricter than a substring search: a name elsewhere in a road
 * name or instruction is not landmark evidence.
 */
export function matchOsrmLandmarkInstruction(
  instruction: string,
  candidateNames: Iterable<string>,
): OsrmLandmarkMatch | null {
  // Exact source-name correlation may identify a real POI whose proper name
  // happens to be a generic navigation word. Only narration-only fallback
  // classification rejects generic navigation features.
  const parsed = extractOsrmLandmarkSlot(instruction);
  if (!parsed) return null;

  const names = Array.from(new Set(candidateNames))
    .filter(isSpecificPoiName)
    .sort((a, b) => normalizeNarrationText(b).length - normalizeNarrationText(a).length);

  const match = names.find((name) => normalizeNarrationText(name) === normalizeNarrationText(parsed.name));
  return match ? { name: match, cue: parsed.cue } : null;
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
