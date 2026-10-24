export type AnalysisTab =
  | 'comparison'
  | 'maneuvers'
  | 'candidates'
  | 'scenarios'
  | 'raw';

export type PanelKey = 'left' | 'right' | 'analysis';

export type DashboardLayoutState = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  analysisCollapsed: boolean;
  activeAnalysisTab: AnalysisTab;
};

export const initialDashboardLayout: DashboardLayoutState = {
  leftCollapsed: false,
  rightCollapsed: false,
  analysisCollapsed: true,
  activeAnalysisTab: 'comparison',
};

export function togglePanel(
  state: DashboardLayoutState,
  panel: PanelKey,
): DashboardLayoutState {
  const key = `${panel}Collapsed` as const;
  return { ...state, [key]: !state[key] };
}

export function selectAnalysisTab(
  state: DashboardLayoutState,
  tab: AnalysisTab,
): DashboardLayoutState {
  return {
    ...state,
    activeAnalysisTab: tab,
    analysisCollapsed: false,
  };
}
