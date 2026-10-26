import type { ScenarioRunResult, ScenarioRunStatus } from '../../scenarioAssertions';
import type { LngLat, RouteScenario } from '../../types';

export interface TestcaseRoutePoints {
  routeStart: LngLat;
  routeEnd: LngLat;
}

export function testcaseRoutePoints(scenario: RouteScenario): TestcaseRoutePoints {
  return {
    routeStart: [scenario.request.start.lon, scenario.request.start.lat],
    routeEnd: [scenario.request.end.lon, scenario.request.end.lat],
  };
}

export function testcaseDatasetMismatchMessage(
  scenario: RouteScenario,
  activeDatasetId: string,
): string | null {
  if (scenario.dataset === activeDatasetId) return null;
  return `Scenario uses dataset "${scenario.dataset}" but the active debugger dataset is "${activeDatasetId || 'unknown'}". Activate the matching dataset before running it.`;
}

export function testcaseErrorResult(
  error: string,
  checkedAt = new Date().toISOString(),
): ScenarioRunResult {
  return {
    status: 'error',
    checkedAt,
    actualInstructions: [],
    matchedInstructions: [],
    failures: [],
    error,
  };
}

export function testcaseResultMessage(
  scenarioName: string,
  status: ScenarioRunStatus,
): string {
  const label = status === 'pass'
    ? 'PASS'
    : status === 'fail'
      ? 'FAIL'
      : 'route ran; no expectation configured';
  return `${scenarioName}: ${label}.`;
}

export function runAllResultMessage(results: ScenarioRunResult[]): string {
  const counts: Record<ScenarioRunStatus, number> = {
    pass: 0,
    fail: 0,
    'no-expectation': 0,
    error: 0,
  };
  for (const result of results) counts[result.status] += 1;
  return `Run all complete: ${counts.pass} PASS · ${counts.fail} FAIL · ${counts['no-expectation']} NO EXPECTATION · ${counts.error} ERROR.`;
}
