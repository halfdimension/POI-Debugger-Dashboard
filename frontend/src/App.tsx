import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { activateDataset, createScenario, deleteScenario, getConfig, getDatasets, getOsrmStatus, getPois, getScenarios, getValhallaStatus, reloadDatasetPois, requestCompareRoute, updateScenario } from './api';
import { decodePolyline6 } from './polyline';
import type { CandidateAnalysis, CandidateAnalysisCandidate, CandidateAnalysisManeuver, DatasetRegistryResponse, DatasetSummary, DebuggerConfig, LngLat, Maneuver, OsrmRouteResponse, OsrmStep, RouteScenario, ScenarioRegistryResponse, ValhallaRouteResponse } from './types';

type PickMode = 'start' | 'end';

type ManeuverView = {
  index: number;
  legIndex: number;
  maneuverIndex: number;
  maneuver: Maneuver;
  coordinate: LngLat | null;
};

type OsrmStepView = {
  index: number;
  legIndex: number;
  stepIndex: number;
  step: OsrmStep;
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

type OsrmRouteNarrationPoi = {
  key: string;
  evidence: NarrationPoiEvidence;
  stepIndexes: number[];
  primaryStepIndex: number;
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

function fmtCoord(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(6) : '';
}

function fmtSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}


function analysisValue(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';

    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(digits);
  }

  return String(value);
}

function candidateStatusClass(status?: string): string {
  if (status === 'SELECTED') {
    return 'selected';
  }

  if (status === 'ELIGIBLE / LOST RANKING') {
    return 'eligible';
  }

  if (status === 'REJECTED') {
    return 'rejected';
  }

  if (status === 'DEDUPLICATED') {
    return 'deduplicated';
  }

  return 'unknown';
}

function candidateCoordinateText(
  candidate: CandidateAnalysisCandidate,
): string {
  const coordinate = candidate.coordinate;

  if (
    !Array.isArray(coordinate) ||
    coordinate.length < 2 ||
    !Number.isFinite(Number(coordinate[0])) ||
    !Number.isFinite(Number(coordinate[1]))
  ) {
    return '—';
  }

  return (
    `${Number(coordinate[1]).toFixed(6)}, ` +
    `${Number(coordinate[0]).toFixed(6)}`
  );
}

function CandidateDecisionList({
  engine,
  analysis,
}: {
  engine: 'valhalla' | 'osrm';
  analysis: CandidateAnalysisManeuver;
}) {
  const candidates = analysis.candidates ?? [];

  const selected =
    candidates.find((candidate) => candidate.selected) ?? null;

  const identity = analysis.identity ?? {};
  const maneuver = analysis.maneuver ?? {};
  const selector = analysis.selector ?? {};

  return (
    <div className={`candidate-analysis-engine ${engine}`}>
      <div className="candidate-analysis-engine-header">
        <span className={`candidate-engine-badge ${engine}`}>
          {engine === 'valhalla' ? 'VALHALLA' : 'OSRM'}
        </span>

        <div>
          <strong>
            {selected?.name
              ? `Selected: ${selected.name}`
              : 'No candidate selected'}
          </strong>

          <small>
            {candidates.length} candidate
            {candidates.length === 1 ? '' : 's'} considered
          </small>
        </div>
      </div>

      {engine === 'osrm' ? (
        <div className="candidate-context-grid">
          <div>
            <span>turn_id</span>
            <strong>{analysisValue(identity.turn_id)}</strong>
          </div>

          <div>
            <span>intersection node</span>
            <strong>
              {analysisValue(identity.intersection_node)}
            </strong>
          </div>

          <div>
            <span>maneuver coordinate</span>
            <strong>
              {Array.isArray(maneuver.coordinate)
                ? (
                  `${Number(maneuver.coordinate[1]).toFixed(6)}, ` +
                  `${Number(maneuver.coordinate[0]).toFixed(6)}`
                )
                : '—'}
            </strong>
          </div>

          <div>
            <span>incoming bearing</span>
            <strong>
              {typeof maneuver.incoming_bearing === 'number'
                ? `${maneuver.incoming_bearing.toFixed(2)}°`
                : '—'}
            </strong>
          </div>

          <div>
            <span>outgoing bearing</span>
            <strong>
              {typeof maneuver.outgoing_bearing === 'number'
                ? `${maneuver.outgoing_bearing.toFixed(2)}°`
                : '—'}
            </strong>
          </div>

          <div>
            <span>delayed turn</span>
            <strong>{analysisValue(identity.delayed)}</strong>
          </div>
        </div>
      ) : (
        <div className="candidate-analysis-limitation">
          Valhalla's current runtime landmark debug does not expose an
          authoritative maneuver coordinate or incoming/outgoing bearings.
          They are intentionally not reconstructed here.
        </div>
      )}

      {Object.keys(selector).length > 0 && (
        <details className="candidate-selector-details">
          <summary>Engine selection policy</summary>

          <div className="candidate-policy-grid">
            {Object.entries(selector).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <code>{analysisValue(value, 3)}</code>
              </div>
            ))}
          </div>
        </details>
      )}

      {candidates.length === 0 ? (
        <div className="empty-state">
          The engine emitted no candidate decisions for this maneuver.
        </div>
      ) : (
        <div className="candidate-decision-list">
          {candidates.map((candidate, index) => {
            const runtimeAssociation =
              candidate.association?.runtime;

            const buildAssociation =
              candidate.association?.build;

            const selectedBuildEvent =
              buildAssociation?.selected_event;

            return (
              <div
                className={
                  `candidate-decision ` +
                  `${candidateStatusClass(candidate.status)}`
                }
                key={
                  `${
                    candidate.poi_id ??
                    candidate.osm_node_id ??
                    candidate.name ??
                    'candidate'
                  }-${index}`
                }
              >
                <div className="candidate-decision-heading">
                  <span className="candidate-rank">
                    {index + 1}
                  </span>

                  <div className="candidate-name">
                    <strong>
                      {candidate.name || 'Unnamed POI'}
                    </strong>

                    <small>
                      {candidate.poi_id
                        ? candidate.poi_id
                        : (
                          candidate.osm_node_id !== null &&
                          candidate.osm_node_id !== undefined
                        )
                          ? `OSM node ${candidate.osm_node_id}`
                          : 'no POI identifier'}
                    </small>
                  </div>

                  <span
                    className={
                      `candidate-status ` +
                      `${candidateStatusClass(candidate.status)}`
                    }
                  >
                    {candidate.status || 'UNKNOWN'}
                  </span>
                </div>

                <div className="candidate-metric-grid">
                  <div>
                    <span>priority</span>
                    <strong>
                      {analysisValue(candidate.priority)}
                    </strong>
                  </div>

                  <div>
                    <span>distance</span>
                    <strong>
                      {typeof candidate.distance_m === 'number'
                        ? `${candidate.distance_m.toFixed(2)} m`
                        : '—'}
                    </strong>
                  </div>

                  <div>
                    <span>coordinate</span>
                    <strong>
                      {candidateCoordinateText(candidate)}
                    </strong>
                  </div>

                  {engine === 'osrm' && (
                    <>
                      <div>
                        <span>POI bearing</span>
                        <strong>
                          {typeof candidate.poi_bearing_deg ===
                          'number'
                            ? (
                              `${candidate.poi_bearing_deg.toFixed(2)}°`
                            )
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>bearing deviation</span>
                        <strong>
                          {typeof candidate.bearing_deviation_deg ===
                          'number'
                            ? (
                              `${
                                candidate.bearing_deviation_deg
                                  .toFixed(2)
                              }°`
                            )
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>visible</span>
                        <strong>
                          {analysisValue(candidate.visible)}
                        </strong>
                      </div>

                      <div>
                        <span>eligible</span>
                        <strong>
                          {analysisValue(candidate.eligible)}
                        </strong>
                      </div>

                      <div>
                        <span>OSM node</span>
                        <strong>
                          {analysisValue(candidate.osm_node_id)}
                        </strong>
                      </div>
                    </>
                  )}

                  {engine === 'valhalla' && (
                    <>
                      <div>
                        <span>side</span>
                        <strong>
                          {candidate.right === true
                            ? 'right'
                            : candidate.right === false
                              ? 'left'
                              : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>route edge role</span>
                        <strong>
                          {analysisValue(
                            runtimeAssociation?.route_edge_role,
                          )}
                        </strong>
                      </div>
                    </>
                  )}
                </div>

                {candidate.reason && (
                  <div className="candidate-reason">
                    <strong>Decision reason</strong>
                    <span>{candidate.reason}</span>
                  </div>
                )}

                {(candidate.rejection_reasons?.length ?? 0) > 0 && (
                  <div className="candidate-structured-reasons">
                    {(candidate.rejection_reasons ?? []).map(
                      (reason, reasonIndex) => (
                        <code
                          key={
                            `${
                              reason.code ?? 'reason'
                            }-${reasonIndex}`
                          }
                        >
                          {reason.code || 'rejection'}

                          {reason.actual !== undefined
                            ? (
                              ` · actual=${
                                analysisValue(
                                  reason.actual,
                                  3,
                                )
                              }`
                            )
                            : ''}

                          {reason.operator
                            ? ` ${reason.operator}`
                            : ''}

                          {reason.threshold !== undefined
                            ? (
                              ` ${
                                analysisValue(
                                  reason.threshold,
                                  3,
                                )
                              }`
                            )
                            : ''}

                          {reason.unit
                            ? ` ${reason.unit}`
                            : ''}
                        </code>
                      ),
                    )}
                  </div>
                )}

                {engine === 'valhalla' &&
                  runtimeAssociation && (
                    <details className="candidate-association-details">
                      <summary>
                        Route / build association
                        {buildAssociation?.matched
                          ? (
                            ` · MATCHED (${
                              buildAssociation.match_kind ??
                              'unknown'
                            })`
                          )
                          : ' · UNMATCHED'}
                      </summary>

                      <div className="candidate-association-grid">
                        <div>
                          <span>runtime graph_id</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation.graph_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>directed edge</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .directed_edge_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>way_id</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation.way_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>trip edge node</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .trip_edge_node_index,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>distance along edge</span>
                          <code>
                            {typeof runtimeAssociation
                              .distance_along_used_edge_m ===
                            'number'
                              ? (
                                `${
                                  runtimeAssociation
                                    .distance_along_used_edge_m
                                    .toFixed(3)
                                } m`
                              )
                              : '—'}
                          </code>
                        </div>

                        <div>
                          <span>full-edge fraction</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .fraction_along_full_edge,
                              4,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>build match</span>
                          <code>
                            {buildAssociation?.matched
                              ? (
                                buildAssociation.match_kind ??
                                'matched'
                              )
                              : 'unmatched'}
                          </code>
                        </div>

                        <div>
                          <span>POI build events</span>
                          <code>
                            {analysisValue(
                              buildAssociation
                                ?.poi_event_count,
                            )}
                          </code>
                        </div>
                      </div>

                      {selectedBuildEvent && (
                        <div className="candidate-build-selected">
                          <strong>
                            Selected Mjolnir association
                          </strong>

                          <span>
                            {selectedBuildEvent.road_name ||
                              'unnamed road'}

                            {typeof selectedBuildEvent
                              .distance_m === 'number'
                              ? (
                                ` · ${
                                  selectedBuildEvent
                                    .distance_m
                                    .toFixed(3)
                                } m`
                              )
                              : ''}
                          </span>

                          <small>
                            edge{' '}
                            {analysisValue(
                              selectedBuildEvent.edge
                                ?.graph_id,
                            )}
                            {' · opposing '}
                            {analysisValue(
                              selectedBuildEvent
                                .opposing_edge
                                ?.graph_id,
                            )}
                          </small>

                          {selectedBuildEvent.reason && (
                            <small>
                              {selectedBuildEvent.reason}
                            </small>
                          )}
                        </div>
                      )}

                      {(buildAssociation?.warnings?.length ??
                        0) > 0 && (
                        <div className="candidate-association-warnings">
                          {(buildAssociation?.warnings ?? [])
                            .map(
                              (warning, warningIndex) => (
                                <span key={warningIndex}>
                                  {warning}
                                </span>
                              ),
                            )}
                        </div>
                      )}
                    </details>
                  )}
              </div>
            );
          })}
        </div>
      )}

      {(analysis.warnings?.length ?? 0) > 0 && (
        <div className="candidate-analysis-warnings">
          {(analysis.warnings ?? []).map(
            (warning, index) => (
              <span key={index}>{warning}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
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

function osrmInstructionText(step: OsrmStep): string {
  const detailed = String(step.maneuver?.instruction ?? '').trim();
  if (detailed) return detailed;

  const shortInstruction = String(step.maneuver?.short_instruction ?? '').trim();
  if (shortInstruction) return shortInstruction;

  const structured = [
    String(step.maneuver?.type ?? '').trim(),
    String(step.maneuver?.modifier ?? '').trim(),
  ].filter(Boolean).join(' ');

  if (structured) return structured;
  return String(step.name ?? '').trim() || 'Unnamed OSRM step';
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
  const [pickMode, setPickMode] = useState<PickMode>('start');
  const [start, setStart] = useState<LngLat | null>(null);
  const [end, setEnd] = useState<LngLat | null>(null);
  const [pois, setPois] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [route, setRoute] = useState<ValhallaRouteResponse | null>(null);
  const [routeGeoJson, setRouteGeoJson] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [osrmRoute, setOsrmRoute] = useState<OsrmRouteResponse | null>(null);
  const [osrmRouteGeoJson, setOsrmRouteGeoJson] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [valhallaCandidateAnalysis, setValhallaCandidateAnalysis] = useState<CandidateAnalysis | null>(null);
  const [osrmCandidateAnalysis, setOsrmCandidateAnalysis] = useState<CandidateAnalysis | null>(null);
  const [valhallaStatus, setValhallaStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [osrmStatus, setOsrmStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [routeView, setRouteView] = useState<'both' | 'valhalla' | 'osrm'>('both');
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [map3D, setMap3D] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [selectedManeuverIndex, setSelectedManeuverIndex] = useState<number | null>(null);
  const [selectedOsrmStepIndex, setSelectedOsrmStepIndex] = useState<number | null>(null);
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

  const osrmPoiNamesByStep = useMemo(() => {
    const result = new Map<number, string[]>();

    for (const item of osrmStepViews) {
      const instruction = osrmInstructionText(item.step);
      const names: string[] = [];

      for (const rawFeature of pois.features) {
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
  }, [osrmStepViews, pois]);

  const osrmRouteNarrationPois = useMemo<OsrmRouteNarrationPoi[]>(() => {
    const grouped = new Map<string, OsrmRouteNarrationPoi>();

    for (const item of osrmStepViews) {
      const instruction = osrmInstructionText(item.step);

      if (!instruction) continue;

      const matches: NarrationPoiEvidence[] = [];

      for (const rawFeature of pois.features) {
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
  }, [osrmStepViews, pois]);

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
    (async () => {
      try {
        const [cfg, poiData, registry, scenarios] = await Promise.all([getConfig(), getPois(), getDatasets(), getScenarios()]);
        setConfig(cfg);
        setPois(poiData);
        setDatasetRegistry(registry);
        setScenarioRegistry(scenarios);

        const [valhallaStatusResponse, osrmStatusResponse] = await Promise.all([
          getValhallaStatus(),
          getOsrmStatus(),
        ]);
        setValhallaStatus(valhallaStatusResponse.ok ? 'up' : 'down');
        setOsrmStatus(osrmStatusResponse.ok ? 'up' : 'down');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setValhallaStatus('down');
        setOsrmStatus('down');
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

      map.on('click', 'maneuver-points', (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const index = Number(feature.properties?.index);
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        if (Number.isFinite(index)) setSelectedManeuverIndex(index);
        closeActivePoiPopup();
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
      });

      for (const layerId of ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points']) {
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
        const candidateLayers = ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points', 'osrm-selected-maneuver', 'poi-turn-inspection-turn', 'route-points']
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
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('selected-poi') as maplibregl.GeoJSONSource | undefined;
    source?.setData(selectedPoi
      ? { type: 'FeatureCollection', features: [selectedPoi] }
      : EMPTY_FC);
  }, [selectedPoi]);

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
    setSelectedOsrmStepIndex(null);
    setSelectedPoi(null);
    setValhallaCandidateAnalysis(null);
    setOsrmCandidateAnalysis(null);

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
      };

      const comparison = await requestCompareRoute(payload);

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
      setRoute(null);
      setOsrmRoute(null);
      setRouteGeoJson(EMPTY_FC);
      setOsrmRouteGeoJson(EMPTY_FC);
      setValhallaCandidateAnalysis(null);
      setOsrmCandidateAnalysis(null);
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
    setSelectedOsrmStepIndex(null);

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
          <h1>{config.project.name ?? 'Valhalla + OSRM POI Debugger'}</h1>
          <div className="subtitle">Dual-engine route, guidance and landmark POI verification</div>
        </div>
        <div className="engine-statuses">
          <div className={`status-pill ${valhallaStatus}`}>
            Valhalla: {valhallaStatus === 'checking' ? 'checking' : valhallaStatus === 'up' ? 'connected' : 'offline'}
          </div>
          <div className={`status-pill ${osrmStatus}`}>
            OSRM: {osrmStatus === 'checking' ? 'checking' : osrmStatus === 'up' ? 'connected' : 'offline'}
          </div>
        </div>
      </header>

      <main className={`workspace ${rightPanelCollapsed ? 'right-collapsed' : ''}`}>
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
              {filteredPoiFeatures.length}/{pois.features.length} POIs shown ·
              {' '}{maneuverViews.length} Odin maneuvers · {osrmStepViews.length} OSRM steps
            </span>
          </div>
          <div ref={mapContainer} className="map" />

          {(route || osrmRoute) && (
            <div className="route-comparison-overlay">
              <div className="route-comparison-heading">
                <strong>Route Comparison</strong>
                <span>same START / END</span>
              </div>

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
          )}

          <div className="landmark-map-legend">
            <div className="landmark-map-legend-title">Map</div>
            <span><i className="legend-route valhalla" />Valhalla route</span>
            <span><i className="legend-route osrm" />OSRM route / casing</span>
            <span><i className="legend-dot source" />Source POI</span>
            <span><i className="legend-dot strong" />POI in Valhalla/Odin instruction</span>
            <span><i className="legend-dot selected" />Selected POI</span>
            <span><i className="legend-inspection-line" />POI ↔ turn</span>
          </div>

          {(route || osrmRoute) && (
            <div className="route-narration-overlay dual-engine-pois">
              <div className="route-narration-overlay-heading">
                <strong>Landmark POIs on this route</strong>
                <span>
                  V {routeNarrationStrongCount} · O {osrmRouteNarrationPois.length}
                </span>
              </div>

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
                    No landmark POI found in Odin instructions.
                  </div>
                ) : (
                  <div className="route-narration-overlay-list engine-list">
                    {routeNarrationPois.slice(0, 8).map((item) => {
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
                    No landmark POI found in OSRM maneuver instructions.
                  </div>
                ) : (
                  <div className="route-narration-overlay-list engine-list">
                    {osrmRouteNarrationPois.slice(0, 8).map((item) => {
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
          )}
        </section>

        <aside className="side-panel">

          <div className="right-panel-toggle-row">

            <button

              className="right-panel-toggle"

              onClick={() => setRightPanelCollapsed((value) => !value)}

              title={rightPanelCollapsed ? 'Expand analysis panel' : 'Collapse analysis panel'}

            >

              {rightPanelCollapsed ? '‹' : '›'}

              <span>

                {rightPanelCollapsed ? 'Expand' : 'Collapse'}

              </span>

            </button>

          </div>
          <section className="card dataset-card">
            <div className="maneuver-heading">
              <h2>Dataset Pipeline</h2>
              <span>POI data</span>
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
            <div className="kv"><span>OSRM</span><code>{config.osrm.service_url}</code></div>
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
            <button className="route-button" onClick={runRoute} disabled={busy}>
              {busy ? 'Routing both engines…' : 'Run Valhalla + OSRM'}
            </button>
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
              Saved scenarios can verify required or forbidden Odin instruction text. A scenario without assertions still runs but reports NO EXPECTATION.
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
                          return <span className="narration-mini-badge strong">POI in instruction</span>;
                        }
                        return null;
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

          <section className="card maneuvers-card osrm-maneuvers-card">
            <div className="maneuver-heading">
              <h2>OSRM Maneuvers</h2>
              {osrmRoute?.routes?.[0] && (
                <span>
                  {((osrmRoute.routes[0].distance ?? 0) / 1000).toFixed(2)} km ·
                  {' '}{Math.round((osrmRoute.routes[0].duration ?? 0) / 60)} min
                </span>
              )}
            </div>

            {osrmStepViews.length === 0 ? (
              <div className="empty-state">
                Run a route to inspect OSRM instructions.
              </div>
            ) : (
              <ol className="maneuver-list osrm-maneuver-list">
                {osrmStepViews.map((item) => {
                  const poiNames = osrmPoiNamesByStep.get(item.index) ?? [];

                  return (
                    <li
                      key={item.index}
                      data-osrm-step-index={item.index}
                      className={selectedOsrmStepIndex === item.index ? 'selected' : ''}
                    >
                      <button
                        className="osrm-step"
                        onClick={() => focusOsrmStep(item)}
                      >
                        <strong>{osrmInstructionText(item.step)}</strong>

                        {poiNames.length > 0 && (
                          <span className="narration-mini-badge osrm">
                            POI in instruction: {poiNames.join(', ')}
                          </span>
                        )}

                        <small>
                          {typeof item.step.distance === 'number'
                            ? `${item.step.distance.toFixed(1)} m`
                            : ''}
                          {typeof item.step.duration === 'number'
                            ? ` · ${Math.round(item.step.duration)} s`
                            : ''}
                          {item.coordinate
                            ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}`
                            : ''}
                        </small>

                        {(item.step.maneuver?.type || item.step.maneuver?.modifier) && (
                          <code>
                            {item.step.maneuver?.type ?? ''}
                            {item.step.maneuver?.modifier
                              ? ` / ${item.step.maneuver.modifier}`
                              : ''}
                          </code>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="card inspection-card">
            <div className="maneuver-heading">
              <h2>Landmark Details</h2>
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
                    <strong>POI in Odin Instruction</strong>
                    {!primaryNarrationEvidence ? (
                      <span className="narration-status none">NO POI FOUND</span>
                    ) : (
                      <span className="narration-status strong">POI FOUND</span>
                    )}
                  </div>

                  {!primaryNarrationEvidence ? (
                    <p>No landmark POI was identified in this maneuver's Odin instruction.</p>
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


          <section className="card candidate-analysis-card">
            <div className="maneuver-heading">
              <h2>Candidate Analysis</h2>

              {selectedManeuver ? (
                <span>
                  Valhalla · Odin #
                  {selectedManeuver.index + 1}
                </span>
              ) : selectedOsrmStepView ? (
                <span>
                  OSRM · step #
                  {selectedOsrmStepView.index + 1}
                </span>
              ) : (
                <span>
                  authoritative engine evidence
                </span>
              )}
            </div>

            {!selectedManeuver &&
            !selectedOsrmStepView ? (
              <div className="empty-state">
                Click a Valhalla maneuver or an OSRM step
                to inspect the candidates actually considered
                by that engine.
              </div>
            ) : selectedManeuver ? (
              !valhallaCandidateAnalysis ? (
                <div className="empty-state">
                  No Valhalla candidate-analysis response was
                  returned.
                </div>
              ) : !valhallaCandidateAnalysis.available ? (
                <div className="candidate-analysis-error">
                  {valhallaCandidateAnalysis.error ??
                    'Valhalla candidate analysis is unavailable.'}
                </div>
              ) : !selectedValhallaCandidateAnalysis ? (
                <div className="empty-state">
                  This Odin maneuver has no embedded
                  authoritative landmark_debug candidate
                  record. No candidate decision is inferred
                  by the frontend.
                </div>
              ) : (
                <CandidateDecisionList
                  engine="valhalla"
                  analysis={
                    selectedValhallaCandidateAnalysis
                  }
                />
              )
            ) : selectedOsrmStepView ? (
              !osrmCandidateAnalysis ? (
                <div className="empty-state">
                  No OSRM candidate-analysis response was
                  returned.
                </div>
              ) : !osrmCandidateAnalysis.available ? (
                <div className="candidate-analysis-error">
                  {osrmCandidateAnalysis.error ??
                    'OSRM candidate analysis is unavailable.'}
                </div>
              ) : !selectedOsrmCandidateAnalysis ? (
                <div className="empty-state">
                  This OSRM step has no authoritative turn_id
                  candidate record. Depart/arrive steps normally
                  do not carry a guidance turn_id.
                </div>
              ) : (
                <CandidateDecisionList
                  engine="osrm"
                  analysis={
                    selectedOsrmCandidateAnalysis
                  }
                />
              )
            ) : null}

            {selectedManeuver &&
            (valhallaCandidateAnalysis?.limitations
              ?.length ?? 0) > 0 ? (
              <details className="candidate-analysis-limitations">
                <summary>
                  Valhalla diagnostic limitations
                </summary>

                {(valhallaCandidateAnalysis
                  ?.limitations ?? []).map(
                    (limitation, index) => (
                      <p key={index}>
                        {limitation}
                      </p>
                    ),
                  )}
              </details>
            ) : null}
          </section>

          <details className="card raw-card">
            <summary>Raw Valhalla JSON</summary>
            <pre>{route ? JSON.stringify(route, null, 2) : 'No Valhalla route response yet.'}</pre>
          </details>

          <details className="card raw-card">
            <summary>Raw OSRM JSON</summary>
            <pre>{osrmRoute ? JSON.stringify(osrmRoute, null, 2) : 'No OSRM route response yet.'}</pre>
          </details>
        </aside>
      </main>
    </div>
  );
}
