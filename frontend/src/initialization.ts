import { getConfig, getDatasets, getPois, getScenarios } from './api';
import type { DatasetRegistryResponse, DebuggerConfig, ScenarioRegistryResponse } from './types';

export interface InitialDashboardData {
  config: DebuggerConfig;
  pois: GeoJSON.FeatureCollection;
  datasets: DatasetRegistryResponse;
  scenarios: ScenarioRegistryResponse;
}

export interface InitializationLoaders {
  getConfig: typeof getConfig;
  getPois: typeof getPois;
  getDatasets: typeof getDatasets;
  getScenarios: typeof getScenarios;
}

const defaultLoaders: InitializationLoaders = { getConfig, getPois, getDatasets, getScenarios };

export async function loadInitialDashboard(loaders: InitializationLoaders = defaultLoaders): Promise<InitialDashboardData> {
  const [config, pois, datasets, scenarios] = await Promise.all([
    loaders.getConfig(), loaders.getPois(), loaders.getDatasets(), loaders.getScenarios(),
  ]);
  return { config, pois, datasets, scenarios };
}
