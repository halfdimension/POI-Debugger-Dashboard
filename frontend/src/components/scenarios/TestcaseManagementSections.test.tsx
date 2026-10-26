import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TestcaseManagementSectionsProps, TestcaseTab } from './TestcaseManagementSections';
import { TestcaseManagementSections } from './TestcaseManagementSections';

function renderTab(activeTab: TestcaseTab): string {
  const noop = vi.fn();
  const props: TestcaseManagementSectionsProps = {
    activeTab,
    onSelectTab: noop,
    registry: {
      scenarios: [], legacy_scenarios: [], shared_scenarios: [], errors: [],
      count: 0, total: 0, limit: 20, offset: 0,
      shared_total: 0, shared_limit: 20, shared_offset: 0,
    },
    activeDataset: 'default',
    start: null,
    end: null,
    scenarioName: 'Unsaved draft',
    scenarioNotes: '',
    scenarioVisibility: 'private',
    expectedText: '',
    forbiddenText: '',
    myQuery: '',
    sharedQuery: '',
    scenarioBusy: false,
    scenarioMessage: '',
    runAllBusy: false,
    routeBusy: false,
    runResults: {},
    setScenarioName: noop,
    setScenarioNotes: noop,
    setScenarioVisibility: noop,
    setExpectedText: noop,
    setForbiddenText: noop,
    setMyQuery: noop,
    setSharedQuery: noop,
    onBrowse: noop,
    onSave: noop,
    onRunAll: noop,
    onLoad: noop,
    onRun: noop,
    onEditExpectation: noop,
    onChangeVisibility: noop,
    onDelete: noop,
  };
  return renderToStaticMarkup(<TestcaseManagementSections {...props} />);
}

describe('TestcaseManagementSections navigation', () => {
  it('renders only the selected testcase category while keeping all tabs available', () => {
    const mine = renderTab('mine');
    expect(mine).toContain('Unsaved draft');
    expect(mine).toContain('Shared Testcases');
    expect(mine).not.toContain('Search shared testcases');

    const shared = renderTab('shared');
    expect(shared).toContain('Search shared testcases');
    expect(shared).not.toContain('Unsaved draft');

    const legacy = renderTab('legacy');
    expect(legacy).toContain('No legacy scenarios configured.');
    expect(legacy).not.toContain('Search shared testcases');
  });
});
