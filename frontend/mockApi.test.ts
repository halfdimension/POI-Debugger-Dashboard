import { describe, expect, it } from 'vitest';
import { createMockApiState, handleMockApi, shouldEnableMockApi } from './mockApi';

describe('development mock API contracts', () => {
  it('returns the startup resources and a realistic route comparison', async () => {
    const state = createMockApiState();
    const config = await handleMockApi('GET', '/api/config', {}, state);
    const pois = await handleMockApi('GET', '/api/pois', {}, state);
    const route = await handleMockApi('POST', '/api/route/compare', {
      locations: [{ lon: 77.2175, lat: 28.6332 }, { lon: 77.2272, lat: 28.6271 }],
    }, state);
    expect(config?.status).toBe(200);
    expect((pois?.body as any).features).toHaveLength(4);
    expect((route?.body as any).valhalla.response.trip.legs[0].shape).toBeTruthy();
    expect((route?.body as any).osrm.response.routes[0].geometry.coordinates).toHaveLength(3);
  });

  it('supports empty and source-error dataset states', async () => {
    const state = createMockApiState();
    await handleMockApi('POST', '/api/datasets/mock-empty/activate', {}, state);
    expect((await handleMockApi('GET', '/api/pois', {}, state))?.body).toEqual({ type: 'FeatureCollection', features: [] });
    await handleMockApi('POST', '/api/datasets/mock-error/activate', {}, state);
    const registry = await handleMockApi('GET', '/api/datasets', {}, state);
    expect((await handleMockApi('GET', '/api/pois', {}, state))?.body).toEqual({ type: 'FeatureCollection', features: [] });
    expect((registry?.body as any).datasets.find((item: any) => item.id === 'mock-error').error).toContain('Synthetic');
  });

  it('implements bounded, filtered and paginated POI search', async () => {
    const state = createMockApiState();
    const first = await handleMockApi('GET', '/api/pois/search?dataset_id=mock-demo&visible=true&min_priority=70&bbox=77.21,28.62,77.23,28.64&limit=2', {}, state);
    expect(first?.status).toBe(200);
    expect((first?.body as any).features).toHaveLength(2);
    expect((first?.body as any).has_more).toBe(true);
    const cursor = (first?.body as any).next_cursor;
    const second = await handleMockApi('GET', `/api/pois/search?dataset_id=mock-demo&visible=true&min_priority=70&bbox=77.21,28.62,77.23,28.64&limit=2&cursor=${cursor}`, {}, state);
    expect((second?.body as any).features).toHaveLength(1);
    expect((second?.body as any).has_more).toBe(false);
  });

  it('supports identifier/type searches and contract errors', async () => {
    const state = createMockApiState();
    const result = await handleMockApi('GET', '/api/pois/search?dataset_id=mock-demo&q=910002&type=restaurant', {}, state);
    expect((result?.body as any).features[0].properties.name).toBe('Clock Tower Cafe');
    expect((await handleMockApi('GET', '/api/pois/search?dataset_id=missing', {}, state))?.status).toBe(404);
    expect((await handleMockApi('GET', '/api/pois/search?dataset_id=mock-error', {}, state))?.status).toBe(503);
    expect((await handleMockApi('GET', '/api/pois/search?dataset_id=mock-demo&bbox=170,-10,-170,10', {}, state))?.status).toBe(400);
  });

  it('keeps numeric identifier search separate from the priority filter', async () => {
    const state = createMockApiState();
    const included = await handleMockApi('GET', '/api/pois/search?dataset_id=mock-demo&q=910002&min_priority=80', {}, state);
    const excluded = await handleMockApi('GET', '/api/pois/search?dataset_id=mock-demo&q=910002&min_priority=81', {}, state);

    expect((included?.body as any).features.map((item: any) => item.properties.name)).toEqual(['Clock Tower Cafe']);
    expect((excluded?.body as any).features).toEqual([]);
  });

  it('is opt-in and cannot activate for builds or preview', () => {
    expect(shouldEnableMockApi('serve', 'development', false, undefined)).toBe(false);
    expect(shouldEnableMockApi('serve', 'development', false, '1')).toBe(true);
    expect(shouldEnableMockApi('build', 'development', false, '1')).toBe(false);
    expect(shouldEnableMockApi('serve', 'production', false, '1')).toBe(false);
    expect(shouldEnableMockApi('serve', 'development', true, '1')).toBe(false);
  });
});
