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

function haversineMeters(a: LngLat, b: LngLat): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b[0] - a[0]);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(value)));
}

function dataset(id: string, name: string, validPois: number, sourceKind: 'geojson' | 'empty' | 'error', error: string | null = null) {
  return {
    id,
    name,
    priority: { rank_order: 'ascending', minimum: null, maximum: null },
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
    description: 'Synthetic happy-path route.',
    visibility: 'private',
    is_owner: true,
    revision: 1,
    expectation: { instruction_contains: 'Clock Tower Cafe' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'mock-shared-market-route',
    name: 'Shared market route',
    dataset: 'mock-demo',
    request: {
      start: { lon: 77.21862, lat: 28.63274 },
      end: { lon: 77.22414, lat: 28.62915 },
      costing: 'auto',
    },
    description: 'A shared testcase from another debugger user.',
    visibility: 'shared',
    is_owner: false,
    owner: { display_name: 'Route QA', username: 'route.qa' },
    revision: 1,
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
];

export interface MockApiState {
  activeDataset: string;
  scenarios: JsonObject[];
  preferences: JsonObject;
}

export function createMockApiState(): MockApiState {
  return {
    activeDataset: 'mock-demo',
    scenarios: structuredClone(INITIAL_SCENARIOS),
    preferences: {
      selected_dataset_id: 'mock-demo', preferred_basemap: 'mapmyindia',
      show_pois_on_map: true, poi_visualization_mode: 'auto',
      map_display_mode: '2d', route_view: 'both',
      layout: { leftCollapsed: false, rightCollapsed: false, analysisCollapsed: true, activeAnalysisTab: 'comparison' },
      dataset_selection_fallback: false, unavailable_dataset_id: null,
    },
  };
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

const MOCK_OPERATORS: Record<string, string[]> = {
  name: ['contains', 'eq'], priority: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  landmark_type: ['eq'], mappls_poi_id: ['eq', 'contains'], new_node_id: ['eq', 'contains'],
  osm_source_id: ['eq', 'contains'], visible: ['is_visible', 'is_hidden'],
};

function mockConditionMatches(properties: Record<string, unknown>, condition: JsonObject): boolean {
  const field = String(condition.field);
  const operator = String(condition.operator);
  if (field === 'visible') {
    const visible = !['no', 'false', '0', 'n'].includes(String(properties.visible ?? 'yes').toLowerCase());
    return operator === 'is_visible' ? visible : !visible;
  }
  if (field === 'priority') {
    const actual = Number(properties.priority);
    if (operator === 'between') {
      const value = condition.value as unknown[];
      return actual >= Number(value[0]) && actual <= Number(value[1]);
    }
    const expected = Number(condition.value);
    return operator === 'eq' ? actual === expected : operator === 'gt' ? actual > expected :
      operator === 'gte' ? actual >= expected : operator === 'lt' ? actual < expected : actual <= expected;
  }
  const actual = String(properties[field] ?? '').trim().toLowerCase();
  const expected = String(condition.value ?? '').trim().toLowerCase();
  return operator === 'eq' ? actual === expected : actual.includes(expected);
}

function validateMockConditions(raw: unknown, priority: { minimum: number | null; maximum: number | null }): string | null {
  if (!Array.isArray(raw)) return 'conditions must be an array';
  if (raw.length > 10) return 'conditions must contain at most 10 items';
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') return `condition ${index + 1} must be an object`;
    const condition = item as JsonObject;
    const field = String(condition.field ?? '');
    const operator = String(condition.operator ?? '');
    if (!MOCK_OPERATORS[field]) return `Unsupported condition field: ${field}`;
    if (!MOCK_OPERATORS[field].includes(operator)) return `Operator ${operator} is not supported for ${field}`;
    if (field === 'priority') {
      const values = operator === 'between' ? condition.value : [condition.value];
      if (!Array.isArray(values) || values.length !== (operator === 'between' ? 2 : 1) || values.some((value) => !Number.isFinite(Number(value)))) return 'Priority must be numeric';
      if (priority.minimum !== null && values.some((value) => Number(value) < priority.minimum!)) return `Priority must be at least ${priority.minimum}`;
      if (priority.maximum !== null && values.some((value) => Number(value) > priority.maximum!)) return `Priority must be at most ${priority.maximum}`;
      if (operator === 'between' && Number(values[0]) > Number(values[1])) return 'Priority between lower bound must not exceed upper bound';
    } else if (field !== 'visible' && (typeof condition.value !== 'string' || !condition.value.trim() || condition.value.length > 200)) {
      return `${field} requires a non-empty text value of at most 200 characters`;
    }
  }
  return null;
}

export async function handleMockApi(method: string, pathname: string, body: JsonObject, state: MockApiState): Promise<{ status: number; body: unknown } | null> {
  const requestUrl = new URL(pathname, 'http://vite.local');
  pathname = requestUrl.pathname;
  const ok = (responseBody: unknown, status = 200) => ({ status, body: responseBody });
  const mockSession = {
    user: {
      id: 'mock-development-user', issuer: 'urn:vpd:vite-mock', subject: 'mock-developer',
      display_name: 'Mock Developer', email: null,
    },
    csrf_token: 'vite-mock-csrf-token', expires_at: 4_102_444_800, auth_mode: 'development',
  };
  if (method === 'GET' && pathname === '/api/auth/config') return ok({
    mode: 'development', local_login_available: false, oidc_login_available: false,
    development_login_available: true, csrf_token: 'vite-mock-csrf-token',
  });
  if (method === 'GET' && pathname === '/api/auth/current') return ok(mockSession);
  if (method === 'POST' && pathname === '/api/auth/dev-login') return ok(mockSession);
  if (method === 'POST' && pathname === '/api/auth/logout') return ok({ ok: true });
  if (method === 'GET' && pathname === '/api/users/me/preferences') return ok(state.preferences);
  if (method === 'PATCH' && pathname === '/api/users/me/preferences') {
    const allowed = new Set(['selected_dataset_id', 'preferred_basemap', 'map_display_mode', 'route_view', 'layout', 'show_pois_on_map', 'poi_visualization_mode']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) return ok({ detail: `Unknown preference fields: ${unknown.join(', ')}` }, 400);
    if (typeof body.selected_dataset_id === 'string' && !DATASETS.some((item) => item.id === body.selected_dataset_id)) {
      return ok({ detail: `Unknown dataset: ${body.selected_dataset_id}` }, 400);
    }
    if ('show_pois_on_map' in body && typeof body.show_pois_on_map !== 'boolean') {
      return ok({ detail: 'show_pois_on_map must be a boolean' }, 400);
    }
    if ('poi_visualization_mode' in body && !['auto', 'density', 'clusters', 'points'].includes(String(body.poi_visualization_mode))) {
      return ok({ detail: 'poi_visualization_mode is invalid' }, 400);
    }
    state.preferences = { ...state.preferences, ...body, dataset_selection_fallback: false, unavailable_dataset_id: null };
    state.activeDataset = String(state.preferences.selected_dataset_id);
    return ok(state.preferences);
  }
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
  if (method === 'GET' && pathname === '/api/pois/search') {
    const datasetId = requestUrl.searchParams.get('dataset_id') ?? '';
    const selected = DATASETS.find((item) => item.id === datasetId);
    if (!datasetId) return ok({ detail: 'dataset_id is required' }, 422);
    if (!selected) return ok({ detail: `Dataset not found: ${datasetId}` }, 404);
    if (datasetId === 'mock-error') return ok({ detail: 'Synthetic POI index error' }, 503);
    const limit = Number(requestUrl.searchParams.get('limit') ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return ok({ detail: 'limit must be between 1 and 500' }, 400);
    let bbox: LngLat[] | null = null;
    const rawBbox = requestUrl.searchParams.get('bbox');
    if (rawBbox) {
      const values = rawBbox.split(',').map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[0] > values[2] || values[1] > values[3]) {
        return ok({ detail: 'bbox must be west,south,east,north without antimeridian crossing' }, 400);
      }
      bbox = [[values[0], values[1]], [values[2], values[3]]];
    }
    const query = (requestUrl.searchParams.get('q') ?? '').trim().toLowerCase();
    const type = requestUrl.searchParams.get('type');
    const minPriority = requestUrl.searchParams.has('min_priority') ? Number(requestUrl.searchParams.get('min_priority')) : null;
    if (minPriority !== null && !Number.isFinite(minPriority)) return ok({ detail: 'min_priority must be a number' }, 400);
    const visible = requestUrl.searchParams.get('visible');
    const allFeatures = datasetId === 'mock-demo' ? DEMO_POIS.features : [];
    const matches = allFeatures.filter((feature) => {
      const properties = feature.properties;
      const text = [properties.name, properties.mappls_poi_id, properties.new_node_id, properties.osm_source_id, properties.landmark_type].join(' ').toLowerCase();
      const [lon, lat] = feature.geometry.coordinates;
      return (!query || text.includes(query)) && (!type || properties.landmark_type === type) &&
        (minPriority === null || properties.priority >= minPriority) &&
        (visible === null || (visible === 'true') === !['no', 'false', '0', 'n'].includes(String(properties.visible).toLowerCase())) &&
        (!bbox || (lon >= bbox[0][0] && lon <= bbox[1][0] && lat >= bbox[0][1] && lat <= bbox[1][1]));
    }).sort((a, b) => query
      ? Number(String(b.properties.name).toLowerCase().startsWith(query)) - Number(String(a.properties.name).toLowerCase().startsWith(query)) || b.properties.priority - a.properties.priority || String(a.properties.name).localeCompare(String(b.properties.name))
      : String(a.id).localeCompare(String(b.id)));
    const cursor = requestUrl.searchParams.get('cursor');
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) return ok({ detail: 'Invalid pagination cursor' }, 400);
    const features = matches.slice(offset, offset + limit);
    const hasMore = offset + limit < matches.length;
    return ok({ type: 'FeatureCollection', dataset_id: datasetId, features, returned: features.length, has_more: hasMore, next_cursor: hasMore ? String(offset + limit) : null });
  }
  if (method === 'POST' && pathname === '/api/pois/diagnostics/nearby') {
    const datasetId = typeof body.dataset_id === 'string' ? body.dataset_id : '';
    const selected = DATASETS.find((item) => item.id === datasetId);
    if (!datasetId) return ok({ detail: 'dataset_id is required' }, 400);
    if (!selected) return ok({ detail: `Dataset not found: ${datasetId}` }, 404);
    if (datasetId === 'mock-error') return ok({ detail: 'Synthetic POI index error' }, 503);
    const points = body.points as LngLat[];
    const radiusM = Number(body.radius_m);
    if (!Array.isArray(points) || points.length === 0 || points.some((point) =>
      !Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value)))) {
      return ok({ detail: 'points must be a non-empty coordinate array' }, 400);
    }
    if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 2000) {
      return ok({ detail: 'radius_m must be greater than 0 and at most 2000' }, 400);
    }
    const features = (datasetId === 'mock-demo' ? DEMO_POIS.features : [])
      .filter((feature) => points.some((point) => haversineMeters(point, feature.geometry.coordinates as LngLat) <= radiusM));
    return ok({
      type: 'FeatureCollection', dataset_id: datasetId, features,
      returned: features.length, complete: true, incomplete_reason: null,
      matched_total: features.length, candidate_count: features.length,
      point_count: points.length, processed_points: points.length, radius_m: radiusM,
    });
  }
  if (method === 'POST' && pathname === '/api/pois/query') {
    const datasetId = typeof body.dataset_id === 'string' ? body.dataset_id : '';
    const selected = DATASETS.find((item) => item.id === datasetId);
    if (!datasetId) return ok({ detail: 'dataset_id is required' }, 400);
    if (!selected) return ok({ detail: `Dataset not found: ${datasetId}` }, 404);
    if (datasetId === 'mock-error') return ok({ detail: 'Synthetic POI index error' }, 503);
    const mode = body.mode ?? 'and';
    if (mode !== 'and' && mode !== 'or') return ok({ detail: "mode must be 'and' or 'or'" }, 400);
    const conditionError = validateMockConditions(body.conditions ?? [], selected.priority);
    if (conditionError) return ok({ detail: conditionError }, 400);
    const conditions = body.conditions as JsonObject[] ?? [];
    const q = String(body.q ?? '').trim().toLowerCase();
    if (q.length > 200) return ok({ detail: 'q must not exceed 200 characters' }, 400);
    const limit = body.limit === undefined ? 100 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return ok({ detail: 'limit must be between 1 and 500' }, 400);
    const bbox = body.bbox as number[] | undefined;
    if (bbox && (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value)) || bbox[0] > bbox[2] || bbox[1] > bbox[3])) return ok({ detail: 'bbox must be [west,south,east,north]' }, 400);
    const signature = JSON.stringify([datasetId, q, mode, conditions, bbox ?? null]);
    const cursor = body.cursor as JsonObject | string | undefined;
    let offset = 0;
    if (cursor !== undefined) {
      try {
        const decoded = JSON.parse(String(cursor)) as { signature: string; offset: number };
        if (decoded.signature !== signature || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error();
        offset = decoded.offset;
      } catch { return ok({ detail: 'Pagination cursor does not match this query' }, 400); }
    }
    const allFeatures = datasetId === 'mock-demo' ? DEMO_POIS.features : [];
    const matches = allFeatures.filter((feature) => {
      const properties = feature.properties as Record<string, unknown>;
      const quickText = [properties.name, properties.mappls_poi_id, properties.new_node_id, properties.osm_source_id, properties.landmark_type].join(' ').toLowerCase();
      const conditionMatches = conditions.map((condition) => mockConditionMatches(properties, condition));
      const advancedMatch = conditions.length === 0 || (mode === 'and' ? conditionMatches.every(Boolean) : conditionMatches.some(Boolean));
      const [lon, lat] = feature.geometry.coordinates;
      return (!q || quickText.includes(q)) && advancedMatch && (!bbox || (lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]));
    }).sort((a, b) => {
      const prefix = q ? Number(String(b.properties.name).toLowerCase().startsWith(q)) - Number(String(a.properties.name).toLowerCase().startsWith(q)) : 0;
      const priority = selected.priority.rank_order === 'ascending'
        ? a.properties.priority - b.properties.priority
        : b.properties.priority - a.properties.priority;
      return prefix || priority || String(a.properties.name).localeCompare(String(b.properties.name)) || String(a.id).localeCompare(String(b.id));
    });
    const features = matches.slice(offset, offset + limit);
    const hasMore = offset + limit < matches.length;
    return ok({ type: 'FeatureCollection', dataset_id: datasetId, features, returned: features.length, has_more: hasMore, next_cursor: hasMore ? JSON.stringify({ signature, offset: offset + limit }) : null });
  }
  if (method === 'GET' && pathname === '/api/scenarios') return ok({ directory: '[mock]', count: 0, scenarios: [], errors: [], source: 'legacy', read_only: true });
  if (method === 'GET' && (pathname === '/api/testcases' || pathname === '/api/testcases/shared')) {
    const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('limit') ?? 20)));
    const offset = Math.max(0, Number(requestUrl.searchParams.get('offset') ?? 0));
    const query = (requestUrl.searchParams.get('q') ?? '').trim().toLowerCase();
    const sharedOnly = pathname.endsWith('/shared');
    const matches = state.scenarios.filter((scenario) => {
      const owned = scenario.is_owner !== false;
      const visibility = String(scenario.visibility ?? 'private');
      const text = `${String(scenario.name ?? '')} ${String(scenario.description ?? '')}`.toLowerCase();
      return (sharedOnly ? visibility === 'shared' : owned) && (!query || text.includes(query));
    });
    return ok({ total: matches.length, limit, offset, testcases: matches.slice(offset, offset + limit) });
  }
  if (method === 'GET' && (pathname === '/api/valhalla/status' || pathname === '/api/osrm/status')) return ok({ ok: true, url: `mock://${pathname.includes('valhalla') ? 'valhalla' : 'osrm'}/status`, response: { version: 'synthetic' } });
  if (method === 'POST' && pathname === '/api/route/compare') return ok(routeComparison(body));
  if (method === 'POST' && pathname === '/api/route') return ok((routeComparison(body) as any).valhalla.response);

  const datasetMatch = pathname.match(/^\/api\/datasets\/([^/]+)\/(activate|reload-pois)$/);
  if (method === 'POST' && datasetMatch) {
    const id = decodeURIComponent(datasetMatch[1]);
    const selected = DATASETS.find((item) => item.id === id);
    if (!selected) return ok({ detail: `Dataset not found: ${id}` }, 404);
    if (datasetMatch[2] === 'activate') {
      state.activeDataset = id;
      state.preferences = { ...state.preferences, selected_dataset_id: id };
    }
    return ok({ ok: true, active_dataset: id, dataset: selected });
  }

  if (method === 'POST' && pathname === '/api/testcases') {
    const scenario = { ...body, id: `mock-${Date.now()}`, visibility: body.visibility === 'shared' ? 'shared' : 'private', is_owner: true, revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    state.scenarios.push(scenario);
    return ok(scenario, 201);
  }
  const scenarioMatch = pathname.match(/^\/api\/testcases\/([^/]+)$/);
  if (scenarioMatch) {
    const id = decodeURIComponent(scenarioMatch[1]);
    const index = state.scenarios.findIndex((scenario) => scenario.id === id);
    if (index < 0) return ok({ detail: `Scenario not found: ${id}` }, 404);
    if (method === 'PATCH') {
      state.scenarios[index] = { ...state.scenarios[index], ...body, id, revision: Number(state.scenarios[index].revision ?? 1) + 1, updated_at: new Date().toISOString() };
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
          const response = await handleMockApi(req.method ?? 'GET', req.url ?? pathname, body, state);
          if (!response) return send(res, 404, { detail: `No development mock for ${req.method} ${pathname}` });
          send(res, response.status, response.body);
        } catch (error) {
          send(res, 400, { detail: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
