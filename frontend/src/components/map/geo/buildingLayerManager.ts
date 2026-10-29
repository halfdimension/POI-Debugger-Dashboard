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

function visibleProviderExtrusion(map: maplibregl.Map): string | null {
  const layer = map.getStyle().layers?.find((candidate) =>
    candidate.id !== DASHBOARD_BUILDING_LAYER_ID &&
    candidate.type === 'fill-extrusion' &&
    candidate.source === OPENMAPTILES_SOURCE_ID &&
    candidate['source-layer'] === OPENMAPTILES_BUILDING_SOURCE_LAYER &&
    candidate.layout?.visibility !== 'none');
  return layer?.id ?? null;
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
  let movedProviderLayer: { id: string; beforeId?: string } | null = null;

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

  const restoreProviderPlacement = () => {
    if (!movedProviderLayer || !map.getLayer(movedProviderLayer.id)) {
      movedProviderLayer = null;
      return;
    }
    const beforeId = movedProviderLayer.beforeId && map.getLayer(movedProviderLayer.beforeId)
      ? movedProviderLayer.beforeId
      : undefined;
    map.moveLayer(movedProviderLayer.id, beforeId);
    movedProviderLayer = null;
  };

  const sync = () => {
    if (disposed) return;
    if (!hasInitializedStyle(map)) {
      publish({ ready: false, sourceAvailable: false, effective: false, mode: enabled ? 'unavailable' : 'off' });
      return;
    }

    const available = sourceIsAvailable(map);
    if (!enabled) {
      restoreProviderPlacement();
      removeDashboardLayer();
      publish({ ready: true, sourceAvailable: available, effective: false, mode: 'off' });
      return;
    }

    if (!available) {
      restoreProviderPlacement();
      removeDashboardLayer();
      publish({ ready: true, sourceAvailable: false, effective: false, mode: 'unavailable' });
      return;
    }

    const providerLayer = visibleProviderExtrusion(map);
    if (basemap === 'openfreemap' && providerLayer) {
      removeDashboardLayer();
      const beforeId = firstDashboardOverlay(map);
      if (!movedProviderLayer) {
        const layers = map.getStyle().layers ?? [];
        const providerIndex = layers.findIndex((layer) => layer.id === providerLayer);
        movedProviderLayer = {
          id: providerLayer,
          beforeId: providerIndex >= 0 ? layers[providerIndex + 1]?.id : undefined,
        };
      }
      if (beforeId) map.moveLayer(providerLayer, beforeId);
      publish({ ready: true, sourceAvailable: true, effective: true, mode: 'provider' });
      return;
    }

    restoreProviderPlacement();
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
    movedProviderLayer = null;
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
      restoreProviderPlacement();
      removeDashboardLayer();
      disposed = true;
    },
  };
}
