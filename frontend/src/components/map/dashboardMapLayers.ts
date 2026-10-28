import type { FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';
import {
  authoritativePoiSource,
  EXPLORER_POI_SOURCE_ID,
  INDIVIDUAL_POI_LAYER_ID,
  POI_CLUSTER_COUNT_LAYER_ID,
  POI_CLUSTER_LAYER_ID,
  POI_AGGREGATE_SOURCE_ID,
  POI_DENSITY_SOURCE_ID,
} from './poiMap';
import type { PoiRenderedVisualization } from '../../poiSearchApi';

const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export interface DashboardMapLayerOptions {
  initialPois: FeatureCollection;
  initialPoiAggregates?: FeatureCollection;
  initialPoiDensity?: FeatureCollection;
}

export const POI_DENSITY_LAYER_ID = 'poi-density-heatmap';

const POI_OVERLAY_LAYER_IDS = [
  'selected-poi',
  'nearby-pois',
  'route-narration-pois-halo',
  'route-narration-pois',
  'narration-poi',
  'osrm-pass-by-events',
] as const;

export function syncPoiLayerVisibility(
  map: maplibregl.Map,
  showPois: boolean,
  visualization: PoiRenderedVisualization,
  showCandidateMap = false,
): void {
  const visibility: Record<string, boolean> = {
    [POI_DENSITY_LAYER_ID]: showPois && visualization === 'density',
    [POI_CLUSTER_LAYER_ID]: showPois && visualization === 'clusters',
    [POI_CLUSTER_COUNT_LAYER_ID]: showPois && visualization === 'clusters',
    [INDIVIDUAL_POI_LAYER_ID]: showPois && visualization === 'points',
    'poi-turn-inspection-line': showPois && !showCandidateMap,
    'candidate-analysis-lines': showPois && showCandidateMap,
    'candidate-analysis-pois': showPois && showCandidateMap,
    'candidate-analysis-selected-ring': showPois && showCandidateMap,
    'candidate-analysis-origin': showCandidateMap,
  };
  for (const layerId of POI_OVERLAY_LAYER_IDS) visibility[layerId] = showPois;
  for (const [layerId, isVisible] of Object.entries(visibility)) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', isVisible ? 'visible' : 'none');
    }
  }
}

export function registerDashboardMapLayers(
  map: maplibregl.Map,
  { initialPois, initialPoiAggregates = EMPTY_FEATURE_COLLECTION, initialPoiDensity = EMPTY_FEATURE_COLLECTION }: DashboardMapLayerOptions,
): void {
  map.addSource(POI_DENSITY_SOURCE_ID, authoritativePoiSource(initialPoiDensity));
  const firstBasemapLabel = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
  map.addLayer(
    {
      id: POI_DENSITY_LAYER_ID,
      type: 'heatmap',
      source: POI_DENSITY_SOURCE_ID,
      maxzoom: 20,
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'normalized_render_weight'], 0, 0, 1, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 10, 0.8, 17, 1.05],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 8, 20, 15, 28, 20, 34],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.58, 15, 0.68, 20, 0.42],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(79,70,229,0)',
          0.18, 'rgba(96,165,250,0.28)',
          0.42, 'rgba(99,102,241,0.48)',
          0.7, 'rgba(109,40,217,0.68)',
          1, 'rgba(236,72,153,0.82)',
        ],
      },
    },
    firstBasemapLabel,
  );
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
      'circle-radius': [
        'interpolate', ['linear'], ['ln', ['max', 1, ['get', 'source_record_count']]],
        0, 12,
        2.302585, 14,
        4.60517, 17,
        6.907755, 21,
        9.21034, 25,
        11.512925, 29,
        13.815511, 32,
      ],
      'circle-color': [
        'interpolate', ['linear'], ['ln', ['max', 1, ['get', 'source_record_count']]],
        0, '#8b7ee8',
        4.60517, '#6d5bd0',
        9.21034, '#4f3ca7',
        13.815511, '#352473',
      ],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.5],
      'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffffff', 'rgba(255,255,255,.82)'],
      'circle-opacity': 0.88,
    },
  });
  map.addLayer({
    id: POI_CLUSTER_COUNT_LAYER_ID,
    type: 'symbol',
    source: POI_AGGREGATE_SOURCE_ID,
    layout: {
      'text-field': [
        'case',
        ['>=', ['get', 'source_record_count'], 1000000],
        ['concat', ['number-format', ['/', ['get', 'source_record_count'], 1000000], { 'max-fraction-digits': 1 }], 'm'],
        ['>=', ['get', 'source_record_count'], 1000],
        ['concat', ['number-format', ['/', ['get', 'source_record_count'], 1000], { 'max-fraction-digits': 1 }], 'k'],
        ['number-format', ['get', 'source_record_count'], { 'max-fraction-digits': 0 }],
      ],
      'text-size': ['interpolate', ['linear'], ['ln', ['max', 1, ['get', 'source_record_count']]], 0, 10, 9.21034, 11.5, 13.815511, 12],
      'text-font': ['Noto Sans Regular'],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-padding': 3,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(31,23,76,.55)',
      'text-halo-width': 1.25,
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

  map.addSource('osrm-pass-by-events', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'osrm-pass-by-events',
    type: 'circle',
    source: 'osrm-pass-by-events',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], true], 12, 8],
      'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 4, 3],
      'circle-stroke-color': '#ffffff',
      'circle-color': '#7c3aed',
      'circle-opacity': 0.98,
    },
  });

  map.addSource('turn-poi-coverage', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'turn-poi-coverage-footprint',
    type: 'fill',
    source: 'turn-poi-coverage',
    filter: ['==', ['get', 'kind'], 'footprint'],
    paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.2, 'fill-outline-color': '#0891b2' },
  });
  map.addLayer({
    id: 'turn-poi-coverage-rim',
    type: 'line',
    source: 'turn-poi-coverage',
    filter: ['in', ['get', 'kind'], ['literal', ['footprint', 'arrow']]],
    paint: { 'line-color': '#06b6d4', 'line-width': 3, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'turn-poi-coverage-origin',
    type: 'circle',
    source: 'turn-poi-coverage',
    filter: ['==', ['get', 'kind'], 'origin'],
    paint: { 'circle-radius': 6, 'circle-color': '#ecfeff', 'circle-stroke-color': '#0891b2', 'circle-stroke-width': 3 },
  });
  map.addSource('turn-poi-coverage-pois', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: 'turn-poi-coverage-pois',
    type: 'circle',
    source: 'turn-poi-coverage-pois',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'lateral'], 'LEFT', '#2563eb', 'RIGHT', '#f97316', '#eab308'],
      'circle-stroke-color': ['case', ['==', ['get', 'boundary'], true], '#fde047', '#ffffff'],
      'circle-stroke-width': ['case', ['==', ['get', 'boundary'], true], 4, 2],
      'circle-opacity': 0.95,
    },
  });
}
