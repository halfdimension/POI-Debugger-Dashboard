import { useState, type Dispatch, type SetStateAction } from 'react';
import { createScenario, deleteScenario, getScenarios, updateScenario } from '../../api';
import { evaluateScenario, type ScenarioRunResult } from '../../scenarioAssertions';
import type { LngLat, RouteScenario, ScenarioRegistryResponse, ValhallaRouteResponse } from '../../types';
import {
  runAllResultMessage,
  testcaseDatasetMismatchMessage,
  testcaseErrorResult,
  testcaseResultMessage,
  testcaseRoutePoints,
} from './testcaseExecution';

export type TestcaseTab = 'mine' | 'shared' | 'legacy';
export type TestcaseVisibility = 'private' | 'shared';
export type TestcaseScope = 'mine' | 'shared';

interface TestcaseManagementOptions {
  activeDatasetId?: string;
  start: LngLat | null;
  end: LngLat | null;
  onError: (message: string) => void;
  onLoadIntoDashboard: (scenario: RouteScenario) => void;
  executeRoute: (
    routeStart: LngLat,
    routeEnd: LngLat,
    costing: string,
  ) => Promise<ValhallaRouteResponse | null>;
}

export interface TestcaseManagement {
  activeTab: TestcaseTab;
  setActiveTab: Dispatch<SetStateAction<TestcaseTab>>;
  registry: ScenarioRegistryResponse | null;
  initializeRegistry: Dispatch<SetStateAction<ScenarioRegistryResponse | null>>;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  notes: string;
  setNotes: Dispatch<SetStateAction<string>>;
  visibility: TestcaseVisibility;
  setVisibility: Dispatch<SetStateAction<TestcaseVisibility>>;
  expectedText: string;
  setExpectedText: Dispatch<SetStateAction<string>>;
  forbiddenText: string;
  setForbiddenText: Dispatch<SetStateAction<string>>;
  myQuery: string;
  setMyQuery: Dispatch<SetStateAction<string>>;
  sharedQuery: string;
  setSharedQuery: Dispatch<SetStateAction<string>>;
  busy: boolean;
  message: string;
  runAllBusy: boolean;
  runResults: Record<string, ScenarioRunResult>;
  browse: (scope: TestcaseScope, query: string, offset: number) => Promise<void>;
  saveCurrent: () => Promise<void>;
  load: (scenario: RouteScenario) => void;
  run: (scenario: RouteScenario) => Promise<ScenarioRunResult | null>;
  edit: (scenario: RouteScenario) => Promise<void>;
  changeVisibility: (scenario: RouteScenario) => Promise<void>;
  remove: (scenario: RouteScenario) => Promise<void>;
  runAll: () => Promise<void>;
}

export function useTestcaseManagement({
  activeDatasetId,
  start,
  end,
  onError,
  onLoadIntoDashboard,
  executeRoute,
}: TestcaseManagementOptions): TestcaseManagement {
  const [activeTab, setActiveTab] = useState<TestcaseTab>('mine');
  const [registry, setRegistry] = useState<ScenarioRegistryResponse | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [visibility, setVisibility] = useState<TestcaseVisibility>('private');
  const [myQuery, setMyQuery] = useState('');
  const [sharedQuery, setSharedQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [expectedText, setExpectedText] = useState('');
  const [forbiddenText, setForbiddenText] = useState('');
  const [runResults, setRunResults] = useState<Record<string, ScenarioRunResult>>({});
  const [runAllBusy, setRunAllBusy] = useState(false);

  async function refresh(nextMessage = ''): Promise<void> {
    const nextRegistry = await getScenarios({
      myQuery,
      myOffset: registry?.offset ?? 0,
      sharedQuery,
      sharedOffset: registry?.shared_offset ?? 0,
    });
    setRegistry(nextRegistry);
    if (nextMessage) setMessage(nextMessage);
  }

  async function browse(scope: TestcaseScope, query: string, offset: number): Promise<void> {
    setBusy(true);
    onError('');
    try {
      const nextRegistry = await getScenarios({
        myQuery: scope === 'mine' ? query : myQuery,
        myOffset: scope === 'mine' ? offset : registry?.offset ?? 0,
        sharedQuery: scope === 'shared' ? query : sharedQuery,
        sharedOffset: scope === 'shared' ? offset : registry?.shared_offset ?? 0,
      });
      setRegistry(nextRegistry);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function load(scenario: RouteScenario): void {
    onLoadIntoDashboard(scenario);
    onError('');
    setMessage(`Loaded ${scenario.name}.`);
  }

  async function run(scenario: RouteScenario): Promise<ScenarioRunResult | null> {
    const mismatch = testcaseDatasetMismatchMessage(scenario, activeDatasetId ?? '');
    if (mismatch) {
      onError(mismatch);
      const result = testcaseErrorResult(mismatch);
      setRunResults((previous) => ({ ...previous, [scenario.id]: result }));
      return result;
    }

    const { routeStart, routeEnd } = testcaseRoutePoints(scenario);
    setMessage(`Running ${scenario.name}.`);
    const response = await executeRoute(routeStart, routeEnd, scenario.request.costing || 'auto');
    if (!response) {
      const result = testcaseErrorResult('Route request failed.');
      setRunResults((previous) => ({ ...previous, [scenario.id]: result }));
      return result;
    }

    const result = evaluateScenario(scenario, response);
    setRunResults((previous) => ({ ...previous, [scenario.id]: result }));
    setMessage(testcaseResultMessage(scenario.name, result.status));
    return result;
  }

  async function edit(scenario: RouteScenario): Promise<void> {
    const nextName = window.prompt('Testcase name.', scenario.name);
    if (nextName === null || !nextName.trim()) return;
    const description = window.prompt('Testcase description.', scenario.description ?? '');
    if (description === null) return;
    const currentContains = scenario.expectation?.instruction_contains ?? scenario.expectation?.landmark_name ?? '';
    const contains = window.prompt('Expected Odin text / landmark name. Leave blank for no positive assertion.', currentContains);
    if (contains === null) return;
    const currentForbidden = scenario.expectation?.instruction_not_contains ?? '';
    const forbidden = window.prompt('Forbidden Odin text. Leave blank if not needed.', currentForbidden);
    if (forbidden === null) return;
    const replaceRoute = Boolean(start && end && window.confirm('Replace the saved route and dataset with the current dashboard configuration?'));

    setBusy(true);
    onError('');
    try {
      await updateScenario(scenario.id, {
        revision: scenario.revision,
        name: nextName.trim(),
        description: description.trim(),
        ...(replaceRoute && start && end ? {
          dataset: activeDatasetId ?? scenario.dataset,
          request: {
            start: { lon: start[0], lat: start[1] },
            end: { lon: end[0], lat: end[1] },
            costing: 'auto',
          },
        } : {}),
        expectation: {
          landmark_name: contains.trim(),
          instruction_contains: contains.trim(),
          instruction_not_contains: forbidden.trim(),
          case_sensitive: false,
        },
      });
      setRunResults((previous) => {
        const next = { ...previous };
        delete next[scenario.id];
        return next;
      });
      await refresh(`Updated testcase ${nextName.trim()}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runAll(): Promise<void> {
    const runnable = (registry?.scenarios ?? [])
      .filter((scenario) => scenario.dataset === (activeDatasetId ?? ''));
    if (runnable.length === 0) {
      setMessage('No saved scenarios match the active dataset.');
      return;
    }

    setRunAllBusy(true);
    setMessage(`Running ${runnable.length} scenarios…`);
    const results: ScenarioRunResult[] = [];
    try {
      for (const scenario of runnable) {
        const result = await run(scenario);
        if (result) results.push(result);
      }
      setMessage(runAllResultMessage(results));
    } finally {
      setRunAllBusy(false);
    }
  }

  async function saveCurrent(): Promise<void> {
    if (!start || !end) {
      onError('Set both start and end coordinates before saving a scenario.');
      return;
    }
    if (!name.trim()) {
      onError('Enter a scenario name before saving.');
      return;
    }

    setBusy(true);
    onError('');
    setMessage('');
    try {
      const created = await createScenario({
        name: name.trim(),
        visibility,
        dataset: activeDatasetId ?? 'default',
        request: {
          start: { lon: start[0], lat: start[1] },
          end: { lon: end[0], lat: end[1] },
          costing: 'auto',
        },
        description: notes.trim(),
        expectation: {
          landmark_name: expectedText.trim(),
          instruction_contains: expectedText.trim(),
          instruction_not_contains: forbiddenText.trim(),
          case_sensitive: false,
        },
      });
      setName('');
      setNotes('');
      setExpectedText('');
      setForbiddenText('');
      setVisibility('private');
      await refresh(`Saved scenario ${created.name}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeVisibility(scenario: RouteScenario): Promise<void> {
    const nextVisibility = scenario.visibility === 'shared' ? 'private' : 'shared';
    setBusy(true);
    onError('');
    try {
      await updateScenario(scenario.id, {
        revision: scenario.revision,
        visibility: nextVisibility,
      });
      await refresh(`${scenario.name} is now ${nextVisibility}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(scenario: RouteScenario): Promise<void> {
    if (!window.confirm(`Delete saved scenario "${scenario.name}"?`)) return;
    setBusy(true);
    onError('');
    setMessage('');
    try {
      await deleteScenario(scenario.id);
      await refresh(`Deleted scenario ${scenario.name}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return {
    activeTab,
    setActiveTab,
    registry,
    initializeRegistry: setRegistry,
    name,
    setName,
    notes,
    setNotes,
    visibility,
    setVisibility,
    expectedText,
    setExpectedText,
    forbiddenText,
    setForbiddenText,
    myQuery,
    setMyQuery,
    sharedQuery,
    setSharedQuery,
    busy,
    message,
    runAllBusy,
    runResults,
    browse,
    saveCurrent,
    load,
    run,
    edit,
    changeVisibility,
    remove,
    runAll,
  };
}
