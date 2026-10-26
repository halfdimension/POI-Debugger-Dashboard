export type LngLat = [number, number];

export interface PriorityPolicy {
  rank_order: 'ascending' | 'descending';
  minimum: number | null;
  maximum: number | null;
}

export interface DatasetStats {
  total_rows: number;
  valid_pois: number;
  invalid_coordinates: number;
  missing_names: number;
  invisible_pois: number;
  duplicate_poi_ids: number;
  duplicate_node_ids: number;
  landmark_types: Record<string, number>;
}

export interface DatasetSummary {
  id: string;
  name: string;
  priority: PriorityPolicy;
  map_bounds?: [LngLat, LngLat] | null;
  pbf_path?: string;
  poi_csv_path?: string;
  poi_geojson_path?: string;
  tiles_path?: string;
  valhalla_config_path?: string;
  valhalla_association_debug_jsonl_path?: string;
  osrm_landmark_debug_jsonl_path?: string;
  source_kind?: 'csv' | 'geojson' | 'empty' | 'error' | null;
  source_path?: string | null;
  source_exists: boolean;
  loaded_at?: string | null;
  stats?: DatasetStats | null;
  error?: string | null;
}

export interface DatasetRegistryResponse {
  active_dataset: string;
  datasets: DatasetSummary[];
}

export interface DebuggerConfig {
  project: { name?: string };
  valhalla: {
    service_url: string;
    status_path: string;
    route_path: string;
    association_debug_jsonl_path?: string | null;
  };
  osrm: {
    service_url: string;
    profile: string;
    route_path: string;
    landmark_debug_jsonl_path?: string | null;
  };
  engine: { root?: string };
  data: {
    pbf_path?: string;
    poi_geojson_path?: string;
    poi_csv_path?: string;
  };
  active_dataset?: string;
  frontend: {
    map_style_url: string;
    default_center: LngLat;
    default_zoom: number;
  };
  config_path: string;
}

export interface Maneuver {
  instruction?: string;
  verbal_pre_transition_instruction?: string;
  type?: number;
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  street_names?: string[];
}

export interface ValhallaLeg {
  shape?: string;
  maneuvers?: Maneuver[];
}

export interface ValhallaRouteResponse {
  trip?: {
    status?: number;
    status_message?: string;
    summary?: {
      length?: number;
      time?: number;
    };
    legs?: ValhallaLeg[];
  };
  error?: string;
}

export interface OsrmStepManeuver {
  location?: LngLat;
  type?: string;
  modifier?: string;

  // Custom fields from this OSRM fork.
  instruction?: string;
  short_instruction?: string;
  maneuver_id?: number;

  // Authoritative extraction TurnData identity from this OSRM fork.
  turn_id?: number;
}

export interface OsrmStep {
  distance?: number;
  duration?: number;
  weight?: number;
  name?: string;
  maneuver?: OsrmStepManeuver;
}

export interface OsrmLeg {
  distance?: number;
  duration?: number;
  weight?: number;
  steps?: OsrmStep[];
}

export interface OsrmRouteGeometry {
  type?: string;
  coordinates?: LngLat[];
}

export interface OsrmRoute {
  distance?: number;
  duration?: number;
  weight?: number;
  geometry?: OsrmRouteGeometry;
  legs?: OsrmLeg[];
}

export interface OsrmRouteResponse {
  code?: string;
  routes?: OsrmRoute[];
  message?: string;
}


export interface CandidateReason {
  code?: string;
  text?: string;
  actual?: unknown;
  operator?: string;
  threshold?: unknown;
  unit?: string;
  required?: unknown;
}

export interface CandidateAssociationEdge {
  graph_id?: number;
  tile_id?: number;
  level?: number;
  directed_edge_id?: number;
}

export interface CandidateAssociationEvent {
  pass?: string;
  stage?: string;
  status?: string;
  reason?: string;
  policy?: Record<string, unknown>;
  edge?: CandidateAssociationEdge | null;
  opposing_edge?: CandidateAssociationEdge | null;
  road_name?: string;
  distance_m?: number;
  classification?: number;
  superseded?: boolean;
  link?: boolean;
}

export interface CandidateRuntimeAssociation {
  route_edge_role?: string;
  graph_id?: number;
  tile_id?: number;
  level?: number;
  directed_edge_id?: number;
  way_id?: number;
  edge_info_offset?: number;
  directed_edge_forward?: boolean;
  trip_edge_node_index?: number;
  distance_along_used_edge_m?: number;
  fraction_along_full_edge?: number;
  used_edge_start_pct?: number;
  used_edge_end_pct?: number;
}

export interface CandidateBuildAssociation {
  available?: boolean;
  matched?: boolean;
  match_kind?: string | null;
  poi_event_count?: number;
  selected_association_count?: number;
  selected_event?: CandidateAssociationEvent | null;
  selected_associations?: CandidateAssociationEvent[];
  route_edge_event_count?: number;
  route_edge_events?: CandidateAssociationEvent[];
  warnings?: string[];
  error?: string | null;
}

export interface CandidateAssociation {
  runtime?: CandidateRuntimeAssociation | null;
  build?: CandidateBuildAssociation;
}

export interface CandidateAnalysisCandidate {
  poi_id?: string | null;
  osm_node_id?: number | null;

  name?: string | null;
  type?: string | number | null;

  coordinate?: LngLat | null;

  location?: {
    lat?: number;
    lon?: number;
  } | null;

  priority?: number | null;
  priority_raw?: string | null;
  visible?: string | null;

  distance_m?: number | null;
  distance_to_maneuver_m?: number | null;

  // OSRM v2 authoritative maneuver / route-edge evidence.
  on_incoming?: boolean | null;
  on_outgoing?: boolean | null;

  // OSRM P2 association provenance.
  //
  // association_augmented describes the effective association evidence
  // used by the selector. The role-specific fields preserve provenance
  // for incoming and outgoing road membership separately.
  incoming_association_augmented?: boolean | null;
  outgoing_association_augmented?: boolean | null;
  association_augmented?: boolean | null;

  incoming_distance_to_turn_m?: number | null;
  outgoing_distance_from_turn_m?: number | null;

  incoming_perpendicular_distance_m?: number | null;
  outgoing_perpendicular_distance_m?: number | null;

  maneuver_distance_m?: number | null;
  perpendicular_distance_m?: number | null;

  right?: boolean | null;

  eligible?: boolean | null;
  selected?: boolean;

  status?: string;
  engine_status?: string;

  reason_code?: string | null;
  reason?: string | null;

  rejection_reasons?: CandidateReason[];
  ranking_reason?: CandidateReason | null;
  deduplication_reason?: CandidateReason | null;

  association?: CandidateAssociation;
}

export interface CandidateAnalysisManeuver {
  engine: 'valhalla' | 'osrm';

  matched?: boolean;

  leg_index: number;
  maneuver_index?: number;
  step_index?: number;

  identity?: {
    turn_id?: number;
    intersection_node?: number;
    delayed?: boolean;
  };

  maneuver?: {
    coordinate?: LngLat | null;
    incoming_bearing?: number | null;
    outgoing_bearing?: number | null;
  } | null;

  route_maneuver?: Record<string, unknown>;

  selector?: Record<string, unknown> | null;

  selected_poi_id?: string | null;
  selected?: Record<string, unknown> | null;

  candidates: CandidateAnalysisCandidate[];

  warnings?: string[];
  error?: string | null;
}

export interface CandidateAnalysis {
  schema: string;
  engine: 'valhalla' | 'osrm';

  available: boolean;

  source?: unknown;

  summary: Record<string, number>;

  maneuvers: CandidateAnalysisManeuver[];

  warnings?: string[];
  limitations?: string[];

  error?: string | null;
}

export interface EngineRouteResult<T> {
  ok: boolean;
  url?: string;
  status_code?: number;
  response?: T;
  candidate_analysis?: CandidateAnalysis;
  error?: string;
}

export interface CompareRouteResponse {
  valhalla: EngineRouteResult<ValhallaRouteResponse>;
  osrm: EngineRouteResult<OsrmRouteResponse>;
}

export interface ScenarioPoint {
  lon: number;
  lat: number;
}

export interface ScenarioExpectation {
  landmark_name?: string;
  instruction_contains?: string;
  instruction_not_contains?: string;
  case_sensitive?: boolean;
}

export interface RouteScenario {
  id: string;
  name: string;
  dataset: string;
  request: {
    start: ScenarioPoint;
    end: ScenarioPoint;
    costing: string;
  };
  notes?: string;
  expectation?: ScenarioExpectation;
  created_at?: string;
  updated_at?: string;
}

export interface ScenarioRegistryResponse {
  directory: string;
  count: number;
  scenarios: RouteScenario[];
  errors: string[];
}
