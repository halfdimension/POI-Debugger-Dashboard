import type { DebuggerConfig, ValhallaRouteResponse } from './types';

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

export async function getValhallaStatus(): Promise<any> {
  const response = await fetch('/api/valhalla/status');
  if (!response.ok) throw new Error(`Valhalla status request failed: ${response.status}`);
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
