import { describe, expect, it } from 'vitest';
import type { RouteScenario } from '../../types';
import {
  runAllResultMessage,
  testcaseDatasetMismatchMessage,
  testcaseErrorResult,
  testcaseResultMessage,
  testcaseRoutePoints,
} from './testcaseExecution';

const scenario: RouteScenario = {
  id: 'scenario-1',
  name: 'Landmark route',
  dataset: 'delhi',
  request: {
    start: { lon: 77.2, lat: 28.6 },
    end: { lon: 77.3, lat: 28.7 },
    costing: 'auto',
  },
};

describe('testcase execution helpers', () => {
  it('converts saved points to dashboard coordinate order', () => {
    expect(testcaseRoutePoints(scenario)).toEqual({
      routeStart: [77.2, 28.6],
      routeEnd: [77.3, 28.7],
    });
  });

  it('preserves dataset compatibility validation and its unknown fallback', () => {
    expect(testcaseDatasetMismatchMessage(scenario, 'delhi')).toBeNull();
    expect(testcaseDatasetMismatchMessage(scenario, '')).toBe(
      'Scenario uses dataset "delhi" but the active debugger dataset is "unknown". Activate the matching dataset before running it.',
    );
  });

  it('builds the established route-error result shape', () => {
    expect(testcaseErrorResult('Route request failed.', '2026-01-02T03:04:05.000Z')).toEqual({
      status: 'error',
      checkedAt: '2026-01-02T03:04:05.000Z',
      actualInstructions: [],
      matchedInstructions: [],
      failures: [],
      error: 'Route request failed.',
    });
  });

  it('preserves individual and run-all status messages', () => {
    expect(testcaseResultMessage('Landmark route', 'pass')).toBe('Landmark route: PASS.');
    expect(testcaseResultMessage('Landmark route', 'fail')).toBe('Landmark route: FAIL.');
    expect(testcaseResultMessage('Landmark route', 'no-expectation')).toBe(
      'Landmark route: route ran; no expectation configured.',
    );
    expect(runAllResultMessage([
      testcaseErrorResult('failed', 'now'),
      { ...testcaseErrorResult('', 'now'), status: 'pass' },
      { ...testcaseErrorResult('', 'now'), status: 'fail' },
      { ...testcaseErrorResult('', 'now'), status: 'no-expectation' },
    ])).toBe('Run all complete: 1 PASS · 1 FAIL · 1 NO EXPECTATION · 1 ERROR.');
  });
});
