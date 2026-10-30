import type { ScenarioRunResult, ScenarioRunStatus } from '../../scenarioAssertions';
import { evaluateScenario } from '../../scenarioAssertions';
import type { CompareRouteResponse, LngLat, RouteScenario } from '../../types';

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

export function testcaseNotEvaluatedResult(
  reason: string,
  checkedAt = new Date().toISOString(),
): ScenarioRunResult {
  return {
    status: 'not-evaluated',
    checkedAt,
    actualInstructions: [],
    matchedInstructions: [],
    failures: [],
    error: reason,
  };
}

export function evaluateTestcaseRouteOutcome(
  scenario: RouteScenario,
  outcome: CompareRouteResponse | null,
  checkedAt = new Date().toISOString(),
): ScenarioRunResult {
  const valhallaResponse = outcome?.valhalla.ok ? outcome.valhalla.response : undefined;
  const osrmResponse = outcome?.osrm.ok ? outcome.osrm.response : undefined;
  const hasUsableValhallaRoute = Boolean(valhallaResponse?.trip?.legs?.length);
  const hasUsableOsrmRoute = osrmResponse?.code === 'Ok' && Boolean(osrmResponse.routes?.length);

  if (hasUsableValhallaRoute && valhallaResponse) {
    return evaluateScenario(scenario, valhallaResponse, checkedAt);
  }
  if (hasUsableOsrmRoute) {
    return testcaseNotEvaluatedResult(
      `OSRM completed, but the Valhalla/Odin assertion was not evaluated: ${outcome?.valhalla.error ?? 'Valhalla did not provide a usable route response'}.`,
      checkedAt,
    );
  }
  return testcaseErrorResult('Neither routing engine provided a usable route response.', checkedAt);
}

export function testcaseResultMessage(
  scenarioName: string,
  status: ScenarioRunStatus,
): string {
  const label = status === 'pass'
    ? 'PASS'
    : status === 'fail'
      ? 'FAIL'
      : status === 'not-evaluated'
        ? 'route ran; Valhalla assertion not evaluated'
        : status === 'error'
          ? 'ERROR'
          : 'route ran; no expectation configured';
  return `${scenarioName}: ${label}.`;
}

export function runAllResultMessage(results: ScenarioRunResult[]): string {
  const counts: Record<ScenarioRunStatus, number> = {
    pass: 0,
    fail: 0,
    'no-expectation': 0,
    'not-evaluated': 0,
    error: 0,
  };
  for (const result of results) counts[result.status] += 1;
  return `Run all complete: ${counts.pass} PASS · ${counts.fail} FAIL · ${counts['no-expectation']} NO EXPECTATION · ${counts['not-evaluated']} NOT EVALUATED · ${counts.error} ERROR.`;
}
