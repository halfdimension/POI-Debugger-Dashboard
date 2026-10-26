import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ScenarioRunResult } from '../../scenarioAssertions';
import type { DatasetRegistryResponse, DebuggerConfig, LngLat, RouteScenario, ScenarioRegistryResponse } from '../../types';

export interface SavedScenarioControlsProps {
  registry: ScenarioRegistryResponse | null;
  datasetRegistry: DatasetRegistryResponse | null;
  config: DebuggerConfig;
  start: LngLat | null;
  end: LngLat | null;
  scenarioName: string;
  scenarioNotes: string;
  expectedText: string;
  forbiddenText: string;
  scenarioBusy: boolean;
  scenarioMessage: string;
  runAllBusy: boolean;
  routeBusy: boolean;
  runResults: Record<string, ScenarioRunResult>;
  setScenarioName: Dispatch<SetStateAction<string>>;
  setScenarioNotes: Dispatch<SetStateAction<string>>;
  setExpectedText: Dispatch<SetStateAction<string>>;
  setForbiddenText: Dispatch<SetStateAction<string>>;
  onSave: () => void;
  onRunAll: () => void;
  onLoad: (scenario: RouteScenario) => void;
  onRun: (scenario: RouteScenario) => void;
  onEditExpectation: (scenario: RouteScenario) => void;
  onDelete: (scenario: RouteScenario) => void;
}

export function SavedScenarioControls({
  registry: scenarioRegistry, datasetRegistry, config, start, end,
  scenarioName, scenarioNotes, expectedText: scenarioExpectedText,
  forbiddenText: scenarioForbiddenText, scenarioBusy, scenarioMessage,
  runAllBusy, routeBusy: busy, runResults: scenarioRunResults,
  setScenarioName, setScenarioNotes, setExpectedText: setScenarioExpectedText,
  setForbiddenText: setScenarioForbiddenText, onSave: saveCurrentScenario,
  onRunAll: runAllScenarios, onLoad: loadScenario, onRun: runSavedScenario,
  onEditExpectation: editScenarioExpectation, onDelete: removeScenario,
}: SavedScenarioControlsProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const owned = (scenarioRegistry?.scenarios ?? []).filter((scenario) =>
    !normalizedQuery || `${scenario.name} ${scenario.description ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
  );
  const legacy = scenarioRegistry?.legacy_scenarios ?? [];
  return (
    <details className="sidebar-disclosure" open>
      <summary><span>My Testcases</span><small>{scenarioRegistry?.count ?? 0}</small></summary>
      <div className="sidebar-disclosure__body">
        <div className="scenario-save-grid">
          <input aria-label="Testcase name" value={scenarioName} placeholder="Testcase name" maxLength={160} onChange={(event) => setScenarioName(event.target.value)} />
          <button onClick={saveCurrentScenario} disabled={scenarioBusy || !start || !end}>{scenarioBusy ? 'Working…' : 'Save current'}</button>
        </div>
        <input className="full-width-input" aria-label="Expected instruction text" value={scenarioExpectedText} placeholder="Expected instruction text (optional)" onChange={(event) => setScenarioExpectedText(event.target.value)} />
        <input className="full-width-input" aria-label="Forbidden instruction text" value={scenarioForbiddenText} placeholder="Forbidden instruction text (optional)" onChange={(event) => setScenarioForbiddenText(event.target.value)} />
        <textarea className="scenario-notes" aria-label="Testcase description" value={scenarioNotes} placeholder="Description (optional)" maxLength={4000} rows={2} onChange={(event) => setScenarioNotes(event.target.value)} />
        <input className="full-width-input" type="search" aria-label="Search my testcases" value={query} placeholder="Search my testcases" onChange={(event) => setQuery(event.target.value)} />
        <button className="secondary-full-button" onClick={runAllScenarios} disabled={runAllBusy || scenarioBusy || busy || !(scenarioRegistry?.scenarios.length)}>{runAllBusy ? 'Running suite…' : 'Run matching scenarios'}</button>
        {scenarioMessage && <div className="scenario-message" role="status">{scenarioMessage}</div>}
        <div className="compact-scenario-list">
          {owned.map((scenario) => {
            const activeId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
            const datasetMismatch = scenario.dataset !== activeId;
            const result = scenarioRunResults[scenario.id];
            return <div className="compact-scenario" key={scenario.id}><span><strong>{scenario.name}</strong><small>{scenario.dataset} · private{result ? ` · ${result.status.toUpperCase()}` : ''}</small></span><div><button onClick={() => loadScenario(scenario)}>Load</button><button onClick={() => runSavedScenario(scenario)} disabled={scenarioBusy || runAllBusy || busy || datasetMismatch}>Run</button><button onClick={() => editScenarioExpectation(scenario)}>Edit</button><button className="danger-button" onClick={() => removeScenario(scenario)}>Delete</button></div></div>;
          })}
        </div>
        {legacy.length > 0 && <><div className="scenario-note"><b>Legacy scenarios</b> · shared filesystem · read-only</div><div className="compact-scenario-list">{legacy.map((scenario) => { const mismatch = scenario.dataset !== (datasetRegistry?.active_dataset ?? config?.active_dataset ?? ''); return <div className="compact-scenario" key={`legacy-${scenario.id}`}><span><strong>{scenario.name}</strong><small>{scenario.dataset} · legacy</small></span><div><button onClick={() => loadScenario(scenario)}>Load</button><button onClick={() => runSavedScenario(scenario)} disabled={busy || mismatch}>Run</button></div></div>; })}</div></>}
      </div>
    </details>
  );
}
