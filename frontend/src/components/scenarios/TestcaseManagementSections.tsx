import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { ScenarioRunResult } from '../../scenarioAssertions';
import type { DatasetRegistryResponse, DebuggerConfig, LngLat, RouteScenario, ScenarioRegistryResponse } from '../../types';

export interface TestcaseManagementProps {
  registry: ScenarioRegistryResponse | null;
  datasetRegistry: DatasetRegistryResponse | null;
  config: DebuggerConfig;
  start: LngLat | null;
  end: LngLat | null;
  scenarioName: string;
  scenarioNotes: string;
  scenarioVisibility: 'private' | 'shared';
  expectedText: string;
  forbiddenText: string;
  myQuery: string;
  sharedQuery: string;
  scenarioBusy: boolean;
  scenarioMessage: string;
  runAllBusy: boolean;
  routeBusy: boolean;
  runResults: Record<string, ScenarioRunResult>;
  setScenarioName: Dispatch<SetStateAction<string>>;
  setScenarioNotes: Dispatch<SetStateAction<string>>;
  setScenarioVisibility: Dispatch<SetStateAction<'private' | 'shared'>>;
  setExpectedText: Dispatch<SetStateAction<string>>;
  setForbiddenText: Dispatch<SetStateAction<string>>;
  setMyQuery: Dispatch<SetStateAction<string>>;
  setSharedQuery: Dispatch<SetStateAction<string>>;
  onBrowse: (scope: 'mine' | 'shared', query: string, offset: number) => void;
  onSave: () => void;
  onRunAll: () => void;
  onLoad: (scenario: RouteScenario) => void;
  onRun: (scenario: RouteScenario) => void;
  onEditExpectation: (scenario: RouteScenario) => void;
  onChangeVisibility: (scenario: RouteScenario) => void;
  onDelete: (scenario: RouteScenario) => void;
}

function PageControls({ total, limit, offset, busy, onPage }: {
  total: number; limit: number; offset: number; busy: boolean; onPage: (offset: number) => void;
}) {
  if (total <= limit && offset === 0) return null;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(total, offset + limit);
  return <div className="testcase-pagination"><span>{first}–{last} of {total}</span><div><button disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button><button disabled={busy || offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button></div></div>;
}

function TestcaseRow({ scenario, sharedView, activeDataset, busy, runAllBusy, routeBusy, result, onLoad, onRun, onEdit, onVisibility, onDelete }: {
  scenario: RouteScenario; sharedView?: boolean; activeDataset: string; busy: boolean; runAllBusy: boolean;
  routeBusy: boolean; result?: ScenarioRunResult; onLoad: () => void; onRun: () => void;
  onEdit: () => void; onVisibility: () => void; onDelete: () => void;
}) {
  const mismatch = scenario.dataset !== activeDataset;
  const isOwner = (scenario.is_owner !== false && !sharedView) || scenario.is_owner === true;
  const visibility = scenario.visibility ?? 'private';
  const author = scenario.owner?.display_name || scenario.owner?.username;
  return <div className={`compact-scenario ${mismatch ? 'dataset-mismatch' : ''}`}>
    <span>
      <strong>{scenario.name}</strong>
      <small>{scenario.dataset} · <span className={`visibility-badge visibility-${visibility}`}>{visibility}</span>{sharedView && author ? ` · by ${author}${scenario.owner?.username ? ` (@${scenario.owner.username})` : ''}` : ''}{result ? ` · ${result.status.toUpperCase()}` : ''}</small>
      {(scenario.description ?? scenario.notes) && <small>{scenario.description ?? scenario.notes}</small>}
      {mismatch && <em className="testcase-dataset-warning">Dataset unavailable here. Activate {scenario.dataset} to run.</em>}
      <details className="testcase-details"><summary>Details</summary><code>{scenario.request.start.lon.toFixed(6)}, {scenario.request.start.lat.toFixed(6)} → {scenario.request.end.lon.toFixed(6)}, {scenario.request.end.lat.toFixed(6)} · {scenario.request.costing}</code></details>
    </span>
    <div>
      <button onClick={onLoad} disabled={busy || runAllBusy}>Load</button>
      <button onClick={onRun} disabled={busy || runAllBusy || routeBusy || mismatch}>Run</button>
      {isOwner && <button onClick={onEdit} disabled={busy || runAllBusy}>Edit</button>}
      {isOwner && <button onClick={onVisibility} disabled={busy || runAllBusy}>Make {visibility === 'shared' ? 'Private' : 'Shared'}</button>}
      {isOwner && <button className="danger-button" onClick={onDelete} disabled={busy || runAllBusy}>Delete</button>}
    </div>
  </div>;
}

export function TestcaseManagementSections(props: TestcaseManagementProps) {
  const {
    registry, datasetRegistry, config, start, end, scenarioName, scenarioNotes, scenarioVisibility,
    expectedText, forbiddenText, myQuery, sharedQuery, scenarioBusy, scenarioMessage, runAllBusy,
    routeBusy, runResults, setScenarioName, setScenarioNotes, setScenarioVisibility, setExpectedText,
    setForbiddenText, setMyQuery, setSharedQuery, onBrowse, onSave, onRunAll, onLoad, onRun,
    onEditExpectation, onChangeVisibility, onDelete,
  } = props;
  const activeDataset = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
  const mine = registry?.scenarios ?? [];
  const shared = registry?.shared_scenarios ?? [];
  const legacy = registry?.legacy_scenarios ?? [];
  const myLimit = registry?.limit ?? 20;
  const myOffset = registry?.offset ?? 0;
  const sharedLimit = registry?.shared_limit ?? 20;
  const sharedOffset = registry?.shared_offset ?? 0;
  const submit = (event: FormEvent, scope: 'mine' | 'shared', query: string) => { event.preventDefault(); onBrowse(scope, query, 0); };
  const row = (scenario: RouteScenario, sharedView = false) => <TestcaseRow key={`${sharedView ? 'shared' : 'mine'}-${scenario.id}`} scenario={scenario} sharedView={sharedView} activeDataset={activeDataset} busy={scenarioBusy} runAllBusy={runAllBusy} routeBusy={routeBusy} result={runResults[scenario.id]} onLoad={() => onLoad(scenario)} onRun={() => onRun(scenario)} onEdit={() => onEditExpectation(scenario)} onVisibility={() => onChangeVisibility(scenario)} onDelete={() => onDelete(scenario)} />;

  return <div className="testcase-sections">
    <section className="testcase-section">
      <div className="testcase-section-heading"><span><strong>My Testcases</strong><small>{registry?.total ?? 0} owned</small></span></div>
      <div className="scenario-save-grid"><input aria-label="Testcase name" value={scenarioName} placeholder="Testcase name" maxLength={160} onChange={(event) => setScenarioName(event.target.value)} /><button onClick={onSave} disabled={scenarioBusy || !start || !end}>{scenarioBusy ? 'Working…' : 'Save current'}</button></div>
      <label className="testcase-visibility-field"><span>Visibility</span><select aria-label="New testcase visibility" value={scenarioVisibility} onChange={(event) => setScenarioVisibility(event.target.value as 'private' | 'shared')}><option value="private">Private</option><option value="shared">Shared</option></select></label>
      <input className="full-width-input" aria-label="Expected instruction text" value={expectedText} placeholder="Expected instruction text (optional)" onChange={(event) => setExpectedText(event.target.value)} />
      <input className="full-width-input" aria-label="Forbidden instruction text" value={forbiddenText} placeholder="Forbidden instruction text (optional)" onChange={(event) => setForbiddenText(event.target.value)} />
      <textarea className="scenario-notes" aria-label="Testcase description" value={scenarioNotes} placeholder="Description (optional)" maxLength={4000} rows={2} onChange={(event) => setScenarioNotes(event.target.value)} />
      <form className="testcase-search" onSubmit={(event) => submit(event, 'mine', myQuery)}><input type="search" aria-label="Search my testcases" value={myQuery} placeholder="Search my testcases" onChange={(event) => setMyQuery(event.target.value)} /><button disabled={scenarioBusy}>Search</button></form>
      <button className="secondary-full-button" onClick={onRunAll} disabled={runAllBusy || scenarioBusy || routeBusy || mine.length === 0}>{runAllBusy ? 'Running page…' : 'Run matching page'}</button>
      {scenarioMessage && <div className="scenario-message" role="status">{scenarioMessage}</div>}
      {(registry?.errors ?? []).map((message) => <div className="scenario-warning" key={message}>{message}</div>)}
      <div className="compact-scenario-list">{mine.length ? mine.map((scenario) => row(scenario)) : <div className="empty-state">No matching personal testcases.</div>}</div>
      <PageControls total={registry?.total ?? 0} limit={myLimit} offset={myOffset} busy={scenarioBusy} onPage={(offset) => onBrowse('mine', myQuery, offset)} />
    </section>

    <section className="testcase-section">
      <div className="testcase-section-heading"><span><strong>Shared Testcases</strong><small>{registry?.shared_total ?? 0} discoverable</small></span></div>
      <form className="testcase-search" onSubmit={(event) => submit(event, 'shared', sharedQuery)}><input type="search" aria-label="Search shared testcases" value={sharedQuery} placeholder="Search shared testcases" onChange={(event) => setSharedQuery(event.target.value)} /><button disabled={scenarioBusy}>Search</button></form>
      <div className="compact-scenario-list">{shared.length ? shared.map((scenario) => row(scenario, true)) : <div className="empty-state">No shared testcases match this search.</div>}</div>
      <PageControls total={registry?.shared_total ?? 0} limit={sharedLimit} offset={sharedOffset} busy={scenarioBusy} onPage={(offset) => onBrowse('shared', sharedQuery, offset)} />
    </section>

    <section className="testcase-section">
      <div className="testcase-section-heading"><span><strong>Legacy Scenarios</strong><small>{legacy.length} read-only</small></span></div>
      <div className="compact-scenario-list">{legacy.length ? legacy.map((scenario) => { const mismatch = scenario.dataset !== activeDataset; return <div className="compact-scenario" key={`legacy-${scenario.id}`}><span><strong>{scenario.name}</strong><small>{scenario.dataset} · legacy</small></span><div><button onClick={() => onLoad(scenario)}>Load</button><button onClick={() => onRun(scenario)} disabled={routeBusy || mismatch}>Run</button></div></div>; }) : <div className="empty-state">No legacy scenarios configured.</div>}</div>
    </section>
  </div>;
}
