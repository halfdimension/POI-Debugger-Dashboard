import type { LngLat, Maneuver, OsrmStep } from '../../types';

export type PoiAssociationClassification = 'confirmed' | 'narration_matched';
export type RoutePoiEngine = 'valhalla' | 'osrm';

export type RoutePoiAssociation = {
  engine: RoutePoiEngine;
  classification: PoiAssociationClassification;
  relatedIndexes: number[];
  primaryIndex: number;
  instruction: string;
  distanceM: number | null;
  candidateStatus: string;
  candidateReason: string;
};

export type RouteFocusedPoi = {
  key: string;
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  name: string;
  landmarkType: string;
  poiId: string;
  sourceNodeId: string;
  priority: number | null;
  associations: RoutePoiAssociation[];
};

export type NearbyCandidateEvidence = {
  engine: RoutePoiEngine;
  status: string;
  reason: string;
  selected: boolean;
};

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
  poiId: string;
  sourceNodeId: string;
  candidateEvidence: NearbyCandidateEvidence[];
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
};
