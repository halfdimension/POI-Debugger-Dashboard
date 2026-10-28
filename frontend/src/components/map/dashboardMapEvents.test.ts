import type { Feature, Point } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindDashboardMapEvents,
  type DashboardMapEventCallbacks,
} from './dashboardMapEvents';

type LayerHandler = (event: Record<string, unknown>) => void;

function point(
  properties: Record<string, unknown>,
  coordinates: [number, number] = [77.2, 28.6],
): Feature<Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties,
  };
}

function mapDouble(expansionZoom: Promise<number> = Promise.resolve(18)) {
  const listeners = new Map<string, Set<LayerHandler>>();
  const canvas = { style: { cursor: '' } };
  const key = (type: string, layerId: string) => `${type}:${layerId}`;
  const map = {
    on: vi.fn((type: string, layerId: string, handler: LayerHandler) => {
      const handlers = listeners.get(key(type, layerId)) ?? new Set<LayerHandler>();
      handlers.add(handler);
      listeners.set(key(type, layerId), handlers);
    }),
    off: vi.fn((type: string, layerId: string, handler: LayerHandler) => {
      const handlers = listeners.get(key(type, layerId));
      handlers?.delete(handler);
      if (handlers?.size === 0) listeners.delete(key(type, layerId));
    }),
    getCanvas: vi.fn(() => canvas),
    getZoom: vi.fn(() => 10),
    flyTo: vi.fn(),
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    getSource: vi.fn(() => ({
      getClusterExpansionZoom: vi.fn(() => expansionZoom),
    })),
  };
  const emit = (type: string, layerId: string, event: Record<string, unknown>) => {
    for (const handler of listeners.get(key(type, layerId)) ?? []) handler(event);
  };
  const listenerCount = () => Array.from(listeners.values())
    .reduce((count, handlers) => count + handlers.size, 0);
  return { map, canvas, emit, listenerCount };
}

function callbackDouble(): DashboardMapEventCallbacks {
  return {
    onAggregateSelected: vi.fn(),
    onPoiSelected: vi.fn(),
    onRouteNarrationPoiSelected: vi.fn(),
    onManeuverScrollRequested: vi.fn(),
    onManeuverSelected: vi.fn(),
    onPassBySelected: vi.fn(),
    onTurnCoverageSelected: vi.fn(),
    openPoiPopup: vi.fn(),
    closeActivePoiPopup: vi.fn(),
  };
}

function mapEvent(feature: Feature, stopPropagation = vi.fn()) {
  return {
    features: [feature],
    originalEvent: { stopPropagation },
  };
}

describe('bindDashboardMapEvents', () => {
  it('registers the expected click and hover listeners in order', () => {
    const { map, listenerCount } = mapDouble();
    const dispose = bindDashboardMapEvents(map as never, callbackDouble());

    expect(map.on.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['click', 'poi-clusters'],
      ['click', 'pois'],
      ['click', 'selected-poi'],
      ['click', 'nearby-pois'],
      ['click', 'narration-poi'],
      ['click', 'route-narration-pois'],
      ['click', 'candidate-analysis-pois'],
      ['click', 'maneuver-points'],
      ['click', 'osrm-pass-by-events'],
      ['click', 'turn-poi-coverage-pois'],
      ['click', 'turn-poi-coverage-origin'],
      ['mouseenter', 'poi-clusters'],
      ['mouseleave', 'poi-clusters'],
      ['mouseenter', 'pois'],
      ['mouseleave', 'pois'],
      ['mouseenter', 'selected-poi'],
      ['mouseleave', 'selected-poi'],
      ['mouseenter', 'nearby-pois'],
      ['mouseleave', 'nearby-pois'],
      ['mouseenter', 'route-narration-pois'],
      ['mouseleave', 'route-narration-pois'],
      ['mouseenter', 'narration-poi'],
      ['mouseleave', 'narration-poi'],
      ['mouseenter', 'maneuver-points'],
      ['mouseleave', 'maneuver-points'],
      ['mouseenter', 'candidate-analysis-pois'],
      ['mouseleave', 'candidate-analysis-pois'],
      ['mouseenter', 'osrm-pass-by-events'],
      ['mouseleave', 'osrm-pass-by-events'],
      ['mouseenter', 'turn-poi-coverage-pois'],
      ['mouseleave', 'turn-poi-coverage-pois'],
      ['mouseenter', 'turn-poi-coverage-origin'],
      ['mouseleave', 'turn-poi-coverage-origin'],
    ]);
    expect(listenerCount()).toBe(33);

    dispose();
    expect(map.off.mock.calls).toEqual(map.on.mock.calls);
    expect(listenerCount()).toBe(0);
  });

  it('selects POIs and preserves candidate popup evidence', () => {
    const { map, emit } = mapDouble();
    const callbacks = callbackDouble();
    bindDashboardMapEvents(map as never, callbacks);
    const poi = point({ name: 'Cafe' });

    emit('click', 'pois', mapEvent(poi));
    expect(callbacks.onPoiSelected).toHaveBeenCalledWith(poi);
    expect(callbacks.openPoiPopup).toHaveBeenCalledWith([77.2, 28.6], { name: 'Cafe' });

    const stopPropagation = vi.fn();
    emit('click', 'candidate-analysis-pois', mapEvent(point({
      name: 'Candidate',
      status: 'SELECTED',
      association_augmented: true,
      reason: 'best match',
    }), stopPropagation));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(callbacks.openPoiPopup).toHaveBeenLastCalledWith(
      [77.2, 28.6],
      expect.objectContaining({
        name: 'Candidate',
        status: 'SELECTED',
        association_augmented: true,
        reason: 'best match',
      }),
    );
  });

  it('preserves route-narration and maneuver selection behavior', () => {
    vi.useFakeTimers();
    const { map, emit } = mapDouble();
    const callbacks = callbackDouble();
    bindDashboardMapEvents(map as never, callbacks);
    const narrationPoi = point({ name: 'Clock Tower', _primary_maneuver_index: 4, _route_landmark_key: 'clock-tower' });

    emit('click', 'route-narration-pois', mapEvent(narrationPoi));
    expect(callbacks.onRouteNarrationPoiSelected).toHaveBeenCalledWith(narrationPoi, 'valhalla', 4, 'clock-tower');
    expect(callbacks.onPoiSelected).not.toHaveBeenCalled();
    expect(callbacks.openPoiPopup).not.toHaveBeenCalled();
    expect(callbacks.closeActivePoiPopup).toHaveBeenCalledOnce();
    expect(map.flyTo).toHaveBeenCalledWith({ center: [77.2, 28.6], zoom: 17, essential: true });
    vi.advanceTimersByTime(80);
    expect(callbacks.onManeuverScrollRequested).toHaveBeenCalledWith(4);

    emit('click', 'maneuver-points', mapEvent(point({ index: 7 }, [78, 29])));
    expect(callbacks.onManeuverSelected).toHaveBeenCalledWith(7);
    expect(callbacks.closeActivePoiPopup).toHaveBeenCalledTimes(2);
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [78, 29], zoom: 17, essential: true });

    emit('click', 'osrm-pass-by-events', mapEvent(point({ event_key: 'pass-by:0:0' }, [79, 30])));
    expect(callbacks.onPassBySelected).toHaveBeenCalledWith('pass-by:0:0');
    expect(callbacks.openPoiPopup).not.toHaveBeenCalled();
    expect(callbacks.closeActivePoiPopup).toHaveBeenCalledTimes(3);
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [79, 30], zoom: 17, essential: true });

    const highlightedRoutePoi = point({ _primary_osrm_step_index: 37, _route_landmark_key: 'bank-1' });
    emit('click', 'selected-poi', mapEvent(highlightedRoutePoi));
    expect(callbacks.onRouteNarrationPoiSelected).toHaveBeenLastCalledWith(highlightedRoutePoi, 'osrm', 37, 'bank-1');
    expect(callbacks.openPoiPopup).not.toHaveBeenCalled();
    expect(callbacks.closeActivePoiPopup).toHaveBeenCalledTimes(4);
  });

  it('expands clusters and preserves hover cursor behavior', async () => {
    const { map, canvas, emit } = mapDouble();
    const callbacks = callbackDouble();
    const dispose = bindDashboardMapEvents(map as never, callbacks);
    const stopPropagation = vi.fn();

    const aggregate = point({ cluster_ref: 'ref', source_record_count: 12, bounds: '[77,28,78,29]' });
    emit('click', 'poi-clusters', mapEvent(aggregate, stopPropagation));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(callbacks.onAggregateSelected).toHaveBeenCalledWith(aggregate);
    expect(map.fitBounds).toHaveBeenCalledWith([[77, 28], [78, 29]], expect.objectContaining({ maxZoom: 14 }));

    emit('mouseenter', 'pois', {});
    expect(canvas.style.cursor).toBe('pointer');
    emit('mouseleave', 'pois', {});
    expect(canvas.style.cursor).toBe('');
    emit('mouseenter', 'pois', {});
    dispose();
    expect(canvas.style.cursor).toBe('');
  });

  it('cancels pending work and does not accumulate listeners when rebound', async () => {
    vi.useFakeTimers();
    const { map, emit, listenerCount } = mapDouble();
    const callbacks = callbackDouble();
    const firstDispose = bindDashboardMapEvents(map as never, callbacks);

    emit('click', 'route-narration-pois', mapEvent(point({ _primary_maneuver_index: 2 })));
    emit('click', 'poi-clusters', mapEvent(point({ cluster_ref: 'ref', source_record_count: 9, bounds: '[77,28,78,29]' })));
    firstDispose();
    firstDispose();
    vi.runAllTimers();

    expect(callbacks.onManeuverScrollRequested).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);

    const secondDispose = bindDashboardMapEvents(map as never, callbacks);
    expect(listenerCount()).toBe(33);
    secondDispose();
    expect(listenerCount()).toBe(0);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
