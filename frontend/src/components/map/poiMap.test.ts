import type { Feature, Point } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoiViewportResponse } from '../../poiSearchApi';
import {
  authoritativePoiSource, bindDebouncedViewportListener, expandServerAggregate,
  incompleteViewportMessage, viewportFeatureCollections, ViewportRequestCoordinator,
  viewportPoiLabel, viewportRequestKey,
} from './poiMap';

const point = (properties: Record<string, unknown>, coordinates: [number, number] = [77, 28]): Feature<Point> => ({
  type: 'Feature', geometry: { type: 'Point', coordinates }, properties,
});

function response(mode: 'aggregated' | 'individual' = 'aggregated'): PoiViewportResponse {
  const feature = point({ name: 'Cafe' });
  return {
    dataset_id: 'weekly', generation: 'g1', bbox: [76, 27, 78, 29], zoom: 10, mode, complete: true,
    total_matching_pois: mode === 'aggregated' ? 18542 : 1,
    aggregates: mode === 'aggregated' ? [{ id: 'cluster-1', source_record_count: 18542, coordinates: [77, 28], coordinate_kind: 'represented_bounds_center', bounds: [76, 27, 78, 29], aggregation_level: 10, cluster_ref: 'ref-1' }] : [],
    individual_pois: mode === 'individual' ? [{ id: 'poi-1', source_record_id: 1, coordinates: [77, 28], feature }] : [],
    meta: { spatial_strategy: 'grid', requested_aggregation_level: 10, aggregation_level: 10, adaptive_coarsening: false, feature_count: 1, aggregate_count: mode === 'aggregated' ? 1 : 0, individual_count: mode === 'individual' ? 1 : 0, represented_poi_count: mode === 'aggregated' ? 18542 : 1, max_features: 500, server_max_features: 1000, max_payload_bytes: 1_000_000, serialized_bytes: 1000 },
  };
}

describe('authoritative POI sources', () => {
  it('keeps server aggregates separate and never enables MapLibre clustering', () => {
    const collections = viewportFeatureCollections(response());
    const source = authoritativePoiSource(collections.aggregates) as Record<string, unknown>;
    expect(source).toEqual({ type: 'geojson', data: collections.aggregates });
    expect(source).not.toHaveProperty('cluster');
    expect(collections.aggregates.features[0].properties).toMatchObject({ source_record_count: 18542, cluster_ref: 'ref-1', dataset_id: 'weekly', generation: 'g1' });
    expect(collections.individuals.features).toHaveLength(0);
  });

  it('preserves original individual POI features', () => {
    const collections = viewportFeatureCollections(response('individual'));
    expect(collections.aggregates.features).toHaveLength(0);
    expect(collections.individuals.features[0].properties).toEqual({ name: 'Cafe' });
  });

  it('fits aggregate bounds without consulting a client cluster index', () => {
    const fitBounds = vi.fn();
    const map = { getZoom: () => 10, fitBounds, easeTo: vi.fn() };
    const aggregate = viewportFeatureCollections(response()).aggregates.features[0];
    expect(expandServerAggregate(map as never, aggregate)).toBe(true);
    expect(fitBounds).toHaveBeenCalledWith([[76, 27], [78, 29]], expect.objectContaining({ maxZoom: 14 }));
  });
});

describe('viewport labels', () => {
  it('distinguishes represented records from rendered features', () => {
    expect(viewportPoiLabel(response())).toBe('18,542 POIs represented · 1 aggregate displayed');
    expect(viewportPoiLabel(response('individual'))).toBe('1 POI represented · 1 individual marker displayed');
    const incomplete = { ...response(), complete: false };
    expect(incompleteViewportMessage(incomplete)).toContain('incomplete');
  });
});

describe('viewport request coordination', () => {
  it('includes zoom, generation and visibility while normalizing insignificant jitter', () => {
    const firstKey = viewportRequestKey('weekly', [77, 28, 78, 29], 10, true, 'g1');
    expect(viewportRequestKey('weekly', [77.0000001, 28, 78, 29], 10, true, 'g1')).toBe(firstKey);
    expect(viewportRequestKey('weekly', [77, 28, 78, 29], 11, true, 'g1')).not.toBe(firstKey);
    expect(viewportRequestKey('weekly', [77, 28, 78, 29], 10, false, 'g1')).not.toBe(firstKey);
  });

  it('aborts stale work and permits refresh after invalidation', () => {
    const requests = new ViewportRequestCoordinator();
    const oldRequest = requests.begin('old')!;
    const newRequest = requests.begin('new')!;
    expect(oldRequest.controller.signal.aborted).toBe(true);
    expect(requests.complete(oldRequest)).toBe(false);
    expect(requests.complete(newRequest)).toBe(true);
    requests.invalidate();
    expect(requests.begin('new')).not.toBeNull();
  });

  it('debounces movement and removes listeners and timers', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const map = { loaded: () => true, on: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)), once: vi.fn(), off: vi.fn((type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); }) };
    const settled = vi.fn();
    const cleanup = bindDebouncedViewportListener(map, settled, 100);
    listeners.get('moveend')?.();
    vi.advanceTimersByTime(100);
    expect(settled).toHaveBeenCalledOnce();
    listeners.get('moveend')?.();
    cleanup();
    vi.runAllTimers();
    expect(settled).toHaveBeenCalledOnce();
  });
});

afterEach(() => vi.useRealTimers());
