import type { Feature, Point } from 'geojson';
import { haversineMeters } from './coordinates';
import { propNumber, propText } from './poi';
import type { CandidateAnalysisCandidate, CandidateAnalysisManeuver, LngLat, OsrmRouteResponse, OsrmStep } from './types';

export const TURN_COVERAGE_RADIUS_M = 30;
export const TURN_COVERAGE_EPSILON_M = 0.35;

export type TurnOccurrence = {
  key: string;
  index: number;
  legIndex: number;
  stepIndex: number;
  turnId: number;
  step: OsrmStep;
  origin: LngLat;
  incoming: { east: number; north: number; bearing: number } | null;
  directionStatus: string;
};

export type CoveragePoi = {
  feature: Feature<Point>;
  coordinate: LngLat;
  distanceM: number;
  approachDotM: number;
  crossM: number;
  halfPlane: 'INCOMING' | 'BOUNDARY' | 'OUTGOING';
  lateral: 'LEFT' | 'RIGHT' | 'LATERAL BOUNDARY';
  inside: boolean;
  boundary: boolean;
  engineEvidence: 'engine-selected' | 'engine-rejected' | 'engine-candidate' | 'engine decision unknown';
  engineReason: string;
};

function validCoordinate(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
}

function localMeters(origin: LngLat, point: LngLat): { east: number; north: number } {
  const latitudeRadians = origin[1] * Math.PI / 180;
  return {
    east: (point[0] - origin[0]) * 111_320 * Math.cos(latitudeRadians),
    north: (point[1] - origin[1]) * 110_574,
  };
}

function geometryCoordinates(step: OsrmStep | undefined): LngLat[] {
  const raw = step?.geometry?.coordinates;
  if (!Array.isArray(raw)) return [];
  return raw.map(validCoordinate).filter((coordinate): coordinate is LngLat => coordinate !== null);
}

function authoritativeIncoming(previousStep: OsrmStep | undefined, origin: LngLat): { vector: TurnOccurrence['incoming']; status: string } {
  const coordinates = geometryCoordinates(previousStep);
  if (coordinates.length < 2) return { vector: null, status: 'Previous OSRM step geometry is unavailable.' };
  const endpoint = coordinates[coordinates.length - 1];
  if (haversineMeters(endpoint, origin) > 2) {
    return { vector: null, status: 'Previous step geometry does not terminate at this maneuver occurrence.' };
  }
  for (let index = coordinates.length - 2; index >= 0; index -= 1) {
    const delta = localMeters(coordinates[index], origin);
    const length = Math.hypot(delta.east, delta.north);
    if (length < 0.5) continue;
    const east = delta.east / length;
    const north = delta.north / length;
    const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
    return { vector: { east, north, bearing }, status: 'Derived from the preceding OSRM step geometry.' };
  }
  return { vector: null, status: 'Incoming step tail contains no usable non-zero segment.' };
}

export function buildTurnOccurrences(response: OsrmRouteResponse | null): TurnOccurrence[] {
  const occurrences: TurnOccurrence[] = [];
  let globalIndex = 0;
  for (const [legIndex, leg] of (response?.routes?.[0]?.legs ?? []).entries()) {
    const steps = leg.steps ?? [];
    for (const [stepIndex, step] of steps.entries()) {
      const index = globalIndex++;
      const rawTurnId = step.maneuver?.turn_id;
      const origin = validCoordinate(step.maneuver?.location);
      const maneuverType = String(step.maneuver?.type ?? '').trim().toLowerCase();
      if (!Number.isSafeInteger(rawTurnId) || Number(rawTurnId) < 0 || !origin || maneuverType === 'depart' || maneuverType === 'arrive') continue;
      const incoming = authoritativeIncoming(stepIndex > 0 ? steps[stepIndex - 1] : undefined, origin);
      occurrences.push({
        key: `${legIndex}:${stepIndex}:${Number(rawTurnId)}`,
        index,
        legIndex,
        stepIndex,
        turnId: Number(rawTurnId),
        step,
        origin,
        incoming: incoming.vector,
        directionStatus: incoming.status,
      });
    }
  }
  return occurrences;
}

function sourceIdentity(feature: Feature<Point>): string[] {
  const properties = feature.properties ?? {};
  return ['mappls_poi_id', 'new_node_id', 'osm_source_id', 'poi_id', 'id']
    .map((key) => propText(properties, key).trim())
    .filter(Boolean);
}

function candidateIdentity(candidate: CandidateAnalysisCandidate): string[] {
  return [candidate.poi_id, candidate.osm_node_id].filter((value) => value !== null && value !== undefined && String(value).trim()).map(String);
}

function evidenceFor(feature: Feature<Point>, analysis?: CandidateAnalysisManeuver | null): Pick<CoveragePoi, 'engineEvidence' | 'engineReason'> {
  if (!analysis?.matched) return { engineEvidence: 'engine decision unknown', engineReason: 'No authoritative candidate-analysis match for this occurrence.' };
  const identities = new Set(sourceIdentity(feature));
  const candidate = analysis.candidates.find((item) => candidateIdentity(item).some((identity) => identities.has(identity)));
  if (!candidate) return { engineEvidence: 'engine decision unknown', engineReason: 'Source identity is not present in authoritative candidate evidence.' };
  if (candidate.selected === true || candidate.status === 'SELECTED' || candidate.engine_status === 'SELECTED') {
    return { engineEvidence: 'engine-selected', engineReason: candidate.reason ?? 'Explicitly selected by candidate analysis.' };
  }
  const rejected = candidate.eligible === false || candidate.status === 'REJECTED' || candidate.engine_status === 'REJECTED';
  if (rejected) return { engineEvidence: 'engine-rejected', engineReason: candidate.reason ?? candidate.rejection_reasons?.map((reason) => reason.text ?? reason.code).filter(Boolean).join('; ') ?? 'Explicitly rejected by candidate analysis.' };
  return { engineEvidence: 'engine-candidate', engineReason: 'Authoritative candidate data contains this POI, but does not explicitly select or reject it.' };
}

export function classifyCoveragePoi(
  turn: TurnOccurrence,
  feature: Feature<Point>,
  analysis?: CandidateAnalysisManeuver | null,
): CoveragePoi | null {
  if (!turn.incoming) return null;
  const coordinate = validCoordinate(feature.geometry.coordinates);
  if (!coordinate) return null;
  const vector = localMeters(turn.origin, coordinate);
  const distanceM = Math.hypot(vector.east, vector.north);
  const approachDotM = vector.east * turn.incoming.east + vector.north * turn.incoming.north;
  const crossM = turn.incoming.east * vector.north - turn.incoming.north * vector.east;
  const radialBoundary = Math.abs(distanceM - TURN_COVERAGE_RADIUS_M) <= TURN_COVERAGE_EPSILON_M;
  const planeBoundary = Math.abs(approachDotM) <= TURN_COVERAGE_EPSILON_M;
  // `inside` is the actual 30 m incoming half-disc. Epsilon only marks a
  // numerically uncertain boundary; it never expands the region.
  const inside = distanceM <= TURN_COVERAGE_RADIUS_M && approachDotM <= 0;
  return {
    feature,
    coordinate,
    distanceM,
    approachDotM,
    crossM,
    halfPlane: planeBoundary ? 'BOUNDARY' : approachDotM < 0 ? 'INCOMING' : 'OUTGOING',
    lateral: Math.abs(crossM) <= TURN_COVERAGE_EPSILON_M ? 'LATERAL BOUNDARY' : crossM > 0 ? 'LEFT' : 'RIGHT',
    inside,
    boundary: radialBoundary || planeBoundary,
    ...evidenceFor(feature, analysis),
  };
}

export function offsetLngLat(origin: LngLat, eastM: number, northM: number): LngLat {
  return [
    origin[0] + eastM / (111_320 * Math.cos(origin[1] * Math.PI / 180)),
    origin[1] + northM / 110_574,
  ];
}

export function poiDisplayName(feature: Feature<Point>): string {
  return propText(feature.properties, 'name', 'Unnamed POI');
}

export function poiPriority(feature: Feature<Point>): number | null {
  return propNumber(feature.properties, 'priority');
}
