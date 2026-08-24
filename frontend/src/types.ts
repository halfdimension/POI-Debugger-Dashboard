export type LngLat = [number, number];

export interface DatasetStats {
  total_rows: number;
  valid_pois: number;
  invalid_coordinates: number;
  missing_names: number;
  invisible_pois: number;
  duplicate_node_ids: number;
  landmark_types: Record<string, number>;
}

export interface DatasetSummary {
  id: string;
  name: string;
  pbf_path?: string;
  poi_csv_path?: string;
  poi_geojson_path?: string;
  tiles_path?: string;
  valhalla_config_path?: string;
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
  };
  osrm: {
    service_url: string;
    profile: string;
    route_path: string;
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

export interface EngineRouteResult<T> {
  ok: boolean;
  url?: string;
  status_code?: number;
  response?: T;
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
