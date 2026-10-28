import type { FeatureCollection } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardMapSourceManager,
  DASHBOARD_GEOJSON_SOURCE_IDS,
} from './dashboardMapSources';

function collection(name: string): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [77, 28] },
      properties: { name },
    }],
  };
}

function mapDouble() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const idleListeners = new Set<() => void>();
  const map = {
    getSource: vi.fn((sourceId: string) => sources.get(sourceId)),
    on: vi.fn((type: string, listener: () => void) => {
      if (type === 'idle') idleListeners.add(listener);
    }),
    off: vi.fn((type: string, listener: () => void) => {
      if (type === 'idle') idleListeners.delete(listener);
    }),
  };
  return {
    map,
    sources,
    idleListeners,
    addSource(sourceId: string) {
      const source = { setData: vi.fn() };
      sources.set(sourceId, source);
      return source;
    },
    emitIdle() {
      for (const listener of [...idleListeners]) listener();
    },
  };
}

describe('createDashboardMapSourceManager', () => {
  it('updates an available source immediately without an idle listener', () => {
    const { map, addSource, idleListeners } = mapDouble();
    const source = addSource('route');
    const manager = createDashboardMapSourceManager(map as never);
    const data = collection('current');

    manager.update('route', data);

    expect(source.setData).toHaveBeenCalledOnce();
    expect(source.setData).toHaveBeenCalledWith(data);
    expect(idleListeners.size).toBe(0);
  });

  it('queues unavailable sources and applies only the newest pending data', () => {
    const { map, addSource, emitIdle, idleListeners } = mapDouble();
    const manager = createDashboardMapSourceManager(map as never);
    const stale = collection('stale');
    const newest = collection('newest');

    manager.update('route', stale);
    manager.update('route', newest);
    expect(idleListeners.size).toBe(1);
    expect(map.on).toHaveBeenCalledTimes(1);

    const source = addSource('route');
    emitIdle();

    expect(source.setData).toHaveBeenCalledOnce();
    expect(source.setData).toHaveBeenCalledWith(newest);
    expect(idleListeners.size).toBe(0);
  });

  it('keeps one listener while multiple sources wait for registration', () => {
    const { map, addSource, emitIdle, idleListeners } = mapDouble();
    const manager = createDashboardMapSourceManager(map as never);

    manager.update('route', collection('route'));
    manager.update('selected-poi', collection('selected'));
    manager.update('pois', collection('pois'));

    expect(map.on).toHaveBeenCalledTimes(1);
    expect(idleListeners.size).toBe(1);
    const route = addSource('route');
    emitIdle();
    expect(route.setData).toHaveBeenCalledOnce();
    expect(idleListeners.size).toBe(1);

    addSource('selected-poi');
    addSource('pois');
    emitIdle();
    expect(idleListeners.size).toBe(0);
  });

  it('removes pending work and ignores updates after disposal', () => {
    const { map, addSource, emitIdle, idleListeners } = mapDouble();
    const manager = createDashboardMapSourceManager(map as never);
    manager.update('route', collection('pending'));

    manager.dispose();
    manager.dispose();
    const source = addSource('route');
    emitIdle();
    manager.update('route', collection('after disposal'));

    expect(source.setData).not.toHaveBeenCalled();
    expect(idleListeners.size).toBe(0);
    expect(map.off).toHaveBeenCalledOnce();
  });

  it('does not let a disposed manager update a replacement map', () => {
    const oldMap = mapDouble();
    const newMap = mapDouble();
    const oldManager = createDashboardMapSourceManager(oldMap.map as never);
    const newManager = createDashboardMapSourceManager(newMap.map as never);
    oldManager.update('route', collection('old'));
    oldManager.dispose();

    const newSource = newMap.addSource('route');
    newManager.update('route', collection('new'));
    oldMap.emitIdle();

    expect(newSource.setData).toHaveBeenCalledOnce();
    expect(newSource.setData.mock.calls[0][0]).toEqual(collection('new'));
  });

  it('keeps the complete dashboard source ID contract explicit', () => {
    expect(DASHBOARD_GEOJSON_SOURCE_IDS).toEqual([
      'route',
      'osrm-route',
      'poi-density',
      'poi-aggregates',
      'pois',
      'selected-poi',
      'poi-turn-inspection',
      'candidate-analysis-map',
      'nearby-pois',
      'route-narration-pois',
      'narration-poi',
      'route-points',
      'maneuver-points',
      'osrm-selected-maneuver',
      'osrm-pass-by-events',
    ]);
  });
});
