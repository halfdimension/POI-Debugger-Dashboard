import { getConfig, getDatasets, getPreferences, getScenarios } from './api';
import type { DatasetRegistryResponse, DebuggerConfig, ScenarioRegistryResponse, UserPreferences } from './types';

export interface InitialDashboardData {
  config: DebuggerConfig;
  datasets: DatasetRegistryResponse;
  scenarios: ScenarioRegistryResponse;
  preferences: UserPreferences;
}

export interface InitializationLoaders {
  getConfig: typeof getConfig;
  getDatasets: typeof getDatasets;
  getScenarios: typeof getScenarios;
  getPreferences: typeof getPreferences;
}

const defaultLoaders: InitializationLoaders = { getConfig, getDatasets, getScenarios, getPreferences };

export async function loadInitialDashboard(loaders: InitializationLoaders = defaultLoaders): Promise<InitialDashboardData> {
  // Resolve preferences first so a removed-dataset fallback is reported by
  // the preference endpoint before other endpoints consume the repaired value.
  const preferences = await loaders.getPreferences();
  const [config, datasets, scenarios] = await Promise.all([
    loaders.getConfig(), loaders.getDatasets(), loaders.getScenarios(),
  ]);
  return { config, datasets, scenarios, preferences };
}
