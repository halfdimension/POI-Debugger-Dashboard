import type maplibregl from 'maplibre-gl';

export const DASHBOARD_BUILDING_LAYER_ID = 'dashboard-buildings-3d';
export const OPENMAPTILES_SOURCE_ID = 'openmaptiles';
export const OPENMAPTILES_BUILDING_SOURCE_LAYER = 'building';

export type BuildingBasemap = 'openfreemap' | 'mapmyindia';

export interface BuildingLayerStatus {
  ready: boolean;
  sourceAvailable: boolean;
  effective: boolean;
  mode: 'off' | 'provider' | 'dashboard' | 'unavailable';
}

export interface BuildingLayerManager {
  setEnabled(enabled: boolean): void;
  setBasemap(basemap: BuildingBasemap): void;
  refresh(): void;
  dispose(): void;
}

interface BuildingLayerManagerOptions {
  enabled: boolean;
  basemap: BuildingBasemap;
  onStatusChange?: (status: BuildingLayerStatus) => void;
}

const DASHBOARD_OVERLAY_LAYER_IDS = [
  'poi-density-heatmap',
  'osrm-route',
  'route',
  'selected-poi',
] as const;

function sourceIsAvailable(map: maplibregl.Map): boolean {
  const source = map.getStyle().sources?.[OPENMAPTILES_SOURCE_ID];
  return source?.type === 'vector' && Boolean(map.getSource(OPENMAPTILES_SOURCE_ID));
}

function hasInitializedStyle(map: maplibregl.Map): boolean {
  try {
    const style = map.getStyle();
    if (!style || !style.sources || !Array.isArray(style.layers)) return false;
    return Object.keys(style.sources).some((sourceId) => Boolean(map.getSource(sourceId))) ||
      style.layers.some((layer) => Boolean(map.getLayer(layer.id)));
  } catch {
    return false;
  }
}

function providerExtrusions(map: maplibregl.Map) {
  return (map.getStyle().layers ?? []).filter((candidate) =>
    candidate.id !== DASHBOARD_BUILDING_LAYER_ID &&
    candidate.type === 'fill-extrusion' &&
    candidate.source === OPENMAPTILES_SOURCE_ID &&
    candidate['source-layer'] === OPENMAPTILES_BUILDING_SOURCE_LAYER);
}

function firstDashboardOverlay(map: maplibregl.Map): string | undefined {
  return DASHBOARD_OVERLAY_LAYER_IDS.find((layerId) => Boolean(map.getLayer(layerId)));
}

function statusEquals(left: BuildingLayerStatus | null, right: BuildingLayerStatus): boolean {
  return left?.ready === right.ready &&
    left.sourceAvailable === right.sourceAvailable &&
    left.effective === right.effective &&
    left.mode === right.mode;
}

export function createBuildingLayerManager(
  map: maplibregl.Map,
  options: BuildingLayerManagerOptions,
): BuildingLayerManager {
  let enabled = options.enabled;
  let basemap = options.basemap;
  let disposed = false;
  let lastStatus: BuildingLayerStatus | null = null;
  let providerState = new Map<string, {
    visibility: 'visible' | 'none';
    beforeId?: string;
    index: number;
  }>();

  const publish = (status: BuildingLayerStatus) => {
    if (disposed || statusEquals(lastStatus, status)) return;
    lastStatus = status;
    options.onStatusChange?.(status);
  };

  const removeDashboardLayer = () => {
    if (map.getLayer(DASHBOARD_BUILDING_LAYER_ID)) {
      map.removeLayer(DASHBOARD_BUILDING_LAYER_ID);
    }
  };

  const captureProviderState = () => {
    const layers = map.getStyle().layers ?? [];
    for (const layer of providerExtrusions(map)) {
      if (providerState.has(layer.id)) continue;
      const index = layers.findIndex((candidate) => candidate.id === layer.id);
      providerState.set(layer.id, {
        visibility: layer.layout?.visibility === 'none' ? 'none' : 'visible',
        beforeId: index >= 0 ? layers[index + 1]?.id : undefined,
        index,
      });
    }
  };

  const setProviderVisibility = (layerId: string, visibility: 'visible' | 'none') => {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visibility);
  };

  const restoreProviderState = () => {
    const states = [...providerState.entries()];
    for (const [layerId, state] of states) {
      setProviderVisibility(layerId, state.visibility);
    }
    for (const [layerId, state] of states.sort((left, right) => right[1].index - left[1].index)) {
      if (!map.getLayer(layerId)) continue;
      const beforeId = state.beforeId && map.getLayer(state.beforeId) ? state.beforeId : undefined;
      map.moveLayer(layerId, beforeId);
    }
    providerState.clear();
  };

  const sync = () => {
    if (disposed) return;
    if (!hasInitializedStyle(map)) {
      publish({ ready: false, sourceAvailable: false, effective: false, mode: enabled ? 'unavailable' : 'off' });
      return;
    }

    const available = sourceIsAvailable(map);
    captureProviderState();
    const providerLayers = providerExtrusions(map);
    if (!enabled) {
      removeDashboardLayer();
      for (const layer of providerLayers) setProviderVisibility(layer.id, 'none');
      publish({ ready: true, sourceAvailable: available, effective: false, mode: 'off' });
      return;
    }

    if (!available) {
      removeDashboardLayer();
      for (const layer of providerLayers) setProviderVisibility(layer.id, 'none');
      publish({ ready: true, sourceAvailable: false, effective: false, mode: 'unavailable' });
      return;
    }

    const providerLayer = providerLayers
      .map((layer) => ({ layer, state: providerState.get(layer.id) }))
      .sort((left, right) => {
        const visibilityDifference = Number(right.state?.visibility === 'visible') -
          Number(left.state?.visibility === 'visible');
        return visibilityDifference || (left.state?.index ?? 0) - (right.state?.index ?? 0);
      })[0]?.layer;
    if (providerLayer) {
      removeDashboardLayer();
      for (const layer of providerLayers) {
        setProviderVisibility(layer.id, layer.id === providerLayer.id ? 'visible' : 'none');
      }
      const beforeId = firstDashboardOverlay(map);
      if (beforeId) map.moveLayer(providerLayer.id, beforeId);
      publish({ ready: true, sourceAvailable: true, effective: true, mode: 'provider' });
      return;
    }

    const beforeId = firstDashboardOverlay(map);
    if (!map.getLayer(DASHBOARD_BUILDING_LAYER_ID)) {
      map.addLayer({
        id: DASHBOARD_BUILDING_LAYER_ID,
        type: 'fill-extrusion',
        source: OPENMAPTILES_SOURCE_ID,
        'source-layer': OPENMAPTILES_BUILDING_SOURCE_LAYER,
        minzoom: 14,
        paint: {
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-color': 'hsl(35, 8%, 85%)',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
          'fill-extrusion-opacity': 0.8,
        },
      }, beforeId);
    } else if (beforeId) {
      // Mappls can finish installing after this layer. Moving it back to the
      // overlay anchor keeps the final order raster -> buildings -> overlays.
      map.moveLayer(DASHBOARD_BUILDING_LAYER_ID, beforeId);
    }

    publish({
      ready: true,
      sourceAvailable: true,
      effective: Boolean(map.getLayer(DASHBOARD_BUILDING_LAYER_ID)),
      mode: map.getLayer(DASHBOARD_BUILDING_LAYER_ID) ? 'dashboard' : 'unavailable',
    });
  };

  const handleStyleLoad = () => {
    // A new style has already restored provider-owned ordering by definition.
    providerState = new Map();
    sync();
  };
  map.on('style.load', handleStyleLoad);
  sync();

  return {
    setEnabled(nextEnabled) {
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      sync();
    },
    setBasemap(nextBasemap) {
      if (basemap === nextBasemap) return;
      basemap = nextBasemap;
      sync();
    },
    refresh: sync,
    dispose() {
      if (disposed) return;
      map.off('style.load', handleStyleLoad);
      removeDashboardLayer();
      restoreProviderState();
      disposed = true;
    },
  };
}
