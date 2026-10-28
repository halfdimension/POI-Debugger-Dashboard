import type { FeatureCollection, Point } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import { registerDashboardMapLayers } from './dashboardMapLayers';

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
      ['turn-poi-coverage-pois', 'turn-poi-coverage-pois'],
    ]);

    const sourceIds = new Set(sources.map(([id]) => id));
    expect(layers.every((layer) => sourceIds.has(String(layer.source)))).toBe(true);
    expect(layers[1]).toMatchObject({ paint: { 'line-width': 10, 'line-color': '#dc2626' } });
    expect(layers[2]).toMatchObject({ paint: { 'line-width': 5, 'line-color': '#2563eb' } });
  });
});
