import { describe, expect, it } from 'vitest';
import {
  hasStrongLandmarkCue,
  instructionContainsName,
  maneuverInstructionTexts,
  narrationPoiKey,
  normalizeNarrationText,
  osrmInstructionText,
} from './narration';

describe('narration text matching', () => {
  it('normalizes accents, punctuation, case, and repeated whitespace', () => {
    expect(normalizeNarrationText('  Café—CENTRAL!!  ')).toBe('cafe central');
  });

  it('collects trimmed, unique Valhalla instruction text', () => {
    expect(maneuverInstructionTexts({
      instruction: ' Turn right ',
      verbal_pre_transition_instruction: 'Turn right',
    })).toEqual(['Turn right']);
    expect(maneuverInstructionTexts({})).toEqual([]);
  });

  it('matches complete normalized names with the established minimum length', () => {
    expect(instructionContainsName('Turn right at Café Central.', 'Cafe Central')).toBe(true);
    expect(instructionContainsName('Pass Centralized Plaza', 'Central')).toBe(false);
    expect(instructionContainsName('Turn at HP', 'HP')).toBe(false);
  });

  it('only treats the existing at/at-the forms as strong landmark cues', () => {
    expect(hasStrongLandmarkCue('Turn right at Café Central', 'Cafe Central')).toBe(true);
    expect(hasStrongLandmarkCue('Turn right at the Clock Tower', 'Clock Tower')).toBe(true);
    expect(hasStrongLandmarkCue('Continue past Clock Tower', 'Clock Tower')).toBe(false);
  });
});

describe('narration POI identity', () => {
  const fallback = {
    poiId: '',
    sourceNodeId: '',
    name: 'Café Central',
    coordinate: [77.209, 28.6139] as [number, number],
  };

  it('prefers POI ID, then source node ID, then normalized name and coordinate', () => {
    expect(narrationPoiKey({ ...fallback, poiId: 'poi-1', sourceNodeId: 'node-1' })).toBe('poi:poi-1');
    expect(narrationPoiKey({ ...fallback, sourceNodeId: 'node-1' })).toBe('node:node-1');
    expect(narrationPoiKey(fallback)).toBe('name:cafe central|77.2090000|28.6139000');
  });
});

describe('OSRM instruction fallback', () => {
  it('preserves the instruction priority and final unnamed fallback', () => {
    expect(osrmInstructionText({
      name: 'Road name',
      maneuver: {
        instruction: ' Detailed instruction ',
        short_instruction: 'Short instruction',
        type: 'turn',
        modifier: 'right',
      },
    })).toBe('Detailed instruction');
    expect(osrmInstructionText({ maneuver: { short_instruction: ' Keep left ' } })).toBe('Keep left');
    expect(osrmInstructionText({ maneuver: { type: 'turn', modifier: 'right' } })).toBe('turn right');
    expect(osrmInstructionText({ name: ' Main Street ' })).toBe('Main Street');
    expect(osrmInstructionText({})).toBe('Unnamed OSRM step');
  });
});
