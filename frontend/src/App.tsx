import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { activateDataset, getConfig, getDatasets, getPois, getValhallaStatus, reloadDatasetPois, requestRoute } from './api';
import { decodePolyline6 } from './polyline';
import type { DatasetRegistryResponse, DatasetSummary, DebuggerConfig, LngLat, Maneuver, ValhallaRouteResponse } from './types';

type PickMode = 'start' | 'end';

type ManeuverView = {
  index: number;
  legIndex: number;
  maneuver: Maneuver;
  coordinate: LngLat | null;
};

type NearbyPoi = {
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  distanceM: number;
  priority: number | null;
  name: string;
  landmarkType: string;
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const NEARBY_POI_RADIUS_M = 100;
const NEARBY_POI_LIMIT = 12;

function fmtCoord(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(6) : '';
}

function basename(path?: string): string {
  if (!path) return 'not configured';
  const pieces = path.split('/');
  return pieces[pieces.length - 1] || path;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function haversineMeters(a: LngLat, b: LngLat): number {
  const earthRadiusM = 6371008.8;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function propText(properties: GeoJSON.GeoJsonProperties, key: string, fallback = ''): string {
  const value = properties?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function propNumber(properties: GeoJSON.GeoJsonProperties, key: string): number | null {
  const value = Number(properties?.[key]);
  return Number.isFinite(value) ? value : null;
}

function poiPopupHtml(properties: GeoJSON.GeoJsonProperties): string {
  const preferred = [
    'name', 'mappls_poi_id', 'new_node_id', 'landmark_type', 'priority', 'visible',
    'osm_source_type', 'osm_source_id', 'osm_amenity', 'osm_tourism', 'osm_shop',
    'osm_historic', 'osm_leisure', 'osm_railway', 'lat', 'lon', '_debug_distance_m',
  ];
  const keys = [
    ...preferred.filter((key) => properties?.[key] !== undefined && properties?.[key] !== ''),
    ...Object.keys(properties ?? {}).filter((key) => !preferred.includes(key) && properties?.[key] !== ''),
  ];
  const title = propText(properties, 'name', 'POI');
  const rows = keys
    .map((key) => `<div class="poi-popup-row"><strong>${escapeHtml(key)}</strong><span>${escapeHtml(properties?.[key])}</span></div>`)
    .join('');
  return `<div class="poi-popup"><div class="poi-popup-title">${escapeHtml(title)}</div>${rows}</div>`;
}

function pointFeature(feature: GeoJSON.Feature): GeoJSON.Feature<GeoJSON.Point> | null {
  return feature.geometry?.type === 'Point' ? feature as GeoJSON.Feature<GeoJSON.Point> : null;
}

const POI_SEARCH_FIELDS = [
  'name', 'mappls_poi_id', 'new_node_id', 'osm_source_id', 'landmark_type',
];

function poiVisible(properties: GeoJSON.GeoJsonProperties): boolean {
  const value = propText(properties, 'visible', 'yes').trim().toLowerCase();
  return !['no', 'false', '0', 'n'].includes(value);
}

function poiSearchText(properties: GeoJSON.GeoJsonProperties): string {
  return POI_SEARCH_FIELDS
    .map((key) => propText(properties, key, ''))
    .join(' ')
    .toLowerCase();
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const [config, setConfig] = useState<DebuggerConfig | null>(null);
  const [pickMode, setPickMode] = useState<PickMode>('start');
  const [start, setStart] = useState<LngLat | null>(null);
  const [end, setEnd] = useState<LngLat | null>(null);
  const [pois, setPois] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [route, setRoute] = useState<ValhallaRouteResponse | null>(null);
  const [routeGeoJson, setRouteGeoJson] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [valhallaStatus, setValhallaStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [selectedManeuverIndex, setSelectedManeuverIndex] = useState<number | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<GeoJSON.Feature<GeoJSON.Point> | null>(null);
  const [datasetRegistry, setDatasetRegistry] = useState<DatasetRegistryResponse | null>(null);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [datasetMessage, setDatasetMessage] = useState('');

  const [poiSearch, setPoiSearch] = useState('');
  const [poiType, setPoiType] = useState('all');
  const [minPriority, setMinPriority] = useState(0);
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [showPois, setShowPois] = useState(true);

  const activeDataset = useMemo<DatasetSummary | null>(() => {
    if (!datasetRegistry) return null;
    return datasetRegistry.datasets.find((dataset) => dataset.id === datasetRegistry.active_dataset) ?? null;
  }, [datasetRegistry]);

  const availablePoiTypes = useMemo(() => {
    const types = new Set<string>();
    for (const rawFeature of pois.features) {
      const feature = pointFeature(rawFeature);
      if (!feature) continue;
      const type = propText(feature.properties, 'landmark_type', '').trim();
      if (type) types.add(type);
    }
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [pois]);

  const fullTypeStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rawFeature of pois.features) {
      const feature = pointFeature(rawFeature);
      if (!feature) continue;
      const type = propText(feature.properties, 'landmark_type', 'unknown') || 'unknown';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [pois]);

  const filteredPoiFeatures = useMemo<GeoJSON.Feature<GeoJSON.Point>[]>(() => {
    const query = poiSearch.trim().toLowerCase();
    const result: GeoJSON.Feature<GeoJSON.Point>[] = [];

    for (const rawFeature of pois.features) {
      const feature = pointFeature(rawFeature);
      if (!feature) continue;
      const properties = feature.properties ?? {};

      if (visibleOnly && !poiVisible(properties)) continue;

      const landmarkType = propText(properties, 'landmark_type', '').trim();
      if (poiType !== 'all' && landmarkType !== poiType) continue;

      if (minPriority > 0) {
        const priority = propNumber(properties, 'priority');
        if (priority === null || priority < minPriority) continue;
      }

      if (query && !poiSearchText(properties).includes(query)) continue;

      result.push(feature);
    }

    return result;
  }, [pois, poiSearch, poiType, minPriority, visibleOnly]);

  const filteredPois = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: filteredPoiFeatures,
  }), [filteredPoiFeatures]);

  const searchResults = useMemo(() => {
    if (!poiSearch.trim()) return [] as GeoJSON.Feature<GeoJSON.Point>[];
    const query = poiSearch.trim().toLowerCase();
    return [...filteredPoiFeatures]
      .sort((a, b) => {
        const aName = propText(a.properties, 'name', '').toLowerCase();
        const bName = propText(b.properties, 'name', '').toLowerCase();
        const aStarts = aName.startsWith(query) ? 1 : 0;
        const bStarts = bName.startsWith(query) ? 1 : 0;
        if (aStarts !== bStarts) return bStarts - aStarts;
        const priorityDiff = (propNumber(b.properties, 'priority') ?? -1) - (propNumber(a.properties, 'priority') ?? -1);
        if (priorityDiff !== 0) return priorityDiff;
        return aName.localeCompare(bName);
      })
      .slice(0, 10);
  }, [filteredPoiFeatures, poiSearch]);

  const maneuverViews = useMemo<ManeuverView[]>(() => {
    const result: ManeuverView[] = [];
    let globalIndex = 0;
    for (const [legIndex, leg] of (route?.trip?.legs ?? []).entries()) {
      const coordinates = leg.shape ? decodePolyline6(leg.shape) : [];
      for (const maneuver of (leg.maneuvers ?? [])) {
        const shapeIndex = maneuver.begin_shape_index;
        const coordinate = typeof shapeIndex === 'number' && shapeIndex >= 0 && shapeIndex < coordinates.length
          ? coordinates[shapeIndex]
          : null;
        result.push({ index: globalIndex++, legIndex, maneuver, coordinate });
      }
    }
    return result;
  }, [route]);

  const selectedManeuver = useMemo(
    () => selectedManeuverIndex === null ? null : maneuverViews.find((item) => item.index === selectedManeuverIndex) ?? null,
    [maneuverViews, selectedManeuverIndex],
  );

  const nearbyPois = useMemo<NearbyPoi[]>(() => {
    if (!selectedManeuver?.coordinate) return [];
    const result: NearbyPoi[] = [];

    for (const rawFeature of filteredPois.features) {
      const feature = pointFeature(rawFeature);
      if (!feature) continue;
      const coordinate = feature.geometry.coordinates as LngLat;
      const distanceM = haversineMeters(selectedManeuver.coordinate, coordinate);
      if (distanceM > NEARBY_POI_RADIUS_M) continue;
      const properties = feature.properties ?? {};
      result.push({
        feature,
        coordinate,
        distanceM,
        priority: propNumber(properties, 'priority'),
        name: propText(properties, 'name', 'Unnamed POI'),
        landmarkType: propText(properties, 'landmark_type', 'unknown'),
      });
    }

    result.sort((a, b) => a.distanceM - b.distanceM || (b.priority ?? -1) - (a.priority ?? -1));
    return result.slice(0, NEARBY_POI_LIMIT);
  }, [filteredPois, selectedManeuver]);

  useEffect(() => {
    (async () => {
      try {
        const [cfg, poiData, registry] = await Promise.all([getConfig(), getPois(), getDatasets()]);
        setConfig(cfg);
        setPois(poiData);
        setDatasetRegistry(registry);

        const status = await getValhallaStatus();
        setValhallaStatus(status.ok ? 'up' : 'down');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setValhallaStatus('down');
      }
    })();
  }, []);

  useEffect(() => {
    if (!config || !mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: config.frontend.map_style_url,
      center: config.frontend.default_center,
      zoom: config.frontend.default_zoom,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-width': 5, 'line-color': '#2563eb' },
      });

      map.addSource('pois', { type: 'geojson', data: showPois ? filteredPois : EMPTY_FC });
      map.addLayer({
        id: 'pois',
        type: 'circle',
        source: 'pois',
        paint: {
          'circle-radius': 4,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
          'circle-color': '#8b5cf6',
        },
      });

      map.addSource('selected-poi', { type: 'geojson', data: EMPTY_FC });
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

      map.addSource('nearby-pois', { type: 'geojson', data: EMPTY_FC });
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

      map.addSource('route-points', { type: 'geojson', data: EMPTY_FC });
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

      map.addSource('maneuver-points', { type: 'geojson', data: EMPTY_FC });
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

      const showPoiPopup = (event: maplibregl.MapLayerMouseEvent) => {
        const rawFeature = event.features?.[0];
        if (!rawFeature || rawFeature.geometry.type !== 'Point') return;
        const feature = rawFeature as GeoJSON.Feature<GeoJSON.Point>;
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        setSelectedPoi(feature);
        new maplibregl.Popup({ maxWidth: '420px' })
          .setLngLat(coordinates)
          .setHTML(poiPopupHtml(feature.properties ?? {}))
          .addTo(map);
      };

      map.on('click', 'pois', showPoiPopup);
      map.on('click', 'selected-poi', showPoiPopup);
      map.on('click', 'nearby-pois', showPoiPopup);

      map.on('click', 'maneuver-points', (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const index = Number(feature.properties?.index);
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        if (Number.isFinite(index)) setSelectedManeuverIndex(index);
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      });

      for (const layerId of ['pois', 'selected-poi', 'nearby-pois', 'maneuver-points']) {
        map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __pickMode?: PickMode }) | null;
    if (map) map.__pickMode = pickMode;
  }, [pickMode]);

  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __pickMode?: PickMode }) | null;
    if (!map) return;
    map.__pickMode = pickMode;
    const handler = (event: maplibregl.MapMouseEvent) => {
      if (map.isStyleLoaded()) {
        const candidateLayers = ['pois', 'selected-poi', 'nearby-pois', 'maneuver-points', 'route-points']
          .filter((layerId) => Boolean(map.getLayer(layerId)));
        if (candidateLayers.length > 0) {
          const hitFeatures = map.queryRenderedFeatures(event.point, { layers: candidateLayers });
          if (hitFeatures.length > 0) return;
        }
      }

      const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
      if ((map.__pickMode ?? 'start') === 'start') setStart(point);
      else setEnd(point);
    };
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [config, pickMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('pois') as maplibregl.GeoJSONSource | undefined;
    source?.setData(showPois ? filteredPois : EMPTY_FC);
  }, [filteredPois, showPois, config]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('selected-poi') as maplibregl.GeoJSONSource | undefined;
    source?.setData(selectedPoi
      ? { type: 'FeatureCollection', features: [selectedPoi] }
      : EMPTY_FC);
  }, [selectedPoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    source?.setData(routeGeoJson);
  }, [routeGeoJson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const features: GeoJSON.Feature[] = [];
    if (start) features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: start },
      properties: { kind: 'start' },
    });
    if (end) features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: end },
      properties: { kind: 'end' },
    });
    const source = map.getSource('route-points') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [start, end]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const features: GeoJSON.Feature[] = maneuverViews
      .filter((item) => item.coordinate)
      .map((item) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: item.coordinate as LngLat },
        properties: {
          index: item.index,
          selected: item.index === selectedManeuverIndex,
          instruction: item.maneuver.instruction ?? '',
        },
      }));
    const source = map.getSource('maneuver-points') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [maneuverViews, selectedManeuverIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const features: GeoJSON.Feature[] = nearbyPois.map((item) => ({
      ...item.feature,
      properties: {
        ...(item.feature.properties ?? {}),
        _debug_distance_m: item.distanceM.toFixed(1),
      },
    }));
    const source = map.getSource('nearby-pois') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [nearbyPois]);

  useEffect(() => {
    if (poiType !== 'all' && !availablePoiTypes.includes(poiType)) {
      setPoiType('all');
    }
  }, [availablePoiTypes, poiType]);

  async function refreshActiveDataset(message = '') {
    const [poiData, registry] = await Promise.all([getPois(), getDatasets()]);
    setPois(poiData);
    setDatasetRegistry(registry);
    setSelectedPoi(null);
    if (message) setDatasetMessage(message);
  }

  async function changeDataset(datasetId: string) {
    if (!datasetId || datasetId === datasetRegistry?.active_dataset) return;
    setDatasetBusy(true);
    setDatasetMessage('');
    setError('');
    try {
      await activateDataset(datasetId);
      await refreshActiveDataset(`Activated ${datasetId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDatasetBusy(false);
    }
  }

  async function reloadActiveDataset() {
    const datasetId = datasetRegistry?.active_dataset;
    if (!datasetId) return;
    setDatasetBusy(true);
    setDatasetMessage('');
    setError('');
    try {
      await reloadDatasetPois(datasetId);
      await refreshActiveDataset(`Reloaded POIs directly from the configured source.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDatasetBusy(false);
    }
  }

  async function runRoute() {
    if (!start || !end) {
      setError('Set both start and end coordinates first.');
      return;
    }

    setBusy(true);
    setError('');
    setSelectedManeuverIndex(null);
    setSelectedPoi(null);
    try {
      const payload = {
        locations: [
          { lon: start[0], lat: start[1] },
          { lon: end[0], lat: end[1] },
        ],
        costing: 'auto',
        units: 'kilometers',
        directions_options: { units: 'kilometers' },
      };
      const response = await requestRoute(payload);
      setRoute(response);

      const features: GeoJSON.Feature[] = [];
      const allCoords: LngLat[] = [];
      for (const [index, leg] of (response.trip?.legs ?? []).entries()) {
        if (!leg.shape) continue;
        const coords = decodePolyline6(leg.shape);
        allCoords.push(...coords);
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { leg: index },
        });
      }
      setRouteGeoJson({ type: 'FeatureCollection', features });

      if (allCoords.length > 1 && mapRef.current) {
        const bounds = new LngLatBounds(allCoords[0], allCoords[0]);
        allCoords.forEach((coord) => bounds.extend(coord));
        mapRef.current.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateCoord(kind: PickMode, axis: 0 | 1, text: string) {
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    const current = kind === 'start' ? start : end;
    const next: LngLat = current ? [...current] as LngLat : [0, 0];
    next[axis] = value;
    if (kind === 'start') setStart(next);
    else setEnd(next);
  }

  function focusManeuver(item: ManeuverView) {
    setSelectedManeuverIndex(item.index);
    if (!item.coordinate || !mapRef.current) return;
    mapRef.current.flyTo({
      center: item.coordinate,
      zoom: Math.max(mapRef.current.getZoom(), 17),
      essential: true,
    });
  }

  function focusPoiFeature(feature: GeoJSON.Feature<GeoJSON.Point>, debugDistanceM?: number) {
    setSelectedPoi(feature);
    const map = mapRef.current;
    if (!map) return;
    const coordinate = feature.geometry.coordinates as LngLat;
    map.flyTo({ center: coordinate, zoom: Math.max(map.getZoom(), 18), essential: true });
    const properties = {
      ...(feature.properties ?? {}),
      ...(typeof debugDistanceM === 'number' ? { _debug_distance_m: debugDistanceM.toFixed(1) } : {}),
    };
    new maplibregl.Popup({ maxWidth: '420px' })
      .setLngLat(coordinate)
      .setHTML(poiPopupHtml(properties))
      .addTo(map);
  }

  function focusPoi(item: NearbyPoi) {
    focusPoiFeature(item.feature, item.distanceM);
  }

  function resetPoiFilters() {
    setPoiSearch('');
    setPoiType('all');
    setMinPriority(0);
    setVisibleOnly(true);
    setShowPois(true);
    setSelectedPoi(null);
  }

  if (!config) {
    return <div className="loading">Loading debugger configuration…</div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>{config.project.name ?? 'Valhalla POI Debugger'}</h1>
          <div className="subtitle">Phase 2B · POI explorer, filtering, search + statistics</div>
        </div>
        <div className={`status-pill ${valhallaStatus}`}>
          Valhalla: {valhallaStatus === 'checking' ? 'checking' : valhallaStatus === 'up' ? 'connected' : 'offline'}
        </div>
      </header>

      <main className="workspace">
        <section className="map-section">
          <div className="map-toolbar">
            <button className={pickMode === 'start' ? 'active' : ''} onClick={() => setPickMode('start')}>Click map → START</button>
            <button className={pickMode === 'end' ? 'active' : ''} onClick={() => setPickMode('end')}>Click map → END</button>
            <span>{filteredPoiFeatures.length}/{pois.features.length} POIs shown · {maneuverViews.length} maneuvers</span>
          </div>
          <div ref={mapContainer} className="map" />
        </section>

        <aside className="side-panel">
          <section className="card dataset-card">
            <div className="maneuver-heading">
              <h2>Dataset Pipeline</h2>
              <span>Phase 2B</span>
            </div>
            <label>Active POI dataset</label>
            <div className="dataset-actions">
              <select
                value={datasetRegistry?.active_dataset ?? ''}
                disabled={datasetBusy || !datasetRegistry}
                onChange={(event) => changeDataset(event.target.value)}
              >
                {(datasetRegistry?.datasets ?? []).map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
                ))}
              </select>
              <button onClick={reloadActiveDataset} disabled={datasetBusy || !activeDataset}>
                {datasetBusy ? 'Working…' : 'Reload POIs'}
              </button>
            </div>
            {datasetMessage && <div className="dataset-message">{datasetMessage}</div>}
            {activeDataset?.error && <div className="dataset-warning">{activeDataset.error}</div>}
            <div className="kv"><span>Source</span><code title={activeDataset?.source_path ?? ''}>{activeDataset?.source_kind ?? '—'} · {basename(activeDataset?.source_path ?? undefined)}</code></div>
            <div className="kv"><span>PBF</span><code title={activeDataset?.pbf_path ?? config.data.pbf_path}>{basename(activeDataset?.pbf_path ?? config.data.pbf_path)}</code></div>
            <div className="dataset-stats">
              <div><strong>{activeDataset?.stats?.total_rows ?? 0}</strong><span>rows</span></div>
              <div><strong>{activeDataset?.stats?.valid_pois ?? 0}</strong><span>valid POIs</span></div>
              <div><strong>{activeDataset?.stats?.invalid_coordinates ?? 0}</strong><span>bad coords</span></div>
              <div><strong>{activeDataset?.stats?.duplicate_node_ids ?? 0}</strong><span>duplicate IDs</span></div>
            </div>
            <div className="dataset-note">Dataset switching changes the debugger POI layer only. It does not restart Valhalla or swap the tile set used by the running Valhalla service.</div>
          </section>

          <section className="card poi-explorer-card">
            <div className="maneuver-heading">
              <h2>POI Explorer</h2>
              <span>{filteredPoiFeatures.length} / {pois.features.length}</span>
            </div>

            <label>Search name / Mappls ID / node ID / OSM ID / type</label>
            <div className="poi-search-row">
              <input
                value={poiSearch}
                placeholder="Indian Oil, POI-CP-000123, 900000123…"
                onChange={(event) => setPoiSearch(event.target.value)}
              />
              <button onClick={resetPoiFilters}>Reset</button>
            </div>

            <div className="poi-filter-grid">
              <div>
                <label>Landmark type</label>
                <select value={poiType} onChange={(event) => setPoiType(event.target.value)}>
                  <option value="all">All types</option>
                  {availablePoiTypes.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Minimum priority <strong>{minPriority}</strong></label>
                <input
                  className="priority-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={minPriority}
                  onChange={(event) => setMinPriority(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="poi-checkboxes">
              <label><input type="checkbox" checked={visibleOnly} onChange={(event) => setVisibleOnly(event.target.checked)} /> Visible only</label>
              <label><input type="checkbox" checked={showPois} onChange={(event) => setShowPois(event.target.checked)} /> Show POIs on map</label>
            </div>

            <div className="poi-filter-summary">
              <strong>{filteredPoiFeatures.length}</strong> POIs match the current filters.
              <span>Filters affect debugger visualization/nearby inspection only; they do not change Valhalla or Odin.</span>
            </div>

            {poiSearch.trim() && (
              <div className="poi-search-results">
                <div className="poi-section-title">Search results</div>
                {searchResults.length === 0 ? (
                  <div className="empty-state">No POIs match the current search and filters.</div>
                ) : searchResults.map((feature, index) => (
                  <button
                    key={`${propText(feature.properties, 'new_node_id', '')}-${index}`}
                    className="poi-search-result"
                    onClick={() => focusPoiFeature(feature)}
                  >
                    <span>
                      <strong>{propText(feature.properties, 'name', 'Unnamed POI')}</strong>
                      <small>{propText(feature.properties, 'landmark_type', 'unknown')} · {propText(feature.properties, 'mappls_poi_id', 'no Mappls ID')}</small>
                    </span>
                    <span className="poi-search-meta">
                      <strong>{propText(feature.properties, 'priority', '—')}</strong>
                      <small>priority</small>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="poi-type-stats">
              <div className="poi-section-title">Dataset type distribution</div>
              {fullTypeStats.slice(0, 8).map(([type, count]) => (
                <button key={type} onClick={() => setPoiType(type)} title={`Filter to ${type}`}>
                  <span>{type}</span><strong>{count}</strong>
                </button>
              ))}
              {fullTypeStats.length > 8 && <small>+ {fullTypeStats.length - 8} more landmark types</small>}
            </div>
          </section>

          <section className="card">
            <h2>Configuration</h2>
            <div className="kv"><span>Valhalla</span><code>{config.valhalla.service_url}</code></div>
            <div className="kv"><span>Engine</span><code title={config.engine.root}>{basename(config.engine.root)}</code></div>
            <div className="kv"><span>Dataset</span><code>{datasetRegistry?.active_dataset ?? config.active_dataset ?? 'default'}</code></div>
          </section>

          <section className="card">
            <h2>Route Request</h2>
            <label>Start [lon, lat]</label>
            <div className="coord-row">
              <input value={fmtCoord(start?.[0])} placeholder="longitude" onChange={(e) => updateCoord('start', 0, e.target.value)} />
              <input value={fmtCoord(start?.[1])} placeholder="latitude" onChange={(e) => updateCoord('start', 1, e.target.value)} />
            </div>
            <label>End [lon, lat]</label>
            <div className="coord-row">
              <input value={fmtCoord(end?.[0])} placeholder="longitude" onChange={(e) => updateCoord('end', 0, e.target.value)} />
              <input value={fmtCoord(end?.[1])} placeholder="latitude" onChange={(e) => updateCoord('end', 1, e.target.value)} />
            </div>
            <button className="route-button" onClick={runRoute} disabled={busy}>{busy ? 'Routing…' : 'Run Valhalla Route'}</button>
            {error && <div className="error-box">{error}</div>}
          </section>

          <section className="card maneuvers-card">
            <div className="maneuver-heading">
              <h2>Odin Maneuvers</h2>
              {route?.trip?.summary && (
                <span>{route.trip.summary.length?.toFixed(2)} km · {Math.round((route.trip.summary.time ?? 0) / 60)} min</span>
              )}
            </div>
            {maneuverViews.length === 0 ? (
              <div className="empty-state">Run a route to inspect Odin instructions.</div>
            ) : (
              <ol className="maneuver-list">
                {maneuverViews.map((item) => (
                  <li key={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}>
                    <button className="maneuver-button" onClick={() => focusManeuver(item)}>
                      <strong>{item.maneuver.instruction ?? 'Unnamed maneuver'}</strong>
                      {item.maneuver.verbal_pre_transition_instruction && (
                        <div>{item.maneuver.verbal_pre_transition_instruction}</div>
                      )}
                      <small>
                        {typeof item.maneuver.length === 'number' ? `${item.maneuver.length.toFixed(2)} km` : ''}
                        {typeof item.maneuver.time === 'number' ? ` · ${Math.round(item.maneuver.time)} s` : ''}
                        {item.coordinate ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}` : ''}
                      </small>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card inspection-card">
            <div className="maneuver-heading">
              <h2>Maneuver ↔ POI Inspection</h2>
              <span>{NEARBY_POI_RADIUS_M} m radius</span>
            </div>
            {!selectedManeuver ? (
              <div className="empty-state">Click an Odin maneuver or a black maneuver marker on the map.</div>
            ) : (
              <>
                <div className="selected-maneuver-summary">
                  <strong>#{selectedManeuver.index + 1} {selectedManeuver.maneuver.instruction ?? 'Unnamed maneuver'}</strong>
                  <span>
                    {selectedManeuver.coordinate
                      ? `${selectedManeuver.coordinate[1].toFixed(6)}, ${selectedManeuver.coordinate[0].toFixed(6)}`
                      : 'No begin_shape_index coordinate available'}
                  </span>
                </div>
                <div className="debug-note">Nearby POIs are computed from the source GeoJSON. This does not yet expose Odin's internal candidate/selected-landmark state.</div>
                {nearbyPois.length === 0 ? (
                  <div className="empty-state">No source POIs within {NEARBY_POI_RADIUS_M} m.</div>
                ) : (
                  <div className="nearby-list">
                    {nearbyPois.map((item, index) => (
                      <button key={`${item.feature.id ?? item.name}-${index}`} className="nearby-poi" onClick={() => focusPoi(item)}>
                        <span className="nearby-rank">{index + 1}</span>
                        <span className="nearby-main">
                          <strong>{item.name}</strong>
                          <small>{item.landmarkType}</small>
                        </span>
                        <span className="nearby-metrics">
                          <strong>{item.distanceM.toFixed(1)} m</strong>
                          <small>priority {item.priority ?? '—'}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {selectedPoi && (
            <section className="card selected-poi-card">
              <div className="maneuver-heading">
                <h2>Selected POI</h2>
                <span>{propText(selectedPoi.properties, 'landmark_type', '')}</span>
              </div>
              <strong className="selected-poi-name">{propText(selectedPoi.properties, 'name', 'Unnamed POI')}</strong>
              <div className="property-grid">
                {Object.entries(selectedPoi.properties ?? {})
                  .filter(([, value]) => value !== '')
                  .map(([key, value]) => (
                    <div className="property-row" key={key}>
                      <span>{key}</span><code>{String(value)}</code>
                    </div>
                  ))}
              </div>
            </section>
          )}

          <details className="card raw-card">
            <summary>Raw Valhalla JSON</summary>
            <pre>{route ? JSON.stringify(route, null, 2) : 'No route response yet.'}</pre>
          </details>
        </aside>
      </main>
    </div>
  );
}
