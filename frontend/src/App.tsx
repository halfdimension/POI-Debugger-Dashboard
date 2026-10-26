import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import maplibregl, { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { getDatasets, getOsrmStatus, getValhallaStatus, reloadDatasetPois, requestCompareRoute, updatePreferences } from './api';
import { haversineMeters, updateCoordinateValue } from './coordinates';
import { decodePolyline6 } from './polyline';
import { pointFeature, propNumber, propText } from './poi';
import { fetchDiagnosticPois, mergePoiPages, queryPois, searchPois, type PoiBounds, type PoiSearchCondition, type PoiSearchResponse } from './poiSearchApi';
import { loadInitialDashboard } from './initialization';
import { developmentLogin, getAuthConfig, getCurrentSession, logout, setAuthSession, type AuthConfig, type AuthSession } from './auth';
import { AnalysisWorkspace, Sidebar } from './components/DashboardLayout';
import { AdminConsole } from './components/admin/AdminConsole';
import { AnalysisTabContent } from './components/analysis/AnalysisTabContent';
import { AuthenticationScreen } from './components/auth/AuthenticationScreen';
import { CompactDatasetSelector } from './components/datasets/DatasetSelector';
import { CompactPoiExplorer } from './components/datasets/PoiExplorer';
import type { ManeuverView, NarrationPoiEvidence, NearbyPoi, OsrmRouteNarrationPoi, OsrmStepView, RouteNarrationPoi } from './components/inspection/viewModels';
import { ManeuverInspection } from './components/inspection/ManeuverInspection';
import { SelectedPoiDetails } from './components/inspection/SelectedPoiDetails';
import { MapContextMenu, type MapContextMenuLocation } from './components/map/MapContextMenu';
import {
  bindDebouncedViewportListener,
  expandPoiCluster,
  explorerPoiSource,
  incompleteViewportMessage,
  INDIVIDUAL_POI_LAYER_ID,
  POI_CLUSTER_COUNT_LAYER_ID,
  POI_CLUSTER_LAYER_ID,
  ViewportRequestCoordinator,
  viewportPoiLabel,
  viewportRequestKey,
} from './components/map/poiMap';
import { RouteSetupControls } from './components/route/RouteSetupControls';
import { RouteComparisonSummary } from './components/route/RouteComparisonSummary';
import { SavedScenarioControls } from './components/scenarios/SavedScenarioControls';
import { TestcaseManagementSections } from './components/scenarios/TestcaseManagementSections';
import { testcaseRoutePoints } from './features/testcases/testcaseExecution';
import { useTestcaseManagement, type TestcaseTab } from './features/testcases/useTestcaseManagement';
import {
  initialDashboardLayout,
  selectAnalysisTab,
  togglePanel,
} from './layoutState';
import {
  hasStrongLandmarkCue,
  instructionContainsName,
  maneuverInstructionTexts,
  narrationPoiKey,
  normalizeNarrationText,
  osrmInstructionText,
} from './narration';
import type { CandidateAnalysis, CandidateAnalysisManeuver, DatasetRegistryResponse, DatasetSummary, DebuggerConfig, LngLat, OsrmRouteResponse, RouteScenario, UserPreferencesPatch, ValhallaRouteResponse } from './types';
import { useVerticalPanelResize } from './useVerticalPanelResize';

declare const __VPD_MOCK_API__: boolean;

type PickMode = 'start' | 'end';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const NEARBY_POI_RADIUS_M = 100;
const NEARBY_POI_LIMIT = 12;
const NARRATION_POI_MAX_DISTANCE_M = 500;
const VIEWPORT_POI_LIMIT = 500;
const SEARCH_POI_LIMIT = 50;
const ANALYSIS_HEIGHT_STORAGE_KEY = 'poi-dashboard.analysis-height';
const DEFAULT_ANALYSIS_HEIGHT = 300;

function storedAnalysisHeight(): number {
  try {
    const value = Number(window.localStorage.getItem(ANALYSIS_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_ANALYSIS_HEIGHT;
  } catch {
    return DEFAULT_ANALYSIS_HEIGHT;
  }
}

function visibleMapBounds(map: MapLibreMap): PoiBounds | null {
  const bounds = map.getBounds();
  let west = bounds.getWest();
  let east = bounds.getEast();
  const width = east - west;
  if (width >= 360) return [-180, bounds.getSouth(), 180, bounds.getNorth()];
  while (west < -180 && east <= -180) { west += 360; east += 360; }
  while (east > 180 && west >= 180) { west -= 360; east -= 360; }
  if (west < -180 || east > 180 || west > east) return null;
  return [west, Math.max(-90, bounds.getSouth()), east, Math.min(90, bounds.getNorth())];
}

function fmtSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}



function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

type PolylineProjection = {
  lateralDistanceM: number;
  distanceAlongM: number;
  remainingDistanceM: number;
  totalLengthM: number;
};

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

function makePoiPopupDraggable(
  popup: maplibregl.Popup,
  map: maplibregl.Map,
): () => void {
  const popupElement = popup.getElement();
  const title = popupElement.querySelector<HTMLElement>('.poi-popup-title');
  if (!title) return () => {};

  let dragging = false;
  let pointerId: number | null = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let offsetStartX = 0;
  let offsetStartY = 0;
  let offsetX = 0;
  let offsetY = 0;

  popupElement.classList.add('draggable-poi-popup');

  const setClampedOffset = (nextX: number, nextY: number) => {
    popupElement.style.translate = `${nextX}px ${nextY}px`;

    const mapRect = map.getContainer().getBoundingClientRect();
    const popupRect = popupElement.getBoundingClientRect();
    const padding = 4;

    if (popupRect.width <= mapRect.width - padding * 2) {
      if (popupRect.left < mapRect.left + padding) {
        nextX += mapRect.left + padding - popupRect.left;
      } else if (popupRect.right > mapRect.right - padding) {
        nextX -= popupRect.right - (mapRect.right - padding);
      }
    }

    if (popupRect.height <= mapRect.height - padding * 2) {
      if (popupRect.top < mapRect.top + padding) {
        nextY += mapRect.top + padding - popupRect.top;
      } else if (popupRect.bottom > mapRect.bottom - padding) {
        nextY -= popupRect.bottom - (mapRect.bottom - padding);
      }
    }

    popupElement.style.translate = `${nextX}px ${nextY}px`;
    offsetX = nextX;
    offsetY = nextY;
  };

  const stopDragging = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
    popupElement.classList.remove('is-dragging');
    if (title.hasPointerCapture(event.pointerId)) {
      title.releasePointerCapture(event.pointerId);
    }
    pointerId = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    offsetStartX = offsetX;
    offsetStartY = offsetY;
    popupElement.classList.add('is-dragging');
    title.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setClampedOffset(
      offsetStartX + event.clientX - pointerStartX,
      offsetStartY + event.clientY - pointerStartY,
    );
  };

  const stopClickPropagation = (event: MouseEvent) => event.stopPropagation();

  title.addEventListener('pointerdown', onPointerDown);
  title.addEventListener('pointermove', onPointerMove);
  title.addEventListener('pointerup', stopDragging);
  title.addEventListener('pointercancel', stopDragging);
  title.addEventListener('lostpointercapture', stopDragging);
  title.addEventListener('click', stopClickPropagation);

  return () => {
    title.removeEventListener('pointerdown', onPointerDown);
    title.removeEventListener('pointermove', onPointerMove);
    title.removeEventListener('pointerup', stopDragging);
    title.removeEventListener('pointercancel', stopDragging);
    title.removeEventListener('lostpointercapture', stopDragging);
    title.removeEventListener('click', stopClickPropagation);
  };
}

type Basemap = 'openfreemap' | 'mapmyindia';

function Dashboard({ session, onLogout }: { session: AuthSession; onLogout: () => Promise<void> }) {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const analysisWorkspaceRef = useRef<HTMLElement | null>(null);

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
    const removeDragHandlers = makePoiPopupDraggable(popup, map);

    popup.on('close', () => {
      removeDragHandlers();
      if (activePoiPopupRef.current === popup) {
        activePoiPopupRef.current = null;
      }
    });

    activePoiPopupRef.current = popup;
  }

  function syncGeoJsonSource(
    sourceId: string,
    data: GeoJSON.FeatureCollection,
  ) {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const source =
        map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;

      if (!source) return false;

      source.setData(data);
      return true;
    };

    // Normal case: map/source already exists.
    if (apply()) return;

    // Defensive case: route response arrived around map/style startup.
    // Replay once MapLibre reaches an idle state.
    map.once('idle', apply);
  }


  const [config, setConfig] = useState<DebuggerConfig | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'debugger' | 'admin'>('debugger');
  const [initializationError, setInitializationError] = useState('');
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [basemap, setBasemap] = useState<Basemap>('mapmyindia');
  const basemapRef = useRef<Basemap>('mapmyindia');
  const [pickMode, setPickMode] = useState<PickMode>('start');
  const [start, setStart] = useState<LngLat | null>(null);
  const [end, setEnd] = useState<LngLat | null>(null);
  const [mapContextMenu, setMapContextMenu] = useState<MapContextMenuLocation | null>(null);
  const [pois, setPois] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [viewportMeta, setViewportMeta] = useState({ loading: false, error: '', incomplete: false });
  const [viewportRevision, setViewportRevision] = useState(0);
  const viewportRequestsRef = useRef(new ViewportRequestCoordinator());
  const [searchResponse, setSearchResponse] = useState<PoiSearchResponse | null>(null);
  const [searchFeatures, setSearchFeatures] = useState<GeoJSON.Feature<GeoJSON.Point>[]>([]);
  const [searchState, setSearchState] = useState({ loading: false, loadingMore: false, error: '' });
  const [searchRetry, setSearchRetry] = useState(0);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const [diagnosticPois, setDiagnosticPois] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [diagnosticWarning, setDiagnosticWarning] = useState('');
  const [diagnosticStatus, setDiagnosticStatus] = useState<'idle' | 'loading' | 'complete' | 'incomplete' | 'unavailable'>('idle');
  const diagnosticRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const completedDiagnosticKeyRef = useRef('');
  const [route, setRoute] = useState<ValhallaRouteResponse | null>(null);
  const [routeGeoJson, setRouteGeoJson] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [osrmRoute, setOsrmRoute] = useState<OsrmRouteResponse | null>(null);
  const [osrmRouteGeoJson, setOsrmRouteGeoJson] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [valhallaCandidateAnalysis, setValhallaCandidateAnalysis] = useState<CandidateAnalysis | null>(null);
  const [osrmCandidateAnalysis, setOsrmCandidateAnalysis] = useState<CandidateAnalysis | null>(null);
  const [valhallaStatus, setValhallaStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [osrmStatus, setOsrmStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [routeView, setRouteView] = useState<'both' | 'valhalla' | 'osrm'>('both');
  const [routeComparisonCollapsed, setRouteComparisonCollapsed] = useState(true);
  const [routePoiCardCollapsed, setRoutePoiCardCollapsed] = useState(true);
  const [layout, setLayout] = useState(initialDashboardLayout);
  const [preferredAnalysisHeight, setPreferredAnalysisHeight] = useState(storedAnalysisHeight);
  const [inspectorTab, setInspectorTab] = useState<'poi' | 'route' | 'maneuver'>('route');
  const [map3D, setMap3D] = useState(false);
  const [showCandidateMap, setShowCandidateMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [selectedManeuverIndex, setSelectedManeuverIndex] = useState<number | null>(null);
  const [selectedOsrmStepIndex, setSelectedOsrmStepIndex] = useState<number | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<GeoJSON.Feature<GeoJSON.Point> | null>(null);
  const [datasetRegistry, setDatasetRegistry] = useState<DatasetRegistryResponse | null>(null);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [datasetMessage, setDatasetMessage] = useState('');
  const activeDatasetIdRef = useRef('');
  const lastSavedPreferencesRef = useRef('');
  const preferencesReadyRef = useRef(false);
  const routeRequestRef = useRef<AbortController | null>(null);

  const persistAnalysisHeight = useCallback((height: number) => {
    setPreferredAnalysisHeight(height);
    try { window.localStorage.setItem(ANALYSIS_HEIGHT_STORAGE_KEY, String(Math.round(height))); } catch { /* Storage can be unavailable in hardened browsers. */ }
  }, []);
  const analysisResize = useVerticalPanelResize({
    workspaceRef,
    panelRef: analysisWorkspaceRef,
    preferredHeight: preferredAnalysisHeight,
    onPreferredHeightChange: persistAnalysisHeight,
    disabled: layout.analysisCollapsed,
  });

  const testcases = useTestcaseManagement({
    activeDatasetId: datasetRegistry?.active_dataset ?? config?.active_dataset,
    start,
    end,
    onError: setError,
    onLoadIntoDashboard: loadTestcaseIntoDashboard,
    executeRoute: executeTestcaseRoute,
  });

  const [poiSearch, setPoiSearch] = useState('');
  const [debouncedPoiSearch, setDebouncedPoiSearch] = useState('');
  const [draftConditions, setDraftConditions] = useState<PoiSearchCondition[]>([]);
  const [advancedConditions, setAdvancedConditions] = useState<PoiSearchCondition[]>([]);
  const [conditionMode, setConditionMode] = useState<'and' | 'or'>('and');
  const [appliedConditionMode, setAppliedConditionMode] = useState<'and' | 'or'>('and');
  const [searchScope, setSearchScope] = useState<'dataset' | 'viewport'>('dataset');
  const [appliedSearchScope, setAppliedSearchScope] = useState<'dataset' | 'viewport'>('dataset');
  const [showPois, setShowPois] = useState(true);
  const searchViewportRevision = appliedSearchScope === 'viewport' ? viewportRevision : 0;
  const searchCriteriaKey = JSON.stringify([datasetRegistry?.active_dataset ?? '', debouncedPoiSearch.trim(), appliedConditionMode, advancedConditions, appliedSearchScope, searchViewportRevision]);
  const searchCriteriaRef = useRef(searchCriteriaKey);
  searchCriteriaRef.current = searchCriteriaKey;
  activeDatasetIdRef.current = datasetRegistry?.active_dataset ?? '';

  const toggleLayoutPanel = (panel: 'left' | 'right' | 'analysis') => {
    setLayout((current) => togglePanel(current, panel));
  };

  const openInspector = (tab: 'poi' | 'route' | 'maneuver') => {
    setInspectorTab(tab);
    setLayout((current) => ({ ...current, rightCollapsed: false }));
  };

  const openTestcases = (tab: TestcaseTab) => {
    testcases.setActiveTab(tab);
    setLayout((current) => selectAnalysisTab(current, 'scenarios'));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPoiSearch(poiSearch), 300);
    return () => window.clearTimeout(timer);
  }, [poiSearch]);

  const activeDataset = useMemo<DatasetSummary | null>(() => {
    if (!datasetRegistry) return null;
    return datasetRegistry.datasets.find((dataset) => dataset.id === datasetRegistry.active_dataset) ?? null;
  }, [datasetRegistry]);

  const availablePoiTypes = useMemo(() => {
    return Object.keys(activeDataset?.stats?.landmark_types ?? {}).sort((a, b) => a.localeCompare(b));
  }, [activeDataset]);

  const advancedFilters = {
    conditions: draftConditions,
    mode: conditionMode,
    scope: searchScope,
    availablePoiTypes,
    priorityPolicy: activeDataset?.priority ?? { rank_order: 'descending' as const, minimum: null, maximum: null },
    onConditionsChange: setDraftConditions,
    onModeChange: setConditionMode,
    onScopeChange: setSearchScope,
    onApply: () => {
      setAdvancedConditions(draftConditions);
      setAppliedConditionMode(conditionMode);
      setAppliedSearchScope(searchScope);
    },
    onClear: () => {
      setDraftConditions([]);
      setAdvancedConditions([]);
    },
  };

  const filteredPoiFeatures = useMemo<GeoJSON.Feature<GeoJSON.Point>[]>(() => {
    return pois.features.map(pointFeature).filter((feature): feature is GeoJSON.Feature<GeoJSON.Point> => feature !== null);
  }, [pois]);

  const filteredPois = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: filteredPoiFeatures,
  }), [filteredPoiFeatures]);

  const searchResults = searchFeatures;

  const maneuverViews = useMemo<ManeuverView[]>(() => {
    const result: ManeuverView[] = [];
    let globalIndex = 0;
    for (const [legIndex, leg] of (route?.trip?.legs ?? []).entries()) {
      const coordinates = leg.shape ? decodePolyline6(leg.shape) : [];
      for (const [maneuverIndex, maneuver] of (leg.maneuvers ?? []).entries()) {
        const shapeIndex = maneuver.begin_shape_index;
        const coordinate = typeof shapeIndex === 'number' && shapeIndex >= 0 && shapeIndex < coordinates.length
          ? coordinates[shapeIndex]
          : null;
        result.push({
          index: globalIndex++,
          legIndex,
          maneuverIndex,
          maneuver,
          coordinate,
        });
      }
    }
    return result;
  }, [route]);

  const selectedManeuver = useMemo(
    () => selectedManeuverIndex === null ? null : maneuverViews.find((item) => item.index === selectedManeuverIndex) ?? null,
    [maneuverViews, selectedManeuverIndex],
  );

  const osrmStepViews = useMemo<OsrmStepView[]>(() => {
    const result: OsrmStepView[] = [];
    let globalIndex = 0;

    for (const [legIndex, leg] of (osrmRoute?.routes?.[0]?.legs ?? []).entries()) {
      for (const [stepIndex, step] of (leg.steps ?? []).entries()) {
        const location = step.maneuver?.location;
        const coordinate = Array.isArray(location) && location.length >= 2
          ? [Number(location[0]), Number(location[1])] as LngLat
          : null;

        result.push({
          index: globalIndex++,
          legIndex,
          stepIndex,
          step,
          coordinate,
        });
      }
    }

    return result;
  }, [osrmRoute]);


  const selectedOsrmStepView = useMemo(
    () =>
      selectedOsrmStepIndex === null
        ? null
        : (
          osrmStepViews.find(
            (item) =>
              item.index === selectedOsrmStepIndex,
          ) ?? null
        ),
    [osrmStepViews, selectedOsrmStepIndex],
  );

  const selectedValhallaCandidateAnalysis = useMemo(
    () => {
      if (
        !selectedManeuver ||
        !valhallaCandidateAnalysis
      ) {
        return null;
      }

      return (
        valhallaCandidateAnalysis.maneuvers.find(
          (item) =>
            item.leg_index === selectedManeuver.legIndex &&
            item.maneuver_index ===
              selectedManeuver.maneuverIndex,
        ) ?? null
      );
    },
    [
      selectedManeuver,
      valhallaCandidateAnalysis,
    ],
  );

  const selectedOsrmCandidateAnalysis = useMemo(
    () => {
      if (
        !selectedOsrmStepView ||
        !osrmCandidateAnalysis
      ) {
        return null;
      }

      return (
        osrmCandidateAnalysis.maneuvers.find(
          (item) =>
            item.leg_index ===
              selectedOsrmStepView.legIndex &&
            item.step_index ===
              selectedOsrmStepView.stepIndex,
        ) ?? null
      );
    },
    [
      selectedOsrmStepView,
      osrmCandidateAnalysis,
    ],
  );

  async function installMapmyindiaBasemap(map: MapLibreMap) {
    try {
      const response = await fetch('/mapmyindia-style.json');

      if (!response.ok) {
        throw new Error(`Style HTTP ${response.status}`);
      }

      const style = await response.json();
      const raster = style.sources?.mapmyindia;

      if (raster?.type !== 'raster' || !Array.isArray(raster.tiles)) {
        throw new Error('Invalid MapmyIndia raster source');
      }

      if (mapRef.current !== map) return;

      map.addSource('mapmyindia-tiles', {
        type: 'raster',
        tiles: raster.tiles,
        tileSize: raster.tileSize ?? 256,
        attribution: raster.attribution ?? '© MapmyIndia',
      });

      map.addLayer(
        {
          id: 'mapmyindia-raster',
          type: 'raster',
          source: 'mapmyindia-tiles',
          layout: {
            visibility: basemapRef.current === 'mapmyindia' ? 'visible' : 'none',
          },
        },
        'osrm-route',
      );
    } catch (error) {
      console.error('MapmyIndia basemap failed:', error);
    }
  }

  useEffect(() => {
    if (!showCandidateMap) {
      syncGeoJsonSource(
        'candidate-analysis-map',
        EMPTY_FC,
      );
      return;
    }

    let engine: 'valhalla' | 'osrm' | null = null;

    let analysis:
      CandidateAnalysisManeuver | null = null;

    let origin:
      LngLat | null = null;

    if (
      selectedManeuver &&
      selectedValhallaCandidateAnalysis
    ) {
      engine = 'valhalla';
      analysis = selectedValhallaCandidateAnalysis;

      // Display-only visualization origin.
      //
      // Valhalla's current authoritative landmark_debug does not
      // expose the maneuver coordinate, so use the already-rendered
      // Odin begin_shape_index route position.
      //
      // Do not use this coordinate to recalculate engine decisions.
      origin = selectedManeuver.coordinate;
    } else if (
      selectedOsrmStepView &&
      selectedOsrmCandidateAnalysis
    ) {
      engine = 'osrm';
      analysis = selectedOsrmCandidateAnalysis;

      const debugCoordinate =
        analysis.maneuver?.coordinate;

      if (
        Array.isArray(debugCoordinate) &&
        debugCoordinate.length >= 2 &&
        Number.isFinite(Number(debugCoordinate[0])) &&
        Number.isFinite(Number(debugCoordinate[1]))
      ) {
        origin = [
          Number(debugCoordinate[0]),
          Number(debugCoordinate[1]),
        ];
      } else {
        origin = selectedOsrmStepView.coordinate;
      }
    }

    if (
      !engine ||
      !analysis ||
      !origin
    ) {
      syncGeoJsonSource(
        'candidate-analysis-map',
        EMPTY_FC,
      );
      return;
    }

    const features:
      GeoJSON.Feature[] = [];

    const bounds =
      new LngLatBounds();

    bounds.extend(origin);

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: origin,
      },
      properties: {
        kind: 'origin',
        engine,
        name:
          engine === 'valhalla'
            ? `Odin maneuver ${
                (selectedManeuver?.index ?? 0) + 1
              }`
            : `OSRM step ${
                (selectedOsrmStepView?.index ?? 0) + 1
              }`,
      },
    });

    for (
      const [
        candidateIndex,
        candidate,
      ] of analysis.candidates.entries()
    ) {
      const coordinate =
        candidate.coordinate;

      if (
        !Array.isArray(coordinate) ||
        coordinate.length < 2
      ) {
        continue;
      }

      const lon =
        Number(coordinate[0]);

      const lat =
        Number(coordinate[1]);

      if (
        !Number.isFinite(lon) ||
        !Number.isFinite(lat)
      ) {
        continue;
      }

      const candidateCoordinate:
        LngLat = [lon, lat];

      bounds.extend(candidateCoordinate);

      const properties = {
        kind: 'candidate',
        engine,
        candidate_index: candidateIndex,
        poi_id:
          candidate.poi_id ?? '',
        osm_node_id:
          candidate.osm_node_id ?? '',
        name:
          candidate.name ??
          'Unnamed POI',
        status:
          candidate.status ??
          'UNKNOWN',
        selected:
          candidate.selected === true,
        eligible:
          candidate.eligible ?? '',
        priority:
          candidate.priority ?? '',
        distance_m:
          engine === 'osrm'
            ? candidate.maneuver_distance_m ?? ''
            : candidate.distance_m ?? '',
        maneuver_distance_m:
          candidate.maneuver_distance_m ?? '',
        perpendicular_distance_m:
          candidate.perpendicular_distance_m ?? '',
        route_edge_role:
          engine === 'osrm'
            ? (
              candidate.on_incoming && candidate.on_outgoing
                ? 'incoming + outgoing'
                : candidate.on_incoming
                  ? 'incoming'
                  : candidate.on_outgoing
                    ? 'outgoing'
                    : ''
            )
            : '',
        on_incoming:
          candidate.on_incoming ?? '',
        on_outgoing:
          candidate.on_outgoing ?? '',

        incoming_association_augmented:
          candidate.incoming_association_augmented ?? '',
        outgoing_association_augmented:
          candidate.outgoing_association_augmented ?? '',
        association_augmented:
          candidate.association_augmented ?? '',

        association_confidence:
          candidate.association_augmented === true
            ? 'augmented fallback'
            : candidate.association_augmented === false
              ? 'normal'
              : '',

        reason:
          candidate.reason ?? '',
      };

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            origin,
            candidateCoordinate,
          ],
        },
        properties: {
          ...properties,
          kind: 'link',
        },
      });

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates:
            candidateCoordinate,
        },
        properties,
      });
    }

    const collection:
      GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features,
      };

    syncGeoJsonSource(
      'candidate-analysis-map',
      collection,
    );

    const map = mapRef.current;

    if (
      map &&
      features.length > 1
    ) {
      map.fitBounds(
        bounds,
        {
          padding: {
            top: 90,
            right: 430,
            bottom: 90,
            left: 390,
          },
          maxZoom: 18.5,
          duration: 700,
        },
      );
    }
  }, [
    showCandidateMap,
    selectedManeuver,
    selectedOsrmStepView,
    selectedValhallaCandidateAnalysis,
    selectedOsrmCandidateAnalysis,
  ]);

  // Candidate Analysis owns the turn fan-out visualization while enabled.
  //
  // The dashboard already has an older POI <-> turn inspection source:
  //   poi-turn-inspection-line
  //   poi-turn-inspection-turn
  //
  // Its Valhalla line is blue. If it remains visible together with the new
  // Candidate Analysis fan-out, one POI can appear to have two relationships.
  //
  // Do not delete or mutate the old source. Hide only its rendering layers
  // while Candidate Analysis is enabled, then restore them afterwards.
  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const visibility =
      showCandidateMap
        ? 'none'
        : 'visible';

    for (const layerId of [
      'poi-turn-inspection-line',
      'poi-turn-inspection-turn',
    ]) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(
          layerId,
          'visibility',
          visibility,
        );
      }
    }
  }, [showCandidateMap]);

  const osrmPoiNamesByStep = useMemo(() => {
    const result = new Map<number, string[]>();

    for (const item of osrmStepViews) {
      const instruction = osrmInstructionText(item.step);
      const names: string[] = [];

      for (const rawFeature of diagnosticPois.features) {
        const feature = pointFeature(rawFeature);
        if (!feature) continue;

        const name = propText(feature.properties, 'name', '').trim();
        if (!name) continue;

        if (
          instructionContainsName(instruction, name) &&
          hasStrongLandmarkCue(instruction, name) &&
          !names.includes(name)
        ) {
          names.push(name);
        }
      }

      result.set(item.index, names);
    }

    return result;
  }, [osrmStepViews, diagnosticPois]);

  const osrmRouteNarrationPois = useMemo<OsrmRouteNarrationPoi[]>(() => {
    const grouped = new Map<string, OsrmRouteNarrationPoi>();

    for (const item of osrmStepViews) {
      const instruction = osrmInstructionText(item.step);

      if (!instruction) continue;

      const matches: NarrationPoiEvidence[] = [];

      for (const rawFeature of diagnosticPois.features) {
        const feature = pointFeature(rawFeature);
        if (!feature) continue;

        const properties = feature.properties ?? {};
        const name = propText(properties, 'name', '').trim();

        if (!name || normalizeNarrationText(name).length < 3) continue;

        // For the OSRM fork, a POI-bearing turn is currently emitted as
        // "Turn <modifier> at <landmark>".
        if (!instructionContainsName(instruction, name)) continue;
        if (!hasStrongLandmarkCue(instruction, name)) continue;

        const coordinate = feature.geometry.coordinates as LngLat;

        const distanceM = item.coordinate
          ? haversineMeters(item.coordinate, coordinate)
          : null;

        if (
          distanceM !== null &&
          distanceM > NARRATION_POI_MAX_DISTANCE_M
        ) {
          continue;
        }

        matches.push({
          feature,
          coordinate,
          distanceM,
          priority: propNumber(properties, 'priority'),
          name,
          landmarkType: propText(properties, 'landmark_type', 'unknown'),
          poiId: propText(properties, 'mappls_poi_id', ''),
          sourceNodeId: propText(properties, 'new_node_id', ''),
          evidence: 'strong',
          matchedInstruction: instruction,
        });
      }

      if (matches.length === 0) continue;

      // Prefer the closest matching source POI when duplicate names exist.
      matches.sort((a, b) => {
        const distanceA = a.distanceM ?? Number.POSITIVE_INFINITY;
        const distanceB = b.distanceM ?? Number.POSITIVE_INFINITY;

        if (distanceA !== distanceB) {
          return distanceA - distanceB;
        }

        return (b.priority ?? -1) - (a.priority ?? -1);
      });

      const primary = matches[0];
      const key = narrationPoiKey(primary);

      const existing = grouped.get(key);

      if (!existing) {
        grouped.set(key, {
          key,
          evidence: primary,
          stepIndexes: [item.index],
          primaryStepIndex: item.index,
        });

        continue;
      }

      if (!existing.stepIndexes.includes(item.index)) {
        existing.stepIndexes.push(item.index);
      }

      const existingDistance =
        existing.evidence.distanceM ?? Number.POSITIVE_INFINITY;

      const newDistance =
        primary.distanceM ?? Number.POSITIVE_INFINITY;

      if (newDistance < existingDistance) {
        existing.evidence = primary;
        existing.primaryStepIndex = item.index;
      }
    }

    return Array.from(grouped.values()).sort(
      (a, b) => a.primaryStepIndex - b.primaryStepIndex,
    );
  }, [osrmStepViews, diagnosticPois]);

  const osrmGeometryPointCount =
    osrmRoute?.routes?.[0]?.geometry?.coordinates?.length ?? 0;

  const routeComparison = useMemo(() => {
    const valhallaSummary = route?.trip?.summary;
    const osrmSummary = osrmRoute?.routes?.[0];

    const valhallaDistanceKm =
      typeof valhallaSummary?.length === 'number'
        ? valhallaSummary.length
        : null;

    const valhallaDurationMin =
      typeof valhallaSummary?.time === 'number'
        ? valhallaSummary.time / 60
        : null;

    const osrmDistanceKm =
      typeof osrmSummary?.distance === 'number'
        ? osrmSummary.distance / 1000
        : null;

    const osrmDurationMin =
      typeof osrmSummary?.duration === 'number'
        ? osrmSummary.duration / 60
        : null;

    const distanceDeltaKm =
      valhallaDistanceKm !== null && osrmDistanceKm !== null
        ? osrmDistanceKm - valhallaDistanceKm
        : null;

    const timeDeltaMin =
      valhallaDurationMin !== null && osrmDurationMin !== null
        ? osrmDurationMin - valhallaDurationMin
        : null;

    const distanceDeltaPct =
      distanceDeltaKm !== null &&
      valhallaDistanceKm !== null &&
      valhallaDistanceKm !== 0
        ? (distanceDeltaKm / valhallaDistanceKm) * 100
        : null;

    const timeDeltaPct =
      timeDeltaMin !== null &&
      valhallaDurationMin !== null &&
      valhallaDurationMin !== 0
        ? (timeDeltaMin / valhallaDurationMin) * 100
        : null;

    return {
      valhallaDistanceKm,
      valhallaDurationMin,
      osrmDistanceKm,
      osrmDurationMin,
      distanceDeltaKm,
      timeDeltaMin,
      distanceDeltaPct,
      timeDeltaPct,
    };
  }, [route, osrmRoute]);

  const nearbyPois = useMemo<NearbyPoi[]>(() => {
    if (!selectedManeuver?.coordinate) return [];
    const result: NearbyPoi[] = [];

    for (const rawFeature of diagnosticPois.features) {
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
  }, [diagnosticPois, selectedManeuver]);

  const narrationEvidenceByManeuver = useMemo(() => {
    const result = new Map<number, NarrationPoiEvidence[]>();

    for (const item of maneuverViews) {
      const instructions = maneuverInstructionTexts(item.maneuver);
      if (instructions.length === 0) {
        result.set(item.index, []);
        continue;
      }

      const matches: NarrationPoiEvidence[] = [];

      for (const rawFeature of diagnosticPois.features) {
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
  }, [maneuverViews, diagnosticPois]);

  const routeNarrationPois = useMemo<RouteNarrationPoi[]>(() => {
    const grouped = new Map<string, RouteNarrationPoi>();

    for (const item of maneuverViews) {
      // Phase 4A sorts evidence strongest-first. For the route-wide map layer we
      // intentionally keep one primary source-POI match per maneuver, then
      // deduplicate the same POI across maneuvers.
      const primary = (narrationEvidenceByManeuver.get(item.index) ?? [])
        .find((match) => match.evidence === 'strong');
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

  const valhallaRoutePoiKeys = useMemo(
    () => new Set(routeNarrationPois.map((item) => item.key)),
    [routeNarrationPois],
  );

  const osrmRoutePoiKeys = useMemo(
    () => new Set(osrmRouteNarrationPois.map((item) => item.key)),
    [osrmRouteNarrationPois],
  );

  const routeNarrationStrongCount = useMemo(
    () => routeNarrationPois.filter((item) => item.evidence.evidence === 'strong').length,
    [routeNarrationPois],
  );

  const selectedNarrationEvidence = useMemo(
    () => selectedManeuverIndex === null
      ? []
      : (narrationEvidenceByManeuver.get(selectedManeuverIndex) ?? [])
          .filter((match) => match.evidence === 'strong'),
    [narrationEvidenceByManeuver, selectedManeuverIndex],
  );

  const primaryNarrationEvidence = selectedNarrationEvidence[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setInitializationError('');
        setError('');
        const initial = await loadInitialDashboard();
        if (cancelled) return;
        setConfig(initial.config);
        setDatasetRegistry(initial.datasets);
        testcases.initializeRegistry(initial.scenarios);
        basemapRef.current = initial.preferences.preferred_basemap;
        setBasemap(initial.preferences.preferred_basemap);
        setMap3D(initial.preferences.map_display_mode === '3d');
        setRouteView(initial.preferences.route_view);
        setLayout(initial.preferences.layout);
        lastSavedPreferencesRef.current = JSON.stringify({
          preferred_basemap: initial.preferences.preferred_basemap,
          map_display_mode: initial.preferences.map_display_mode,
          route_view: initial.preferences.route_view,
          layout: initial.preferences.layout,
        });
        preferencesReadyRef.current = true;
        if (initial.preferences.dataset_selection_fallback) {
          setDatasetMessage(`Dataset ${initial.preferences.unavailable_dataset_id ?? ''} is unavailable; using ${initial.preferences.selected_dataset_id}.`);
        }

        const [valhallaStatusResponse, osrmStatusResponse] = await Promise.all([
          getValhallaStatus(),
          getOsrmStatus(),
        ]);
        if (cancelled) return;
        setValhallaStatus(valhallaStatusResponse.ok ? 'up' : 'down');
        setOsrmStatus(osrmStatusResponse.ok ? 'up' : 'down');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setInitializationError(message);
        setValhallaStatus('down');
        setOsrmStatus('down');
      }
    })();
    return () => { cancelled = true; };
  }, [initializationAttempt]);

  useEffect(() => {
    if (!preferencesReadyRef.current) return;
    const payload: UserPreferencesPatch = {
      preferred_basemap: basemap,
      map_display_mode: map3D ? '3d' : '2d',
      route_view: routeView,
      layout,
    };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedPreferencesRef.current) return;
    const timer = window.setTimeout(() => {
      updatePreferences(payload).then(() => {
        lastSavedPreferencesRef.current = serialized;
      }).catch((err) => {
        setError(`Could not save dashboard preferences: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [basemap, map3D, routeView, layout]);

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
      // OSRM goes underneath as a thick red line.
      // When Valhalla follows the same geometry, the red OSRM line remains
      // visible as a casing around the thinner blue Valhalla line.
      map.addSource('osrm-route', { type: 'geojson', data: EMPTY_FC });
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

      // Valhalla is intentionally rendered above OSRM.
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
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

      map.addSource('pois', explorerPoiSource(showPois ? filteredPois : EMPTY_FC));
      map.addLayer({
        id: POI_CLUSTER_LAYER_ID,
        type: 'circle',
        source: 'pois',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 15, 25, 18, 100, 22, 250, 26],
          'circle-color': ['step', ['get', 'point_count'], '#6d5bd0', 100, '#5746b8', 250, '#43338f'],
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(255,255,255,.9)',
          'circle-opacity': 0.94,
        },
      });
      map.addLayer({
        id: POI_CLUSTER_COUNT_LAYER_ID,
        type: 'symbol',
        source: 'pois',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
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
      map.addLayer({
        id: 'pois',
        type: 'circle',
        source: 'pois',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 5,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-color': '#8b5cf6',
          'circle-opacity': 0.92,
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

      // 3D POI <-> turn inspection.
      // One source contains:
      //   - LineString: POI to associated maneuver
      //   - Point: actual maneuver location
      map.addSource('poi-turn-inspection', {
        type: 'geojson',
        data: EMPTY_FC,
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
        data: EMPTY_FC,
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

      map.addSource('osrm-selected-maneuver', {
        type: 'geojson',
        data: EMPTY_FC,
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

      const showPoiPopup = (event: maplibregl.MapLayerMouseEvent) => {
        const rawFeature = event.features?.[0];
        if (!rawFeature || rawFeature.geometry.type !== 'Point') return;
        const feature = rawFeature as GeoJSON.Feature<GeoJSON.Point>;
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        setSelectedPoi(feature);
        setInspectorTab('poi');
        setLayout((current) => ({ ...current, rightCollapsed: false }));
        openPoiPopup(
          map,
          coordinates,
          feature.properties ?? {},
        );
      };

      map.on('click', POI_CLUSTER_LAYER_ID, (event) => {
        event.originalEvent.stopPropagation();
        const feature = event.features?.[0] as GeoJSON.Feature | undefined;
        if (feature) void expandPoiCluster(map, feature);
      });

      map.on('click', INDIVIDUAL_POI_LAYER_ID, showPoiPopup);
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
          setInspectorTab('maneuver');
          setLayout((current) => ({ ...current, rightCollapsed: false }));
          window.setTimeout(() => {
            document.querySelector(`[data-maneuver-index="${maneuverIndex}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 80);
        }

        setSelectedPoi(feature);
        setInspectorTab('poi');
        setLayout((current) => ({ ...current, rightCollapsed: false }));
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
        openPoiPopup(
          map,
          coordinates,
          feature.properties ?? {},
        );
      });


      map.on(
        'click',
        'candidate-analysis-pois',
        (event) => {
          event.originalEvent.stopPropagation();

          const feature = event.features?.[0];

          if (
            !feature ||
            feature.geometry?.type !== 'Point'
          ) {
            return;
          }

          const coordinate =
            feature.geometry.coordinates as LngLat;

          const properties =
            feature.properties ?? {};

          const popupProperties = {
            name:
              properties.name ??
              'Candidate POI',
            poi_id:
              properties.poi_id ??
              '',
            status:
              properties.status ??
              '',
            selected:
              properties.selected ??
              false,
            engine:
              properties.engine ??
              '',
            route_edge_role:
              properties.route_edge_role ??
              '',
            association_confidence:
              properties.association_confidence ??
              '',
            association_augmented:
              properties.association_augmented ??
              '',
            incoming_association_augmented:
              properties.incoming_association_augmented ??
              '',
            outgoing_association_augmented:
              properties.outgoing_association_augmented ??
              '',
            maneuver_distance_m:
              properties.maneuver_distance_m ??
              '',
            perpendicular_distance_m:
              properties.perpendicular_distance_m ??
              '',
            distance_m:
              properties.distance_m ??
              '',
            priority:
              properties.priority ??
              '',
            reason:
              properties.reason ??
              '',
          };

          openPoiPopup(
            map,
            coordinate,
            popupProperties,
          );
        },
      );

      map.on('click', 'maneuver-points', (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const index = Number(feature.properties?.index);
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        if (Number.isFinite(index)) {
          setSelectedManeuverIndex(index);
          setSelectedOsrmStepIndex(null);
          setInspectorTab('maneuver');
          setLayout((current) => ({ ...current, rightCollapsed: false }));
        }
        closeActivePoiPopup();
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      });

      for (const layerId of [POI_CLUSTER_LAYER_ID, INDIVIDUAL_POI_LAYER_ID, 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points', 'candidate-analysis-pois']) {
        map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      }

      if (map3D) {
        map.jumpTo({ pitch: 60, bearing: 25 });
      }
      void installMapmyindiaBasemap(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const container = mapContainer.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const resizeMap = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => mapRef.current?.resize());
    };
    const observer = new ResizeObserver(resizeMap);
    observer.observe(container);
    resizeMap();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [config]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.resize(), 240);
    return () => window.clearTimeout(timer);
  }, [layout.leftCollapsed, layout.rightCollapsed, layout.analysisCollapsed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !config || !activeDataset) return;

    if (activeDataset.map_bounds) {
      map.fitBounds(activeDataset.map_bounds, { padding: 60, maxZoom: 16, duration: 0 });
    } else {
      map.jumpTo({ center: config.frontend.default_center, zoom: config.frontend.default_zoom });
    }
  }, [config, activeDataset?.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return bindDebouncedViewportListener(
      map,
      () => setViewportRevision((revision) => revision + 1),
    );
  }, [config]);

  useEffect(() => () => {
    viewportRequestsRef.current.cancel();
    diagnosticRequestRef.current?.controller.abort();
    routeRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    const datasetId = datasetRegistry?.active_dataset;
    const map = mapRef.current;
    if (!datasetId || !map) {
      viewportRequestsRef.current.cancel();
      return;
    }
    const bbox = visibleMapBounds(map);
    if (!bbox) {
      viewportRequestsRef.current.cancel();
      setPois(EMPTY_FC);
      setViewportMeta({ loading: false, incomplete: false, error: 'POIs are unavailable for a viewport crossing the antimeridian.' });
      return;
    }
    const ticket = viewportRequestsRef.current.begin(viewportRequestKey(datasetId, bbox));
    if (!ticket) return;
    setViewportMeta((state) => ({ ...state, loading: true, error: '' }));
    searchPois({
      datasetId,
      bbox,
      limit: VIEWPORT_POI_LIMIT,
    }, ticket.controller.signal).then((response) => {
      if (!viewportRequestsRef.current.complete(ticket)) return;
      setPois(response);
      setViewportMeta({ loading: false, error: '', incomplete: response.has_more });
    }).catch((err) => {
      if (ticket.controller.signal.aborted || !viewportRequestsRef.current.fail(ticket)) return;
      setViewportMeta({ loading: false, incomplete: false, error: err instanceof Error ? err.message : String(err) });
    });
  }, [datasetRegistry?.active_dataset, viewportRevision]);

  useEffect(() => {
    const datasetId = datasetRegistry?.active_dataset;
    const query = debouncedPoiSearch.trim();
    const hasSearch = Boolean(query || advancedConditions.length);
    loadMoreControllerRef.current?.abort();
    setSearchFeatures([]);
    setSearchResponse(null);
    setSearchState({ loading: Boolean(datasetId && hasSearch), loadingMore: false, error: '' });
    if (!datasetId || !hasSearch) return;
    const bbox = appliedSearchScope === 'viewport' && mapRef.current ? (visibleMapBounds(mapRef.current) ?? undefined) : undefined;
    if (appliedSearchScope === 'viewport' && !bbox) {
      setSearchState({ loading: false, loadingMore: false, error: 'The current viewport crosses the antimeridian and cannot be searched.' });
      return;
    }
    const controller = new AbortController();
    let current = true;
    const request = advancedConditions.length
      ? queryPois({ datasetId, q: query, mode: appliedConditionMode, conditions: advancedConditions, bbox, limit: SEARCH_POI_LIMIT }, controller.signal)
      : searchPois({ datasetId, q: query, bbox, limit: SEARCH_POI_LIMIT }, controller.signal);
    request.then((response) => {
        if (!current) return;
        setSearchResponse(response);
        setSearchFeatures(response.features);
        setSearchState({ loading: false, loadingMore: false, error: '' });
      }).catch((err) => {
        if (!current || err instanceof DOMException && err.name === 'AbortError') return;
        setSearchState({ loading: false, loadingMore: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { current = false; controller.abort(); };
  }, [datasetRegistry?.active_dataset, debouncedPoiSearch, advancedConditions, appliedConditionMode, appliedSearchScope, searchViewportRevision, searchRetry]);

  useEffect(() => {
    const datasetId = datasetRegistry?.active_dataset;
    const coordinates = [
      ...maneuverViews.map((item) => item.coordinate),
      ...osrmStepViews.map((item) => item.coordinate),
    ].filter((coordinate): coordinate is LngLat => coordinate !== null);
    if (!datasetId || coordinates.length === 0) {
      diagnosticRequestRef.current?.controller.abort();
      diagnosticRequestRef.current = null;
      completedDiagnosticKeyRef.current = '';
      setDiagnosticPois(EMPTY_FC);
      setDiagnosticWarning('');
      setDiagnosticStatus('idle');
      return;
    }
    const requestKey = JSON.stringify([
      datasetId,
      NARRATION_POI_MAX_DISTANCE_M,
      coordinates.map(([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))]),
    ]);
    if (diagnosticRequestRef.current?.key === requestKey || completedDiagnosticKeyRef.current === requestKey) return;
    const controller = new AbortController();
    diagnosticRequestRef.current?.controller.abort();
    diagnosticRequestRef.current = { key: requestKey, controller };
    setDiagnosticPois(EMPTY_FC);
    setDiagnosticWarning('');
    setDiagnosticStatus('loading');
    fetchDiagnosticPois(datasetId, coordinates, NARRATION_POI_MAX_DISTANCE_M, controller.signal).then((response) => {
      if (diagnosticRequestRef.current?.controller !== controller || controller.signal.aborted) return;
      diagnosticRequestRef.current = null;
      completedDiagnosticKeyRef.current = requestKey;
      setDiagnosticPois(response);
      setDiagnosticStatus(response.complete ? 'complete' : 'incomplete');
      setDiagnosticWarning(response.complete ? '' :
        'Nearby source-POI retrieval is incomplete because a configured diagnostic processing limit was reached. Missing POIs must not be interpreted as absent.');
    }).catch((err) => {
      if (diagnosticRequestRef.current?.controller !== controller || controller.signal.aborted) return;
      diagnosticRequestRef.current = null;
      setDiagnosticPois(EMPTY_FC);
      setDiagnosticStatus('unavailable');
      setDiagnosticWarning(`Route diagnostic POIs could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [datasetRegistry?.active_dataset, maneuverViews, osrmStepViews]);

  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __pickMode?: PickMode }) | null;
    if (map) map.__pickMode = pickMode;
  }, [pickMode]);

  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __pickMode?: PickMode }) | null;
    if (!map) return;
    map.__pickMode = pickMode;
    const handler = (event: maplibregl.MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;

      if (map.isStyleLoaded()) {
        const candidateLayers = [POI_CLUSTER_LAYER_ID, INDIVIDUAL_POI_LAYER_ID, 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points', 'osrm-selected-maneuver', 'poi-turn-inspection-turn', 'candidate-analysis-pois', 'candidate-analysis-origin', 'route-points']
          .filter((layerId) => Boolean(map.getLayer(layerId)));
        if (candidateLayers.length > 0) {
          const hitFeatures = map.queryRenderedFeatures(event.point, { layers: candidateLayers });
          if (hitFeatures.length > 0) return;
        }
      }

      closeActivePoiPopup();

      const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
      setRoutePoint(map.__pickMode ?? 'start', point);
    };
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [config, pickMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handler = (event: maplibregl.MapMouseEvent) => {
      event.originalEvent.preventDefault();
      setMapContextMenu({
        coordinate: [event.lngLat.lng, event.lngLat.lat],
        x: event.point.x,
        y: event.point.y,
      });
    };

    map.on('contextmenu', handler);
    return () => { map.off('contextmenu', handler); };
  }, [config]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data = showPois ? filteredPois : EMPTY_FC;
    const apply = () => {
      const source = map.getSource('pois') as maplibregl.GeoJSONSource | undefined;
      source?.setData(data);
    };
    if (map.isStyleLoaded() && map.getSource('pois')) apply();
    else map.once('idle', apply);
    return () => { map.off('idle', apply); };
  }, [filteredPois, showPois, config]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (map.getLayer('route')) {
      map.setLayoutProperty(
        'route',
        'visibility',
        routeView === 'osrm' ? 'none' : 'visible',
      );
    }

    if (map.getLayer('osrm-route')) {
      map.setLayoutProperty(
        'osrm-route',
        'visibility',
        routeView === 'valhalla' ? 'none' : 'visible',
      );
    }
  }, [routeView, config]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data = selectedPoi
      ? { type: 'FeatureCollection', features: [selectedPoi] }
      : EMPTY_FC;
    const apply = () => {
      const source = map.getSource('selected-poi') as maplibregl.GeoJSONSource | undefined;
      source?.setData(data as GeoJSON.FeatureCollection);
    };
    if (map.isStyleLoaded() && map.getSource('selected-poi')) apply();
    else map.once('idle', apply);
    return () => { map.off('idle', apply); };
  }, [selectedPoi, config]);

  useEffect(() => {
    syncGeoJsonSource('route', routeGeoJson);
  }, [routeGeoJson]);

  useEffect(() => {
    syncGeoJsonSource('osrm-route', osrmRouteGeoJson);
  }, [osrmRouteGeoJson]);

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

    const selectedOsrmStep =
      selectedOsrmStepIndex === null
        ? null
        : osrmStepViews.find((item) => item.index === selectedOsrmStepIndex) ?? null;

    const source =
      map.getSource('osrm-selected-maneuver') as maplibregl.GeoJSONSource | undefined;

    if (!selectedOsrmStep?.coordinate) {
      source?.setData(EMPTY_FC);
      return;
    }

    source?.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: selectedOsrmStep.coordinate,
        },
        properties: {
          index: selectedOsrmStep.index,
          instruction: osrmInstructionText(selectedOsrmStep.step),
        },
      }],
    });
  }, [selectedOsrmStepIndex, osrmStepViews]);

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

  async function refreshActiveDataset(message = '', preserveSelectedPoi = true) {
    const registry = await getDatasets();
    setDatasetRegistry(registry);
    setPois(EMPTY_FC);
    setDiagnosticPois(EMPTY_FC);
    setDiagnosticStatus('idle');
    setDiagnosticWarning('');
    diagnosticRequestRef.current?.controller.abort();
    diagnosticRequestRef.current = null;
    completedDiagnosticKeyRef.current = '';
    if (!preserveSelectedPoi) setSelectedPoi(null);
    viewportRequestsRef.current.invalidate();
    setViewportRevision((revision) => revision + 1);
    if (message) setDatasetMessage(message);
  }

  async function loadMoreSearchResults() {
    const datasetId = datasetRegistry?.active_dataset;
    const cursor = searchResponse?.next_cursor;
    if (!datasetId || !cursor || searchState.loadingMore) return;
    const requestCriteria = searchCriteriaKey;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setSearchState((state) => ({ ...state, loadingMore: true, error: '' }));
    try {
      const bbox = appliedSearchScope === 'viewport' && mapRef.current ? (visibleMapBounds(mapRef.current) ?? undefined) : undefined;
      if (appliedSearchScope === 'viewport' && !bbox) throw new Error('The current viewport cannot be searched.');
      const response = advancedConditions.length
        ? await queryPois({ datasetId, q: debouncedPoiSearch.trim(), mode: appliedConditionMode, conditions: advancedConditions, bbox, limit: SEARCH_POI_LIMIT, cursor }, controller.signal)
        : await searchPois({ datasetId, q: debouncedPoiSearch.trim(), bbox, limit: SEARCH_POI_LIMIT, cursor }, controller.signal);
      if (searchCriteriaRef.current !== requestCriteria) return;
      setSearchFeatures((features) => mergePoiPages(features, response.features));
      setSearchResponse(response);
      setSearchState({ loading: false, loadingMore: false, error: '' });
    } catch (err) {
      if (controller.signal.aborted) return;
      setSearchState({ loading: false, loadingMore: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = null;
    }
  }

  async function changeDataset(datasetId: string) {
    if (!datasetId || datasetId === datasetRegistry?.active_dataset) return;
    setDatasetBusy(true);
    setDatasetMessage('');
    setError('');
    viewportRequestsRef.current.cancel();
    diagnosticRequestRef.current?.controller.abort();
    loadMoreControllerRef.current?.abort();
    routeRequestRef.current?.abort();
    try {
      await updatePreferences({ selected_dataset_id: datasetId });
      await refreshActiveDataset(`Selected ${datasetId}.`, false);
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
    const datasetId = activeDatasetIdRef.current;
    if (!datasetId) return null;
    routeRequestRef.current?.abort();
    const controller = new AbortController();
    routeRequestRef.current = controller;
    setBusy(true);
    setError('');
    setSelectedManeuverIndex(null);
    setSelectedOsrmStepIndex(null);
    setSelectedPoi(null);
    setValhallaCandidateAnalysis(null);
    setOsrmCandidateAnalysis(null);
    setShowCandidateMap(false);

    syncGeoJsonSource(
      'candidate-analysis-map',
      EMPTY_FC,
    );

    syncGeoJsonSource(
      'poi-turn-inspection',
      EMPTY_FC,
    );

    try {
      const payload = {
        locations: [
          { lon: routeStart[0], lat: routeStart[1] },
          { lon: routeEnd[0], lat: routeEnd[1] },
        ],
        costing,
        units: 'kilometers',
        directions_options: { units: 'kilometers' },
        dataset_id: datasetId,
      };

      const comparison = await requestCompareRoute(payload, controller.signal);
      if (controller.signal.aborted || activeDatasetIdRef.current !== datasetId) return null;

      const valhallaResponse =
        comparison.valhalla.ok
          ? comparison.valhalla.response ?? null
          : null;

      const osrmResponse =
        comparison.osrm.ok
          ? comparison.osrm.response ?? null
          : null;

      setRoute(valhallaResponse);
      setOsrmRoute(osrmResponse);

      setValhallaCandidateAnalysis(
        comparison.valhalla.ok
          ? (
            comparison.valhalla
              .candidate_analysis ?? null
          )
          : null,
      );

      setOsrmCandidateAnalysis(
        comparison.osrm.ok
          ? (
            comparison.osrm
              .candidate_analysis ?? null
          )
          : null,
      );

      const valhallaFeatures: GeoJSON.Feature[] = [];
      const osrmFeatures: GeoJSON.Feature[] = [];
      const allCoords: LngLat[] = [];

      for (const [index, leg] of (valhallaResponse?.trip?.legs ?? []).entries()) {
        if (!leg.shape) continue;

        const coords = decodePolyline6(leg.shape);
        allCoords.push(...coords);

        valhallaFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
          properties: {
            leg: index,
            engine: 'valhalla',
          },
        });
      }

      const valhallaRouteData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: valhallaFeatures,
      };

      setRouteGeoJson(valhallaRouteData);
      syncGeoJsonSource('route', valhallaRouteData);

      const osrmCoordinates =
        osrmResponse?.routes?.[0]?.geometry?.coordinates ?? [];

      if (osrmCoordinates.length > 0) {
        allCoords.push(...osrmCoordinates);

        osrmFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: osrmCoordinates,
          },
          properties: {
            engine: 'osrm',
          },
        });
      }

      const osrmRouteData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: osrmFeatures,
      };

      setOsrmRouteGeoJson(osrmRouteData);

      // Do not rely only on a later React effect. Push the current OSRM
      // geometry into the existing MapLibre source immediately.
      syncGeoJsonSource('osrm-route', osrmRouteData);

      if (allCoords.length > 1 && mapRef.current) {
        const bounds = new LngLatBounds(allCoords[0], allCoords[0]);
        allCoords.forEach((coord) => bounds.extend(coord));
        mapRef.current.fitBounds(bounds, {
          padding: 60,
          maxZoom: 16,
        });
      }

      const engineErrors: string[] = [];

      if (!comparison.valhalla.ok) {
        engineErrors.push(
          `Valhalla: ${comparison.valhalla.error ?? 'route request failed'}`
        );
      }

      if (!comparison.osrm.ok) {
        engineErrors.push(
          `OSRM: ${comparison.osrm.error ?? 'route request failed'}`
        );
      }

      if (engineErrors.length > 0) {
        setError(engineErrors.join('\n'));
      }

      // Existing scenario assertions are still Odin/Valhalla assertions.
      return valhallaResponse;
    } catch (err) {
      if (controller.signal.aborted) return null;
      setRoute(null);
      setOsrmRoute(null);
      setRouteGeoJson(EMPTY_FC);
      setOsrmRouteGeoJson(EMPTY_FC);
      setValhallaCandidateAnalysis(null);
      setOsrmCandidateAnalysis(null);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (routeRequestRef.current === controller) {
        routeRequestRef.current = null;
        setBusy(false);
      }
    }
  }

  async function runRoute() {
    if (!start || !end) {
      setError('Set both start and end coordinates first.');
      return;
    }
    openInspector('route');
    await executeRoute(start, end, 'auto');
  }

  function loadTestcaseIntoDashboard(scenario: RouteScenario): void {
    const { routeStart, routeEnd } = testcaseRoutePoints(scenario);
    setStart(routeStart);
    setEnd(routeEnd);
    setRoute(null);
    setRouteGeoJson(EMPTY_FC);
    setOsrmRoute(null);
    setOsrmRouteGeoJson(EMPTY_FC);
    setValhallaCandidateAnalysis(null);
    setOsrmCandidateAnalysis(null);
    setSelectedManeuverIndex(null);
    setSelectedOsrmStepIndex(null);
    setSelectedPoi(null);

    syncGeoJsonSource(
      'poi-turn-inspection',
      EMPTY_FC,
    );

    if (mapRef.current) {
      const bounds = new LngLatBounds(routeStart, routeStart);
      bounds.extend(routeEnd);
      mapRef.current.fitBounds(bounds, { padding: 100, maxZoom: 16 });
    }
  }

  async function executeTestcaseRoute(
    routeStart: LngLat,
    routeEnd: LngLat,
    costing: string,
  ): Promise<ValhallaRouteResponse | null> {
    setStart(routeStart);
    setEnd(routeEnd);
    return executeRoute(routeStart, routeEnd, costing);
  }

  function set3DView(enabled: boolean) {
    setMap3D(enabled);

    const map = mapRef.current;
    if (!map) return;

    if (enabled) {
      const currentBearing = map.getBearing();

      map.easeTo({
        pitch: 60,
        bearing: Math.abs(currentBearing) < 1 ? 25 : currentBearing,
        duration: 700,
        essential: true,
      });

      return;
    }

    // Reset visual POI-turn relationship when returning to normal analysis.
    syncGeoJsonSource('poi-turn-inspection', EMPTY_FC);

    map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 700,
      essential: true,
    });
  }

  function inspectPoiTurn(
    engine: 'valhalla' | 'osrm',
    poiCoordinate: LngLat,
    turnCoordinate: LngLat,
  ) {
    const map = mapRef.current;
    if (!map) return;

    setMap3D(true);

    const inspectionData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              poiCoordinate,
              turnCoordinate,
            ],
          },
          properties: {
            kind: 'poi-turn-link',
            engine,
          },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: turnCoordinate,
          },
          properties: {
            kind: 'turn',
            engine,
          },
        },
      ],
    };

    syncGeoJsonSource(
      'poi-turn-inspection',
      inspectionData,
    );

    const center: LngLat = [
      (poiCoordinate[0] + turnCoordinate[0]) / 2,
      (poiCoordinate[1] + turnCoordinate[1]) / 2,
    ];

    const currentBearing = map.getBearing();

    map.easeTo({
      center,
      zoom: Math.max(map.getZoom(), 18),
      pitch: 60,
      bearing: Math.abs(currentBearing) < 1 ? 25 : currentBearing,
      duration: 850,
      essential: true,
    });
  }

  function updateCoord(kind: PickMode, axis: 0 | 1, text: string) {
    const current = kind === 'start' ? start : end;
    const next = updateCoordinateValue(current, axis, text);
    if (next === current) return;
    if (kind === 'start') setStart(next);
    else setEnd(next);
  }

  function setRoutePoint(kind: PickMode, coordinate: LngLat) {
    if (kind === 'start') setStart(coordinate);
    else setEnd(coordinate);
  }

  function focusManeuver(item: ManeuverView) {
    setSelectedManeuverIndex(item.index);
    setSelectedOsrmStepIndex(null);
    openInspector('maneuver');

    if (!item.coordinate || !mapRef.current) return;

    mapRef.current.flyTo({
      center: item.coordinate,
      zoom: Math.max(mapRef.current.getZoom(), 17),
      essential: true,
    });
  }

  function focusOsrmStep(item: OsrmStepView) {
    setSelectedOsrmStepIndex(item.index);
    setSelectedManeuverIndex(null);
    openInspector('maneuver');
    closeActivePoiPopup();

    if (!item.coordinate || !mapRef.current) return;

    mapRef.current.flyTo({
      center: item.coordinate,
      zoom: Math.max(mapRef.current.getZoom(), 17),
      essential: true,
    });
  }

  function focusPoiFeature(feature: GeoJSON.Feature<GeoJSON.Point>, debugDistanceM?: number) {
    setSelectedPoi(feature);
    openInspector('poi');

    const map = mapRef.current;
    if (!map) return;

    const coordinate = feature.geometry.coordinates as LngLat;

    // Clear an older POI-turn relation first. A route-specific click will
    // immediately populate a new relation below.
    syncGeoJsonSource('poi-turn-inspection', EMPTY_FC);

    setMap3D(true);

    map.flyTo({
      center: coordinate,
      zoom: Math.max(map.getZoom(), 18),
      pitch: 60,
      bearing: Math.abs(map.getBearing()) < 1 ? 25 : map.getBearing(),
      essential: true,
    });

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
    setSelectedOsrmStepIndex(null);

    focusPoiFeature(
      item.evidence.feature,
      item.evidence.distanceM ?? undefined,
    );

    const maneuver =
      maneuverViews.find(
        (candidate) =>
          candidate.index === item.primaryManeuverIndex,
      );

    if (maneuver?.coordinate) {
      inspectPoiTurn(
        'valhalla',
        item.evidence.coordinate,
        maneuver.coordinate,
      );
    }

    window.setTimeout(() => {
      document.querySelector(
        `[data-maneuver-index="${item.primaryManeuverIndex}"]`,
      )?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 80);
  }

  function focusOsrmRouteNarrationPoi(item: OsrmRouteNarrationPoi) {
    setSelectedOsrmStepIndex(item.primaryStepIndex);
    setSelectedManeuverIndex(null);

    focusPoiFeature(
      item.evidence.feature,
      item.evidence.distanceM ?? undefined,
    );

    const step =
      osrmStepViews.find(
        (candidate) =>
          candidate.index === item.primaryStepIndex,
      );

    if (step?.coordinate) {
      inspectPoiTurn(
        'osrm',
        item.evidence.coordinate,
        step.coordinate,
      );
    }

    window.setTimeout(() => {
      document.querySelector(
        `[data-osrm-step-index="${item.primaryStepIndex}"]`,
      )?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 80);
  }

  function resetPoiFilters() {
    setPoiSearch('');
    setDraftConditions([]);
    setAdvancedConditions([]);
    setConditionMode('and');
    setAppliedConditionMode('and');
    setSearchScope('dataset');
    setAppliedSearchScope('dataset');
    setShowPois(true);
  }

  if (!config) {
    if (initializationError) {
      return (
        <main className="initialization-error" role="alert">
          <div className="initialization-error__card">
            <span className="product-mark" aria-hidden="true">PD</span>
            <div>
              <p className="product-kicker">Dashboard unavailable</p>
              <h1>Could not load debugger configuration</h1>
              <p>The frontend could not reach the API. Start the FastAPI backend, check <code>VPD_BACKEND_URL</code>, or explicitly enable the development mock API.</p>
              <code className="initialization-error__detail">{initializationError}</code>
              <button type="button" onClick={() => setInitializationAttempt((attempt) => attempt + 1)}>Retry API connection</button>
            </div>
          </div>
        </main>
      );
    }
    return <div className="loading" role="status">Loading debugger configuration…</div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="product-identity">
          <span className="product-mark" aria-hidden="true">PD</span>
          <div>
            <div className="product-kicker">Routing quality workspace</div>
            <h1>{config.project.name ?? 'POI Debugger Dashboard'}</h1>
          </div>
        </div>

        {workspaceView === 'debugger' && <button
          className="primary-route-action"
          onClick={runRoute}
          disabled={busy || !start || !end}
        >
          {busy ? 'Running both engines…' : 'Run route comparison'}
        </button>}

        {workspaceView === 'debugger' && <div className="engine-statuses" aria-label="Routing engine status">
          {__VPD_MOCK_API__ && <div className="mock-mode-badge" title="Responses are synthetic and provided by the Vite development server">Mock Data / Development Mode</div>}
          <div className={`status-pill ${valhallaStatus}`}><i />Valhalla</div>
          <div className={`status-pill ${osrmStatus}`}><i />OSRM</div>
        </div>}

        <div className="user-nav" aria-label="Current user">
          {session.user.role === 'super_admin' && <button type="button" className={workspaceView === 'admin' ? 'is-active' : ''} onClick={() => setWorkspaceView((current) => current === 'admin' ? 'debugger' : 'admin')}>{workspaceView === 'admin' ? 'Debugger' : 'Admin Console'}</button>}
          <span title={session.user.email ?? session.user.display_name}>{session.user.display_name}</span>
          <button type="button" onClick={() => void onLogout()}>Log out</button>
        </div>
      </header>

      {workspaceView === 'admin' ? <AdminConsole /> : <main
        ref={workspaceRef}
        className={`workspace${layout.leftCollapsed ? ' left-collapsed' : ''}${layout.rightCollapsed ? ' right-collapsed' : ''}${layout.analysisCollapsed ? ' analysis-collapsed' : ''}`}
        style={{ '--analysis-height': `${analysisResize.liveHeight}px` } as CSSProperties}
      >
        <Sidebar
          side="left"
          label="Route and dataset controls"
          collapsed={layout.leftCollapsed}
          onToggle={() => toggleLayoutPanel('left')}
        >
          <RouteSetupControls
            pickMode={pickMode}
            start={start}
            end={end}
            busy={busy}
            error={error}
            onPickModeChange={setPickMode}
            onCoordinateChange={updateCoord}
            onRunRoute={runRoute}
          />

          <CompactDatasetSelector
            activeDataset={activeDataset}
            datasetRegistry={datasetRegistry}
            datasetBusy={datasetBusy}
            datasetMessage={datasetMessage}
            config={config}
            onChangeDataset={changeDataset}
            onReloadDataset={reloadActiveDataset}
          />

          <CompactPoiExplorer
            filteredPoiFeatures={filteredPoiFeatures}
            searchResults={searchResults}
            availablePoiTypes={availablePoiTypes}
            poiSearch={poiSearch}
            advancedFilters={advancedFilters}
            showPois={showPois}
            searchLoading={searchState.loading}
            searchLoadingMore={searchState.loadingMore}
            searchError={searchState.error}
            searchHasMore={searchResponse?.has_more === true}
            onSearchChange={setPoiSearch}
            onShowPoisChange={setShowPois}
            onResetFilters={resetPoiFilters}
            onFocusPoi={focusPoiFeature}
            onLoadMore={loadMoreSearchResults}
            onRetrySearch={() => setSearchRetry((value) => value + 1)}
          />

          <SavedScenarioControls
            mineCount={testcases.registry?.total ?? 0}
            sharedCount={testcases.registry?.shared_total ?? 0}
            legacyCount={testcases.registry?.legacy_scenarios?.length ?? 0}
            onOpen={openTestcases}
          />
        </Sidebar>

        <section className="map-section">
          <div className="map-toolbar">
            <button className={pickMode === 'start' ? 'active' : ''} onClick={() => setPickMode('start')}>Click map → START</button>
            <button className={pickMode === 'end' ? 'active' : ''} onClick={() => setPickMode('end')}>Click map → END</button>

            <button
              className="toolbar-route-button"
              onClick={runRoute}
              disabled={busy || !start || !end}
            >
              {busy ? 'Routing…' : 'Run Valhalla + OSRM'}
            </button>

            <div className="map-dimension-switcher">
              <button
                className={!map3D ? 'active two-d' : ''}
                onClick={() => set3DView(false)}
                title="Return to normal top-down map"
              >
                2D
              </button>

              <button
                className={map3D ? 'active three-d' : ''}
                onClick={() => set3DView(true)}
                title="Pitch map for 3D landmark inspection"
              >
                3D
              </button>
            </div>

            <span>
              {viewportMeta.loading ? 'Loading POIs…' : viewportPoiLabel(filteredPoiFeatures.length, viewportMeta.incomplete)} ·
              {' '}{maneuverViews.length} Odin maneuvers · {osrmStepViews.length} OSRM steps
            </span>
          </div>
          <div className="map-surface">
            <div ref={mapContainer} className="map" />
            {viewportMeta.incomplete && (
              <div className="map-data-notice" role="status">
                {incompleteViewportMessage(filteredPoiFeatures.length, viewportMeta.incomplete)}
              </div>
            )}
            {(viewportMeta.error || diagnosticWarning) && (
              <div className="map-data-warning" role="status">
                {[viewportMeta.error, diagnosticWarning].filter(Boolean).join(' ')}
              </div>
            )}
            {mapContextMenu && (
              <MapContextMenu
                {...mapContextMenu}
                onSetStart={(coordinate) => setRoutePoint('start', coordinate)}
                onSetEnd={(coordinate) => setRoutePoint('end', coordinate)}
                onClose={() => setMapContextMenu(null)}
              />
            )}
          </div>

          {(route || osrmRoute) && (
            <div className={`route-comparison-overlay ${routeComparisonCollapsed ? 'collapsed' : ''}`}>
              <div className="route-comparison-heading">
                <strong>Route Comparison</strong>
                <span>same START / END</span>
                <button
                  type="button"
                  className="route-comparison-toggle"
                  aria-expanded={!routeComparisonCollapsed}
                  aria-label={routeComparisonCollapsed ? 'Expand route comparison' : 'Collapse route comparison'}
                  title={routeComparisonCollapsed ? 'Expand route comparison' : 'Collapse route comparison'}
                  onClick={() => setRouteComparisonCollapsed((value) => !value)}
                >
                  {routeComparisonCollapsed ? '+' : '−'}
                </button>
              </div>

              <div className="route-comparison-body" aria-hidden={routeComparisonCollapsed}>
              <div className="route-comparison-engines">
                <div className="route-engine-summary valhalla">
                  <div className="route-engine-name">
                    <i />
                    <span>Valhalla</span>
                  </div>

                  <strong>
                    {routeComparison.valhallaDistanceKm === null
                      ? '—'
                      : `${routeComparison.valhallaDistanceKm.toFixed(2)} km`}
                  </strong>

                  <small>
                    {routeComparison.valhallaDurationMin === null
                      ? 'time —'
                      : `${routeComparison.valhallaDurationMin.toFixed(1)} min`}
                    {' · '}
                    {maneuverViews.length} maneuvers
                  </small>
                </div>

                <div className="route-engine-summary osrm">
                  <div className="route-engine-name">
                    <i />
                    <span>OSRM</span>
                  </div>

                  <strong>
                    {routeComparison.osrmDistanceKm === null
                      ? '—'
                      : `${routeComparison.osrmDistanceKm.toFixed(2)} km`}
                  </strong>

                  <small>
                    {routeComparison.osrmDurationMin === null
                      ? 'time —'
                      : `${routeComparison.osrmDurationMin.toFixed(1)} min`}
                    {' · '}
                    {osrmStepViews.length} steps
                    {' · '}
                    {osrmGeometryPointCount} geometry pts
                  </small>
                </div>
              </div>

              <div className="route-view-switcher">
                <button
                  className={routeView === 'both' ? 'active' : ''}
                  onClick={() => setRouteView('both')}
                >
                  Both
                </button>

                <button
                  className={routeView === 'valhalla' ? 'active valhalla' : ''}
                  onClick={() => setRouteView('valhalla')}
                >
                  Valhalla
                </button>

                <button
                  className={routeView === 'osrm' ? 'active osrm' : ''}
                  onClick={() => setRouteView('osrm')}
                >
                  OSRM
                </button>
              </div>

              <div className="route-comparison-deltas">
                <div>
                  <span>Δ distance</span>
                  <strong>
                    {routeComparison.distanceDeltaKm === null
                      ? '—'
                      : `${fmtSigned(routeComparison.distanceDeltaKm)} km`}
                    {routeComparison.distanceDeltaPct !== null &&
                      ` (${fmtSigned(routeComparison.distanceDeltaPct, 1)}%)`}
                  </strong>
                </div>

                <div>
                  <span>Δ time</span>
                  <strong>
                    {routeComparison.timeDeltaMin === null
                      ? '—'
                      : `${fmtSigned(routeComparison.timeDeltaMin, 1)} min`}
                    {routeComparison.timeDeltaPct !== null &&
                      ` (${fmtSigned(routeComparison.timeDeltaPct, 1)}%)`}
                  </strong>
                </div>
              </div>

              <div className="route-comparison-note">
                <span><i className="comparison-line valhalla" />Valhalla</span>
                <span><i className="comparison-line osrm" />OSRM</span>
                <span className="overlap-note">Blue + red border = overlap</span>
              </div>
              </div>
            </div>
          )}

          <details className="landmark-map-legend">
            <summary className="landmark-map-legend-title">Map legend</summary>
            <div className="landmark-map-legend__items">
              <span><i className="legend-route valhalla" />Valhalla route</span>
              <span><i className="legend-route osrm" />OSRM route / casing</span>
              <span><i className="legend-dot source" />Source POI</span>
              <span><i className="legend-dot strong" />POI in Valhalla/Odin instruction</span>
              <span><i className="legend-dot selected" />Selected POI</span>
              <span><i className="legend-inspection-line" />POI ↔ turn</span>
            </div>
          </details>

          {(route || osrmRoute) && (
            <div className={`route-narration-overlay dual-engine-pois ${routePoiCardCollapsed ? 'collapsed' : ''}`}>
              <div className="route-narration-overlay-heading">
                <strong>Landmark POIs on this route</strong>
                <span>
                  V {routeNarrationStrongCount} · O {osrmRouteNarrationPois.length}
                </span>
                <button
                  type="button"
                  className="route-comparison-toggle route-poi-card-toggle"
                  aria-expanded={!routePoiCardCollapsed}
                  aria-label={routePoiCardCollapsed ? 'Expand landmark POIs' : 'Collapse landmark POIs'}
                  title={routePoiCardCollapsed ? 'Expand landmark POIs' : 'Collapse landmark POIs'}
                  onClick={() => setRoutePoiCardCollapsed((value) => !value)}
                >
                  {routePoiCardCollapsed ? '+' : '−'}
                </button>
              </div>

              <div className="route-poi-engine-sections" aria-hidden={routePoiCardCollapsed}>
              <div className="route-poi-engine-section valhalla">
                <div className="route-poi-engine-heading">
                  <span className="route-poi-engine-badge valhalla">
                    Valhalla
                  </span>
                  <span>
                    {routeNarrationStrongCount} POI
                    {routeNarrationStrongCount === 1 ? '' : 's'}
                  </span>
                </div>

                {routeNarrationPois.length === 0 ? (
                  <div className="route-narration-empty compact">
                    {diagnosticStatus === 'complete'
                      ? 'No source POI name matched the Odin instructions.'
                      : 'Source-POI correlation is incomplete; Odin instructions remain authoritative.'}
                  </div>
                ) : (
                  <div className="route-narration-overlay-list engine-list">
                    {routeNarrationPois.map((item) => {
                      const alsoOsrm = osrmRoutePoiKeys.has(item.key);

                      return (
                        <button
                          key={`valhalla-${item.key}`}
                          className="route-narration-overlay-item valhalla-engine"
                          onClick={() => focusRouteNarrationPoi(item)}
                          title={item.evidence.matchedInstruction}
                        >
                          <i />

                          <span>
                            <strong>{item.evidence.name}</strong>

                            <small>
                              Odin maneuver {item.primaryManeuverIndex + 1}
                              {' · '}
                              {item.evidence.poiId ||
                                item.evidence.sourceNodeId ||
                                'source POI'}
                            </small>
                          </span>

                          <b className={`engine-match-badge ${alsoOsrm ? 'both' : 'valhalla'}`}>
                            {alsoOsrm ? 'BOTH' : 'V'}
                          </b>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="route-poi-engine-section osrm">
                <div className="route-poi-engine-heading">
                  <span className="route-poi-engine-badge osrm">
                    OSRM
                  </span>

                  <span>
                    {osrmRouteNarrationPois.length} POI
                    {osrmRouteNarrationPois.length === 1 ? '' : 's'}
                  </span>
                </div>

                {osrmRouteNarrationPois.length === 0 ? (
                  <div className="route-narration-empty compact">
                    {diagnosticStatus === 'complete'
                      ? 'No source POI name matched the OSRM maneuver instructions.'
                      : 'Source-POI correlation is incomplete; OSRM instructions remain authoritative.'}
                  </div>
                ) : (
                  <div className="route-narration-overlay-list engine-list">
                    {osrmRouteNarrationPois.map((item) => {
                      const alsoValhalla =
                        valhallaRoutePoiKeys.has(item.key);

                      return (
                        <button
                          key={`osrm-${item.key}`}
                          className="route-narration-overlay-item osrm-engine"
                          onClick={() => focusOsrmRouteNarrationPoi(item)}
                          title={item.evidence.matchedInstruction}
                        >
                          <i />

                          <span>
                            <strong>{item.evidence.name}</strong>

                            <small>
                              OSRM step {item.primaryStepIndex + 1}
                              {' · '}
                              {item.evidence.poiId ||
                                item.evidence.sourceNodeId ||
                                'source POI'}
                            </small>
                          </span>

                          <b className={`engine-match-badge ${alsoValhalla ? 'both' : 'osrm'}`}>
                            {alsoValhalla ? 'BOTH' : 'O'}
                          </b>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              </div>
            </div>
          )}
        </section>

        <Sidebar
          side="right"
          label="Context inspector"
          collapsed={layout.rightCollapsed}
          onToggle={() => toggleLayoutPanel('right')}
        >
          <section className="inspector-map-controls" aria-label="Map display controls">
            <label htmlFor="basemap-select"><span>Basemap</span>
            <select
              id="basemap-select"
              value={basemap}
              onChange={(event) => {
                const next = event.target.value as Basemap;

                basemapRef.current = next;
                setBasemap(next);

                const map = mapRef.current;

                if (map?.getLayer('mapmyindia-raster')) {
                  map.setLayoutProperty(
                    'mapmyindia-raster',
                    'visibility',
                    next === 'mapmyindia' ? 'visible' : 'none',
                  );
                }
              }}
            >
              <option value="mapmyindia">MapmyIndia</option>
              <option value="openfreemap">OpenFreeMap</option>
            </select>
            </label>
            <div className="inspector-dimension-switcher" role="group" aria-label="Map dimension">
              <button type="button" className={!map3D ? 'is-active' : ''} aria-pressed={!map3D} onClick={() => set3DView(false)}>2D</button>
              <button type="button" className={map3D ? 'is-active' : ''} aria-pressed={map3D} onClick={() => set3DView(true)}>3D</button>
            </div>
          </section>

          <div className="inspector-tabs" role="tablist" aria-label="Inspector context">
            <button type="button" role="tab" aria-selected={inspectorTab === 'poi'} className={inspectorTab === 'poi' ? 'is-active' : ''} onClick={() => setInspectorTab('poi')}>POI</button>
            <button type="button" role="tab" aria-selected={inspectorTab === 'route'} className={inspectorTab === 'route' ? 'is-active' : ''} onClick={() => setInspectorTab('route')}>Route</button>
            <button type="button" role="tab" aria-selected={inspectorTab === 'maneuver'} className={inspectorTab === 'maneuver' ? 'is-active' : ''} onClick={() => setInspectorTab('maneuver')}>Maneuver</button>
          </div>

          <div className="inspector-content" role="tabpanel">
          {inspectorTab === 'poi' && (selectedPoi
            ? <SelectedPoiDetails poi={selectedPoi} />
            : <div className="inspector-empty"><strong>No POI selected</strong><span>Select a POI on the map or from search results to inspect its properties.</span></div>)}

          {inspectorTab === 'route' && <>
            <RouteComparisonSummary
              hasRoute={Boolean(route || osrmRoute)}
              comparison={routeComparison}
              maneuverCount={maneuverViews.length}
              osrmStepCount={osrmStepViews.length}
              onOpenComparison={() => setLayout((current) => selectAnalysisTab(current, 'comparison'))}
            />
            <details className="inspector-disclosure">
              <summary>Engine and dataset details</summary>
              <div className="kv"><span>Valhalla</span><code>{config.valhalla.service_url}</code></div>
              <div className="kv"><span>OSRM</span><code>{config.osrm.service_url}</code></div>
              <div className="kv"><span>Dataset</span><code>{datasetRegistry?.active_dataset ?? config.active_dataset ?? 'default'}</code></div>
            </details>
          </>}

          {inspectorTab === 'maneuver' && <>
            <ManeuverInspection
            compact
            route={route}
            osrmRoute={osrmRoute}
            maneuverViews={maneuverViews}
            osrmStepViews={osrmStepViews}
            selectedManeuverIndex={selectedManeuverIndex}
            selectedOsrmStepIndex={selectedOsrmStepIndex}
            selectedManeuver={selectedManeuver}
            selectedOsrmStep={selectedOsrmStepView}
            narrationEvidenceByManeuver={narrationEvidenceByManeuver}
            osrmPoiNamesByStep={osrmPoiNamesByStep}
            primaryNarrationEvidence={primaryNarrationEvidence}
            selectedNarrationEvidence={selectedNarrationEvidence}
            nearbyPois={nearbyPois}
            diagnosticStatus={diagnosticStatus}
            diagnosticMessage={diagnosticWarning}
            getOsrmInstruction={osrmInstructionText}
            onFocusManeuver={focusManeuver}
            onFocusOsrmStep={focusOsrmStep}
            onFocusNarrationEvidence={focusNarrationEvidence}
            onFocusPoi={focusPoi}
          />
            <div className="inspector-analysis-actions">
              <button type="button" onClick={() => setLayout((current) => selectAnalysisTab(current, 'maneuvers'))}>Open maneuver lists</button>
              <button type="button" disabled={!selectedManeuver && !selectedOsrmStepView} onClick={() => setLayout((current) => selectAnalysisTab(current, 'candidates'))}>Open candidate evidence</button>
            </div>
          </>}
          </div>
        </Sidebar>

        <AnalysisWorkspace
          activeTab={layout.activeAnalysisTab}
          collapsed={layout.analysisCollapsed}
          panelRef={analysisWorkspaceRef}
          resizing={analysisResize.resizing}
          liveHeight={analysisResize.liveHeight}
          minimumHeight={analysisResize.minimumHeight}
          maximumHeight={analysisResize.maximumHeight}
          resizeHandleProps={analysisResize.resizeHandleProps}
          onSelectTab={(tab) => setLayout((current) => selectAnalysisTab(current, tab))}
          onToggle={() => toggleLayoutPanel('analysis')}
        >
          <AnalysisTabContent
            activeTab={layout.activeAnalysisTab}
            comparison={routeComparison}
            route={route}
            osrmRoute={osrmRoute}
            maneuverViews={maneuverViews}
            osrmStepViews={osrmStepViews}
            selectedManeuverIndex={selectedManeuverIndex}
            selectedOsrmStepIndex={selectedOsrmStepIndex}
            selectedManeuver={selectedManeuver}
            selectedOsrmStep={selectedOsrmStepView}
            selectedValhallaAnalysis={selectedValhallaCandidateAnalysis}
            selectedOsrmAnalysis={selectedOsrmCandidateAnalysis}
            showCandidatesOnMap={showCandidateMap}
            testcaseWorkspace={<TestcaseManagementSections
              activeTab={testcases.activeTab}
              onSelectTab={testcases.setActiveTab}
              registry={testcases.registry}
              activeDataset={datasetRegistry?.active_dataset ?? config.active_dataset ?? ''}
              start={start}
              end={end}
              scenarioName={testcases.name}
              scenarioNotes={testcases.notes}
              scenarioVisibility={testcases.visibility}
              expectedText={testcases.expectedText}
              forbiddenText={testcases.forbiddenText}
              myQuery={testcases.myQuery}
              sharedQuery={testcases.sharedQuery}
              scenarioBusy={testcases.busy}
              scenarioMessage={testcases.message}
              runAllBusy={testcases.runAllBusy}
              routeBusy={busy}
              runResults={testcases.runResults}
              setScenarioName={testcases.setName}
              setScenarioNotes={testcases.setNotes}
              setScenarioVisibility={testcases.setVisibility}
              setExpectedText={testcases.setExpectedText}
              setForbiddenText={testcases.setForbiddenText}
              setMyQuery={testcases.setMyQuery}
              setSharedQuery={testcases.setSharedQuery}
              onBrowse={testcases.browse}
              onSave={testcases.saveCurrent}
              onRunAll={testcases.runAll}
              onLoad={testcases.load}
              onRun={testcases.run}
              onEditExpectation={testcases.edit}
              onChangeVisibility={testcases.changeVisibility}
              onDelete={testcases.remove}
            />}
            getOsrmInstruction={osrmInstructionText}
            onFocusManeuver={focusManeuver}
            onFocusOsrmStep={focusOsrmStep}
            onToggleCandidatesOnMap={() => setShowCandidateMap((current) => !current)}
          />
        </AnalysisWorkspace>
      </main>}
    </div>
  );
}

export default function App() {
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const config = await getAuthConfig();
        const activeSession = await getCurrentSession();
        if (!current) return;
        setAuthConfig(config);
        setSession(activeSession);
      } catch (error) {
        if (current) setAuthError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current) setAuthLoading(false);
      }
    })();
    const expired = () => {
      setAuthSession(null);
      setSession(null);
      setSessionExpired(true);
    };
    window.addEventListener('vpd:session-expired', expired);
    return () => {
      current = false;
      window.removeEventListener('vpd:session-expired', expired);
    };
  }, []);

  async function useDevelopmentLogin() {
    try {
      setAuthLoading(true);
      setAuthError('');
      setSession(await developmentLogin());
      setSessionExpired(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthLoading(false);
    }
  }

  async function endSession() {
    try {
      await logout();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthSession(null);
      setSession(null);
      setSessionExpired(false);
    }
  }

  if (authLoading) {
    return (
      <main className="login-screen login-screen--loading">
        <div className="auth-loading" role="status">
          <span className="auth-loading__indicator" aria-hidden="true" />
          <span>Checking your secure session…</span>
        </div>
      </main>
    );
  }
  if (!session) {
    return <AuthenticationScreen config={authConfig} initialError={authError} sessionExpired={sessionExpired} onAuthenticated={(activeSession) => { setSession(activeSession); setSessionExpired(false); }} onDevelopmentLogin={useDevelopmentLogin} />;
  }

  return <Dashboard session={session} onLogout={endSession} />;
}
