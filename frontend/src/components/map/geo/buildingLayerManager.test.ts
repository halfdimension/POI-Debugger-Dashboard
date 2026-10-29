import type maplibregl from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  createBuildingLayerManager,
  DASHBOARD_BUILDING_LAYER_ID,
  type BuildingLayerStatus,
} from './buildingLayerManager';

type TestLayer = {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  layout?: { visibility?: 'visible' | 'none' };
};

class MapStub {
  loaded = true;
  sources: Record<string, { type: string }> = { openmaptiles: { type: 'vector' } };
  layers: TestLayer[];
  listeners = new Map<string, Set<() => void>>();
  addLayer = vi.fn((layer: TestLayer, beforeId?: string) => {
    const index = beforeId ? this.layers.findIndex((candidate) => candidate.id === beforeId) : -1;
    if (index < 0) this.layers.push(layer);
    else this.layers.splice(index, 0, layer);
  });
  removeLayer = vi.fn((id: string) => {
    this.layers = this.layers.filter((layer) => layer.id !== id);
  });
  moveLayer = vi.fn((id: string, beforeId?: string) => {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (!layer) return;
    this.layers = this.layers.filter((candidate) => candidate.id !== id);
    const index = beforeId ? this.layers.findIndex((candidate) => candidate.id === beforeId) : -1;
    if (index < 0) this.layers.push(layer);
    else this.layers.splice(index, 0, layer);
  });

  constructor(layers: TestLayer[] = []) {
    this.layers = layers;
  }

  isStyleLoaded() { return this.loaded; }
  getStyle() { return { version: 8, sources: this.sources, layers: this.layers }; }
  getSource(id: string) { return this.sources[id]; }
  getLayer(id: string) { return this.layers.find((layer) => layer.id === id); }
  on(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: () => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(); }
}

function providerBuilding(visibility?: 'visible' | 'none'): TestLayer {
  return {
    id: 'building-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    ...(visibility ? { layout: { visibility } } : {}),
  };
}

function asMap(map: MapStub): maplibregl.Map {
  return map as unknown as maplibregl.Map;
}

describe('buildingLayerManager', () => {
  it('detects vector building availability while OFF without changing provider layers', () => {
    const map = new MapStub([providerBuilding(), { id: 'poi-density-heatmap', type: 'heatmap' }]);
    const statuses: BuildingLayerStatus[] = [];

    createBuildingLayerManager(asMap(map), {
      enabled: false,
      basemap: 'openfreemap',
      onStatusChange: (status) => statuses.push(status),
    });

    expect(statuses.at(-1)).toEqual({ ready: true, sourceAvailable: true, effective: false, mode: 'off' });
    expect(map.getLayer('building-3d')).toBeTruthy();
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it('reports an unavailable style without adding a layer or resetting the request', () => {
    const map = new MapStub([{ id: 'route', type: 'line' }]);
    map.sources = {};
    const statuses: BuildingLayerStatus[] = [];

    createBuildingLayerManager(asMap(map), {
      enabled: true,
      basemap: 'mapmyindia',
      onStatusChange: (status) => statuses.push(status),
    });

    expect(statuses.at(-1)).toEqual({ ready: true, sourceAvailable: false, effective: false, mode: 'unavailable' });
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it('synchronizes against an initialized style while source tiles are still loading', () => {
    const map = new MapStub([providerBuilding(), { id: 'route', type: 'line' }]);
    map.loaded = false;
    const statuses: BuildingLayerStatus[] = [];
    const manager = createBuildingLayerManager(asMap(map), {
      enabled: false,
      basemap: 'mapmyindia',
      onStatusChange: (status) => statuses.push(status),
    });

    manager.setEnabled(true);

    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeTruthy();
    expect(statuses.at(-1)).toEqual({ ready: true, sourceAvailable: true, effective: true, mode: 'dashboard' });
  });

  it('applies a preference enabled before initialization when style.load arrives', () => {
    const map = new MapStub();
    map.sources = {};
    const statuses: BuildingLayerStatus[] = [];
    createBuildingLayerManager(asMap(map), {
      enabled: true,
      basemap: 'openfreemap',
      onStatusChange: (status) => statuses.push(status),
    });
    expect(statuses.at(-1)?.ready).toBe(false);

    map.sources = { openmaptiles: { type: 'vector' } };
    map.layers = [providerBuilding(), { id: 'route', type: 'line' }];
    map.emit('style.load');

    expect(statuses.at(-1)).toEqual({ ready: true, sourceAvailable: true, effective: true, mode: 'provider' });
  });

  it('reuses a visible OpenFreeMap provider extrusion and replaces a hidden one with the dashboard layer', () => {
    const visibleMap = new MapStub([providerBuilding(), { id: 'route', type: 'line' }]);
    const visibleStatuses: BuildingLayerStatus[] = [];
    createBuildingLayerManager(asMap(visibleMap), {
      enabled: true,
      basemap: 'openfreemap',
      onStatusChange: (status) => visibleStatuses.push(status),
    });
    expect(visibleStatuses.at(-1)?.mode).toBe('provider');
    expect(visibleMap.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();

    const hiddenMap = new MapStub([providerBuilding('none'), { id: 'route', type: 'line' }]);
    createBuildingLayerManager(asMap(hiddenMap), { enabled: true, basemap: 'openfreemap' });
    expect(hiddenMap.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeTruthy();
    expect(hiddenMap.getLayer('building-3d')?.layout?.visibility).toBe('none');
  });

  it('adds one Mappls extrusion above the raster and below dashboard overlays across repeated toggles', () => {
    const map = new MapStub([
      providerBuilding(),
      { id: 'mapmyindia-raster', type: 'raster' },
      { id: 'poi-density-heatmap', type: 'heatmap' },
      { id: 'route', type: 'line' },
    ]);
    const manager = createBuildingLayerManager(asMap(map), { enabled: true, basemap: 'mapmyindia' });

    manager.refresh();
    manager.refresh();
    expect(map.layers.filter((layer) => layer.id === DASHBOARD_BUILDING_LAYER_ID)).toHaveLength(1);
    expect(map.layers.map((layer) => layer.id)).toEqual([
      'building-3d',
      'mapmyindia-raster',
      DASHBOARD_BUILDING_LAYER_ID,
      'poi-density-heatmap',
      'route',
    ]);

    manager.setEnabled(false);
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();
    expect(map.getLayer('building-3d')).toBeTruthy();
    manager.setEnabled(true);
    expect(map.layers.filter((layer) => layer.id === DASHBOARD_BUILDING_LAYER_ID)).toHaveLength(1);
  });

  it('switches between provider and dashboard rendering without duplicates', () => {
    const map = new MapStub([
      providerBuilding(),
      { id: 'mapmyindia-raster', type: 'raster' },
      { id: 'route', type: 'line' },
    ]);
    const manager = createBuildingLayerManager(asMap(map), { enabled: true, basemap: 'openfreemap' });
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();
    expect(map.layers.map((layer) => layer.id)).toEqual([
      'mapmyindia-raster',
      'building-3d',
      'route',
    ]);

    manager.setBasemap('mapmyindia');
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeTruthy();
    expect(map.layers[0]?.id).toBe('building-3d');
    manager.setBasemap('openfreemap');
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();
    expect(map.getLayer('building-3d')).toBeTruthy();
  });

  it('restores its layer after style load and removes its listener and owned layer on cleanup', () => {
    const map = new MapStub([{ id: 'mapmyindia-raster', type: 'raster' }, { id: 'route', type: 'line' }]);
    const manager = createBuildingLayerManager(asMap(map), { enabled: true, basemap: 'mapmyindia' });
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeTruthy();

    map.layers = [{ id: 'mapmyindia-raster', type: 'raster' }, { id: 'route', type: 'line' }];
    map.emit('style.load');
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeTruthy();

    manager.dispose();
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();
    map.emit('style.load');
    expect(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)).toBeUndefined();
  });
});
