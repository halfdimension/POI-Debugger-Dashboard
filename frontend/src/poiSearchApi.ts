import type { Feature, FeatureCollection, Point } from 'geojson';
import { apiFetch } from './auth';

export type PoiBounds = [west: number, south: number, east: number, north: number];
export type PoiVisualizationMode = 'auto' | 'density' | 'clusters' | 'points';
export type PoiRenderedVisualization = Exclude<PoiVisualizationMode, 'auto'>;

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

export interface ViewportAggregate {
  id: string;
  source_record_count: number;
  coordinates: [number, number];
  coordinate_kind: 'density_weighted_centroid' | 'represented_bounds_center';
  bounds: PoiBounds;
  aggregation_level: number;
  cluster_ref: string;
}

export interface ViewportIndividualPoi {
  id: string;
  source_record_id: number;
  coordinates: [number, number];
  feature: Feature<Point>;
}

export interface ViewportResponseMeta {
  spatial_strategy: string;
  requested_aggregation_level: number | null;
  aggregation_level: number | null;
  adaptive_coarsening: boolean;
  feature_count: number;
  aggregate_count: number;
  individual_count: number;
  represented_poi_count: number;
  max_features: number;
  server_max_features: number;
  max_payload_bytes: number;
  serialized_bytes: number;
  requested_representation?: 'auto' | 'clusters' | 'points';
  fallback_reason?: 'viewport_too_dense_for_complete_points' | null;
}

export interface PoiViewportResponse {
  dataset_id: string;
  generation: string;
  bbox: PoiBounds;
  zoom: number;
  mode: 'aggregated' | 'individual';
  complete: boolean;
  total_matching_pois: number;
  aggregates: ViewportAggregate[];
  individual_pois: ViewportIndividualPoi[];
  meta: ViewportResponseMeta;
}

export interface ClusterMemberResponse {
  dataset_id: string;
  generation: string;
  cluster_id: string;
  cluster_ref: string;
  bounds: PoiBounds;
  aggregation_level: number;
  total_matching_pois: number;
  individual_pois: ViewportIndividualPoi[];
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
  meta: {
    order: 'source_record_id_ascending';
    max_limit: number;
    max_payload_bytes: number;
    serialized_bytes: number;
  };
}

export interface PoiViewportParams {
  datasetId: string;
  bbox: PoiBounds;
  zoom: number;
  maxFeatures?: number;
  representation?: 'auto' | 'clusters' | 'points';
}

export interface DensitySample {
  id: string;
  coordinates: [number, number];
  source_record_count: number;
  render_weight: number;
  bounds: PoiBounds;
  aggregation_level: number;
}

export interface PoiDensityResponse {
  dataset_id: string;
  generation: string;
  bbox: PoiBounds;
  zoom: number;
  complete: boolean;
  total_matching_pois: number;
  samples: DensitySample[];
  meta: {
    spatial_strategy: string;
    requested_aggregation_level: number;
    aggregation_level: number;
    adaptive_coarsening: boolean;
    sample_count: number;
    represented_poi_count: number;
    max_samples: number;
    server_max_samples: number;
    max_render_weight: number;
    max_payload_bytes: number;
    serialized_bytes: number;
  };
}

export interface PoiDensityParams {
  datasetId: string;
  bbox: PoiBounds;
  zoom: number;
  maxSamples?: number;
}

export interface ClusterMemberParams {
  datasetId: string;
  clusterRef: string;
  limit?: number;
  cursor?: string;
}

export class PoiSearchRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null) {
    super(message);
    this.name = 'PoiSearchRequestError';
  }
}

export class PoiIndexStaleError extends PoiSearchRequestError {
  constructor(message = 'The POI index changed. Refresh the map and try this cluster again.') {
    super(message, 409, 'poi_index_generation_stale');
    this.name = 'PoiIndexStaleError';
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

function responseCode(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  return detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string'
    ? (detail as { code: string }).code
    : null;
}

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = responseCode(body);
    if (response.status === 409 && code === 'poi_index_generation_stale') throw new PoiIndexStaleError();
    throw new PoiSearchRequestError(responseDetail(body, fallback), response.status, code);
  }
  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function parseViewportResponse(value: unknown): PoiViewportResponse {
  if (!isRecord(value) || typeof value.dataset_id !== 'string' || typeof value.generation !== 'string' ||
      (value.mode !== 'aggregated' && value.mode !== 'individual') || typeof value.complete !== 'boolean' ||
      typeof value.total_matching_pois !== 'number' || !Array.isArray(value.bbox) ||
      !Array.isArray(value.aggregates) || !Array.isArray(value.individual_pois) || !isRecord(value.meta)) {
    throw new PoiSearchRequestError('The POI map service returned an invalid response.', 503);
  }
  return value as unknown as PoiViewportResponse;
}

function parseDensityResponse(value: unknown): PoiDensityResponse {
  if (!isRecord(value) || typeof value.dataset_id !== 'string' || typeof value.generation !== 'string' ||
      typeof value.complete !== 'boolean' || typeof value.total_matching_pois !== 'number' ||
      !Array.isArray(value.bbox) || !Array.isArray(value.samples) || !isRecord(value.meta)) {
    throw new PoiSearchRequestError('The POI density service returned an invalid response.', 503);
  }
  return value as unknown as PoiDensityResponse;
}

function parseClusterMemberResponse(value: unknown): ClusterMemberResponse {
  if (!isRecord(value) || typeof value.dataset_id !== 'string' || typeof value.generation !== 'string' ||
      typeof value.cluster_ref !== 'string' || typeof value.total_matching_pois !== 'number' ||
      !Array.isArray(value.individual_pois) || typeof value.has_more !== 'boolean' ||
      !(value.next_cursor === null || typeof value.next_cursor === 'string') || !isRecord(value.meta)) {
    throw new PoiSearchRequestError('The POI map service returned an invalid member response.', 503);
  }
  return value as unknown as ClusterMemberResponse;
}

export async function searchPois(params: PoiSearchParams, signal?: AbortSignal): Promise<PoiSearchResponse> {
  const response = await apiFetch(buildPoiSearchUrl(params), { signal });
  return jsonResponse(response, `POI search request failed: ${response.status}`);
}

export function buildPoiViewportUrl(params: PoiViewportParams): string {
  if (!params.datasetId.trim()) throw new Error('dataset_id is required');
  if (!Number.isFinite(params.zoom)) throw new Error('zoom must be finite');
  const query = new URLSearchParams({
    dataset_id: params.datasetId,
    bbox: serializePoiBounds(params.bbox),
    zoom: String(params.zoom),
  });
  if (params.maxFeatures !== undefined) query.set('max_features', String(params.maxFeatures));
  if (params.representation) query.set('representation', params.representation);
  return `/api/pois/viewport?${query.toString()}`;
}

export function buildPoiDensityUrl(params: PoiDensityParams): string {
  if (!params.datasetId.trim()) throw new Error('dataset_id is required');
  if (!Number.isFinite(params.zoom)) throw new Error('zoom must be finite');
  const query = new URLSearchParams({
    dataset_id: params.datasetId,
    bbox: serializePoiBounds(params.bbox),
    zoom: String(params.zoom),
  });
  if (params.maxSamples !== undefined) query.set('max_samples', String(params.maxSamples));
  return `/api/pois/viewport/density?${query.toString()}`;
}

export async function fetchPoiDensity(params: PoiDensityParams, signal?: AbortSignal): Promise<PoiDensityResponse> {
  const response = await apiFetch(buildPoiDensityUrl(params), { signal });
  return parseDensityResponse(await jsonResponse(response, `POI density request failed: ${response.status}`));
}

export async function fetchPoiViewport(params: PoiViewportParams, signal?: AbortSignal): Promise<PoiViewportResponse> {
  const response = await apiFetch(buildPoiViewportUrl(params), { signal });
  return parseViewportResponse(await jsonResponse(response, `Viewport POI request failed: ${response.status}`));
}

export function buildClusterMemberUrl(params: ClusterMemberParams): string {
  if (!params.datasetId.trim()) throw new Error('dataset_id is required');
  if (!params.clusterRef) throw new Error('cluster_ref is required');
  const query = new URLSearchParams({ dataset_id: params.datasetId, cluster_ref: params.clusterRef });
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  return `/api/pois/viewport/cluster-members?${query.toString()}`;
}

export async function fetchClusterMembers(params: ClusterMemberParams, signal?: AbortSignal): Promise<ClusterMemberResponse> {
  const response = await apiFetch(buildClusterMemberUrl(params), { signal });
  return parseClusterMemberResponse(await jsonResponse(response, `Cluster member request failed: ${response.status}`));
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
