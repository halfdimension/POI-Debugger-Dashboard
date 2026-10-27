import { haversineMeters } from './coordinates';
import { propText } from './poi';
import type {
  CandidateAnalysis,
  CandidateAnalysisCandidate,
  CandidateAnalysisManeuver,
  LngLat,
} from './types';
import type {
  ManeuverView,
  NearbyCandidateEvidence,
  OsrmStepView,
  RoutePoiAssociation,
  RoutePoiEngine,
} from './components/inspection/viewModels';

const SOURCE_MATCH_TOLERANCE_M = 5;

function finiteCoordinate(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

export function sourcePoiKey(feature: GeoJSON.Feature<GeoJSON.Point>): string {
  const properties = feature.properties ?? {};
  const coordinate = feature.geometry.coordinates;
  const coordinateKey = `${Number(coordinate[0]).toFixed(7)}|${Number(coordinate[1]).toFixed(7)}`;
  const identifiers = [
    feature.id === undefined || feature.id === null ? '' : String(feature.id),
    propText(properties, 'new_node_id', '').trim(),
    propText(properties, 'mappls_poi_id', '').trim(),
    propText(properties, 'osm_source_type', '').trim(),
    propText(properties, 'osm_source_id', '').trim(),
  ];

  if (identifiers.some(Boolean)) return `source:${identifiers.join('|')}|${coordinateKey}`;

  return [
    'anonymous',
    coordinateKey,
    JSON.stringify(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))),
  ].join('|');
}

function candidateSourceMatches(
  candidate: CandidateAnalysisCandidate,
  sourceFeatures: GeoJSON.Feature<GeoJSON.Point>[],
): GeoJSON.Feature<GeoJSON.Point>[] {
  const candidateId = String(candidate.poi_id ?? '').trim();
  const candidateCoordinate = finiteCoordinate(candidate.coordinate);
  if (!candidateId || !candidateCoordinate) return [];

  return sourceFeatures.filter((feature) => {
    const properties = feature.properties ?? {};
    const sourceIds = [
      propText(properties, 'mappls_poi_id', '').trim(),
      propText(properties, 'new_node_id', '').trim(),
    ];
    if (!sourceIds.includes(candidateId)) return false;
    return haversineMeters(candidateCoordinate, feature.geometry.coordinates as LngLat) <= SOURCE_MATCH_TOLERANCE_M;
  });
}

function selectedCandidate(analysis: CandidateAnalysisManeuver): CandidateAnalysisCandidate | null {
  const selected = analysis.candidates.filter((candidate) => candidate.selected === true);
  if (selected.length !== 1) return null;
  const candidate = selected[0];
  const selectedPoiId = String(analysis.selected_poi_id ?? '').trim();
  const candidatePoiId = String(candidate.poi_id ?? '').trim();
  if (!selectedPoiId || selectedPoiId !== candidatePoiId) return null;
  return candidate;
}

function routeIndexForAnalysis(
  engine: RoutePoiEngine,
  analysis: CandidateAnalysisManeuver,
  maneuverViews: ManeuverView[],
  osrmStepViews: OsrmStepView[],
): number | null {
  if (engine === 'valhalla') {
    const view = maneuverViews.find((item) =>
      item.legIndex === analysis.leg_index && item.maneuverIndex === analysis.maneuver_index);
    return view?.index ?? null;
  }
  const view = osrmStepViews.find((item) =>
    item.legIndex === analysis.leg_index && item.stepIndex === analysis.step_index);
  return view?.index ?? null;
}

function instructionForIndex(
  engine: RoutePoiEngine,
  index: number,
  maneuverViews: ManeuverView[],
  osrmStepViews: OsrmStepView[],
  getOsrmInstruction: (step: OsrmStepView['step']) => string,
): string {
  return engine === 'valhalla'
    ? maneuverViews.find((item) => item.index === index)?.maneuver.instruction ?? ''
    : getOsrmInstruction(osrmStepViews.find((item) => item.index === index)?.step ?? {});
}

export function confirmedRoutePoiAssociations(
  engine: RoutePoiEngine,
  candidateAnalysis: CandidateAnalysis | null,
  sourceFeatures: GeoJSON.Feature<GeoJSON.Point>[],
  maneuverViews: ManeuverView[],
  osrmStepViews: OsrmStepView[],
  getOsrmInstruction: (step: OsrmStepView['step']) => string,
): Array<{ feature: GeoJSON.Feature<GeoJSON.Point>; association: RoutePoiAssociation }> {
  if (!candidateAnalysis?.available || candidateAnalysis.engine !== engine) return [];
  const result: Array<{ feature: GeoJSON.Feature<GeoJSON.Point>; association: RoutePoiAssociation }> = [];

  for (const analysis of candidateAnalysis.maneuvers) {
    const candidate = selectedCandidate(analysis);
    if (!candidate) continue;
    const matches = candidateSourceMatches(candidate, sourceFeatures);
    if (matches.length !== 1) continue;
    const routeIndex = routeIndexForAnalysis(engine, analysis, maneuverViews, osrmStepViews);
    if (routeIndex === null) continue;

    result.push({
      feature: matches[0],
      association: {
        engine,
        classification: 'confirmed',
        relatedIndexes: [routeIndex],
        primaryIndex: routeIndex,
        instruction: instructionForIndex(engine, routeIndex, maneuverViews, osrmStepViews, getOsrmInstruction),
        distanceM: candidate.distance_to_maneuver_m ?? candidate.maneuver_distance_m ?? candidate.distance_m ?? null,
        candidateStatus: candidate.status ?? candidate.engine_status ?? 'SELECTED',
        candidateReason: candidate.reason ?? candidate.ranking_reason?.text ?? '',
      },
    });
  }

  return result;
}

export function candidateEvidenceForSource(
  feature: GeoJSON.Feature<GeoJSON.Point>,
  analyses: Array<CandidateAnalysisManeuver | null>,
): NearbyCandidateEvidence[] {
  const result: NearbyCandidateEvidence[] = [];
  for (const analysis of analyses) {
    if (!analysis) continue;
    for (const candidate of analysis.candidates) {
      const matches = candidateSourceMatches(candidate, [feature]);
      if (matches.length !== 1) continue;
      result.push({
        engine: analysis.engine,
        status: candidate.status ?? candidate.engine_status ?? 'UNKNOWN',
        reason: candidate.reason ?? candidate.ranking_reason?.text ?? candidate.rejection_reasons?.[0]?.text ?? '',
        selected: candidate.selected === true,
      });
    }
  }
  return result;
}
