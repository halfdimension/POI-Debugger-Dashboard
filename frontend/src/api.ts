import type { CompareRouteResponse, DatasetRegistryResponse, DebuggerConfig, ValhallaRouteResponse } from './types';

export async function getConfig(): Promise<DebuggerConfig> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
  return response.json();
}

export async function getPois(): Promise<GeoJSON.FeatureCollection> {
  const response = await fetch('/api/pois');
  if (!response.ok) throw new Error(`POI request failed: ${response.status}`);
  return response.json();
}

export async function getDatasets(): Promise<DatasetRegistryResponse> {
  const response = await fetch('/api/datasets');
  if (!response.ok) throw new Error(`Dataset registry request failed: ${response.status}`);
  return response.json();
}

export async function activateDataset(datasetId: string): Promise<any> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/activate`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function reloadDatasetPois(datasetId: string): Promise<any> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/reload-pois`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function getValhallaStatus(): Promise<any> {
  const response = await fetch('/api/valhalla/status');
  if (!response.ok) throw new Error(`Valhalla status request failed: ${response.status}`);
  return response.json();
}

export async function getOsrmStatus(): Promise<any> {
  const response = await fetch('/api/osrm/status');
  if (!response.ok) throw new Error(`OSRM status request failed: ${response.status}`);
  return response.json();
}

export async function requestRoute(payload: object): Promise<ValhallaRouteResponse> {
  const response = await fetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  }
  return body;
}

export async function requestCompareRoute(payload: object): Promise<CompareRouteResponse> {
  const response = await fetch('/api/route/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
  const response = await fetch('/api/scenarios');
  if (!response.ok) throw new Error(`Scenario request failed: ${response.status}`);
  return response.json();
}

export async function createScenario(payload: object): Promise<import('./types').RouteScenario> {
  const response = await fetch('/api/scenarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function updateScenario(scenarioId: string, payload: object): Promise<import('./types').RouteScenario> {
  const response = await fetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  return body;
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  const response = await fetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body));
  }
}
