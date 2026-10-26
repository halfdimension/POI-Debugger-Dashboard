import type { Feature, FeatureCollection, Point } from 'geojson';
import { apiFetch } from './auth';

export type PoiBounds = [west: number, south: number, east: number, north: number];

export interface PoiSearchParams {
  datasetId: string;
  q?: string;
  type?: string;
  minPriority?: number;
  visible?: boolean;
  bbox?: PoiBounds;
  limit?: number;
  cursor?: string;
}

export type PoiConditionField = 'name' | 'priority' | 'landmark_type' | 'mappls_poi_id' | 'new_node_id' | 'osm_source_id' | 'visible';
export type PoiConditionOperator = 'contains' | 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'is_visible' | 'is_hidden';
export type PoiConditionValue = string | number | [number, number];

export interface PoiSearchCondition {
  id: string;
  field: PoiConditionField;
  operator: PoiConditionOperator;
  value?: PoiConditionValue;
}

export interface PoiQueryParams {
  datasetId: string;
  q?: string;
  mode: 'and' | 'or';
  conditions: PoiSearchCondition[];
  bbox?: PoiBounds;
  limit?: number;
  cursor?: string;
}

export interface PoiSearchResponse extends FeatureCollection<Point> {
  dataset_id: string;
  features: Feature<Point>[];
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface DiagnosticPoiResponse extends FeatureCollection<Point> {
  dataset_id: string;
  features: Feature<Point>[];
  returned: number;
  complete: boolean;
  incomplete_reason: 'point_limit' | 'candidate_limit' | 'result_limit' | null;
  matched_total: number | null;
  candidate_count: number;
  point_count: number;
  processed_points: number;
  radius_m: number;
}

export class PoiSearchRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PoiSearchRequestError';
  }
}

export function serializePoiBounds(bounds: PoiBounds): string {
  if (bounds.some((value) => !Number.isFinite(value))) throw new Error('POI bounds must contain finite numbers');
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90) throw new Error('POI bounds are outside valid longitude/latitude ranges');
  if (west > east) throw new Error('POI bounds crossing the antimeridian are not supported');
  if (south > north) throw new Error('POI bounds south must not exceed north');
  return bounds.join(',');
}

export function buildPoiSearchUrl(params: PoiSearchParams): string {
  if (!params.datasetId.trim()) throw new Error('dataset_id is required');
  const query = new URLSearchParams({ dataset_id: params.datasetId });
  if (params.q?.trim()) query.set('q', params.q.trim());
  if (params.type?.trim()) query.set('type', params.type.trim());
  if (params.minPriority !== undefined) query.set('min_priority', String(params.minPriority));
  if (params.visible !== undefined) query.set('visible', String(params.visible));
  if (params.bbox) query.set('bbox', serializePoiBounds(params.bbox));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  return `/api/pois/search?${query.toString()}`;
}

function responseDetail(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return fallback;
}

export async function searchPois(params: PoiSearchParams, signal?: AbortSignal): Promise<PoiSearchResponse> {
  const response = await apiFetch(buildPoiSearchUrl(params), { signal });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const detail = responseDetail(body, `POI search request failed: ${response.status}`);
    throw new PoiSearchRequestError(detail, response.status);
  }
  return body as PoiSearchResponse;
}

export function buildPoiQueryBody(params: PoiQueryParams): Record<string, unknown> {
  if (!params.datasetId.trim()) throw new Error('dataset_id is required');
  if (params.bbox) serializePoiBounds(params.bbox);
  return {
    dataset_id: params.datasetId,
    q: params.q?.trim() ?? '',
    mode: params.mode,
    conditions: params.conditions.map(({ field, operator, value }) => ({
      field,
      operator,
      ...(value === undefined ? {} : { value }),
    })),
    ...(params.bbox ? { bbox: params.bbox } : {}),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
}

export async function queryPois(params: PoiQueryParams, signal?: AbortSignal): Promise<PoiSearchResponse> {
  const response = await apiFetch('/api/pois/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPoiQueryBody(params)),
    signal,
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const detail = responseDetail(body, `POI query request failed: ${response.status}`);
    throw new PoiSearchRequestError(detail, response.status);
  }
  return body as PoiSearchResponse;
}

export async function fetchDiagnosticPois(
  datasetId: string,
  points: Array<[number, number]>,
  radiusM: number,
  signal?: AbortSignal,
): Promise<DiagnosticPoiResponse> {
  const response = await apiFetch('/api/pois/diagnostics/nearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_id: datasetId, points, radius_m: radiusM }),
    signal,
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const detail = responseDetail(body, `Diagnostic POI request failed: ${response.status}`);
    throw new PoiSearchRequestError(detail, response.status);
  }
  return body as DiagnosticPoiResponse;
}

export function poiFeatureKey(feature: Feature<Point>): string {
  const props = feature.properties ?? {};
  return [feature.id ?? '', props.mappls_poi_id ?? '', props.new_node_id ?? '', props.osm_source_id ?? '',
    feature.geometry.coordinates[0], feature.geometry.coordinates[1], props.name ?? ''].join('|');
}

export function mergePoiPages(current: Feature<Point>[], next: Feature<Point>[]): Feature<Point>[] {
  const merged = new Map(current.map((feature) => [poiFeatureKey(feature), feature]));
  for (const feature of next) merged.set(poiFeatureKey(feature), feature);
  return [...merged.values()];
}
