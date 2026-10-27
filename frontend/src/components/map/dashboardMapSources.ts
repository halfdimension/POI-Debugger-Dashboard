import type { FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';

export const DASHBOARD_GEOJSON_SOURCE_IDS = [
  'route',
  'osrm-route',
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
] as const;

export type DashboardGeoJsonSourceId = typeof DASHBOARD_GEOJSON_SOURCE_IDS[number];

export interface DashboardMapSourceManager {
  update(sourceId: DashboardGeoJsonSourceId, data: FeatureCollection): void;
  flush(): void;
  dispose(): void;
}

export function createDashboardMapSourceManager(
  map: maplibregl.Map,
): DashboardMapSourceManager {
  const pending = new Map<DashboardGeoJsonSourceId, FeatureCollection>();
  let disposed = false;
  let listeningForIdle = false;

  const stopListening = () => {
    if (!listeningForIdle) return;
    map.off('idle', flush);
    listeningForIdle = false;
  };

  const ensureListening = () => {
    if (disposed || listeningForIdle || pending.size === 0) return;
    map.on('idle', flush);
    listeningForIdle = true;
  };

  function flush(): void {
    if (disposed) return;

    for (const [sourceId, data] of pending) {
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (!source) continue;
      source.setData(data);
      pending.delete(sourceId);
    }

    if (pending.size === 0) stopListening();
    else ensureListening();
  }

  return {
    update(sourceId, data) {
      if (disposed) return;
      pending.set(sourceId, data);
      flush();
      ensureListening();
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopListening();
      pending.clear();
    },
  };
}
