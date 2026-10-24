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

  it('is opt-in and cannot activate for builds or preview', () => {
    expect(shouldEnableMockApi('serve', 'development', false, undefined)).toBe(false);
    expect(shouldEnableMockApi('serve', 'development', false, '1')).toBe(true);
    expect(shouldEnableMockApi('build', 'development', false, '1')).toBe(false);
    expect(shouldEnableMockApi('serve', 'production', false, '1')).toBe(false);
    expect(shouldEnableMockApi('serve', 'development', true, '1')).toBe(false);
  });
});
