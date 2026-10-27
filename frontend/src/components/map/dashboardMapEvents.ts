import type { Feature, GeoJsonProperties, Point } from 'geojson';
import type maplibregl from 'maplibre-gl';
import type { LngLat } from '../../types';
import {
  expandServerAggregate,
  INDIVIDUAL_POI_LAYER_ID,
  POI_CLUSTER_LAYER_ID,
} from './poiMap';

export interface DashboardMapEventCallbacks {
  onAggregateSelected: (feature: Feature<Point>) => void;
  onPoiSelected: (feature: Feature<Point>) => void;
  onRouteNarrationManeuverSelected: (maneuverIndex: number) => void;
  onManeuverScrollRequested: (maneuverIndex: number) => void;
  onManeuverSelected: (maneuverIndex: number) => void;
  openPoiPopup: (
    coordinate: LngLat,
    properties: GeoJsonProperties,
  ) => void;
  closeActivePoiPopup: () => void;
}

type DashboardLayerEventType = 'click' | 'mouseenter' | 'mouseleave';
type DashboardLayerEventHandler = (event: maplibregl.MapLayerMouseEvent) => void;

const INTERACTIVE_LAYER_IDS = [
  POI_CLUSTER_LAYER_ID,
  INDIVIDUAL_POI_LAYER_ID,
  'selected-poi',
  'nearby-pois',
  'route-narration-pois',
  'narration-poi',
  'maneuver-points',
  'candidate-analysis-pois',
];

export function bindDashboardMapEvents(
  map: maplibregl.Map,
  callbacks: DashboardMapEventCallbacks,
): () => void {
  let disposed = false;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const listeners: Array<{
    type: DashboardLayerEventType;
    layerId: string;
    handler: DashboardLayerEventHandler;
  }> = [];

  const bind = (
    type: DashboardLayerEventType,
    layerId: string,
    handler: DashboardLayerEventHandler,
  ) => {
    const stableHandler: DashboardLayerEventHandler = (event) => {
      if (!disposed) handler(event);
    };
    map.on(type, layerId, stableHandler);
    listeners.push({ type, layerId, handler: stableHandler });
  };

  const showPoiPopup: DashboardLayerEventHandler = (event) => {
    const rawFeature = event.features?.[0];
    if (!rawFeature || rawFeature.geometry.type !== 'Point') return;
    const feature = rawFeature as Feature<Point>;
    const coordinates = feature.geometry.coordinates.slice() as LngLat;
    callbacks.onPoiSelected(feature);
    callbacks.openPoiPopup(coordinates, feature.properties ?? {});
  };

  const expandCluster: DashboardLayerEventHandler = (event) => {
    event.originalEvent.stopPropagation();
    const feature = event.features?.[0] as Feature | undefined;
    if (feature) {
      if (feature.geometry.type === 'Point') callbacks.onAggregateSelected(feature as Feature<Point>);
      expandServerAggregate(map, feature);
    }
  };

  const showRouteNarrationPoi: DashboardLayerEventHandler = (event) => {
    const rawFeature = event.features?.[0];
    if (!rawFeature || rawFeature.geometry.type !== 'Point') return;

    const feature = rawFeature as Feature<Point>;
    const coordinates = feature.geometry.coordinates.slice() as LngLat;
    const maneuverIndex = Number(feature.properties?._primary_maneuver_index);
    if (Number.isFinite(maneuverIndex)) {
      callbacks.onRouteNarrationManeuverSelected(maneuverIndex);
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!disposed) callbacks.onManeuverScrollRequested(maneuverIndex);
      }, 80);
      pendingTimers.add(timer);
    }

    callbacks.onPoiSelected(feature);
    map.flyTo({
      center: coordinates,
      zoom: Math.max(map.getZoom(), 17),
      essential: true,
    });
    callbacks.openPoiPopup(coordinates, feature.properties ?? {});
  };

  const showCandidatePopup: DashboardLayerEventHandler = (event) => {
    event.originalEvent.stopPropagation();

    const feature = event.features?.[0];
    if (!feature || feature.geometry?.type !== 'Point') return;

    const coordinate = feature.geometry.coordinates as LngLat;
    const properties = feature.properties ?? {};
    callbacks.openPoiPopup(coordinate, {
      name: properties.name ?? 'Candidate POI',
      poi_id: properties.poi_id ?? '',
      status: properties.status ?? '',
      selected: properties.selected ?? false,
      engine: properties.engine ?? '',
      route_edge_role: properties.route_edge_role ?? '',
      association_confidence: properties.association_confidence ?? '',
      association_augmented: properties.association_augmented ?? '',
      incoming_association_augmented: properties.incoming_association_augmented ?? '',
      outgoing_association_augmented: properties.outgoing_association_augmented ?? '',
      maneuver_distance_m: properties.maneuver_distance_m ?? '',
      perpendicular_distance_m: properties.perpendicular_distance_m ?? '',
      distance_m: properties.distance_m ?? '',
      priority: properties.priority ?? '',
      reason: properties.reason ?? '',
    });
  };

  const selectManeuver: DashboardLayerEventHandler = (event) => {
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== 'Point') return;
    const maneuverIndex = Number(feature.properties?.index);
    const coordinates = feature.geometry.coordinates.slice() as LngLat;
    if (Number.isFinite(maneuverIndex)) {
      callbacks.onManeuverSelected(maneuverIndex);
    }
    callbacks.closeActivePoiPopup();
    map.flyTo({
      center: coordinates,
      zoom: Math.max(map.getZoom(), 17),
      essential: true,
    });
  };

  bind('click', POI_CLUSTER_LAYER_ID, expandCluster);
  bind('click', INDIVIDUAL_POI_LAYER_ID, showPoiPopup);
  bind('click', 'selected-poi', showPoiPopup);
  bind('click', 'nearby-pois', showPoiPopup);
  bind('click', 'narration-poi', showPoiPopup);
  bind('click', 'route-narration-pois', showRouteNarrationPoi);
  bind('click', 'candidate-analysis-pois', showCandidatePopup);
  bind('click', 'maneuver-points', selectManeuver);

  for (const layerId of INTERACTIVE_LAYER_IDS) {
    bind('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    bind('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const { type, layerId, handler } of listeners) {
      map.off(type, layerId, handler);
    }
    map.getCanvas().style.cursor = '';
  };
}
