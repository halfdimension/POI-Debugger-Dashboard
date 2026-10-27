import type { Feature, FeatureCollection, Point } from 'geojson';
import type maplibregl from 'maplibre-gl';
import type { PoiBounds, PoiDensityResponse, PoiRenderedVisualization, PoiViewportResponse, ViewportAggregate } from '../../poiSearchApi';

export const POI_AGGREGATE_SOURCE_ID = 'poi-aggregates';
export const POI_DENSITY_SOURCE_ID = 'poi-density';
export const EXPLORER_POI_SOURCE_ID = 'pois';
export const POI_CLUSTER_LAYER_ID = 'poi-clusters';
export const POI_CLUSTER_COUNT_LAYER_ID = 'poi-cluster-count';
export const INDIVIDUAL_POI_LAYER_ID = 'pois';
export const VIEWPORT_MOVE_DEBOUNCE_MS = 180;
export const VIEWPORT_MAX_FEATURES = 500;
export const CLUSTER_MAX_FEATURES = 250;
export const DENSITY_MAX_SAMPLES = 800;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function aggregateFeature(aggregate: ViewportAggregate, context: Pick<PoiViewportResponse, 'dataset_id' | 'generation'>): Feature<Point> {
  return {
    type: 'Feature', id: aggregate.id,
    geometry: { type: 'Point', coordinates: aggregate.coordinates },
    properties: {
      cluster_ref: aggregate.cluster_ref,
      source_record_count: aggregate.source_record_count,
      dataset_id: context.dataset_id,
      generation: context.generation,
      aggregation_level: aggregate.aggregation_level,
      coordinate_kind: aggregate.coordinate_kind,
      bounds: JSON.stringify(aggregate.bounds),
    },
  };
}

export function viewportFeatureCollections(response: PoiViewportResponse): { aggregates: FeatureCollection<Point>; individuals: FeatureCollection<Point> } {
  return {
    aggregates: { type: 'FeatureCollection', features: response.aggregates.map((item) => aggregateFeature(item, response)) },
    individuals: { type: 'FeatureCollection', features: response.individual_pois.map((item) => item.feature) },
  };
}

export function densityFeatureCollection(response: PoiDensityResponse): FeatureCollection<Point> {
  const denominator = Math.max(1, response.meta.max_render_weight);
  return {
    type: 'FeatureCollection',
    features: response.samples.map((sample) => ({
      type: 'Feature',
      id: sample.id,
      geometry: { type: 'Point', coordinates: sample.coordinates },
      properties: {
        source_record_count: sample.source_record_count,
        render_weight: sample.render_weight,
        normalized_render_weight: sample.render_weight / denominator,
        bounds: JSON.stringify(sample.bounds),
        aggregation_level: sample.aggregation_level,
      },
    })),
  };
}

export function emptyViewportCollections() { return { aggregates: EMPTY, individuals: EMPTY }; }

export function authoritativePoiSource(data: FeatureCollection): maplibregl.GeoJSONSourceSpecification {
  return { type: 'geojson', data };
}

export function aggregateBounds(feature: Feature): PoiBounds | null {
  const raw = feature.properties?.bounds;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((value) => !Number.isFinite(Number(value)))) return null;
    return parsed.map(Number) as PoiBounds;
  } catch { return null; }
}

export function isServerAggregateFeature(feature: Feature): feature is Feature<Point> {
  return feature.geometry.type === 'Point' && typeof feature.properties?.cluster_ref === 'string' && Number.isFinite(Number(feature.properties?.source_record_count));
}

type AggregateExpansionMap = Pick<maplibregl.Map, 'getZoom' | 'easeTo' | 'fitBounds'>;

export function expandServerAggregate(map: AggregateExpansionMap, feature: Feature): boolean {
  if (!isServerAggregateFeature(feature)) return false;
  const bounds = aggregateBounds(feature);
  if (!bounds) return false;
  const [west, south, east, north] = bounds;
  if (east - west > 1e-7 || north - south > 1e-7) {
    map.fitBounds([[west, south], [east, north]], { padding: 70, maxZoom: Math.min(22, map.getZoom() + 4), duration: 350 });
  } else {
    map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: Math.min(22, map.getZoom() + 2), duration: 350, essential: true });
  }
  return true;
}

export function viewportRequestKey(datasetId: string, bounds: PoiBounds, zoom: number, visible: boolean, generation = '', visualization = 'auto'): string {
  return `${datasetId}|${bounds.map((value) => value.toFixed(5)).join(',')}|${zoom.toFixed(2)}|${generation}|${visualization}|${visible ? 'visible' : 'hidden'}`;
}

export function selectAutoPoiVisualization(
  zoom: number,
  representedCount: number | null,
  current: PoiRenderedVisualization,
): PoiRenderedVisualization {
  const count = representedCount ?? Number.POSITIVE_INFINITY;
  if (current === 'density') {
    if (zoom < 10.5 || count > 12_000) return 'density';
    return zoom >= 15.5 && count <= 350 ? 'points' : 'clusters';
  }
  if (current === 'points') {
    if (zoom >= 14.5 && count <= 650) return 'points';
    return zoom < 9.5 || count > 20_000 ? 'density' : 'clusters';
  }
  if (zoom < 9.5 || count > 20_000) return 'density';
  if (zoom >= 15.5 && count <= 350) return 'points';
  return 'clusters';
}

export function poiVisualizationLabel(mode: PoiRenderedVisualization): string {
  return mode === 'density' ? 'Density' : mode === 'clusters' ? 'Clusters' : 'Points';
}

export function viewportPoiLabel(response: PoiViewportResponse | null): string {
  if (!response) return 'No viewport POIs loaded';
  const represented = `${response.total_matching_pois.toLocaleString()} ${response.total_matching_pois === 1 ? 'POI' : 'POIs'} represented`;
  return response.mode === 'aggregated'
    ? `${represented} · ${response.aggregates.length.toLocaleString()} ${response.aggregates.length === 1 ? 'aggregate' : 'aggregates'} displayed`
    : `${represented} · ${response.individual_pois.length.toLocaleString()} individual ${response.individual_pois.length === 1 ? 'marker' : 'markers'} displayed`;
}

export function incompleteViewportMessage(response: PoiViewportResponse | null): string {
  return response && !response.complete ? 'This viewport representation is incomplete. Some matching POIs may not be represented.' : '';
}

export interface ViewportRequestTicket { key: string; sequence: number; controller: AbortController; }
export class ViewportRequestCoordinator {
  private active: ViewportRequestTicket | null = null;
  private completedKey = '';
  private sequence = 0;
  begin(key: string): ViewportRequestTicket | null {
    if (key === this.active?.key || key === this.completedKey) return null;
    this.active?.controller.abort();
    const ticket = { key, sequence: ++this.sequence, controller: new AbortController() };
    this.active = ticket;
    return ticket;
  }
  accepts(ticket: ViewportRequestTicket): boolean { return this.active?.sequence === ticket.sequence && !ticket.controller.signal.aborted; }
  complete(ticket: ViewportRequestTicket): boolean { if (!this.accepts(ticket)) return false; this.completedKey = ticket.key; this.active = null; return true; }
  fail(ticket: ViewportRequestTicket): boolean { if (!this.accepts(ticket)) return false; this.active = null; return true; }
  invalidate(): void { this.cancel(); this.completedKey = ''; }
  cancel(): void { this.active?.controller.abort(); this.active = null; }
}

interface ViewportEventMap {
  loaded(): boolean;
  on(type: 'moveend', listener: () => void): unknown;
  off(type: 'moveend' | 'load', listener: () => void): unknown;
  once(type: 'load', listener: () => void): unknown;
}
export function bindDebouncedViewportListener(map: ViewportEventMap, onSettled: () => void, delay = VIEWPORT_MOVE_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onSettled(); }, delay);
  };
  map.on('moveend', settled);
  if (map.loaded()) settled(); else map.once('load', settled);
  return () => {
    if (timer !== null) clearTimeout(timer);
    map.off('moveend', settled);
    map.off('load', settled);
  };
}
