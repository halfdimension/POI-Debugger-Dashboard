import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { TestcaseTab } from '../../features/testcases/useTestcaseManagement';
import type { ScenarioRunResult } from '../../scenarioAssertions';
import type { LngLat, RouteScenario, ScenarioRegistryResponse } from '../../types';

export type { TestcaseTab } from '../../features/testcases/useTestcaseManagement';

export interface TestcaseLibraryProps {
  activeTab: TestcaseTab;
  onSelectTab: (tab: TestcaseTab) => void;
  registry: ScenarioRegistryResponse | null;
  activeDataset: string;
  myQuery: string;
  sharedQuery: string;
  scenarioBusy: boolean;
  scenarioMessage: string;
  runAllBusy: boolean;
  routeBusy: boolean;
  runResults: Record<string, ScenarioRunResult>;
  setMyQuery: Dispatch<SetStateAction<string>>;
  setSharedQuery: Dispatch<SetStateAction<string>>;
  onBrowse: (scope: 'mine' | 'shared', query: string, offset: number) => void;
  onRunAll: () => void;
  onLoad: (scenario: RouteScenario) => void;
  onRun: (scenario: RouteScenario) => void;
  onEdit: (scenario: RouteScenario) => void;
  onChangeVisibility: (scenario: RouteScenario) => void;
  onDelete: (scenario: RouteScenario) => void;
}

export interface TestcaseManagementSectionsProps {
  activeDataset: string;
  start: LngLat | null;
  end: LngLat | null;
  editingScenario: RouteScenario | null;
  editorDataset: string;
  editorStart: LngLat | null;
  editorEnd: LngLat | null;
  routeReplaced: boolean;
  scenarioName: string;
  scenarioNotes: string;
  scenarioVisibility: 'private' | 'shared';
  expectedText: string;
  forbiddenText: string;
  scenarioBusy: boolean;
  scenarioMessage: string;
  setScenarioName: Dispatch<SetStateAction<string>>;
  setScenarioNotes: Dispatch<SetStateAction<string>>;
  setScenarioVisibility: Dispatch<SetStateAction<'private' | 'shared'>>;
  setExpectedText: Dispatch<SetStateAction<string>>;
  setForbiddenText: Dispatch<SetStateAction<string>>;
  onSave: () => void;
  onUseCurrentRoute: () => void;
  onCancelEdit: () => void;
  onReset: () => void;
}

function PageControls({ total, limit, offset, busy, onPage }: { total: number; limit: number; offset: number; busy: boolean; onPage: (offset: number) => void }) {
  if (total <= limit && offset === 0) return null;
  return <div className="testcase-pagination"><span>{total ? offset + 1 : 0}–{Math.min(total, offset + limit)} of {total}</span><div><button disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button><button disabled={busy || offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button></div></div>;
}

function ScenarioDetails({ scenario, result }: { scenario: RouteScenario; result?: ScenarioRunResult }) {
  return <div className="testcase-detail-body">
    <p>{scenario.description ?? scenario.notes ?? 'No description provided.'}</p>
    <dl>
      <div><dt>Route</dt><dd>{scenario.request.start.lon.toFixed(6)}, {scenario.request.start.lat.toFixed(6)} → {scenario.request.end.lon.toFixed(6)}, {scenario.request.end.lat.toFixed(6)}</dd></div>
      <div><dt>Costing</dt><dd>{scenario.request.costing}</dd></div>
      <div><dt>Expected</dt><dd>{scenario.expectation?.instruction_contains || scenario.expectation?.landmark_name || '—'}</dd></div>
      <div><dt>Forbidden</dt><dd>{scenario.expectation?.instruction_not_contains || '—'}</dd></div>
      <div><dt>Last result</dt><dd>{result ? result.status.replace('-', ' ') : 'Not run in this session'}</dd></div>
    </dl>
    {result?.error && <p className="testcase-result-note">{result.error}</p>}
  </div>;
}

function TestcaseCard({ scenario, sharedView, activeDataset, busy, runAllBusy, routeBusy, result, onLoad, onRun, onEdit, onVisibility, onDelete }: {
  scenario: RouteScenario; sharedView?: boolean; activeDataset: string; busy: boolean; runAllBusy: boolean; routeBusy: boolean; result?: ScenarioRunResult;
  onLoad: () => void; onRun: () => void; onEdit: () => void; onVisibility: () => void; onDelete: () => void;
}) {
  const mismatch = scenario.dataset !== activeDataset;
  const isOwner = (scenario.is_owner !== false && !sharedView) || scenario.is_owner === true;
  const visibility = scenario.visibility ?? 'private';
  const author = scenario.owner?.display_name || scenario.owner?.username;
  return <article className={`testcase-card ${mismatch ? 'dataset-mismatch' : ''}`}>
    <header><strong>{scenario.name}</strong>{result && <span className={`testcase-run-status status-${result.status}`}>{result.status.replace('-', ' ')}</span>}</header>
    <small>{scenario.dataset} · <span className={`visibility-badge visibility-${visibility}`}>{visibility}</span>{sharedView && author ? ` · ${author}` : ''}</small>
    {(scenario.description ?? scenario.notes) && <p className="testcase-description-preview">{scenario.description ?? scenario.notes}</p>}
    {mismatch && <em className="testcase-dataset-warning">Activate {scenario.dataset} before running.</em>}
    <div className="testcase-card__actions">
      <button onClick={onLoad} disabled={busy || runAllBusy}>Load</button>
      <button onClick={onRun} disabled={busy || runAllBusy || routeBusy || mismatch}>Run</button>
      {isOwner && <details className="testcase-more-actions"><summary aria-label={`More actions for ${scenario.name}`}>⋯</summary><div><button onClick={onEdit} disabled={busy || runAllBusy}>Edit</button><button onClick={onVisibility} disabled={busy || runAllBusy}>Make {visibility === 'shared' ? 'private' : 'shared'}</button><button className="danger-button" onClick={onDelete} disabled={busy || runAllBusy}>Delete</button></div></details>}
    </div>
    <details className="testcase-card__details"><summary>Details</summary><ScenarioDetails scenario={scenario} result={result} /></details>
  </article>;
}

export function TestcaseLibrary(props: TestcaseLibraryProps) {
  const { registry, activeDataset, activeTab, onSelectTab, myQuery, sharedQuery, setMyQuery, setSharedQuery, scenarioBusy, scenarioMessage, runAllBusy, routeBusy, runResults, onBrowse, onRunAll, onLoad, onRun, onEdit, onChangeVisibility, onDelete } = props;
  const mine = registry?.scenarios ?? [];
  const shared = registry?.shared_scenarios ?? [];
  const legacy = registry?.legacy_scenarios ?? [];
  const submit = (event: FormEvent, scope: 'mine' | 'shared', query: string) => { event.preventDefault(); onBrowse(scope, query, 0); };
  const card = (scenario: RouteScenario, sharedView = false) => <TestcaseCard key={`${sharedView ? 'shared' : 'mine'}-${scenario.id}`} scenario={scenario} sharedView={sharedView} activeDataset={activeDataset} busy={scenarioBusy} runAllBusy={runAllBusy} routeBusy={routeBusy} result={runResults[scenario.id]} onLoad={() => onLoad(scenario)} onRun={() => onRun(scenario)} onEdit={() => onEdit(scenario)} onVisibility={() => onChangeVisibility(scenario)} onDelete={() => onDelete(scenario)} />;
  return <div className="testcase-library">
    <div className="testcase-tabs" role="tablist" aria-label="Testcase categories">
      <button role="tab" aria-selected={activeTab === 'mine'} className={activeTab === 'mine' ? 'is-active' : ''} onClick={() => onSelectTab('mine')}>My <span>{registry?.total ?? 0}</span></button>
      <button role="tab" aria-selected={activeTab === 'shared'} className={activeTab === 'shared' ? 'is-active' : ''} onClick={() => onSelectTab('shared')}>Shared <span>{registry?.shared_total ?? 0}</span></button>
      <button role="tab" aria-selected={activeTab === 'legacy'} className={activeTab === 'legacy' ? 'is-active' : ''} onClick={() => onSelectTab('legacy')}>Legacy <span>{legacy.length}</span></button>
    </div>
    {activeTab === 'mine' && <section className="testcase-library__section"><div className="testcase-library__summary"><strong>My Testcases</strong><span>{registry?.total ?? 0} · {activeDataset || 'No dataset'}</span></div><form className="testcase-search" onSubmit={(event) => submit(event, 'mine', myQuery)}><input type="search" aria-label="Search my testcases" value={myQuery} placeholder="Name or description" onChange={(event) => setMyQuery(event.target.value)} /><button disabled={scenarioBusy}>Search</button></form><button className="secondary-full-button" onClick={onRunAll} disabled={runAllBusy || scenarioBusy || routeBusy || !mine.length}>{runAllBusy ? 'Running page…' : 'Run matching page'}</button><div className="testcase-card-list">{mine.length ? mine.map((item) => card(item)) : <div className="empty-state">No matching personal testcases.</div>}</div><PageControls total={registry?.total ?? 0} limit={registry?.limit ?? 20} offset={registry?.offset ?? 0} busy={scenarioBusy} onPage={(offset) => onBrowse('mine', myQuery, offset)} /></section>}
    {activeTab === 'shared' && <section className="testcase-library__section"><div className="testcase-library__summary"><strong>Shared Testcases</strong><span>{registry?.shared_total ?? 0} discoverable</span></div><form className="testcase-search" onSubmit={(event) => submit(event, 'shared', sharedQuery)}><input type="search" aria-label="Search shared testcases" value={sharedQuery} placeholder="Name or description" onChange={(event) => setSharedQuery(event.target.value)} /><button disabled={scenarioBusy}>Search</button></form><div className="testcase-card-list">{shared.length ? shared.map((item) => card(item, true)) : <div className="empty-state">No shared testcases match this search.</div>}</div><PageControls total={registry?.shared_total ?? 0} limit={registry?.shared_limit ?? 20} offset={registry?.shared_offset ?? 0} busy={scenarioBusy} onPage={(offset) => onBrowse('shared', sharedQuery, offset)} /></section>}
    {activeTab === 'legacy' && <section className="testcase-library__section"><div className="testcase-library__summary"><strong>Legacy Scenarios</strong><span>{legacy.length} read-only</span></div><div className="testcase-card-list">{legacy.length ? legacy.map((item) => card(item, true)) : <div className="empty-state">No legacy scenarios configured.</div>}</div></section>}
    {scenarioMessage && <div className="scenario-message" role="status">{scenarioMessage}</div>}{(registry?.errors ?? []).map((message) => <div className="scenario-warning" key={message}>{message}</div>)}
  </div>;
}

const coordinateText = (point: LngLat | null) => point ? `${point[0].toFixed(6)}, ${point[1].toFixed(6)}` : 'Not set';

export function TestcaseManagementSections(props: TestcaseManagementSectionsProps) {
  const { activeDataset, start, end, editingScenario, editorDataset, editorStart, editorEnd, routeReplaced, scenarioName, scenarioNotes, scenarioVisibility, expectedText, forbiddenText, scenarioBusy, scenarioMessage, setScenarioName, setScenarioNotes, setScenarioVisibility, setExpectedText, setForbiddenText, onSave, onUseCurrentRoute, onCancelEdit, onReset } = props;
  const editing = Boolean(editingScenario);
  return <section className="testcase-editor" aria-labelledby="testcase-editor-title">
    <header className="testcase-editor__header"><div><h2 id="testcase-editor-title">{editing ? 'Edit Testcase' : 'Create Testcase'}</h2><p>{editing ? `Editing ${editingScenario?.name} · revision ${editingScenario?.revision ?? 0}` : 'Save the current dashboard route as a reusable testcase.'}</p></div>{editing && <span className="edit-mode-badge">Edit mode</span>}</header>
    <div className="testcase-editor__grid"><div className="testcase-editor__main">
      <label><span>Testcase name <b>*</b></span><input aria-label="Testcase name" value={scenarioName} maxLength={160} disabled={scenarioBusy} placeholder="A concise, searchable name" onChange={(event) => setScenarioName(event.target.value)} /></label>
      <label><span>Description</span><textarea aria-label="Testcase description" value={scenarioNotes} maxLength={4000} rows={5} disabled={scenarioBusy} placeholder="What route behavior is this intended to validate?" onChange={(event) => setScenarioNotes(event.target.value)} /></label>
      <div className="testcase-expectations"><label><span>Expected instruction text <small>Optional · Valhalla/Odin</small></span><input aria-label="Expected instruction text" value={expectedText} disabled={scenarioBusy} placeholder="Instruction must contain…" onChange={(event) => setExpectedText(event.target.value)} /></label><label><span>Forbidden instruction text <small>Optional · Valhalla/Odin</small></span><input aria-label="Forbidden instruction text" value={forbiddenText} disabled={scenarioBusy} placeholder="Instruction must not contain…" onChange={(event) => setForbiddenText(event.target.value)} /></label></div>
    </div><aside className="testcase-editor__context"><div><span>Dataset</span><strong>{editorDataset}</strong>{editing && !routeReplaced && <small>Saved dataset preserved</small>}</div><div><span>Start</span><code>{coordinateText(editorStart)}</code></div><div><span>End</span><code>{coordinateText(editorEnd)}</code></div><label><span>Visibility</span><select aria-label="Testcase visibility" value={scenarioVisibility} disabled={scenarioBusy} onChange={(event) => setScenarioVisibility(event.target.value as 'private' | 'shared')}><option value="private">Private</option><option value="shared">Shared</option></select></label>{editing && <button type="button" className="text-action" disabled={scenarioBusy || !start || !end || (activeDataset === editorDataset && coordinateText(start) === coordinateText(editorStart) && coordinateText(end) === coordinateText(editorEnd))} onClick={onUseCurrentRoute}>Use current dashboard route</button>}{editing && routeReplaced && <small className="testcase-route-warning">Saving will replace the stored route and dataset.</small>}</aside></div>
    {scenarioMessage && <div className="scenario-message" role="status">{scenarioMessage}</div>}
    <footer className="testcase-editor__actions"><button type="button" className="route-button" onClick={onSave} disabled={scenarioBusy || !scenarioName.trim() || !editorStart || !editorEnd}>{scenarioBusy ? 'Saving…' : editing ? 'Save Changes' : 'Save Testcase'}</button>{editing && <button type="button" onClick={onCancelEdit} disabled={scenarioBusy}>Cancel editing</button>}<button type="button" onClick={onReset} disabled={scenarioBusy}>Reset form</button></footer>
  </section>;
}
