import { describe, expect, it, vi } from 'vitest';
import { buildPoiQueryBody, buildPoiSearchUrl, fetchDiagnosticPois, mergePoiPages, queryPois, searchPois, serializePoiBounds } from './poiSearchApi';

const feature = (id: string) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [77, 28] },
  properties: { mappls_poi_id: id, name: id },
});

describe('POI search client', () => {
  it('serializes the explicit dataset and combined filters safely', () => {
    const url = new URL(buildPoiSearchUrl({
      datasetId: 'weekly data', q: 'Cafe & fuel', type: 'shop', minPriority: 35,
      visible: true, bbox: [76.5, 27, 78, 29], limit: 100, cursor: 'a+b=',
    }), 'http://local');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      dataset_id: 'weekly data', q: 'Cafe & fuel', type: 'shop', min_priority: '35',
      visible: 'true', bbox: '76.5,27,78,29', limit: '100', cursor: 'a+b=',
    });
  });

  it('serializes a numeric identifier as search text, independently of minimum priority', () => {
    const url = new URL(buildPoiSearchUrl({
      datasetId: 'weekly', q: '900000123', minPriority: 40,
    }), 'http://local');

    expect(url.searchParams.get('q')).toBe('900000123');
    expect(url.searchParams.get('min_priority')).toBe('40');
  });

  it('omits the optional priority filter while preserving numeric search text', () => {
    const url = new URL(buildPoiSearchUrl({ datasetId: 'weekly', q: '910002' }), 'http://local');

    expect(url.searchParams.get('q')).toBe('910002');
    expect(url.searchParams.has('min_priority')).toBe(false);
  });

  it('validates bbox ordering and antimeridian bounds', () => {
    expect(serializePoiBounds([-180, -90, 180, 90])).toBe('-180,-90,180,90');
    expect(() => serializePoiBounds([170, -10, -170, 10])).toThrow(/antimeridian/);
  });

  it('passes AbortSignal and reports backend details', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'index failed' }) }));
    await expect(searchPois({ datasetId: 'demo' }, controller.signal)).rejects.toThrow('index failed');
    expect(fetch).toHaveBeenCalledWith('/api/pois/search?dataset_id=demo', { signal: controller.signal });
    vi.unstubAllGlobals();
  });

  it('serializes structured fields, numeric ranges, mode, scope bounds and cursor', () => {
    expect(buildPoiQueryBody({
      datasetId: 'weekly', q: 'Delhi', mode: 'or', bbox: [76, 27, 78, 29], limit: 50, cursor: 'next',
      conditions: [
        { id: 'ui-1', field: 'priority', operator: 'between', value: [60, 90] },
        { id: 'ui-2', field: 'landmark_type', operator: 'eq', value: 'fuel' },
      ],
    })).toEqual({
      dataset_id: 'weekly', q: 'Delhi', mode: 'or', bbox: [76, 27, 78, 29], limit: 50, cursor: 'next',
      conditions: [
        { field: 'priority', operator: 'between', value: [60, 90] },
        { field: 'landmark_type', operator: 'eq', value: 'fuel' },
      ],
    });
  });

  it('posts a structured query with cancellation support', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ features: [] }) }));
    await queryPois({ datasetId: 'demo', mode: 'and', conditions: [{ id: '1', field: 'visible', operator: 'is_visible' }] }, controller.signal);
    expect(fetch).toHaveBeenCalledWith('/api/pois/query', expect.objectContaining({ method: 'POST', signal: controller.signal }));
    vi.unstubAllGlobals();
  });

  it('posts targeted diagnostic points and preserves explicit completeness', async () => {
    const controller = new AbortController();
    const diagnostic = { type: 'FeatureCollection', features: [], complete: false, incomplete_reason: 'candidate_limit' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => diagnostic }));
    await expect(fetchDiagnosticPois('demo', [[77, 28], [77.1, 28.1]], 500, controller.signal))
      .resolves.toBe(diagnostic);
    expect(fetch).toHaveBeenCalledWith('/api/pois/diagnostics/nearby', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ dataset_id: 'demo', points: [[77, 28], [77.1, 28.1]], radius_m: 500 }),
    }));
    vi.unstubAllGlobals();
  });

  it('merges pages without duplicate POIs', () => {
    expect(mergePoiPages([feature('one'), feature('two')], [feature('two'), feature('three')]).map((item) => item.properties?.name))
      .toEqual(['one', 'two', 'three']);
  });

  it('does not collapse separate POIs that reuse an external identifier', () => {
    const duplicateAtAnotherLocation = { ...feature('one'), geometry: { type: 'Point' as const, coordinates: [78, 29] } };
    expect(mergePoiPages([feature('one')], [duplicateAtAnotherLocation])).toHaveLength(2);
  });
});
