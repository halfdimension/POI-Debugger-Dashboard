import type { Feature, GeoJsonProperties, Point } from 'geojson';

export const POI_SEARCH_FIELDS = [
  'name',
  'mappls_poi_id',
  'new_node_id',
  'osm_source_id',
  'landmark_type',
] as const;

export interface PoiFilters {
  search: string;
  landmarkType: string;
  minimumPriority: number;
  visibleOnly: boolean;
}

export function pointFeature(feature: Feature): Feature<Point> | null {
  return feature.geometry?.type === 'Point' ? feature as Feature<Point> : null;
}

export function propText(
  properties: GeoJsonProperties,
  key: string,
  fallback = '',
): string {
  const value = properties?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

export function propNumber(
  properties: GeoJsonProperties,
  key: string,
): number | null {
  const value = Number(properties?.[key]);
  return Number.isFinite(value) ? value : null;
}

export function poiVisible(properties: GeoJsonProperties): boolean {
  const value = propText(properties, 'visible', 'yes').trim().toLowerCase();
  return !['no', 'false', '0', 'n'].includes(value);
}

export function poiSearchText(properties: GeoJsonProperties): string {
  return POI_SEARCH_FIELDS
    .map((key) => propText(properties, key, ''))
    .join(' ')
    .toLowerCase();
}

export function filterPoiFeatures(
  features: Feature[],
  filters: PoiFilters,
): Feature<Point>[] {
  const query = filters.search.trim().toLowerCase();
  const result: Feature<Point>[] = [];

  for (const rawFeature of features) {
    const feature = pointFeature(rawFeature);
    if (!feature) continue;
    const properties = feature.properties ?? {};

    if (filters.visibleOnly && !poiVisible(properties)) continue;

    const landmarkType = propText(properties, 'landmark_type', '').trim();
    if (
      filters.landmarkType !== 'all' &&
      landmarkType !== filters.landmarkType
    ) {
      continue;
    }

    if (filters.minimumPriority > 0) {
      const priority = propNumber(properties, 'priority');
      if (priority === null || priority < filters.minimumPriority) continue;
    }

    if (query && !poiSearchText(properties).includes(query)) continue;

    result.push(feature);
  }

  return result;
}

export function rankPoiSearchResults(
  features: Feature<Point>[],
  search: string,
  limit = 10,
): Feature<Point>[] {
  const query = search.trim().toLowerCase();
  if (!query) return [];

  return [...features]
    .sort((a, b) => {
      const aName = propText(a.properties, 'name', '').toLowerCase();
      const bName = propText(b.properties, 'name', '').toLowerCase();
      const aStarts = aName.startsWith(query) ? 1 : 0;
      const bStarts = bName.startsWith(query) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;
      const priorityDiff =
        (propNumber(b.properties, 'priority') ?? -1) -
        (propNumber(a.properties, 'priority') ?? -1);
      if (priorityDiff !== 0) return priorityDiff;
      return aName.localeCompare(bName);
    })
    .slice(0, limit);
}
