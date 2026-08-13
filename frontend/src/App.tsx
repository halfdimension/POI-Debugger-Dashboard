import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { activateDataset, createScenario, deleteScenario, getConfig, getDatasets, getPois, getScenarios, getValhallaStatus, reloadDatasetPois, requestRoute, updateScenario } from './api';
import { decodePolyline6 } from './polyline';
import type { DatasetRegistryResponse, DatasetSummary, DebuggerConfig, LngLat, Maneuver, RouteScenario, ScenarioRegistryResponse, ValhallaRouteResponse } from './types';

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

type NarrationPoiEvidence = {
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  distanceM: number | null;
  priority: number | null;
  name: string;
  landmarkType: string;
  poiId: string;
  sourceNodeId: string;
  evidence: 'strong' | 'ambiguous';
  matchedInstruction: string;
};

type RouteNarrationPoi = {
  key: string;
  evidence: NarrationPoiEvidence;
  maneuverIndexes: number[];
  primaryManeuverIndex: number;
};

type PredictedPoiCandidate = {
  key: string;
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  routeOffsetM: number;
  distanceToManeuverM: number;
  lateralDistanceM: number;
  priority: number;
  name: string;
  landmarkType: string;
  poiId: string;
  sourceNodeId: string;
};

type PredictionStatus = 'match' | 'mismatch' | 'not-observed' | 'ambiguous-only' | 'no-candidate';

type ManeuverPrediction = {
  maneuverIndex: number;
  candidates: PredictedPoiCandidate[];
  winner: PredictedPoiCandidate | null;
  observed: NarrationPoiEvidence | null;
  status: PredictionStatus;
  approachLengthM: number;
};

type RoutePredictedPoi = {
  key: string;
  candidate: PredictedPoiCandidate;
  maneuverIndexes: number[];
  primaryManeuverIndex: number;
};

type ScenarioRunStatus = 'pass' | 'fail' | 'no-expectation' | 'error';

type ScenarioRunResult = {
  status: ScenarioRunStatus;
  checkedAt: string;
  actualInstructions: string[];
  matchedInstructions: string[];
  failures: string[];
  error?: string;
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const NEARBY_POI_RADIUS_M = 100;
const NEARBY_POI_LIMIT = 12;
const NARRATION_POI_MAX_DISTANCE_M = 500;
const PREDICTION_CORRIDOR_M = 60;
const PREDICTION_CANDIDATE_LIMIT = 8;

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

type PolylineProjection = {
  lateralDistanceM: number;
  distanceAlongM: number;
  remainingDistanceM: number;
  totalLengthM: number;
};

function projectPointToPolylineMeters(point: LngLat, line: LngLat[]): PolylineProjection | null {
  if (line.length < 2) return null;

  const latScale = 111132.92;
  const lonScale = 111412.84 * Math.cos(point[1] * Math.PI / 180);
  const segmentLengths = line.slice(1).map((coord, index) => haversineMeters(line[index], coord));
  const totalLengthM = segmentLengths.reduce((sum, value) => sum + value, 0);

  let best: { lateralDistanceM: number; distanceAlongM: number } | null = null;
  let accumulatedM = 0;

  for (let index = 0; index < line.length - 1; index += 1) {
    const a = line[index];
    const b = line[index + 1];
    const ax = (a[0] - point[0]) * lonScale;
    const ay = (a[1] - point[1]) * latScale;
    const bx = (b[0] - point[0]) * lonScale;
    const by = (b[1] - point[1]) * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const denom = dx * dx + dy * dy;
    const t = denom <= Number.EPSILON ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const lateralDistanceM = Math.hypot(px, py);
    const distanceAlongM = accumulatedM + segmentLengths[index] * t;

    if (!best || lateralDistanceM < best.lateralDistanceM) {
      best = { lateralDistanceM, distanceAlongM };
    }
    accumulatedM += segmentLengths[index];
  }

  if (!best) return null;
  return {
    lateralDistanceM: best.lateralDistanceM,
    distanceAlongM: best.distanceAlongM,
    remainingDistanceM: Math.max(0, totalLengthM - best.distanceAlongM),
    totalLengthM,
  };
}

function sourcePoiKey(feature: GeoJSON.Feature<GeoJSON.Point>): string {
  const properties = feature.properties ?? {};
  const poiId = propText(properties, 'mappls_poi_id', '');
  const nodeId = propText(properties, 'new_node_id', '');
  if (poiId) return `poi:${poiId}`;
  if (nodeId) return `node:${nodeId}`;
  const coordinate = feature.geometry.coordinates as LngLat;
  return `name:${normalizeNarrationText(propText(properties, 'name', ''))}|${coordinate[0].toFixed(7)}|${coordinate[1].toFixed(7)}`;
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

function normalizeNarrationText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function maneuverInstructionTexts(maneuver: Maneuver): string[] {
  const values = [maneuver.instruction, maneuver.verbal_pre_transition_instruction]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function instructionContainsName(instruction: string, name: string): boolean {
  const normalizedInstruction = ` ${normalizeNarrationText(instruction)} `;
  const normalizedName = normalizeNarrationText(name);
  return normalizedName.length >= 3 && normalizedInstruction.includes(` ${normalizedName} `);
}

function hasStrongLandmarkCue(instruction: string, name: string): boolean {
  const normalizedInstruction = ` ${normalizeNarrationText(instruction)} `;
  const normalizedName = normalizeNarrationText(name);
  if (!normalizedName) return false;
  return normalizedInstruction.includes(` at ${normalizedName} `) ||
    normalizedInstruction.includes(` at the ${normalizedName} `);
}

function narrationPoiKey(item: NarrationPoiEvidence): string {
  if (item.poiId) return `poi:${item.poiId}`;
  if (item.sourceNodeId) return `node:${item.sourceNodeId}`;
  return `name:${normalizeNarrationText(item.name)}|${item.coordinate[0].toFixed(7)}|${item.coordinate[1].toFixed(7)}`;
}

function odinInstructionTexts(response: ValhallaRouteResponse): string[] {
  const values: string[] = [];
  for (const leg of response.trip?.legs ?? []) {
    for (const maneuver of leg.maneuvers ?? []) {
      for (const value of [maneuver.instruction, maneuver.verbal_pre_transition_instruction]) {
        const text = String(value ?? '').trim();
        if (text && !values.includes(text)) values.push(text);
      }
    }
  }
  return values;
}

function evaluateScenario(scenario: RouteScenario, response: ValhallaRouteResponse): ScenarioRunResult {
  const expectation = scenario.expectation;
  const actualInstructions = odinInstructionTexts(response);
  const checkedAt = new Date().toISOString();

  const landmarkName = expectation?.landmark_name?.trim() ?? '';
  const required = expectation?.instruction_contains?.trim() || landmarkName;
  const forbidden = expectation?.instruction_not_contains?.trim() ?? '';

  if (!required && !forbidden) {
    return { status: 'no-expectation', checkedAt, actualInstructions, matchedInstructions: [], failures: [] };
  }

  const caseSensitive = expectation?.case_sensitive ?? false;
  const normalize = (value: string) => caseSensitive ? value : value.toLowerCase();
  const normalizedInstructions = actualInstructions.map((text) => ({ raw: text, normalized: normalize(text) }));
  const failures: string[] = [];
  const matchedInstructions: string[] = [];

  if (required) {
    const needle = normalize(required);
    const matches = normalizedInstructions.filter((item) => item.normalized.includes(needle)).map((item) => item.raw);
    if (matches.length === 0) failures.push(`No Odin instruction contained "${required}".`);
    else matchedInstructions.push(...matches);
  }

  if (forbidden) {
    const needle = normalize(forbidden);
    const matches = normalizedInstructions.filter((item) => item.normalized.includes(needle)).map((item) => item.raw);
    if (matches.length > 0) {
      failures.push(`Forbidden Odin text "${forbidden}" was present.`);
      matchedInstructions.push(...matches);
    }
  }

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    checkedAt,
    actualInstructions,
    matchedInstructions: Array.from(new Set(matchedInstructions)),
    failures,
  };
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  // Keep at most one POI popup open at any time.
  const activePoiPopupRef = useRef<maplibregl.Popup | null>(null);

  function closeActivePoiPopup() {
    activePoiPopupRef.current?.remove();
    activePoiPopupRef.current = null;
  }

  function openPoiPopup(
    map: maplibregl.Map,
    coordinate: LngLat,
    properties: GeoJSON.GeoJsonProperties,
  ) {
    closeActivePoiPopup();

    const popup = new maplibregl.Popup({ maxWidth: '420px' })
      .setLngLat(coordinate)
      .setHTML(poiPopupHtml(properties ?? {}))
      .addTo(map);

    popup.on('close', () => {
      if (activePoiPopupRef.current === popup) {
        activePoiPopupRef.current = null;
      }
    });

    activePoiPopupRef.current = popup;
  }


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

  const [scenarioRegistry, setScenarioRegistry] = useState<ScenarioRegistryResponse | null>(null);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioNotes, setScenarioNotes] = useState('');
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioMessage, setScenarioMessage] = useState('');
  const [scenarioExpectedText, setScenarioExpectedText] = useState('');
  const [scenarioForbiddenText, setScenarioForbiddenText] = useState('');
  const [scenarioRunResults, setScenarioRunResults] = useState<Record<string, ScenarioRunResult>>({});
  const [runAllBusy, setRunAllBusy] = useState(false);

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

  const narrationEvidenceByManeuver = useMemo(() => {
    const result = new Map<number, NarrationPoiEvidence[]>();

    for (const item of maneuverViews) {
      const instructions = maneuverInstructionTexts(item.maneuver);
      if (instructions.length === 0) {
        result.set(item.index, []);
        continue;
      }

      const matches: NarrationPoiEvidence[] = [];

      for (const rawFeature of pois.features) {
        const feature = pointFeature(rawFeature);
        if (!feature) continue;

        const properties = feature.properties ?? {};
        const name = propText(properties, 'name', '').trim();
        if (!name || normalizeNarrationText(name).length < 3) continue;

        const matchedInstruction = instructions.find((instruction) => instructionContainsName(instruction, name));
        if (!matchedInstruction) continue;

        const coordinate = feature.geometry.coordinates as LngLat;
        const distanceM = item.coordinate ? haversineMeters(item.coordinate, coordinate) : null;
        if (distanceM !== null && distanceM > NARRATION_POI_MAX_DISTANCE_M) continue;

        matches.push({
          feature,
          coordinate,
          distanceM,
          priority: propNumber(properties, 'priority'),
          name,
          landmarkType: propText(properties, 'landmark_type', 'unknown'),
          poiId: propText(properties, 'mappls_poi_id', ''),
          sourceNodeId: propText(properties, 'new_node_id', ''),
          evidence: hasStrongLandmarkCue(matchedInstruction, name) ? 'strong' : 'ambiguous',
          matchedInstruction,
        });
      }

      matches.sort((a, b) => {
        if (a.evidence !== b.evidence) return a.evidence === 'strong' ? -1 : 1;
        const nameLength = normalizeNarrationText(b.name).length - normalizeNarrationText(a.name).length;
        if (nameLength !== 0) return nameLength;
        const distanceA = a.distanceM ?? Number.POSITIVE_INFINITY;
        const distanceB = b.distanceM ?? Number.POSITIVE_INFINITY;
        if (distanceA !== distanceB) return distanceA - distanceB;
        return (b.priority ?? -1) - (a.priority ?? -1);
      });

      const deduped: NarrationPoiEvidence[] = [];
      const seen = new Set<string>();
      for (const match of matches) {
        const key = `${normalizeNarrationText(match.name)}|${match.poiId}|${match.sourceNodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(match);
      }

      result.set(item.index, deduped.slice(0, 8));
    }

    return result;
  }, [maneuverViews, pois]);

  const routeNarrationPois = useMemo<RouteNarrationPoi[]>(() => {
    const grouped = new Map<string, RouteNarrationPoi>();

    for (const item of maneuverViews) {
      // Phase 4A sorts evidence strongest-first. For the route-wide map layer we
      // intentionally keep one primary source-POI match per maneuver, then
      // deduplicate the same POI across maneuvers.
      const primary = (narrationEvidenceByManeuver.get(item.index) ?? [])[0];
      if (!primary) continue;

      const key = narrationPoiKey(primary);
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          key,
          evidence: primary,
          maneuverIndexes: [item.index],
          primaryManeuverIndex: item.index,
        });
        continue;
      }

      if (!existing.maneuverIndexes.includes(item.index)) {
        existing.maneuverIndexes.push(item.index);
      }

      // If the same source POI is only an ambiguous match on one maneuver but
      // a strong landmark-style match on another, represent the route-wide POI
      // using the stronger evidence.
      if (existing.evidence.evidence === 'ambiguous' && primary.evidence === 'strong') {
        existing.evidence = primary;
        existing.primaryManeuverIndex = item.index;
      }
    }

    return Array.from(grouped.values()).sort((a, b) => {
      if (a.evidence.evidence !== b.evidence.evidence) {
        return a.evidence.evidence === 'strong' ? -1 : 1;
      }
      return a.primaryManeuverIndex - b.primaryManeuverIndex;
    });
  }, [maneuverViews, narrationEvidenceByManeuver]);

  const routeNarrationStrongCount = useMemo(
    () => routeNarrationPois.filter((item) => item.evidence.evidence === 'strong').length,
    [routeNarrationPois],
  );

  const routeNarrationAmbiguousCount = routeNarrationPois.length - routeNarrationStrongCount;

  const predictionByManeuver = useMemo(() => {
    const result = new Map<number, ManeuverPrediction>();
    const legCoordinates = new Map<number, LngLat[]>();

    for (const item of maneuverViews) {
      const leg = route?.trip?.legs?.[item.legIndex];
      if (!leg?.shape) {
        result.set(item.index, { maneuverIndex: item.index, candidates: [], winner: null, observed: null, status: 'no-candidate', approachLengthM: 0 });
        continue;
      }

      let coordinates = legCoordinates.get(item.legIndex);
      if (!coordinates) {
        coordinates = decodePolyline6(leg.shape);
        legCoordinates.set(item.legIndex, coordinates);
      }

      const legManeuvers = maneuverViews.filter((candidate) => candidate.legIndex === item.legIndex);
      const legPosition = legManeuvers.findIndex((candidate) => candidate.index === item.index);
      const previous = legPosition > 0 ? legManeuvers[legPosition - 1] : null;
      const startIndex = previous?.maneuver.begin_shape_index;
      const endIndex = item.maneuver.begin_shape_index;

      if (typeof startIndex !== 'number' || typeof endIndex !== 'number' || endIndex <= startIndex || startIndex < 0 || endIndex >= coordinates.length) {
        const observed = (narrationEvidenceByManeuver.get(item.index) ?? []).find((match) => match.evidence === 'strong') ?? null;
        result.set(item.index, { maneuverIndex: item.index, candidates: [], winner: null, observed, status: 'no-candidate', approachLengthM: 0 });
        continue;
      }

      const approach = coordinates.slice(startIndex, endIndex + 1);
      const candidates: PredictedPoiCandidate[] = [];

      for (const rawFeature of pois.features) {
        const feature = pointFeature(rawFeature);
        if (!feature) continue;
        const properties = feature.properties ?? {};
        if (!poiVisible(properties)) continue;

        const name = propText(properties, 'name', '').trim();
        const poiId = propText(properties, 'mappls_poi_id', '').trim();
        const sourceNodeId = propText(properties, 'new_node_id', '').trim();
        const landmarkType = propText(properties, 'landmark_type', '').trim();
        const priority = propNumber(properties, 'priority');
        if (!name || !poiId || !landmarkType || landmarkType.toLowerCase() === 'unknown' || priority === null || priority < 0 || priority > 100) continue;

        const coordinate = feature.geometry.coordinates as LngLat;
        const projection = projectPointToPolylineMeters(coordinate, approach);
        if (!projection || projection.lateralDistanceM > PREDICTION_CORRIDOR_M) continue;

        candidates.push({
          key: sourcePoiKey(feature),
          feature,
          coordinate,
          routeOffsetM: projection.distanceAlongM,
          distanceToManeuverM: projection.remainingDistanceM,
          lateralDistanceM: projection.lateralDistanceM,
          priority,
          name,
          landmarkType,
          poiId,
          sourceNodeId,
        });
      }

      candidates.sort((a, b) =>
        b.priority - a.priority ||
        a.distanceToManeuverM - b.distanceToManeuverM ||
        a.poiId.localeCompare(b.poiId),
      );

      const winner = candidates[0] ?? null;
      const evidence = narrationEvidenceByManeuver.get(item.index) ?? [];
      const observed = evidence.find((match) => match.evidence === 'strong') ?? null;
      let status: PredictionStatus;

      if (!winner) status = 'no-candidate';
      else if (observed) status = winner.key === narrationPoiKey(observed) ? 'match' : 'mismatch';
      else if (evidence.length > 0) status = 'ambiguous-only';
      else status = 'not-observed';

      const approachLengthM = projectPointToPolylineMeters(approach[0], approach)?.totalLengthM ?? 0;
      result.set(item.index, {
        maneuverIndex: item.index,
        candidates: candidates.slice(0, PREDICTION_CANDIDATE_LIMIT),
        winner,
        observed,
        status,
        approachLengthM,
      });
    }

    return result;
  }, [maneuverViews, narrationEvidenceByManeuver, pois, route]);

  const routePredictedPois = useMemo<RoutePredictedPoi[]>(() => {
    const grouped = new Map<string, RoutePredictedPoi>();
    for (const item of maneuverViews) {
      const winner = predictionByManeuver.get(item.index)?.winner;
      if (!winner) continue;
      const existing = grouped.get(winner.key);
      if (!existing) {
        grouped.set(winner.key, {
          key: winner.key,
          candidate: winner,
          maneuverIndexes: [item.index],
          primaryManeuverIndex: item.index,
        });
      } else if (!existing.maneuverIndexes.includes(item.index)) {
        existing.maneuverIndexes.push(item.index);
      }
    }
    return Array.from(grouped.values()).sort((a, b) => a.primaryManeuverIndex - b.primaryManeuverIndex);
  }, [maneuverViews, predictionByManeuver]);

  const predictionCounts = useMemo(() => {
    const counts: Record<PredictionStatus, number> = { match: 0, mismatch: 0, 'not-observed': 0, 'ambiguous-only': 0, 'no-candidate': 0 };
    for (const prediction of predictionByManeuver.values()) counts[prediction.status] += 1;
    return counts;
  }, [predictionByManeuver]);

  const selectedPrediction = useMemo(
    () => selectedManeuverIndex === null ? null : predictionByManeuver.get(selectedManeuverIndex) ?? null,
    [predictionByManeuver, selectedManeuverIndex],
  );

  const selectedNarrationEvidence = useMemo(
    () => selectedManeuverIndex === null ? [] : narrationEvidenceByManeuver.get(selectedManeuverIndex) ?? [],
    [narrationEvidenceByManeuver, selectedManeuverIndex],
  );

  const primaryNarrationEvidence = selectedNarrationEvidence[0] ?? null;

  useEffect(() => {
    (async () => {
      try {
        const [cfg, poiData, registry, scenarios] = await Promise.all([getConfig(), getPois(), getDatasets(), getScenarios()]);
        setConfig(cfg);
        setPois(poiData);
        setDatasetRegistry(registry);
        setScenarioRegistry(scenarios);

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

      map.addSource('route-narration-pois', { type: 'geojson', data: EMPTY_FC });
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

      map.addSource('predicted-pois', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'predicted-pois',
        type: 'circle',
        source: 'predicted-pois',
        paint: {
          'circle-radius': 13,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#2563eb',
          'circle-opacity': 1,
        },
      });

      map.addSource('narration-poi', { type: 'geojson', data: EMPTY_FC });
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
        openPoiPopup(
          map,
          coordinates,
          feature.properties ?? {},
        );
      };

      map.on('click', 'pois', showPoiPopup);
      map.on('click', 'selected-poi', showPoiPopup);
      map.on('click', 'nearby-pois', showPoiPopup);
      map.on('click', 'narration-poi', showPoiPopup);

      map.on('click', 'route-narration-pois', (event) => {
        const rawFeature = event.features?.[0];
        if (!rawFeature || rawFeature.geometry.type !== 'Point') return;

        const feature = rawFeature as GeoJSON.Feature<GeoJSON.Point>;
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        const maneuverIndex = Number(feature.properties?._primary_maneuver_index);
        if (Number.isFinite(maneuverIndex)) {
          setSelectedManeuverIndex(maneuverIndex);
          window.setTimeout(() => {
            document.querySelector(`[data-maneuver-index="${maneuverIndex}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 80);
        }

        setSelectedPoi(feature);
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
        openPoiPopup(
          map,
          coordinates,
          feature.properties ?? {},
        );
      });

      map.on('click', 'predicted-pois', (event) => {
        const rawFeature = event.features?.[0];
        if (!rawFeature || rawFeature.geometry.type !== 'Point') return;
        const feature = rawFeature as GeoJSON.Feature<GeoJSON.Point>;
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        const maneuverIndex = Number(feature.properties?._predicted_maneuver_index);
        if (Number.isFinite(maneuverIndex)) {
          setSelectedManeuverIndex(maneuverIndex);
          window.setTimeout(() => {
            document.querySelector(`[data-maneuver-index="${maneuverIndex}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 80);
        }
        setSelectedPoi(feature);
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
        openPoiPopup(
          map,
          coordinates,
          feature.properties ?? {},
        );
      });

      map.on('click', 'maneuver-points', (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const index = Number(feature.properties?.index);
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        if (Number.isFinite(index)) setSelectedManeuverIndex(index);
        closeActivePoiPopup();
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      });

      for (const layerId of ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'predicted-pois', 'narration-poi', 'maneuver-points']) {
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
        const candidateLayers = ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'predicted-pois', 'narration-poi', 'maneuver-points', 'route-points']
          .filter((layerId) => Boolean(map.getLayer(layerId)));
        if (candidateLayers.length > 0) {
          const hitFeatures = map.queryRenderedFeatures(event.point, { layers: candidateLayers });
          if (hitFeatures.length > 0) return;
        }
      }

      closeActivePoiPopup();

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
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const features: GeoJSON.Feature<GeoJSON.Point>[] = routeNarrationPois.map((item) => ({
      ...item.evidence.feature,
      properties: {
        ...(item.evidence.feature.properties ?? {}),
        _route_evidence: item.evidence.evidence,
        _primary_maneuver_index: item.primaryManeuverIndex,
        _maneuver_indexes: item.maneuverIndexes.map((index) => index + 1).join(', '),
        _matched_instruction: item.evidence.matchedInstruction,
        _debug_distance_m: item.evidence.distanceM === null ? '' : item.evidence.distanceM.toFixed(1),
      },
    }));

    const source = map.getSource('route-narration-pois') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [routeNarrationPois]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = routePredictedPois.map((item) => ({
      ...item.candidate.feature,
      properties: {
        ...(item.candidate.feature.properties ?? {}),
        _predicted_maneuver_index: item.primaryManeuverIndex,
        _predicted_maneuvers: item.maneuverIndexes.map((index) => index + 1).join(', '),
        _predicted_priority: item.candidate.priority,
        _predicted_distance_to_maneuver_m: item.candidate.distanceToManeuverM.toFixed(1),
        _predicted_lateral_distance_m: item.candidate.lateralDistanceM.toFixed(1),
      },
    }));
    const source = map.getSource('predicted-pois') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [routePredictedPois]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('narration-poi') as maplibregl.GeoJSONSource | undefined;
    if (!primaryNarrationEvidence) {
      source?.setData(EMPTY_FC);
      return;
    }

    source?.setData({
      type: 'FeatureCollection',
      features: [{
        ...primaryNarrationEvidence.feature,
        properties: {
          ...(primaryNarrationEvidence.feature.properties ?? {}),
          _debug_distance_m: primaryNarrationEvidence.distanceM === null
            ? ''
            : primaryNarrationEvidence.distanceM.toFixed(1),
          _narration_evidence: primaryNarrationEvidence.evidence,
        },
      }],
    });
  }, [primaryNarrationEvidence]);

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

  async function executeRoute(routeStart: LngLat, routeEnd: LngLat, costing = 'auto'): Promise<ValhallaRouteResponse | null> {
    setBusy(true);
    setError('');
    setSelectedManeuverIndex(null);
    setSelectedPoi(null);
    try {
      const payload = {
        locations: [
          { lon: routeStart[0], lat: routeStart[1] },
          { lon: routeEnd[0], lat: routeEnd[1] },
        ],
        costing,
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
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runRoute() {
    if (!start || !end) {
      setError('Set both start and end coordinates first.');
      return;
    }
    await executeRoute(start, end, 'auto');
  }

  async function refreshScenarios(message = '') {
    const registry = await getScenarios();
    setScenarioRegistry(registry);
    if (message) setScenarioMessage(message);
  }

  function scenarioPoints(scenario: RouteScenario): { routeStart: LngLat; routeEnd: LngLat } {
    return {
      routeStart: [scenario.request.start.lon, scenario.request.start.lat],
      routeEnd: [scenario.request.end.lon, scenario.request.end.lat],
    };
  }

  function loadScenario(scenario: RouteScenario) {
    const { routeStart, routeEnd } = scenarioPoints(scenario);
    setStart(routeStart);
    setEnd(routeEnd);
    setRoute(null);
    setRouteGeoJson(EMPTY_FC);
    setSelectedManeuverIndex(null);
    setSelectedPoi(null);
    setError('');
    setScenarioMessage(`Loaded ${scenario.name}.`);

    if (mapRef.current) {
      const bounds = new LngLatBounds(routeStart, routeStart);
      bounds.extend(routeEnd);
      mapRef.current.fitBounds(bounds, { padding: 100, maxZoom: 16 });
    }
  }

  async function runSavedScenario(scenario: RouteScenario): Promise<ScenarioRunResult | null> {
    const activeId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
    if (scenario.dataset !== activeId) {
      const message = `Scenario uses dataset "${scenario.dataset}" but the active debugger dataset is "${activeId || 'unknown'}". Activate the matching dataset before running it.`;
      setError(message);
      const result: ScenarioRunResult = { status: 'error', checkedAt: new Date().toISOString(), actualInstructions: [], matchedInstructions: [], failures: [], error: message };
      setScenarioRunResults((previous) => ({ ...previous, [scenario.id]: result }));
      return result;
    }

    const { routeStart, routeEnd } = scenarioPoints(scenario);
    setStart(routeStart);
    setEnd(routeEnd);
    setScenarioMessage(`Running ${scenario.name}.`);
    const response = await executeRoute(routeStart, routeEnd, scenario.request.costing || 'auto');
    if (!response) {
      const result: ScenarioRunResult = { status: 'error', checkedAt: new Date().toISOString(), actualInstructions: [], matchedInstructions: [], failures: [], error: 'Route request failed.' };
      setScenarioRunResults((previous) => ({ ...previous, [scenario.id]: result }));
      return result;
    }

    const result = evaluateScenario(scenario, response);
    setScenarioRunResults((previous) => ({ ...previous, [scenario.id]: result }));
    setScenarioMessage(`${scenario.name}: ${result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'route ran; no expectation configured'}.`);
    return result;
  }

  async function editScenarioExpectation(scenario: RouteScenario) {
    const currentContains = scenario.expectation?.instruction_contains ?? scenario.expectation?.landmark_name ?? '';
    const contains = window.prompt('Expected Odin text / landmark name. Leave blank for no positive assertion.', currentContains);
    if (contains === null) return;
    const currentForbidden = scenario.expectation?.instruction_not_contains ?? '';
    const forbidden = window.prompt('Forbidden Odin text. Leave blank if not needed.', currentForbidden);
    if (forbidden === null) return;

    setScenarioBusy(true);
    setError('');
    try {
      await updateScenario(scenario.id, {
        expectation: {
          landmark_name: contains.trim(),
          instruction_contains: contains.trim(),
          instruction_not_contains: forbidden.trim(),
          case_sensitive: false,
        },
      });
      setScenarioRunResults((previous) => {
        const next = { ...previous };
        delete next[scenario.id];
        return next;
      });
      await refreshScenarios(`Updated expectations for ${scenario.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScenarioBusy(false);
    }
  }

  async function runAllScenarios() {
    const scenarios = scenarioRegistry?.scenarios ?? [];
    const activeId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
    const runnable = scenarios.filter((scenario) => scenario.dataset === activeId);
    if (runnable.length === 0) {
      setScenarioMessage('No saved scenarios match the active dataset.');
      return;
    }

    setRunAllBusy(true);
    setScenarioMessage(`Running ${runnable.length} scenarios…`);
    let pass = 0;
    let fail = 0;
    let noExpectation = 0;
    let errors = 0;
    try {
      for (const scenario of runnable) {
        const result = await runSavedScenario(scenario);
        if (!result) continue;
        if (result.status === 'pass') pass += 1;
        else if (result.status === 'fail') fail += 1;
        else if (result.status === 'no-expectation') noExpectation += 1;
        else errors += 1;
      }
      setScenarioMessage(`Run all complete: ${pass} PASS · ${fail} FAIL · ${noExpectation} NO EXPECTATION · ${errors} ERROR.`);
    } finally {
      setRunAllBusy(false);
    }
  }

  async function saveCurrentScenario() {
    if (!start || !end) {
      setError('Set both start and end coordinates before saving a scenario.');
      return;
    }
    if (!scenarioName.trim()) {
      setError('Enter a scenario name before saving.');
      return;
    }

    const datasetId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? 'default';
    setScenarioBusy(true);
    setError('');
    setScenarioMessage('');
    try {
      const created = await createScenario({
        name: scenarioName.trim(),
        dataset: datasetId,
        request: {
          start: { lon: start[0], lat: start[1] },
          end: { lon: end[0], lat: end[1] },
          costing: 'auto',
        },
        notes: scenarioNotes.trim(),
        expectation: {
          landmark_name: scenarioExpectedText.trim(),
          instruction_contains: scenarioExpectedText.trim(),
          instruction_not_contains: scenarioForbiddenText.trim(),
          case_sensitive: false,
        },
      });
      setScenarioName('');
      setScenarioNotes('');
      setScenarioExpectedText('');
      setScenarioForbiddenText('');
      await refreshScenarios(`Saved scenario ${created.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScenarioBusy(false);
    }
  }

  async function removeScenario(scenario: RouteScenario) {
    if (!window.confirm(`Delete saved scenario "${scenario.name}"?`)) return;
    setScenarioBusy(true);
    setError('');
    setScenarioMessage('');
    try {
      await deleteScenario(scenario.id);
      await refreshScenarios(`Deleted scenario ${scenario.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScenarioBusy(false);
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
    openPoiPopup(
      map,
      coordinate,
      properties,
    );
  }

  function focusPoi(item: NearbyPoi) {
    focusPoiFeature(item.feature, item.distanceM);
  }

  function focusNarrationEvidence(item: NarrationPoiEvidence) {
    focusPoiFeature(item.feature, item.distanceM ?? undefined);
  }

  function focusRouteNarrationPoi(item: RouteNarrationPoi) {
    setSelectedManeuverIndex(item.primaryManeuverIndex);
    focusPoiFeature(item.evidence.feature, item.evidence.distanceM ?? undefined);
    window.setTimeout(() => {
      document.querySelector(`[data-maneuver-index="${item.primaryManeuverIndex}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
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
          <div className="subtitle">Phase 4B · external predicted-winner vs Odin narration</div>
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

          <div className="landmark-map-legend">
            <div className="landmark-map-legend-title">Map POI evidence</div>
            <span><i className="legend-dot source" />Source POI</span>
            <span><i className="legend-dot strong" />Observed in Odin narration</span>
            <span><i className="legend-dot ambiguous" />Ambiguous name match</span>
            <span><i className="legend-ring predicted" />External predicted winner</span>
            <span><i className="legend-dot selected" />Currently inspected match</span>
          </div>

          {route && (
            <div className="route-narration-overlay">
              <div className="route-narration-overlay-heading">
                <strong>Narration POIs on this route</strong>
                <span>{routeNarrationStrongCount} observed · {predictionCounts.match} predicted match · {predictionCounts.mismatch} mismatch</span>
              </div>
              {routeNarrationPois.length === 0 ? (
                <div className="route-narration-empty">No loaded source POI name was correlated with this route's Odin narration.</div>
              ) : (
                <div className="route-narration-overlay-list">
                  {routeNarrationPois.slice(0, 8).map((item) => (
                    <button
                      key={item.key}
                      className={`route-narration-overlay-item ${item.evidence.evidence}`}
                      onClick={() => focusRouteNarrationPoi(item)}
                      title={item.evidence.matchedInstruction}
                    >
                      <i />
                      <span>
                        <strong>{item.evidence.name}</strong>
                        <small>
                          maneuver {item.primaryManeuverIndex + 1} · {item.evidence.poiId || item.evidence.sourceNodeId || 'source POI'}
                        </small>
                      </span>
                    </button>
                  ))}
                  {routeNarrationPois.length > 8 && (
                    <div className="route-narration-more">+{routeNarrationPois.length - 8} more narration match(es)</div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="side-panel">
          <section className="card dataset-card">
            <div className="maneuver-heading">
              <h2>Dataset Pipeline</h2>
              <span>Phase 4B</span>
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
            <div className="kv"><span>Dataset</span><code>{datasetRegistry?.active_dataset ?? config?.active_dataset ?? 'default'}</code></div>
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

          <section className="card scenarios-card">
            <div className="maneuver-heading">
              <h2>Test Scenarios</h2>
              <span>{scenarioRegistry?.count ?? 0} saved</span>
            </div>
            <div className="scenario-save-grid">
              <input
                value={scenarioName}
                placeholder="Scenario name, e.g. Indian Oil right turn"
                onChange={(event) => setScenarioName(event.target.value)}
              />
              <button onClick={saveCurrentScenario} disabled={scenarioBusy || !start || !end}>
                {scenarioBusy ? 'Working…' : 'Save Current Route'}
              </button>
            </div>
            <div className="scenario-expectation-grid">
              <input
                value={scenarioExpectedText}
                placeholder="Expected Odin text / landmark, e.g. Indian Oil"
                onChange={(event) => setScenarioExpectedText(event.target.value)}
              />
              <input
                value={scenarioForbiddenText}
                placeholder="Forbidden Odin text (optional)"
                onChange={(event) => setScenarioForbiddenText(event.target.value)}
              />
            </div>
            <textarea
              className="scenario-notes"
              value={scenarioNotes}
              placeholder="Optional note about why this route is useful"
              rows={2}
              onChange={(event) => setScenarioNotes(event.target.value)}
            />
            <div className="scenario-suite-actions">
              <button onClick={runAllScenarios} disabled={runAllBusy || scenarioBusy || busy || !(scenarioRegistry?.scenarios.length)}>
                {runAllBusy ? 'Running suite…' : 'Run All Matching Dataset'}
              </button>
              <span>Assertions inspect Odin maneuver instruction + verbal pre-transition text.</span>
            </div>
            {scenarioMessage && <div className="scenario-message">{scenarioMessage}</div>}
            {(scenarioRegistry?.errors ?? []).map((message) => (
              <div className="scenario-warning" key={message}>{message}</div>
            ))}
            <div className="scenario-note">
              Phase 3B evaluates required/forbidden Odin text after each route. A scenario without assertions still runs but reports NO EXPECTATION.
            </div>
            {(scenarioRegistry?.scenarios ?? []).length === 0 ? (
              <div className="empty-state">Set START/END, give the route a name and optionally an expected landmark, then save it.</div>
            ) : (
              <div className="scenario-list">
                {(scenarioRegistry?.scenarios ?? []).map((scenario) => {
                  const activeId = datasetRegistry?.active_dataset ?? config?.active_dataset ?? '';
                  const datasetMismatch = scenario.dataset !== activeId;
                  const result = scenarioRunResults[scenario.id];
                  const expectedText = scenario.expectation?.instruction_contains ?? scenario.expectation?.landmark_name ?? '';
                  const forbiddenText = scenario.expectation?.instruction_not_contains ?? '';
                  return (
                    <div className={`scenario-item ${datasetMismatch ? 'dataset-mismatch' : ''} ${result ? `result-${result.status}` : ''}`} key={scenario.id}>
                      <div className="scenario-main">
                        <div className="scenario-title-row">
                          <strong>{scenario.name}</strong>
                          {result && <span className={`scenario-result-badge ${result.status}`}>{result.status === 'no-expectation' ? 'NO EXPECTATION' : result.status.toUpperCase()}</span>}
                        </div>
                        <small>{scenario.dataset} · {scenario.request.costing}</small>
                        <code>
                          {scenario.request.start.lon.toFixed(6)}, {scenario.request.start.lat.toFixed(6)} → {scenario.request.end.lon.toFixed(6)}, {scenario.request.end.lat.toFixed(6)}
                        </code>
                        {(expectedText || forbiddenText) ? (
                          <div className="scenario-expectation-summary">
                            {expectedText && <span><b>Must contain:</b> {expectedText}</span>}
                            {forbiddenText && <span><b>Must not contain:</b> {forbiddenText}</span>}
                          </div>
                        ) : <span className="scenario-no-expectation">No PASS/FAIL expectation configured.</span>}
                        {scenario.notes && <span>{scenario.notes}</span>}
                        {result?.matchedInstructions.length ? (
                          <span className="scenario-match"><b>Matched:</b> {result.matchedInstructions[0]}</span>
                        ) : null}
                        {result?.failures.map((failure) => <em className="scenario-failure" key={failure}>{failure}</em>)}
                        {result?.error && <em className="scenario-failure">{result.error}</em>}
                        {datasetMismatch && <em>Dataset mismatch: activate {scenario.dataset} before Run.</em>}
                      </div>
                      <div className="scenario-actions">
                        <button onClick={() => loadScenario(scenario)} disabled={scenarioBusy || runAllBusy}>Load</button>
                        <button className="scenario-run" onClick={() => runSavedScenario(scenario)} disabled={scenarioBusy || runAllBusy || busy || datasetMismatch}>Run</button>
                        <button className="scenario-expect" onClick={() => editScenarioExpectation(scenario)} disabled={scenarioBusy || runAllBusy}>Expect</button>
                        <button className="scenario-delete" onClick={() => removeScenario(scenario)} disabled={scenarioBusy || runAllBusy}>Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
                  <li key={item.index} data-maneuver-index={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}>
                    <button className="maneuver-button" onClick={() => focusManeuver(item)}>
                      <strong>{item.maneuver.instruction ?? 'Unnamed maneuver'}</strong>
                      {(() => {
                        const evidence = narrationEvidenceByManeuver.get(item.index) ?? [];
                        if (evidence.some((match) => match.evidence === 'strong')) {
                          return <span className="narration-mini-badge strong">POI observed</span>;
                        }
                        if (evidence.length > 0) {
                          return <span className="narration-mini-badge ambiguous">name match</span>;
                        }
                        return null;
                      })()}
                      {(() => {
                        const prediction = predictionByManeuver.get(item.index);
                        if (!prediction || prediction.status === 'no-candidate') return null;
                        if (prediction.status === 'match') return <span className="prediction-mini-badge match">prediction MATCH</span>;
                        if (prediction.status === 'mismatch') return <span className="prediction-mini-badge mismatch">prediction MISMATCH</span>;
                        if (prediction.status === 'ambiguous-only') return <span className="prediction-mini-badge ambiguous">prediction ambiguous</span>;
                        return <span className="prediction-mini-badge not-observed">predicted · not observed</span>;
                      })()}
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
                <div className="narration-verification">
                  <div className="narration-verification-heading">
                    <strong>External Narration Verification</strong>
                    {!primaryNarrationEvidence ? (
                      <span className="narration-status none">NO SOURCE POI MATCH</span>
                    ) : primaryNarrationEvidence.evidence === 'strong' ? (
                      <span className="narration-status strong">CONFIRMED BY NARRATION</span>
                    ) : (
                      <span className="narration-status ambiguous">AMBIGUOUS NAME MATCH</span>
                    )}
                  </div>

                  {!primaryNarrationEvidence ? (
                    <p>No loaded source POI name was found in this maneuver's Odin instruction within {NARRATION_POI_MAX_DISTANCE_M} m of the maneuver.</p>
                  ) : (
                    <>
                      <button className="narration-primary-match" onClick={() => focusNarrationEvidence(primaryNarrationEvidence)}>
                        <span>
                          <strong>{primaryNarrationEvidence.name}</strong>
                          <small>{primaryNarrationEvidence.landmarkType} · {primaryNarrationEvidence.poiId || 'no mappls_poi_id'}</small>
                        </span>
                        <span>
                          <strong>{primaryNarrationEvidence.distanceM === null ? 'distance n/a' : `${primaryNarrationEvidence.distanceM.toFixed(1)} m`}</strong>
                          <small>priority {primaryNarrationEvidence.priority ?? '—'}</small>
                        </span>
                      </button>
                      <code className="narration-matched-instruction">{primaryNarrationEvidence.matchedInstruction}</code>
                      {primaryNarrationEvidence.evidence === 'ambiguous' && (
                        <p className="narration-caution">The POI name appears in narration, but not in the strong “at &lt;POI&gt;” landmark pattern. It may be a road/place-name coincidence.</p>
                      )}
                      {selectedNarrationEvidence.length > 1 && (
                        <details className="narration-other-matches">
                          <summary>{selectedNarrationEvidence.length - 1} additional source-name match(es)</summary>
                          {selectedNarrationEvidence.slice(1).map((match, index) => (
                            <button key={`${match.poiId}-${match.sourceNodeId}-${index}`} onClick={() => focusNarrationEvidence(match)}>
                              <span>{match.name}</span>
                              <small>{match.distanceM === null ? 'n/a' : `${match.distanceM.toFixed(1)} m`} · priority {match.priority ?? '—'}</small>
                            </button>
                          ))}
                        </details>
                      )}
                    </>
                  )}
                </div>
                <div className="prediction-verification">
                  <div className="prediction-verification-heading">
                    <strong>External Selection Prediction</strong>
                    {!selectedPrediction || selectedPrediction.status === 'no-candidate' ? (
                      <span className="prediction-status no-candidate">NO CANDIDATE</span>
                    ) : selectedPrediction.status === 'match' ? (
                      <span className="prediction-status match">MATCH</span>
                    ) : selectedPrediction.status === 'mismatch' ? (
                      <span className="prediction-status mismatch">MISMATCH</span>
                    ) : selectedPrediction.status === 'ambiguous-only' ? (
                      <span className="prediction-status ambiguous">AMBIGUOUS ONLY</span>
                    ) : (
                      <span className="prediction-status not-observed">NOT OBSERVED</span>
                    )}
                  </div>

                  {!selectedPrediction?.winner ? (
                    <p>No valid source POI was found within the {PREDICTION_CORRIDOR_M} m approach-route corridor for this maneuver.</p>
                  ) : (
                    <>
                      <button
                        className="prediction-winner"
                        onClick={() => focusPoiFeature(selectedPrediction.winner!.feature, selectedPrediction.winner!.distanceToManeuverM)}
                      >
                        <span>
                          <strong>{selectedPrediction.winner.name}</strong>
                          <small>{selectedPrediction.winner.landmarkType} · {selectedPrediction.winner.poiId}</small>
                        </span>
                        <span>
                          <strong>priority {selectedPrediction.winner.priority}</strong>
                          <small>{selectedPrediction.winner.distanceToManeuverM.toFixed(1)} m before maneuver · {selectedPrediction.winner.lateralDistanceM.toFixed(1)} m from route</small>
                        </span>
                      </button>

                      <div className="prediction-comparison">
                        <span><b>Predicted:</b> {selectedPrediction.winner.name}</span>
                        <span><b>Observed:</b> {selectedPrediction.observed?.name ?? 'none in strong narration evidence'}</span>
                        <span><b>Approach:</b> {selectedPrediction.approachLengthM.toFixed(1)} m route segment</span>
                      </div>

                      {selectedPrediction.candidates.length > 1 && (
                        <details className="prediction-candidates">
                          <summary>Top {selectedPrediction.candidates.length} approximate candidate(s)</summary>
                          {selectedPrediction.candidates.map((candidate, index) => (
                            <button key={candidate.key} onClick={() => focusPoiFeature(candidate.feature, candidate.distanceToManeuverM)}>
                              <span className="prediction-rank">{index + 1}</span>
                              <span>
                                <strong>{candidate.name}</strong>
                                <small>{candidate.landmarkType} · {candidate.poiId}</small>
                              </span>
                              <span>
                                <strong>P{candidate.priority}</strong>
                                <small>{candidate.distanceToManeuverM.toFixed(1)} m</small>
                              </span>
                            </button>
                          ))}
                        </details>
                      )}
                    </>
                  )}
                  <p className="prediction-caution">Approximation only: candidate membership is inferred externally from source POIs within {PREDICTION_CORRIDOR_M} m of the previous maneuver's route segment. Ranking mirrors the inspected Odin order: priority DESC → distance-to-maneuver ASC → poi_id ASC. It is not Odin's private candidate list.</p>
                </div>
                <div className="debug-note">Nearby POIs are computed from source data. “Confirmed by narration” means the existing Odin text strongly matches a loaded POI name; it does not claim access to Odin's private candidate/selected-landmark object.</div>
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
