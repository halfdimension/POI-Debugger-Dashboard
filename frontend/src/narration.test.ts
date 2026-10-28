import { describe, expect, it } from 'vitest';
import {
  hasStrongLandmarkCue,
  instructionContainsName,
  maneuverInstructionTexts,
  matchOsrmLandmarkInstruction,
  parseOsrmLandmarkInstruction,
  narrationPoiKey,
  normalizeNarrationText,
  osrmInstructionText,
} from './narration';
import { buildOsrmGuidance } from './components/inspection/viewModels';

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

  it('recognizes OSRM at, after, and prefix landmark grammar without substring inference', () => {
    const names = ['Bank', 'Yes Bank', 'Indian Oil Petrol Pump', 'RBL Bank', 'Main'];
    expect(matchOsrmLandmarkInstruction('Keep right after Yes Bank', names)).toEqual({ name: 'Yes Bank', cue: 'after' });
    expect(matchOsrmLandmarkInstruction('Turn right at the Indian Oil Petrol Pump.', names)).toEqual({ name: 'Indian Oil Petrol Pump', cue: 'at' });
    expect(matchOsrmLandmarkInstruction('After RBL Bank: Enter the roundabout', names)).toEqual({ name: 'RBL Bank', cue: 'prefix-after' });
    expect(matchOsrmLandmarkInstruction('Continue on Yes Bank Road', names)).toBeNull();
    expect(matchOsrmLandmarkInstruction('Turn right at Bank', names)).toBeNull();
    expect(parseOsrmLandmarkInstruction('Merge left after Dev College')).toEqual({ name: 'Dev College', cue: 'after' });
    expect(parseOsrmLandmarkInstruction('After the RBL Bank: Enter the roundabout')).toEqual({ name: 'RBL Bank', cue: 'prefix-after' });
    expect(parseOsrmLandmarkInstruction('Continue on Yes Bank Road')).toBeNull();
  });

  it('classifies all landmark wording observed on the long verification route', () => {
    const cases: Array<[string, string]> = [
      ['Keep right after Yes Bank', 'after'],
      ['Take the exit on the right after Indian Oil Petrol Pump', 'after'],
      ['Merge left after Indian Oil Petrol Pump', 'after'],
      ['Keep right after Union Bank of India', 'after'],
      ['Merge left after Dev College', 'after'],
      ['Merge left at Vasan Eye Care Hospital', 'at'],
      ['Keep right at Apollo AyurVAID Hospitals', 'at'],
      ['After RBL Bank: Enter the roundabout and take the 1st exit', 'prefix-after'],
    ];
    for (const [instruction, cue] of cases) {
      expect(parseOsrmLandmarkInstruction(instruction)?.cue).toBe(cue);
    }
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

describe('OSRM guidance derivation', () => {
  it('keeps pass-by identity separate and computes multi-leg route positions', () => {
    const guidance = buildOsrmGuidance({ routes: [{ legs: [
      {
        distance: 100,
        steps: [{ distance: 100, maneuver: { instruction: 'Turn left at College of Art', location: [77, 28] } }],
        pass_by_events: [{ type: 'pass_by', instruction: 'Pass College of Art on your left', name: 'College of Art', side: 'left', location: [77.1, 28.1], distance_from_leg_start: 50, poi_id: 'p1' }],
      },
      {
        distance: 200,
        steps: [{ distance: 200, maneuver: { instruction: 'Merge left after Dev College', location: [77.2, 28.2] } }],
        pass_by_events: [{ type: 'pass_by', name: 'Police Station', distance_from_leg_start: 25 }],
      },
    ] }] });
    expect(guidance.exactOrdering).toBe(true);
    expect(guidance.entries.map((entry) => [entry.kind, entry.routeDistanceM])).toEqual([
      ['maneuver', 0], ['pass-by', 50], ['maneuver', 100], ['pass-by', 125],
    ]);
    expect(guidance.entries[0].category).toBe('landmark-at');
    expect(guidance.entries[2].category).toBe('landmark-after');
    expect(guidance.passByEvents[0].key).toBe('pass-by:0:0');
  });

  it('ignores malformed arrays and reports unavailable ordering without inventing distance', () => {
    const guidance = buildOsrmGuidance({ routes: [{ legs: [{
      steps: [{ maneuver: { instruction: 'depart', location: [Number.NaN, 28] } }],
      pass_by_events: [null as never, { instruction: 'Pass unnamed place' }],
    }] }] });
    expect(guidance.passByEvents).toHaveLength(1);
    expect(guidance.passByEvents[0].routeDistanceM).toBeNull();
    expect(guidance.passByEvents[0].coordinate).toBeNull();
    expect(guidance.exactOrdering).toBe(false);
  });
});
