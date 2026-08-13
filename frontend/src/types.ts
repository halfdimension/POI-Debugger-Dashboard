export type LngLat = [number, number];

export interface DebuggerConfig {
  project: { name?: string };
  valhalla: {
    service_url: string;
    status_path: string;
    route_path: string;
  };
  engine: { root?: string };
  data: {
    pbf_path?: string;
    poi_geojson_path?: string;
    poi_csv_path?: string;
  };
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
