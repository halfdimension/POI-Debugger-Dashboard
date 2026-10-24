import { describe, expect, it, vi } from 'vitest';
import { buildPoiSearchUrl, mergePoiPages, searchPois, serializePoiBounds } from './poiSearchApi';

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

  it('merges pages without duplicate POIs', () => {
    expect(mergePoiPages([feature('one'), feature('two')], [feature('two'), feature('three')]).map((item) => item.properties?.name))
      .toEqual(['one', 'two', 'three']);
  });
});
