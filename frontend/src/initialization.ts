import { getConfig, getDatasets, getScenarios } from './api';
import type { DatasetRegistryResponse, DebuggerConfig, ScenarioRegistryResponse } from './types';

export interface InitialDashboardData {
  config: DebuggerConfig;
  datasets: DatasetRegistryResponse;
  scenarios: ScenarioRegistryResponse;
}

export interface InitializationLoaders {
  getConfig: typeof getConfig;
  getDatasets: typeof getDatasets;
  getScenarios: typeof getScenarios;
}

const defaultLoaders: InitializationLoaders = { getConfig, getDatasets, getScenarios };

export async function loadInitialDashboard(loaders: InitializationLoaders = defaultLoaders): Promise<InitialDashboardData> {
  const [config, datasets, scenarios] = await Promise.all([
    loaders.getConfig(), loaders.getDatasets(), loaders.getScenarios(),
  ]);
  return { config, datasets, scenarios };
}
