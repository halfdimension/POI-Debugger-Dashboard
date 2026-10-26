import { describe, expect, it, vi } from 'vitest';
import { loadInitialDashboard, type InitializationLoaders } from './initialization';

const config = { project: {}, valhalla: {}, osrm: {}, engine: {}, data: {}, frontend: {}, config_path: '' } as any;
const datasets = { active_dataset: 'test', datasets: [] };
const scenarios = { directory: '', count: 0, scenarios: [], errors: [] };
const preferences = {
  selected_dataset_id: 'test', preferred_basemap: 'mapmyindia', map_display_mode: '2d', route_view: 'both',
  layout: { leftCollapsed: false, rightCollapsed: false, analysisCollapsed: true, activeAnalysisTab: 'comparison' },
  dataset_selection_fallback: false, unavailable_dataset_id: null,
} as const;

function loaders(): InitializationLoaders {
  return {
    getConfig: vi.fn().mockResolvedValue(config),
    getDatasets: vi.fn().mockResolvedValue(datasets),
    getScenarios: vi.fn().mockResolvedValue(scenarios),
    getPreferences: vi.fn().mockResolvedValue(preferences),
  };
}

describe('loadInitialDashboard', () => {
  it('loads startup contracts without downloading the full POI collection', async () => {
    const deps = loaders();
    await expect(loadInitialDashboard(deps)).resolves.toEqual({ config, datasets, scenarios, preferences });
    expect(Object.keys(deps)).not.toContain('getPois');
  });

  it('rejects when the backend is unavailable', async () => {
    const deps = loaders();
    vi.mocked(deps.getConfig).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(loadInitialDashboard(deps)).rejects.toThrow('Failed to fetch');
  });
});
