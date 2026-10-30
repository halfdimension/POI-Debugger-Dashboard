import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TestcaseLibrary, TestcaseManagementSections, type TestcaseLibraryProps } from './TestcaseManagementSections';

const registry = {
  scenarios: [], legacy_scenarios: [], shared_scenarios: [], errors: [],
  count: 0, total: 0, limit: 20, offset: 0,
  shared_total: 0, shared_limit: 20, shared_offset: 0,
};

const testcase = {
  id: 'case-1', name: 'Readable testcase', dataset: 'default', description: 'Expanded details description',
  request: { start: { lon: 77, lat: 28 }, end: { lon: 78, lat: 29 }, costing: 'auto' },
};

function library(activeTab: TestcaseLibraryProps['activeTab']): string {
  const noop = vi.fn();
  return renderToStaticMarkup(<TestcaseLibrary activeTab={activeTab} onSelectTab={noop} registry={registry}
    activeDataset="default" myQuery="" sharedQuery="" scenarioBusy={false} scenarioMessage=""
    runAllBusy={false} routeBusy={false} runResults={{}} setMyQuery={noop} setSharedQuery={noop}
    onBrowse={noop} onRunAll={noop} onLoad={noop} onRun={noop} onEdit={noop}
    onChangeVisibility={noop} onDelete={noop} />);
}

describe('testcase workspace', () => {
  it('keeps all library categories while showing only the selected category', () => {
    expect(library('mine')).toContain('My Testcases');
    expect(library('shared')).toContain('Search shared testcases');
    expect(library('legacy')).toContain('No legacy scenarios configured.');
  });

  it('renders a dedicated create editor with route context', () => {
    const noop = vi.fn();
    const markup = renderToStaticMarkup(<TestcaseManagementSections activeDataset="default" start={[77, 28]}
      end={[78, 29]} editingScenario={null} editorDataset="default" editorStart={[77, 28]} editorEnd={[78, 29]}
      routeReplaced={false} scenarioName="Unsaved draft" scenarioNotes="Description" scenarioVisibility="private"
      expectedText="" forbiddenText="" scenarioBusy={false} scenarioMessage="" setScenarioName={noop}
      setScenarioNotes={noop} setScenarioVisibility={noop} setExpectedText={noop} setForbiddenText={noop}
      onSave={noop} onUseCurrentRoute={noop} onCancelEdit={noop} onReset={noop} />);
    expect(markup).toContain('Create Testcase');
    expect(markup).toContain('Unsaved draft');
    expect(markup).toContain('77.000000, 28.000000');
  });

  it('renders testcase details outside the compact primary action row', () => {
    const noop = vi.fn();
    const markup = renderToStaticMarkup(<TestcaseLibrary activeTab="mine" onSelectTab={noop}
      registry={{ ...registry, scenarios: [testcase], count: 1, total: 1 }} activeDataset="default"
      myQuery="" sharedQuery="" scenarioBusy={false} scenarioMessage="" runAllBusy={false}
      routeBusy={false} runResults={{}} setMyQuery={noop} setSharedQuery={noop} onBrowse={noop}
      onRunAll={noop} onLoad={noop} onRun={noop} onEdit={noop} onChangeVisibility={noop} onDelete={noop} />);
    const actionEnd = markup.indexOf('</div><details class="testcase-card__details"');
    expect(actionEnd).toBeGreaterThan(markup.indexOf('testcase-card__actions'));
    expect(markup).toContain('Expanded details description');
  });

  it('locks editor controls while a save is running', () => {
    const noop = vi.fn();
    const markup = renderToStaticMarkup(<TestcaseManagementSections activeDataset="default" start={[77, 28]}
      end={[78, 29]} editingScenario={testcase} editorDataset="default" editorStart={[77, 28]}
      editorEnd={[78, 29]} routeReplaced={false} scenarioName="Readable testcase" scenarioNotes="Draft"
      scenarioVisibility="private" expectedText="" forbiddenText="" scenarioBusy scenarioMessage=""
      setScenarioName={noop} setScenarioNotes={noop} setScenarioVisibility={noop} setExpectedText={noop}
      setForbiddenText={noop} onSave={noop} onUseCurrentRoute={noop} onCancelEdit={noop} onReset={noop} />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel editing<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Reset form<\/button>/);
    expect(markup).toMatch(/<input[^>]*aria-label="Testcase name"[^>]*disabled=""/);
  });
});
