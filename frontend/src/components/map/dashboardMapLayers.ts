import type { FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';
import {
  authoritativePoiSource,
  EXPLORER_POI_SOURCE_ID,
  INDIVIDUAL_POI_LAYER_ID,
  POI_CLUSTER_COUNT_LAYER_ID,
  POI_CLUSTER_LAYER_ID,
  POI_AGGREGATE_SOURCE_ID,
} from './poiMap';

const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export interface DashboardMapLayerOptions {
  initialPois: FeatureCollection;
  initialPoiAggregates?: FeatureCollection;
}

export function registerDashboardMapLayers(
  map: maplibregl.Map,
  { initialPois, initialPoiAggregates = EMPTY_FEATURE_COLLECTION }: DashboardMapLayerOptions,
): void {
  // OSRM goes underneath as a thick red line. Valhalla is registered next so
  // overlapping routes retain the existing red casing around the blue line.
  map.addSource('osrm-route', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'osrm-route',
    type: 'line',
    source: 'osrm-route',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-width': 10,
      'line-color': '#dc2626',
      'line-opacity': 0.92,
    },
  });

  map.addSource('route', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-width': 5,
      'line-color': '#2563eb',
      'line-opacity': 1,
    },
  });

  map.addSource(POI_AGGREGATE_SOURCE_ID, authoritativePoiSource(initialPoiAggregates));
  map.addLayer({
    id: POI_CLUSTER_LAYER_ID,
    type: 'circle',
    source: POI_AGGREGATE_SOURCE_ID,
    paint: {
      'circle-radius': ['step', ['get', 'source_record_count'], 15, 25, 18, 100, 22, 250, 26],
      'circle-color': ['step', ['get', 'source_record_count'], '#6d5bd0', 100, '#5746b8', 250, '#43338f'],
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(255,255,255,.9)',
      'circle-opacity': 0.94,
    },
  });
  map.addLayer({
    id: POI_CLUSTER_COUNT_LAYER_ID,
    type: 'symbol',
    source: POI_AGGREGATE_SOURCE_ID,
    layout: {
      'text-field': ['number-format', ['get', 'source_record_count'], {}],
      'text-size': 11,
      'text-font': ['Noto Sans Regular'],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(31,23,76,.35)',
      'text-halo-width': 1,
    },
  });
  map.addSource(EXPLORER_POI_SOURCE_ID, authoritativePoiSource(initialPois));
  map.addLayer({
    id: INDIVIDUAL_POI_LAYER_ID,
    type: 'circle',
    source: EXPLORER_POI_SOURCE_ID,
    paint: {
      'circle-radius': 5,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
      'circle-color': '#8b5cf6',
      'circle-opacity': 0.92,
    },
  });

  map.addSource('selected-poi', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'selected-poi',
    type: 'circle',
    source: 'selected-poi',
    paint: {
      'circle-radius': 10,
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
      'circle-color': '#0f766e',
    },
  });

  // This source contains both POI-to-turn lines and maneuver-location points.
  map.addSource('poi-turn-inspection', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addLayer({
    id: 'poi-turn-inspection-line',
    type: 'line',
    source: 'poi-turn-inspection',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-width': 4,
      'line-dasharray': [2, 1.4],
      'line-color': [
        'match',
        ['get', 'engine'],
        'osrm', '#dc2626',
        '#2563eb',
      ],
      'line-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'poi-turn-inspection-turn',
    type: 'circle',
    source: 'poi-turn-inspection',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 11,
      'circle-stroke-width': 4,
      'circle-stroke-color': '#ffffff',
      'circle-color': [
        'match',
        ['get', 'engine'],
        'osrm', '#dc2626',
        '#2563eb',
      ],
    },
  });

  map.addSource('candidate-analysis-map', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addLayer({
    id: 'candidate-analysis-lines',
    type: 'line',
    source: 'candidate-analysis-map',
    filter: ['==', ['get', 'kind'], 'link'],
    paint: {
      'line-color': [
        'match',
        ['get', 'status'],
        'SELECTED', '#16a34a',
        'ELIGIBLE / LOST RANKING', '#d97706',
        'REJECTED', '#dc2626',
        '#64748b',
      ],
      'line-width': [
        'case',
        ['==', ['get', 'selected'], true],
        4,
        2,
      ],
      'line-opacity': [
        'case',
        ['==', ['get', 'selected'], true],
        0.95,
        0.62,
      ],
      'line-dasharray': [2, 1.5],
    },
  });
  map.addLayer({
    id: 'candidate-analysis-pois',
    type: 'circle',
    source: 'candidate-analysis-map',
    filter: ['==', ['get', 'kind'], 'candidate'],
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'selected'], true],
        10,
        7,
      ],
      'circle-color': [
        'match',
        ['get', 'status'],
        'SELECTED', '#16a34a',
        'ELIGIBLE / LOST RANKING', '#d97706',
        'REJECTED', '#dc2626',
        '#64748b',
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': [
        'case',
        ['==', ['get', 'selected'], true],
        4,
        2,
      ],
      'circle-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'candidate-analysis-selected-ring',
    type: 'circle',
    source: 'candidate-analysis-map',
    filter: [
      'all',
      ['==', ['get', 'kind'], 'candidate'],
      ['==', ['get', 'selected'], true],
    ],
    paint: {
      'circle-radius': 15,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#052e16',
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'candidate-analysis-origin',
    type: 'circle',
    source: 'candidate-analysis-map',
    filter: ['==', ['get', 'kind'], 'origin'],
    paint: {
      'circle-radius': 8,
      'circle-color': '#1d4ed8',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });

  map.addSource('nearby-pois', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'nearby-pois',
    type: 'circle',
    source: 'nearby-pois',
    paint: {
      'circle-radius': 8,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-color': '#f59e0b',
      'circle-opacity': 0.9,
    },
  });

  map.addSource('route-narration-pois', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'route-narration-pois-halo',
    type: 'circle',
    source: 'route-narration-pois',
    paint: {
      'circle-radius': ['case', ['==', ['get', '_route_evidence'], 'strong'], 16, 13],
      'circle-color': ['case', ['==', ['get', '_route_evidence'], 'strong'], '#22c55e', '#f59e0b'],
      'circle-opacity': 0.22,
      'circle-stroke-width': 0,
    },
  });
  map.addLayer({
    id: 'route-narration-pois',
    type: 'circle',
    source: 'route-narration-pois',
    paint: {
      'circle-radius': ['case', ['==', ['get', '_route_evidence'], 'strong'], 10, 8],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
      'circle-color': ['case', ['==', ['get', '_route_evidence'], 'strong'], '#16a34a', '#f59e0b'],
      'circle-opacity': 0.98,
    },
  });

  map.addSource('narration-poi', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'narration-poi',
    type: 'circle',
    source: 'narration-poi',
    paint: {
      'circle-radius': 14,
      'circle-stroke-width': 4,
      'circle-stroke-color': '#0f172a',
      'circle-color': ['case', ['==', ['get', '_narration_evidence'], 'strong'], '#22c55e', '#f59e0b'],
      'circle-opacity': 0.82,
    },
  });

  map.addSource('route-points', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'route-points',
    type: 'circle',
    source: 'route-points',
    paint: {
      'circle-radius': 7,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-color': [
        'match',
        ['get', 'kind'],
        'start', '#16a34a',
        'end', '#dc2626',
        '#111827',
      ],
    },
  });

  map.addSource('maneuver-points', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'maneuver-points',
    type: 'circle',
    source: 'maneuver-points',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], true], 9, 6],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-color': ['case', ['==', ['get', 'selected'], true], '#ef4444', '#111827'],
    },
  });

  map.addSource('osrm-selected-maneuver', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addLayer({
    id: 'osrm-selected-maneuver',
    type: 'circle',
    source: 'osrm-selected-maneuver',
    paint: {
      'circle-radius': 9,
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
      'circle-color': '#dc2626',
    },
  });
}
