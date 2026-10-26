import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ScenarioRunResult } from '../../scenarioAssertions';
import type { DatasetRegistryResponse, DebuggerConfig, LngLat, RouteScenario, ScenarioRegistryResponse } from '../../types';

export interface ScenarioManagementPanelProps {
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

export function ScenarioManagementPanel({
  registry: scenarioRegistry, datasetRegistry, config, start, end,
  scenarioName, scenarioNotes, expectedText: scenarioExpectedText,
  forbiddenText: scenarioForbiddenText, scenarioBusy, scenarioMessage,
  runAllBusy, routeBusy: busy, runResults: scenarioRunResults,
  setScenarioName, setScenarioNotes, setExpectedText: setScenarioExpectedText,
  setForbiddenText: setScenarioForbiddenText, onSave: saveCurrentScenario,
  onRunAll: runAllScenarios, onLoad: loadScenario, onRun: runSavedScenario,
  onEditExpectation: editScenarioExpectation, onDelete: removeScenario,
}: ScenarioManagementPanelProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visibleScenarios = (scenarioRegistry?.scenarios ?? []).filter((scenario) =>
    !needle || `${scenario.name} ${scenario.description ?? ''}`.toLocaleLowerCase().includes(needle)
  );
  return (
    <section className="card scenarios-card">
      <div className="maneuver-heading">
        <h2>My Testcases</h2>
        <span>{scenarioRegistry?.count ?? 0} private</span>
      </div>
      <div className="scenario-save-grid">
        <input
          value={scenarioName}
          placeholder="Testcase name, e.g. Indian Oil right turn"
          maxLength={160}
          onChange={(event) => setScenarioName(event.target.value)}
        />
        <button onClick={saveCurrentScenario} disabled={scenarioBusy || !start || !end}>
          {scenarioBusy ? 'Working…' : 'Save Current Route'}
        </button>
      </div>
      <div className="scenario-expectation-grid">
        <input
          value={scenarioExpectedText}
          placeholder="Expected Odin text / landmark, e.g. Indian Oil"
          onChange={(event) => setScenarioExpectedText(event.target.value)}
        />
        <input
          value={scenarioForbiddenText}
          placeholder="Forbidden Odin text (optional)"
          onChange={(event) => setScenarioForbiddenText(event.target.value)}
        />
      </div>
      <textarea
        className="scenario-notes"
        value={scenarioNotes}
        placeholder="Optional description of why this route is useful"
        maxLength={4000}
        rows={2}
        onChange={(event) => setScenarioNotes(event.target.value)}
      />
      <input className="full-width-input" type="search" value={query} placeholder="Search my testcases" onChange={(event) => setQuery(event.target.value)} />
      <div className="scenario-suite-actions">
        <button onClick={runAllScenarios} disabled={runAllBusy || scenarioBusy || busy || !(scenarioRegistry?.scenarios.length)}>
          {runAllBusy ? 'Running suite…' : 'Run All Matching Dataset'}
        </button>
        <span>Assertions inspect Odin maneuver instruction + verbal pre-transition text.</span>
      </div>
      {scenarioMessage && <div className="scenario-message">{scenarioMessage}</div>}
      {(scenarioRegistry?.errors ?? []).map((message) => (
        <div className="scenario-warning" key={message}>{message}</div>
      ))}
      <div className="scenario-note">
        Saved scenarios can verify required or forbidden Odin instruction text. A scenario without assertions still runs but reports NO EXPECTATION.
      </div>
      {visibleScenarios.length === 0 ? (
        <div className="empty-state">Set START/END, give the route a name and optionally an expected landmark, then save it.</div>
      ) : (
        <div className="scenario-list">
          {visibleScenarios.map((scenario) => {
            const activeId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
            const datasetMismatch = scenario.dataset !== activeId;
            const result = scenarioRunResults[scenario.id];
            const expectedText = scenario.expectation?.instruction_contains ?? scenario.expectation?.landmark_name ?? '';
            const forbiddenText = scenario.expectation?.instruction_not_contains ?? '';
            return (
              <div className={`scenario-item ${datasetMismatch ? 'dataset-mismatch' : ''} ${result ? `result-${result.status}` : ''}`} key={scenario.id}>
                <div className="scenario-main">
                  <div className="scenario-title-row">
                    <strong>{scenario.name}</strong>
                    {result && <span className={`scenario-result-badge ${result.status}`}>{result.status === 'no-expectation' ? 'NO EXPECTATION' : result.status.toUpperCase()}</span>}
                  </div>
                  <small>{scenario.dataset} · {scenario.request.costing}</small>
                  <code>
                    {scenario.request.start.lon.toFixed(6)}, {scenario.request.start.lat.toFixed(6)} → {scenario.request.end.lon.toFixed(6)}, {scenario.request.end.lat.toFixed(6)}
                  </code>
                  {(expectedText || forbiddenText) ? (
                    <div className="scenario-expectation-summary">
                      {expectedText && <span><b>Must contain:</b> {expectedText}</span>}
                      {forbiddenText && <span><b>Must not contain:</b> {forbiddenText}</span>}
                    </div>
                  ) : <span className="scenario-no-expectation">No PASS/FAIL expectation configured.</span>}
                  {(scenario.description ?? scenario.notes) && <span>{scenario.description ?? scenario.notes}</span>}
                  {result?.matchedInstructions.length ? (
                    <span className="scenario-match"><b>Matched:</b> {result.matchedInstructions[0]}</span>
                  ) : null}
                  {result?.failures.map((failure) => <em className="scenario-failure" key={failure}>{failure}</em>)}
                  {result?.error && <em className="scenario-failure">{result.error}</em>}
                  {datasetMismatch && <em>Dataset mismatch: activate {scenario.dataset} before Run.</em>}
                </div>
                <div className="scenario-actions">
                  <button onClick={() => loadScenario(scenario)} disabled={scenarioBusy || runAllBusy}>Load</button>
                  <button className="scenario-run" onClick={() => runSavedScenario(scenario)} disabled={scenarioBusy || runAllBusy || busy || datasetMismatch}>Run</button>
                  <button className="scenario-expect" onClick={() => editScenarioExpectation(scenario)} disabled={scenarioBusy || runAllBusy}>Edit</button>
                  <button className="scenario-delete" onClick={() => removeScenario(scenario)} disabled={scenarioBusy || runAllBusy}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(scenarioRegistry?.legacy_scenarios?.length ?? 0) > 0 && <div className="scenario-note"><b>Legacy scenarios:</b> {(scenarioRegistry?.legacy_scenarios ?? []).length} filesystem scenarios remain available from the sidebar for read-only load/run.</div>}
    </section>
  );
}
