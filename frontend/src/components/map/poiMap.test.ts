import type { Feature, FeatureCollection, Point } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindDebouncedViewportListener,
  expandPoiCluster,
  explorerPoiSource,
  incompleteViewportMessage,
  INDIVIDUAL_POI_LAYER_ID,
  isIndividualPoiFeature,
  isPoiClusterFeature,
  POI_CLUSTER_COUNT_LAYER_ID,
  POI_CLUSTER_LAYER_ID,
  ViewportRequestCoordinator,
  viewportPoiLabel,
  viewportRequestKey,
} from './poiMap';

const point = (
  properties: Record<string, unknown>,
  coordinates: [number, number] = [77, 28],
): Feature<Point> => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
});

describe('explorer POI clustering', () => {
  it('configures native GeoJSON clustering without changing source features', () => {
    const data: FeatureCollection = { type: 'FeatureCollection', features: [point({ mappls_poi_id: 'one' })] };
    const source = explorerPoiSource(data);

    expect(source).toMatchObject({ type: 'geojson', data, cluster: true, clusterRadius: 48, clusterMaxZoom: 14 });
    expect(source.data).toBe(data);
    expect([POI_CLUSTER_LAYER_ID, POI_CLUSTER_COUNT_LAYER_ID, INDIVIDUAL_POI_LAYER_ID])
      .toEqual(['poi-clusters', 'poi-cluster-count', 'pois']);
  });

  it('distinguishes generated clusters from individual POIs', () => {
    const cluster = point({ cluster: true, cluster_id: 12, point_count: 8 });
    const individual = point({ mappls_poi_id: 'same', new_node_id: 'node-1' });

    expect(isPoiClusterFeature(cluster)).toBe(true);
    expect(isIndividualPoiFeature(cluster)).toBe(false);
    expect(isPoiClusterFeature(individual)).toBe(false);
    expect(isIndividualPoiFeature(individual)).toBe(true);
  });

  it('keeps records with duplicate external identifiers as distinct source features', () => {
    const first = point({ mappls_poi_id: 'duplicate', new_node_id: 'a' }, [77, 28]);
    const second = point({ mappls_poi_id: 'duplicate', new_node_id: 'b' }, [77, 28]);
    const data: FeatureCollection = { type: 'FeatureCollection', features: [first, second] };

    expect(explorerPoiSource(data).data).toBe(data);
    expect(data.features).toHaveLength(2);
    expect(data.features[0].properties).toEqual({ mappls_poi_id: 'duplicate', new_node_id: 'a' });
    expect(data.features[1].properties).toEqual({ mappls_poi_id: 'duplicate', new_node_id: 'b' });
  });

  it('uses the cluster expansion API and limits a single zoom jump', async () => {
    const easeTo = vi.fn();
    const getClusterExpansionZoom = vi.fn().mockResolvedValue(19);
    const map = {
      getSource: vi.fn().mockReturnValue({ getClusterExpansionZoom }),
      getZoom: vi.fn().mockReturnValue(10),
      easeTo,
    };
    const cluster = point({ cluster: true, cluster_id: 44, point_count: 25 }, [77.2, 28.6]);

    await expect(expandPoiCluster(map as never, cluster)).resolves.toBe(true);
    expect(getClusterExpansionZoom).toHaveBeenCalledWith(44);
    expect(easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [77.2, 28.6], zoom: 14, duration: 350 }));
  });

  it('does not treat an individual POI click as a cluster click', async () => {
    const map = { getSource: vi.fn(), getZoom: vi.fn(), easeTo: vi.fn() };
    await expect(expandPoiCluster(map as never, point({ name: 'Cafe', priority: 1 }))).resolves.toBe(false);
    expect(map.getSource).not.toHaveBeenCalled();
  });
});

describe('viewport completeness labels', () => {
  it('does not imply a dataset total for incomplete viewport data', () => {
    expect(viewportPoiLabel(500, true)).toBe('500 loaded viewport POIs');
    expect(incompleteViewportMessage(500, true)).toContain('Additional POIs are available');
    expect(incompleteViewportMessage(500, true)).toContain('Zoom in');
  });

  it('does not show an incomplete notice for a complete response', () => {
    expect(viewportPoiLabel(23, false)).toBe('23 viewport POIs');
    expect(incompleteViewportMessage(23, false)).toBe('');
  });
});

describe('viewport request coordination', () => {
  it('normalizes insignificant bounds jitter and prevents duplicate requests', () => {
    const firstKey = viewportRequestKey('weekly', [77, 28, 78, 29]);
    const jitteredKey = viewportRequestKey('weekly', [77.0000001, 28, 78, 29]);
    const requests = new ViewportRequestCoordinator();
    const first = requests.begin(firstKey)!;

    expect(jitteredKey).toBe(firstKey);
    expect(requests.begin(jitteredKey)).toBeNull();
    expect(requests.complete(first)).toBe(true);
    expect(requests.begin(firstKey)).toBeNull();
  });

  it('aborts stale work and rejects an older response after viewport or dataset changes', () => {
    const requests = new ViewportRequestCoordinator();
    const oldRequest = requests.begin(viewportRequestKey('weekly', [77, 28, 78, 29]))!;
    const newRequest = requests.begin(viewportRequestKey('monthly', [77, 28, 78, 29]))!;

    expect(oldRequest.controller.signal.aborted).toBe(true);
    expect(requests.complete(oldRequest)).toBe(false);
    expect(requests.complete(newRequest)).toBe(true);
  });

  it('allows unchanged bounds to refresh after dataset data is invalidated', () => {
    const requests = new ViewportRequestCoordinator();
    const key = viewportRequestKey('weekly', [77, 28, 78, 29]);
    const initial = requests.begin(key)!;
    requests.complete(initial);
    requests.invalidate();

    expect(requests.begin(key)).not.toBeNull();
  });

  it('debounces map movement and removes listeners and timers on cleanup', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const map = {
      loaded: () => true,
      on: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener); }),
      once: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener); }),
      off: vi.fn((type: string, listener: () => void) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    const settled = vi.fn();
    const cleanup = bindDebouncedViewportListener(map, settled, 100);

    listeners.get('moveend')?.();
    listeners.get('moveend')?.();
    vi.advanceTimersByTime(99);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);

    listeners.get('moveend')?.();
    cleanup();
    vi.runAllTimers();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(map.off).toHaveBeenCalledWith('moveend', expect.any(Function));
    expect(map.off).toHaveBeenCalledWith('load', expect.any(Function));
  });
});

afterEach(() => {
  vi.useRealTimers();
});
