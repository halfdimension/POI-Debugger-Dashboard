import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

type JsonObject = Record<string, unknown>;
type LngLat = [number, number];

const DEMO_POIS = {
  type: 'FeatureCollection',
  features: [
    poi('mock-001', 'Metro Gate Landmark', [77.21862, 28.63274], 'transit', 95, 'yes', '910001'),
    poi('mock-002', 'Clock Tower Cafe', [77.22105, 28.63091], 'restaurant', 80, 'yes', '910002'),
    poi('mock-003', 'City Library', [77.22414, 28.62915], 'public_building', 70, 'yes', '910003'),
    poi('mock-004', 'Hidden Test Landmark', [77.2263, 28.62755], 'shop', 35, 'no', '910004'),
  ],
};

function poi(id: string, name: string, coordinates: LngLat, landmarkType: string, priority: number, visible: string, nodeId: string) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates },
    properties: {
      name,
      mappls_poi_id: id,
      new_node_id: nodeId,
      osm_source_id: nodeId,
      landmark_type: landmarkType,
      priority,
      visible,
    },
  };
}

function dataset(id: string, name: string, validPois: number, sourceKind: 'geojson' | 'empty' | 'error', error: string | null = null) {
  return {
    id,
    name,
    map_bounds: [[77.212, 28.625], [77.232, 28.638]],
    poi_geojson_path: `[mock]/${id}.geojson`,
    source_kind: sourceKind,
    source_path: `[mock]/${id}.geojson`,
    source_exists: sourceKind !== 'error',
    loaded_at: '2026-01-01T00:00:00Z',
    stats: {
      total_rows: validPois,
      valid_pois: validPois,
      invalid_coordinates: 0,
      missing_names: 0,
      invisible_pois: id === 'mock-demo' ? 1 : 0,
      duplicate_poi_ids: 0,
      duplicate_node_ids: 0,
      landmark_types: id === 'mock-demo' ? { transit: 1, restaurant: 1, public_building: 1, shop: 1 } : {},
    },
    error,
  };
}

const DATASETS = [
  dataset('mock-demo', 'Mock Delhi landmarks', 4, 'geojson'),
  dataset('mock-empty', 'Mock empty dataset', 0, 'empty'),
  dataset('mock-error', 'Mock source error', 0, 'error', 'Synthetic source-read error for UI validation.'),
];

const INITIAL_SCENARIOS = [
  {
    id: 'mock-metro-to-library',
    name: 'Metro gate to library',
    dataset: 'mock-demo',
    request: {
      start: { lon: 77.2175, lat: 28.6332 },
      end: { lon: 77.2272, lat: 28.6271 },
      costing: 'auto',
    },
    notes: 'Synthetic happy-path route.',
    expectation: { instruction_contains: 'Clock Tower Cafe' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

export interface MockApiState {
  activeDataset: string;
  scenarios: JsonObject[];
}

export function createMockApiState(): MockApiState {
  return { activeDataset: 'mock-demo', scenarios: structuredClone(INITIAL_SCENARIOS) };
}

export function shouldEnableMockApi(command: string, mode: string, isPreview: boolean, value: string | undefined): boolean {
  return command === 'serve' && !isPreview && mode === 'development' && value === '1';
}

function encodePolyline6(coordinates: LngLat[]): string {
  let previousLat = 0;
  let previousLon = 0;
  let encoded = '';
  const encodeValue = (value: number) => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    encoded += String.fromCharCode(shifted + 63);
  };
  for (const [lon, lat] of coordinates) {
    const nextLat = Math.round(lat * 1e6);
    const nextLon = Math.round(lon * 1e6);
    encodeValue(nextLat - previousLat);
    encodeValue(nextLon - previousLon);
    previousLat = nextLat;
    previousLon = nextLon;
  }
  return encoded;
}

function routeComparison(body: JsonObject) {
  const locations = Array.isArray(body.locations) ? body.locations as Array<{ lon?: number; lat?: number }> : [];
  const start: LngLat = [Number(locations[0]?.lon ?? 77.2175), Number(locations[0]?.lat ?? 28.6332)];
  const end: LngLat = [Number(locations[1]?.lon ?? 77.2272), Number(locations[1]?.lat ?? 28.6271)];
  const middle: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const coordinates: LngLat[] = [start, middle, end];
  const valhalla = {
    trip: {
      status: 0,
      status_message: 'Found route between points',
      summary: { length: 1.42, time: 218 },
      legs: [{
        shape: encodePolyline6(coordinates),
        maneuvers: [
          { instruction: 'Drive east toward Clock Tower Cafe.', verbal_pre_transition_instruction: 'Drive east.', type: 1, length: 0.72, time: 110, begin_shape_index: 0, end_shape_index: 1, street_names: ['Mock Avenue'] },
          { instruction: 'Turn right at Clock Tower Cafe.', verbal_pre_transition_instruction: 'Turn right at Clock Tower Cafe.', type: 10, length: 0.70, time: 108, begin_shape_index: 1, end_shape_index: 2, street_names: ['Fixture Road'] },
        ],
      }],
    },
  };
  const osrm = {
    code: 'Ok',
    routes: [{
      distance: 1490,
      duration: 232,
      weight: 232,
      geometry: { type: 'LineString', coordinates },
      legs: [{
        distance: 1490,
        duration: 232,
        weight: 232,
        steps: [
          { distance: 760, duration: 116, weight: 116, name: 'Mock Avenue', maneuver: { location: start, type: 'depart', modifier: 'straight', instruction: 'Depart on Mock Avenue' } },
          { distance: 730, duration: 116, weight: 116, name: 'Fixture Road', maneuver: { location: middle, type: 'turn', modifier: 'right', instruction: 'Turn right at Clock Tower Cafe', turn_id: 7001 } },
          { distance: 0, duration: 0, weight: 0, name: 'Fixture Road', maneuver: { location: end, type: 'arrive', modifier: 'straight', instruction: 'You have arrived' } },
        ],
      }],
    }],
  };
  const unavailableAnalysis = (engine: 'valhalla' | 'osrm') => ({
    schema: 'mock-candidate-analysis-v1', engine, available: false, summary: {}, maneuvers: [],
    limitations: ['Synthetic routes do not contain authoritative engine candidate evidence.'],
    error: 'Candidate evidence is intentionally unavailable in frontend mock mode.',
  });
  return {
    valhalla: { ok: true, url: 'mock://valhalla/route', status_code: 200, response: valhalla, candidate_analysis: unavailableAnalysis('valhalla') },
    osrm: { ok: true, url: 'mock://osrm/route', status_code: 200, response: osrm, candidate_analysis: unavailableAnalysis('osrm') },
  };
}

function parseBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) as JsonObject : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function handleMockApi(method: string, pathname: string, body: JsonObject, state: MockApiState): Promise<{ status: number; body: unknown } | null> {
  const ok = (responseBody: unknown, status = 200) => ({ status, body: responseBody });
  if (method === 'GET' && pathname === '/api/config') return ok({
    project: { name: 'POI Debugger Dashboard' },
    valhalla: { service_url: 'mock://valhalla', status_path: '/status', route_path: '/route', association_debug_jsonl_path: null },
    osrm: { service_url: 'mock://osrm', profile: 'driving', route_path: '/route/v1', landmark_debug_jsonl_path: null },
    engine: { root: '[mock]' },
    data: { poi_geojson_path: `[mock]/${state.activeDataset}.geojson` },
    active_dataset: state.activeDataset,
    frontend: { map_style_url: 'https://tiles.openfreemap.org/styles/liberty', default_center: [77.222, 28.6305], default_zoom: 14 },
    config_path: '[Vite development mock]',
  });
  if (method === 'GET' && pathname === '/api/datasets') return ok({ active_dataset: state.activeDataset, datasets: DATASETS });
  if (method === 'GET' && pathname === '/api/pois') {
    return ok(state.activeDataset === 'mock-demo' ? DEMO_POIS : { type: 'FeatureCollection', features: [] });
  }
  if (method === 'GET' && pathname === '/api/scenarios') return ok({ directory: '[mock]', count: state.scenarios.length, scenarios: state.scenarios, errors: [] });
  if (method === 'GET' && (pathname === '/api/valhalla/status' || pathname === '/api/osrm/status')) return ok({ ok: true, url: `mock://${pathname.includes('valhalla') ? 'valhalla' : 'osrm'}/status`, response: { version: 'synthetic' } });
  if (method === 'POST' && pathname === '/api/route/compare') return ok(routeComparison(body));
  if (method === 'POST' && pathname === '/api/route') return ok((routeComparison(body) as any).valhalla.response);

  const datasetMatch = pathname.match(/^\/api\/datasets\/([^/]+)\/(activate|reload-pois)$/);
  if (method === 'POST' && datasetMatch) {
    const id = decodeURIComponent(datasetMatch[1]);
    const selected = DATASETS.find((item) => item.id === id);
    if (!selected) return ok({ detail: `Dataset not found: ${id}` }, 404);
    state.activeDataset = id;
    return ok({ ok: true, active_dataset: id, dataset: selected });
  }

  if (method === 'POST' && pathname === '/api/scenarios') {
    const scenario = { ...body, id: `mock-${Date.now()}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    state.scenarios.push(scenario);
    return ok(scenario, 201);
  }
  const scenarioMatch = pathname.match(/^\/api\/scenarios\/([^/]+)$/);
  if (scenarioMatch) {
    const id = decodeURIComponent(scenarioMatch[1]);
    const index = state.scenarios.findIndex((scenario) => scenario.id === id);
    if (index < 0) return ok({ detail: `Scenario not found: ${id}` }, 404);
    if (method === 'PUT') {
      state.scenarios[index] = { ...state.scenarios[index], ...body, id, updated_at: new Date().toISOString() };
      return ok(state.scenarios[index]);
    }
    if (method === 'DELETE') {
      state.scenarios.splice(index, 1);
      return ok({ ok: true, id });
    }
  }
  return null;
}

export function mockApiPlugin(): Plugin {
  const state = createMockApiState();
  return {
    name: 'vpd-development-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://vite.local').pathname;
        if (!pathname.startsWith('/api/')) return next();
        try {
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await parseBody(req) : {};
          const response = await handleMockApi(req.method ?? 'GET', pathname, body, state);
          if (!response) return send(res, 404, { detail: `No development mock for ${req.method} ${pathname}` });
          send(res, response.status, response.body);
        } catch (error) {
          send(res, 400, { detail: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
