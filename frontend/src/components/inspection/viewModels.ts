import { osrmInstructionText, parseOsrmLandmarkInstruction, type OsrmLandmarkMatch } from '../../narration';
import { haversineMeters } from '../../coordinates';
import type { LngLat, Maneuver, OsrmPassByEvent, OsrmRouteResponse, OsrmStep } from '../../types';

export type ManeuverView = {
  index: number;
  legIndex: number;
  maneuverIndex: number;
  maneuver: Maneuver;
  coordinate: LngLat | null;
};

export type OsrmStepView = {
  index: number;
  legIndex: number;
  stepIndex: number;
  step: OsrmStep;
  coordinate: LngLat | null;
};

export type NearbyPoi = {
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  distanceM: number;
  priority: number | null;
  name: string;
  landmarkType: string;
};

export type NarrationPoiEvidence = {
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

export type RouteNarrationPoi = {
  key: string;
  evidence: NarrationPoiEvidence;
  maneuverIndexes: number[];
  primaryManeuverIndex: number;
};

export type OsrmRouteNarrationPoi = {
  key: string;
  evidence: NarrationPoiEvidence;
  stepIndexes: number[];
  primaryStepIndex: number;
  matchesByStep: Record<number, OsrmLandmarkMatch>;
};

export function narrationEvidenceForOsrmOccurrence(
  evidence: NarrationPoiEvidence,
  step: OsrmStepView,
): NarrationPoiEvidence {
  return {
    ...evidence,
    distanceM: step.coordinate ? haversineMeters(step.coordinate, evidence.coordinate) : null,
    matchedInstruction: osrmInstructionText(step.step),
  };
}

export type OsrmPassByEventView = {
  key: string;
  index: number;
  legIndex: number;
  eventIndex: number;
  event: OsrmPassByEvent;
  instruction: string;
  name: string;
  coordinate: LngLat | null;
  legDistanceM: number | null;
  routeDistanceM: number | null;
};

export type OsrmPassByLandmark = {
  key: string;
  event: OsrmPassByEventView;
  sourceEvidence: NarrationPoiEvidence | null;
  sourceMatch: 'poi-id' | 'osm-node-id' | 'name-and-proximity' | null;
};

export type OsrmGuidanceEntry = {
  key: string;
  kind: 'maneuver' | 'pass-by';
  category: 'maneuver' | 'landmark-at' | 'landmark-after' | 'landmark-before' | 'pass-by';
  landmark?: OsrmLandmarkMatch;
  instruction: string;
  legIndex: number;
  routeDistanceM: number | null;
  coordinate: LngLat | null;
  step?: OsrmStepView;
  passBy?: OsrmPassByEventView;
};

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validCoordinate(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

export function buildOsrmGuidance(
  response: OsrmRouteResponse | null,
): { passByEvents: OsrmPassByEventView[]; entries: OsrmGuidanceEntry[]; exactOrdering: boolean } {
  const passByEvents: OsrmPassByEventView[] = [];
  const entries: OsrmGuidanceEntry[] = [];
  let globalStepIndex = 0;
  let globalEventIndex = 0;
  let legOffsetM: number | null = 0;

  for (const [legIndex, leg] of (response?.routes?.[0]?.legs ?? []).entries()) {
    const steps = Array.isArray(leg.steps) ? leg.steps : [];
    let stepOffsetM: number | null = 0;
    for (const [stepIndex, step] of steps.entries()) {
      const coordinate = validCoordinate(step.maneuver?.location);
      const stepView: OsrmStepView = {
        index: globalStepIndex,
        legIndex,
        stepIndex,
        step,
        coordinate,
      };
      const landmark = parseOsrmLandmarkInstruction(osrmInstructionText(step));
      entries.push({
        key: `step:${legIndex}:${stepIndex}`,
        kind: 'maneuver',
        category: landmark ? `landmark-${landmark.relation}` : 'maneuver',
        landmark: landmark ?? undefined,
        instruction: osrmInstructionText(step),
        legIndex,
        routeDistanceM: legOffsetM !== null && stepOffsetM !== null ? legOffsetM + stepOffsetM : null,
        coordinate,
        step: stepView,
      });
      const distance = finiteNonNegative(step.distance);
      stepOffsetM = stepOffsetM !== null && distance !== null ? stepOffsetM + distance : null;
      globalStepIndex += 1;
    }

    const rawEvents = Array.isArray(leg.pass_by_events) ? leg.pass_by_events : [];
    for (const [eventIndex, rawEvent] of rawEvents.entries()) {
      if (!rawEvent || typeof rawEvent !== 'object') continue;
      const event = rawEvent as OsrmPassByEvent;
      const legDistanceM = finiteNonNegative(event.distance_from_leg_start);
      const view: OsrmPassByEventView = {
        key: `pass-by:${legIndex}:${eventIndex}`,
        index: globalEventIndex++,
        legIndex,
        eventIndex,
        event,
        instruction: String(event.instruction ?? '').trim() || `Pass ${String(event.name ?? 'unnamed POI').trim()}`,
        name: String(event.name ?? '').trim() || 'Unnamed pass-by POI',
        coordinate: validCoordinate(event.location),
        legDistanceM,
        routeDistanceM: legOffsetM !== null && legDistanceM !== null ? legOffsetM + legDistanceM : null,
      };
      passByEvents.push(view);
      entries.push({
        key: view.key,
        kind: 'pass-by',
        category: 'pass-by',
        instruction: view.instruction,
        legIndex,
        routeDistanceM: view.routeDistanceM,
        coordinate: view.coordinate,
        passBy: view,
      });
    }

    const declaredLegDistance = finiteNonNegative(leg.distance);
    const derivedLegDistance = steps.length > 0 && steps.every((step) => finiteNonNegative(step.distance) !== null)
      ? steps.reduce((sum, step) => sum + (finiteNonNegative(step.distance) ?? 0), 0)
      : null;
    const legDistance = declaredLegDistance ?? derivedLegDistance;
    legOffsetM = legOffsetM !== null && legDistance !== null ? legOffsetM + legDistance : null;
  }

  const exactOrdering = entries.every((entry) => entry.routeDistanceM !== null);
  entries.sort((a, b) => {
    if (a.routeDistanceM !== null && b.routeDistanceM !== null) return a.routeDistanceM - b.routeDistanceM;
    if (a.routeDistanceM !== null) return -1;
    if (b.routeDistanceM !== null) return 1;
    return a.legIndex - b.legIndex;
  });
  return { passByEvents, entries, exactOrdering };
}
