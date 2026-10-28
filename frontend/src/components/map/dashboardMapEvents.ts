import type { Feature, GeoJsonProperties, Point } from 'geojson';
import type maplibregl from 'maplibre-gl';
import type { LngLat } from '../../types';
import {
  expandServerAggregate,
  INDIVIDUAL_POI_LAYER_ID,
  POI_AGGREGATE_SOURCE_ID,
  POI_CLUSTER_LAYER_ID,
} from './poiMap';

export interface DashboardMapEventCallbacks {
  onAggregateSelected: (feature: Feature<Point>) => void;
  onPoiSelected: (feature: Feature<Point>) => void;
  onRouteNarrationPoiSelected: (
    feature: Feature<Point>,
    engine: 'valhalla' | 'osrm',
    occurrenceIndex: number,
    landmarkKey: string,
  ) => void;
  onManeuverScrollRequested: (maneuverIndex: number) => void;
  onManeuverSelected: (maneuverIndex: number) => void;
  onPassBySelected: (key: string) => void;
  onTurnCoverageSelected?: (stepIndex: number) => void;
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
  'osrm-pass-by-events',
  'turn-poi-coverage-pois',
  'turn-poi-coverage-origin',
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
  let hoveredAggregateId: string | number | null = null;

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
    const passByKey = String(feature.properties?._selected_pass_by_key ?? '');
    const maneuverIndex = Number(feature.properties?._primary_maneuver_index);
    const osrmStepIndex = Number(feature.properties?._primary_osrm_step_index);
    const landmarkKey = String(feature.properties?._route_landmark_key ?? '');
    const turnCoverageKey = String(feature.properties?._turn_key ?? '');
    if (turnCoverageKey) {
      callbacks.onPoiSelected(feature);
      callbacks.closeActivePoiPopup();
      map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 18), essential: true });
      return;
    }
    if (passByKey) {
      callbacks.onPassBySelected(passByKey);
      callbacks.closeActivePoiPopup();
      map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      return;
    }
    if (Number.isFinite(maneuverIndex) || Number.isFinite(osrmStepIndex)) {
      callbacks.onRouteNarrationPoiSelected(
        feature,
        Number.isFinite(maneuverIndex) ? 'valhalla' : 'osrm',
        Number.isFinite(maneuverIndex) ? maneuverIndex : osrmStepIndex,
        landmarkKey,
      );
      callbacks.closeActivePoiPopup();
      map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      return;
    }
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
    const osrmStepIndex = Number(feature.properties?._primary_osrm_step_index);
    const landmarkKey = String(feature.properties?._route_landmark_key ?? '');
    if (Number.isFinite(maneuverIndex)) {
      callbacks.onRouteNarrationPoiSelected(feature, 'valhalla', maneuverIndex, landmarkKey);
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!disposed) callbacks.onManeuverScrollRequested(maneuverIndex);
      }, 80);
      pendingTimers.add(timer);
    } else if (Number.isFinite(osrmStepIndex)) {
      callbacks.onRouteNarrationPoiSelected(feature, 'osrm', osrmStepIndex, landmarkKey);
    }

    callbacks.closeActivePoiPopup();
    map.flyTo({
      center: coordinates,
      zoom: Math.max(map.getZoom(), 17),
      essential: true,
    });
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

  const selectPassBy: DashboardLayerEventHandler = (event) => {
    event.originalEvent.stopPropagation();
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== 'Point') return;
    const key = String(feature.properties?.event_key ?? '');
    const coordinates = feature.geometry.coordinates.slice() as LngLat;
    if (key) callbacks.onPassBySelected(key);
    callbacks.closeActivePoiPopup();
    map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
  };

  const selectTurnCoverage: DashboardLayerEventHandler = (event) => {
    event.originalEvent.stopPropagation();
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== 'Point') return;
    const index = Number(feature.properties?.step_view_index);
    if (Number.isFinite(index)) callbacks.onTurnCoverageSelected?.(index);
  };

  bind('click', POI_CLUSTER_LAYER_ID, expandCluster);
  bind('click', INDIVIDUAL_POI_LAYER_ID, showPoiPopup);
  bind('click', 'selected-poi', showPoiPopup);
  bind('click', 'nearby-pois', showPoiPopup);
  bind('click', 'narration-poi', showPoiPopup);
  bind('click', 'route-narration-pois', showRouteNarrationPoi);
  bind('click', 'candidate-analysis-pois', showCandidatePopup);
  bind('click', 'maneuver-points', selectManeuver);
  bind('click', 'osrm-pass-by-events', selectPassBy);
  bind('click', 'turn-poi-coverage-pois', showPoiPopup);
  bind('click', 'turn-poi-coverage-origin', selectTurnCoverage);

  for (const layerId of INTERACTIVE_LAYER_IDS) {
    bind('mouseenter', layerId, (event) => {
      map.getCanvas().style.cursor = 'pointer';
      if (layerId !== POI_CLUSTER_LAYER_ID) return;
      const id = event.features?.[0]?.id;
      if (id === undefined) return;
      if (hoveredAggregateId !== null && hoveredAggregateId !== id) {
        map.setFeatureState({ source: POI_AGGREGATE_SOURCE_ID, id: hoveredAggregateId }, { hover: false });
      }
      hoveredAggregateId = id;
      map.setFeatureState({ source: POI_AGGREGATE_SOURCE_ID, id }, { hover: true });
    });
    bind('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
      if (layerId !== POI_CLUSTER_LAYER_ID || hoveredAggregateId === null) return;
      map.setFeatureState({ source: POI_AGGREGATE_SOURCE_ID, id: hoveredAggregateId }, { hover: false });
      hoveredAggregateId = null;
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    if (hoveredAggregateId !== null && map.getSource(POI_AGGREGATE_SOURCE_ID)) {
      map.setFeatureState({ source: POI_AGGREGATE_SOURCE_ID, id: hoveredAggregateId }, { hover: false });
      hoveredAggregateId = null;
    }
    for (const { type, layerId, handler } of listeners) {
      map.off(type, layerId, handler);
    }
    map.getCanvas().style.cursor = '';
  };
}
