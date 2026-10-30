import type { FeatureCollection, Point } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDashboardMapLayers, TURN_COVERAGE_POI_HALO_LAYER_ID } from './dashboardMapLayers';
import { TurnCoveragePoiHalo } from './TurnCoveragePoiHalo';

afterEach(() => {
  vi.unstubAllGlobals();
});

function registrationRecorder() {
  const sources: Array<[string, Record<string, unknown>]> = [];
  const layers: Array<Record<string, unknown>> = [];
  const map = {
    getStyle: vi.fn(() => ({ layers: [] })),
    addSource: vi.fn((id: string, source: Record<string, unknown>) => {
      sources.push([id, source]);
    }),
    addLayer: vi.fn((layer: Record<string, unknown>) => {
      layers.push(layer);
    }),
  };
  return { map, sources, layers };
}

const initialPois: FeatureCollection<Point> = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [77.2, 28.6] },
    properties: { name: 'Initial POI' },
  }],
};

describe('registerDashboardMapLayers', () => {
  it('registers every dashboard source in the established order', () => {
    const { map, sources } = registrationRecorder();

    registerDashboardMapLayers(map as never, { initialPois });

    expect(sources.map(([id]) => id)).toEqual([
      'poi-density',
      'osrm-route',
      'route',
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
      'turn-poi-coverage',
      'turn-poi-coverage-pois',
    ]);

    const poiSource = sources.find(([id]) => id === 'pois')?.[1];
    expect(poiSource).toEqual({ type: 'geojson', data: initialPois });
    expect(poiSource).not.toHaveProperty('cluster');
    expect(poiSource?.data).toBe(initialPois);
  });

  it('preserves layer order and source references', () => {
    const { map, sources, layers } = registrationRecorder();

    registerDashboardMapLayers(map as never, { initialPois });

    expect(layers.map(({ id, source }) => [id, source])).toEqual([
      ['poi-density-heatmap', 'poi-density'],
      ['osrm-route', 'osrm-route'],
      ['route', 'route'],
      ['poi-clusters', 'poi-aggregates'],
      ['poi-cluster-count', 'poi-aggregates'],
      ['pois', 'pois'],
      ['selected-poi', 'selected-poi'],
      ['poi-turn-inspection-line', 'poi-turn-inspection'],
      ['poi-turn-inspection-turn', 'poi-turn-inspection'],
      ['candidate-analysis-lines', 'candidate-analysis-map'],
      ['candidate-analysis-pois', 'candidate-analysis-map'],
      ['candidate-analysis-selected-ring', 'candidate-analysis-map'],
      ['candidate-analysis-origin', 'candidate-analysis-map'],
      ['nearby-pois', 'nearby-pois'],
      ['route-narration-pois-halo', 'route-narration-pois'],
      ['route-narration-pois', 'route-narration-pois'],
      ['narration-poi', 'narration-poi'],
      ['route-points', 'route-points'],
      ['maneuver-points', 'maneuver-points'],
      ['osrm-selected-maneuver', 'osrm-selected-maneuver'],
      ['osrm-pass-by-events', 'osrm-pass-by-events'],
      ['turn-poi-coverage-footprint', 'turn-poi-coverage'],
      ['turn-poi-coverage-rim', 'turn-poi-coverage'],
      ['turn-poi-coverage-origin', 'turn-poi-coverage'],
      [TURN_COVERAGE_POI_HALO_LAYER_ID, 'turn-poi-coverage-pois'],
      ['turn-poi-coverage-pois', 'turn-poi-coverage-pois'],
    ]);

    const sourceIds = new Set(sources.map(([id]) => id));
    expect(layers.every((layer) => sourceIds.has(String(layer.source)))).toBe(true);
    expect(layers[1]).toMatchObject({ paint: { 'line-width': 10, 'line-color': '#dc2626' } });
    expect(layers[2]).toMatchObject({ paint: { 'line-width': 5, 'line-color': '#2563eb' } });

    const haloIndex = layers.findIndex((layer) => layer.id === TURN_COVERAGE_POI_HALO_LAYER_ID);
    const markerIndex = layers.findIndex((layer) => layer.id === 'turn-poi-coverage-pois');
    expect(haloIndex).toBeLessThan(markerIndex);
    expect(layers[haloIndex]).toMatchObject({
      type: 'circle',
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['match', ['get', 'coverage_region'], 'opposite', '#f59e0b', '#06b6d4'],
      },
    });
  });
});

describe('TurnCoveragePoiHalo', () => {
  function animationDouble(reducedMotion = false) {
    let nextFrame: FrameRequestCallback | null = null;
    const motionListeners = new Set<() => void>();
    const mediaQuery = {
      matches: reducedMotion,
      addEventListener: vi.fn((_type: string, listener: () => void) => motionListeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: () => void) => motionListeners.delete(listener)),
    };
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 7;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => mediaQuery),
      requestAnimationFrame,
      cancelAnimationFrame,
    });
    return {
      mediaQuery,
      requestAnimationFrame,
      cancelAnimationFrame,
      runFrame(timestamp: number) {
        const callback = nextFrame;
        nextFrame = null;
        callback?.(timestamp);
      },
    };
  }

  it('animates paint only while eligible coverage POIs and style resources exist', () => {
    const animation = animationDouble();
    let styleAvailable = true;
    const map = {
      getSource: vi.fn(() => styleAvailable ? {} : undefined),
      getLayer: vi.fn(() => styleAvailable ? {} : undefined),
      setPaintProperty: vi.fn(),
    };
    const halo = new TurnCoveragePoiHalo(map as never);

    halo.setEligiblePoiCount(2);
    expect(animation.requestAnimationFrame).toHaveBeenCalledOnce();
    animation.runFrame(900);
    expect(map.setPaintProperty).toHaveBeenNthCalledWith(1, TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-radius', 15.5);
    expect(map.setPaintProperty).toHaveBeenNthCalledWith(2, TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-stroke-opacity', expect.any(Number));
    expect(animation.requestAnimationFrame).toHaveBeenCalledTimes(2);

    styleAvailable = false;
    animation.runFrame(1000);
    expect(animation.requestAnimationFrame).toHaveBeenCalledTimes(2);

    styleAvailable = true;
    halo.syncStyle();
    expect(animation.requestAnimationFrame).toHaveBeenCalledTimes(3);
    halo.setEligiblePoiCount(0);
    expect(animation.cancelAnimationFrame).toHaveBeenCalledWith(7);

    halo.dispose();
    expect(animation.mediaQuery.removeEventListener).toHaveBeenCalledOnce();
  });

  it('uses a static ring and no animation when reduced motion is requested', () => {
    const animation = animationDouble(true);
    const map = {
      getSource: vi.fn(() => ({})),
      getLayer: vi.fn(() => ({})),
      setPaintProperty: vi.fn(),
    };
    const halo = new TurnCoveragePoiHalo(map as never);

    halo.setEligiblePoiCount(1);

    expect(animation.requestAnimationFrame).not.toHaveBeenCalled();
    expect(map.setPaintProperty).toHaveBeenNthCalledWith(1, TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-radius', 13);
    expect(map.setPaintProperty).toHaveBeenNthCalledWith(2, TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-stroke-opacity', 0.62);
    halo.dispose();
  });
});
