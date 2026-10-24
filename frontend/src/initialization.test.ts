import { describe, expect, it, vi } from 'vitest';
import { loadInitialDashboard, type InitializationLoaders } from './initialization';

const config = { project: {}, valhalla: {}, osrm: {}, engine: {}, data: {}, frontend: {}, config_path: '' } as any;
const datasets = { active_dataset: 'test', datasets: [] };
const scenarios = { directory: '', count: 0, scenarios: [], errors: [] };

function loaders(): InitializationLoaders {
  return {
    getConfig: vi.fn().mockResolvedValue(config),
    getDatasets: vi.fn().mockResolvedValue(datasets),
    getScenarios: vi.fn().mockResolvedValue(scenarios),
  };
}

describe('loadInitialDashboard', () => {
  it('loads startup contracts without downloading the full POI collection', async () => {
    const deps = loaders();
    await expect(loadInitialDashboard(deps)).resolves.toEqual({ config, datasets, scenarios });
    expect(Object.keys(deps)).not.toContain('getPois');
  });

  it('rejects when the backend is unavailable', async () => {
    const deps = loaders();
    vi.mocked(deps.getConfig).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(loadInitialDashboard(deps)).rejects.toThrow('Failed to fetch');
  });
});
