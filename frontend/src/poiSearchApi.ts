import type { Feature, FeatureCollection, Point } from 'geojson';

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

export interface PoiSearchResponse extends FeatureCollection<Point> {
  dataset_id: string;
  features: Feature<Point>[];
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
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

export async function searchPois(params: PoiSearchParams, signal?: AbortSignal): Promise<PoiSearchResponse> {
  const response = await fetch(buildPoiSearchUrl(params), { signal });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const detail = typeof (body as { detail?: unknown } | null)?.detail === 'string'
      ? (body as { detail: string }).detail
      : `POI search request failed: ${response.status}`;
    throw new PoiSearchRequestError(detail, response.status);
  }
  return body as PoiSearchResponse;
}

export function poiFeatureKey(feature: Feature<Point>): string {
  const props = feature.properties ?? {};
  const identifier = props.mappls_poi_id ?? props.new_node_id ?? props.osm_source_id ?? feature.id;
  return identifier !== undefined && identifier !== ''
    ? String(identifier)
    : `${feature.geometry.coordinates[0]},${feature.geometry.coordinates[1]}|${String(props.name ?? '')}`;
}

export function mergePoiPages(current: Feature<Point>[], next: Feature<Point>[]): Feature<Point>[] {
  const merged = new Map(current.map((feature) => [poiFeatureKey(feature), feature]));
  for (const feature of next) merged.set(poiFeatureKey(feature), feature);
  return [...merged.values()];
}
