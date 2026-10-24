import type { RouteScenario, ValhallaRouteResponse } from './types';

export type ScenarioRunStatus =
  | 'pass'
  | 'fail'
  | 'no-expectation'
  | 'error';

export interface ScenarioRunResult {
  status: ScenarioRunStatus;
  checkedAt: string;
  actualInstructions: string[];
  matchedInstructions: string[];
  failures: string[];
  error?: string;
}

export function odinInstructionTexts(
  response: ValhallaRouteResponse,
): string[] {
  const values: string[] = [];
  for (const leg of response.trip?.legs ?? []) {
    for (const maneuver of leg.maneuvers ?? []) {
      for (const value of [
        maneuver.instruction,
        maneuver.verbal_pre_transition_instruction,
      ]) {
        const text = String(value ?? '').trim();
        if (text && !values.includes(text)) values.push(text);
      }
    }
  }
  return values;
}

export function evaluateScenario(
  scenario: RouteScenario,
  response: ValhallaRouteResponse,
  checkedAt = new Date().toISOString(),
): ScenarioRunResult {
  const expectation = scenario.expectation;
  const actualInstructions = odinInstructionTexts(response);

  const landmarkName = expectation?.landmark_name?.trim() ?? '';
  const required = expectation?.instruction_contains?.trim() || landmarkName;
  const forbidden = expectation?.instruction_not_contains?.trim() ?? '';

  if (!required && !forbidden) {
    return {
      status: 'no-expectation',
      checkedAt,
      actualInstructions,
      matchedInstructions: [],
      failures: [],
    };
  }

  const caseSensitive = expectation?.case_sensitive ?? false;
  const normalize = (value: string) =>
    caseSensitive ? value : value.toLowerCase();
  const normalizedInstructions = actualInstructions.map((text) => ({
    raw: text,
    normalized: normalize(text),
  }));
  const failures: string[] = [];
  const matchedInstructions: string[] = [];

  if (required) {
    const needle = normalize(required);
    const matches = normalizedInstructions
      .filter((item) => item.normalized.includes(needle))
      .map((item) => item.raw);
    if (matches.length === 0) {
      failures.push(`No Odin instruction contained "${required}".`);
    } else {
      matchedInstructions.push(...matches);
    }
  }

  if (forbidden) {
    const needle = normalize(forbidden);
    const matches = normalizedInstructions
      .filter((item) => item.normalized.includes(needle))
      .map((item) => item.raw);
    if (matches.length > 0) {
      failures.push(`Forbidden Odin text "${forbidden}" was present.`);
      matchedInstructions.push(...matches);
    }
  }

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    checkedAt,
    actualInstructions,
    matchedInstructions: Array.from(new Set(matchedInstructions)),
    failures,
  };
}
