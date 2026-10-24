import { describe, expect, it } from 'vitest';
import {
  initialDashboardLayout,
  selectAnalysisTab,
  togglePanel,
} from './layoutState';

describe('dashboard layout state', () => {
  it('toggles panels without changing unrelated state', () => {
    const next = togglePanel(initialDashboardLayout, 'left');
    expect(next.leftCollapsed).toBe(true);
    expect(next.rightCollapsed).toBe(false);
    expect(next.activeAnalysisTab).toBe('comparison');
  });

  it('opens the analysis workspace when a tab is selected', () => {
    const next = selectAnalysisTab(initialDashboardLayout, 'raw');
    expect(next.analysisCollapsed).toBe(false);
    expect(next.activeAnalysisTab).toBe('raw');
  });

  it('can collapse and restore the analysis workspace', () => {
    const open = selectAnalysisTab(initialDashboardLayout, 'maneuvers');
    const collapsed = togglePanel(open, 'analysis');
    const restored = togglePanel(collapsed, 'analysis');
    expect(collapsed.analysisCollapsed).toBe(true);
    expect(restored).toEqual(open);
  });
});
