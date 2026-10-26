import type { CompareRouteResponse, DatasetRegistryResponse, DebuggerConfig, UserPreferences, UserPreferencesPatch, ValhallaRouteResponse } from './types';
import { apiFetch } from './auth';

export async function getConfig(): Promise<DebuggerConfig> {
  const response = await apiFetch('/api/config');
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
  return response.json();
}

export async function getDatasets(): Promise<DatasetRegistryResponse> {
  const response = await apiFetch('/api/datasets');
  if (!response.ok) throw new Error(`Dataset registry request failed: ${response.status}`);
  return response.json();
}

export async function getPreferences(): Promise<UserPreferences> {
  const response = await apiFetch('/api/users/me/preferences');
  if (!response.ok) throw new Error(`Preference request failed: ${response.status}`);
  return response.json();
}

export async function updatePreferences(payload: UserPreferencesPatch): Promise<UserPreferences> {
  const response = await apiFetch('/api/users/me/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : 'Preference update failed');
  return body;
}

export async function activateDataset(datasetId: string): Promise<any> {
  const response = await apiFetch(`/api/datasets/${encodeURIComponent(datasetId)}/activate`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function reloadDatasetPois(datasetId: string): Promise<any> {
  const response = await apiFetch(`/api/datasets/${encodeURIComponent(datasetId)}/reload-pois`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function getValhallaStatus(): Promise<any> {
  const response = await apiFetch('/api/valhalla/status');
  if (!response.ok) throw new Error(`Valhalla status request failed: ${response.status}`);
  return response.json();
}

export async function getOsrmStatus(): Promise<any> {
  const response = await apiFetch('/api/osrm/status');
  if (!response.ok) throw new Error(`OSRM status request failed: ${response.status}`);
  return response.json();
}

export async function requestRoute(payload: object, signal?: AbortSignal): Promise<ValhallaRouteResponse> {
  const response = await apiFetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  }
  return body;
}

export async function requestCompareRoute(payload: object, signal?: AbortSignal): Promise<CompareRouteResponse> {
  const response = await apiFetch('/api/route/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : JSON.stringify(body?.detail ?? body)
    );
  }

  return body;
}

export async function getScenarios(): Promise<import('./types').ScenarioRegistryResponse> {
  const [testcaseResponse, legacyResponse] = await Promise.all([
    apiFetch('/api/testcases?limit=100'), apiFetch('/api/scenarios'),
  ]);
  if (!testcaseResponse.ok) throw new Error(`Testcase request failed: ${testcaseResponse.status}`);
  if (!legacyResponse.ok) throw new Error(`Legacy scenario request failed: ${legacyResponse.status}`);
  const owned = await testcaseResponse.json();
  const legacy = await legacyResponse.json();
  return {
    count: owned.total, total: owned.total, scenarios: owned.testcases,
    errors: legacy.errors ?? [], legacy_scenarios: legacy.scenarios ?? [],
  };
}

export async function createScenario(payload: object): Promise<import('./types').RouteScenario> {
  const response = await apiFetch('/api/testcases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function updateScenario(scenarioId: string, payload: object): Promise<import('./types').RouteScenario> {
  const response = await apiFetch(`/api/testcases/${encodeURIComponent(scenarioId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  const response = await apiFetch(`/api/testcases/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  }
}
