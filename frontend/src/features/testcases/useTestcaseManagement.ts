import { useState, type Dispatch, type SetStateAction } from 'react';
import { createScenario, deleteScenario, getScenarios, updateScenario } from '../../api';
import type { ScenarioRunResult } from '../../scenarioAssertions';
import type { CompareRouteResponse, LngLat, RouteScenario, ScenarioRegistryResponse } from '../../types';
import {
  runAllResultMessage,
  evaluateTestcaseRouteOutcome,
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
  ) => Promise<CompareRouteResponse | null>;
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
  editingScenario: RouteScenario | null;
  editorDataset: string;
  editorStart: LngLat | null;
  editorEnd: LngLat | null;
  routeReplaced: boolean;
  browse: (scope: TestcaseScope, query: string, offset: number) => Promise<void>;
  saveCurrent: () => Promise<void>;
  load: (scenario: RouteScenario) => void;
  run: (scenario: RouteScenario) => Promise<ScenarioRunResult | null>;
  edit: (scenario: RouteScenario) => boolean;
  useCurrentRoute: () => void;
  cancelEdit: () => void;
  resetEditor: () => void;
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
  const [editingScenario, setEditingScenario] = useState<RouteScenario | null>(null);
  const [routeReplaced, setRouteReplaced] = useState(false);

  const hasDraft = Boolean(name.trim() || notes.trim() || expectedText.trim() || forbiddenText.trim() || visibility !== 'private');
  const editorDirty = editingScenario
    ? name !== editingScenario.name
      || notes !== (editingScenario.description ?? editingScenario.notes ?? '')
      || visibility !== (editingScenario.visibility ?? 'private')
      || expectedText !== (editingScenario.expectation?.instruction_contains ?? editingScenario.expectation?.landmark_name ?? '')
      || forbiddenText !== (editingScenario.expectation?.instruction_not_contains ?? '')
      || routeReplaced
    : hasDraft;
  const savedStart: LngLat | null = editingScenario
    ? [editingScenario.request.start.lon, editingScenario.request.start.lat]
    : null;
  const savedEnd: LngLat | null = editingScenario
    ? [editingScenario.request.end.lon, editingScenario.request.end.lat]
    : null;
  const editorStart = editingScenario && !routeReplaced ? savedStart : start;
  const editorEnd = editingScenario && !routeReplaced ? savedEnd : end;
  const editorDataset = editingScenario && !routeReplaced
    ? editingScenario.dataset
    : activeDatasetId ?? 'default';

  function clearEditor(): void {
    setEditingScenario(null);
    setRouteReplaced(false);
    setName('');
    setNotes('');
    setVisibility('private');
    setExpectedText('');
    setForbiddenText('');
    setMessage('');
  }

  function resetEditor(): void {
    if (editorDirty && !window.confirm('Reset the testcase form and discard the unsaved changes?')) return;
    clearEditor();
  }

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
    const outcome = await executeRoute(routeStart, routeEnd, scenario.request.costing || 'auto');
    const result = evaluateTestcaseRouteOutcome(scenario, outcome);
    setRunResults((previous) => ({ ...previous, [scenario.id]: result }));
    setMessage(testcaseResultMessage(scenario.name, result.status));
    return result;
  }

  function edit(scenario: RouteScenario): boolean {
    if (editorDirty && !window.confirm('Discard the current unsaved testcase draft and edit this testcase?')) return false;
    setEditingScenario(scenario);
    setRouteReplaced(false);
    setName(scenario.name);
    setNotes(scenario.description ?? scenario.notes ?? '');
    setVisibility(scenario.visibility ?? 'private');
    setExpectedText(scenario.expectation?.instruction_contains ?? scenario.expectation?.landmark_name ?? '');
    setForbiddenText(scenario.expectation?.instruction_not_contains ?? '');
    setMessage(`Editing ${scenario.name}. Saved coordinates and dataset are preserved.`);
    onError('');
    return true;
  }

  function useCurrentRoute(): void {
    if (!editingScenario || !start || !end) return;
    setRouteReplaced(true);
    setMessage('The current dashboard route and dataset will replace the saved route when changes are saved.');
  }

  function cancelEdit(): void {
    if (editorDirty && !window.confirm('Cancel editing and discard the unsaved changes?')) return;
    clearEditor();
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
    if (!editorStart || !editorEnd) {
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
      const payload = {
        name: name.trim(),
        visibility,
        dataset: editorDataset,
        request: {
          start: { lon: editorStart[0], lat: editorStart[1] },
          end: { lon: editorEnd[0], lat: editorEnd[1] },
          costing: editingScenario?.request.costing || 'auto',
        },
        description: notes.trim(),
        expectation: {
          landmark_name: expectedText.trim(),
          instruction_contains: expectedText.trim(),
          instruction_not_contains: forbiddenText.trim(),
          case_sensitive: false,
        },
      };
      if (editingScenario) {
        const updated = await updateScenario(editingScenario.id, {
          revision: editingScenario.revision,
          ...payload,
        });
        setRunResults((previous) => {
          const next = { ...previous };
          delete next[editingScenario.id];
          return next;
        });
        clearEditor();
        await refresh(`Updated testcase ${updated.name}.`);
      } else {
        const created = await createScenario(payload);
        clearEditor();
        await refresh(`Saved testcase ${created.name}.`);
      }
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
      const updated = await updateScenario(scenario.id, {
        revision: scenario.revision,
        visibility: nextVisibility,
      });
      if (editingScenario?.id === scenario.id) {
        const editorVisibilityWasUnchanged = visibility === (editingScenario.visibility ?? 'private');
        setEditingScenario(updated);
        if (editorVisibilityWasUnchanged) setVisibility(updated.visibility ?? nextVisibility);
      }
      await refresh(`${scenario.name} is now ${nextVisibility}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(scenario: RouteScenario): Promise<void> {
    const discardsOpenDraft = editingScenario?.id === scenario.id && editorDirty;
    const warning = discardsOpenDraft ? '\n\nThis will also discard unsaved changes in the open editor.' : '';
    if (!window.confirm(`Delete saved scenario "${scenario.name}"?${warning}`)) return;
    setBusy(true);
    onError('');
    setMessage('');
    try {
      await deleteScenario(scenario.id);
      if (editingScenario?.id === scenario.id) clearEditor();
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
    editingScenario,
    editorDataset,
    editorStart,
    editorEnd,
    routeReplaced,
    browse,
    saveCurrent,
    load,
    run,
    edit,
    useCurrentRoute,
    cancelEdit,
    resetEditor,
    changeVisibility,
    remove,
    runAll,
  };
}
