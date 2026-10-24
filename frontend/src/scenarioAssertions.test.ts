import { describe, expect, it } from 'vitest';
import { evaluateScenario, odinInstructionTexts } from './scenarioAssertions';
import type { RouteScenario, ValhallaRouteResponse } from './types';

const CHECKED_AT = '2026-10-24T12:00:00.000Z';

function scenario(
  expectation?: RouteScenario['expectation'],
): RouteScenario {
  return {
    id: 'fixture',
    name: 'Fixture',
    dataset: 'test-data',
    request: {
      start: { lon: 77.2, lat: 28.6 },
      end: { lon: 77.3, lat: 28.7 },
      costing: 'auto',
    },
    expectation,
  };
}

const response: ValhallaRouteResponse = {
  trip: {
    legs: [{
      maneuvers: [
        {
          instruction: 'Turn left at Moti Mahal.',
          verbal_pre_transition_instruction: 'Turn left at Moti Mahal.',
        },
        {
          instruction: 'Continue straight for 200 meters.',
          verbal_pre_transition_instruction: 'Then merge right.',
        },
      ],
    }],
  },
};

describe('scenario assertions', () => {
  it('collects trimmed Odin text from both instruction fields without duplicates', () => {
    expect(odinInstructionTexts(response)).toEqual([
      'Turn left at Moti Mahal.',
      'Continue straight for 200 meters.',
      'Then merge right.',
    ]);
  });

  it('returns NO EXPECTATION when no required or forbidden text is configured', () => {
    expect(evaluateScenario(scenario(), response, CHECKED_AT)).toMatchObject({
      status: 'no-expectation',
      checkedAt: CHECKED_AT,
      failures: [],
      matchedInstructions: [],
    });
  });

  it('uses landmark_name as the legacy positive assertion fallback', () => {
    const result = evaluateScenario(
      scenario({ landmark_name: 'moti mahal', case_sensitive: false }),
      response,
      CHECKED_AT,
    );

    expect(result.status).toBe('pass');
    expect(result.matchedInstructions).toEqual(['Turn left at Moti Mahal.']);
  });

  it('fails when required text is missing or forbidden text is present', () => {
    const result = evaluateScenario(
      scenario({
        instruction_contains: 'Bheem',
        instruction_not_contains: 'MERGE RIGHT',
        case_sensitive: false,
      }),
      response,
      CHECKED_AT,
    );

    expect(result.status).toBe('fail');
    expect(result.failures).toEqual([
      'No Odin instruction contained "Bheem".',
      'Forbidden Odin text "MERGE RIGHT" was present.',
    ]);
    expect(result.matchedInstructions).toEqual(['Then merge right.']);
  });

  it('honors case-sensitive assertions', () => {
    const result = evaluateScenario(
      scenario({ instruction_contains: 'moti mahal', case_sensitive: true }),
      response,
      CHECKED_AT,
    );

    expect(result.status).toBe('fail');
  });
});
