import { describe, expect, it } from 'vitest';
import type { Feature, Point } from 'geojson';
import {
  filterPoiFeatures,
  poiSearchText,
  poiVisible,
  rankPoiSearchResults,
} from './poi';

function poi(
  name: string,
  properties: Record<string, unknown> = {},
): Feature<Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [77.2, 28.6] },
    properties: { name, ...properties },
  };
}

const line: Feature = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [[77.2, 28.6], [77.3, 28.7]],
  },
  properties: { name: 'Not a POI' },
};

describe('POI filtering', () => {
  it('searches the existing name and identifier fields case-insensitively', () => {
    const properties = {
      name: 'Moti Mahal',
      mappls_poi_id: 'MM-42',
      new_node_id: 'node-7',
      osm_source_id: 'osm-9',
      landmark_type: 'Restaurant',
    };

    const text = poiSearchText(properties);
    expect(text).toContain('moti mahal');
    expect(text).toContain('mm-42');
    expect(text).toContain('node-7');
    expect(text).toContain('osm-9');
    expect(text).toContain('restaurant');
  });

  it.each(['no', 'false', '0', 'n', ' FALSE '])(
    'treats %j as invisible',
    (visible) => expect(poiVisible({ visible })).toBe(false),
  );

  it('keeps missing visibility visible, matching the existing default', () => {
    expect(poiVisible({})).toBe(true);
  });

  it('combines visibility, exact type, priority, and text filters', () => {
    const features: Feature[] = [
      poi('Moti Mahal', {
        landmark_type: 'Restaurant',
        priority: '8',
        visible: 'yes',
      }),
      poi('Moti Mahal Hidden', {
        landmark_type: 'Restaurant',
        priority: '9',
        visible: 'no',
      }),
      poi('Moti Mahal Low', {
        landmark_type: 'Restaurant',
        priority: '2',
        visible: 'yes',
      }),
      poi('Moti Mahal Hotel', {
        landmark_type: 'Hotel',
        priority: '10',
        visible: 'yes',
      }),
      line,
    ];

    const result = filterPoiFeatures(features, {
      search: 'MOTI',
      landmarkType: 'Restaurant',
      minimumPriority: 5,
      visibleOnly: true,
    });

    expect(result.map((feature) => feature.properties?.name)).toEqual([
      'Moti Mahal',
    ]);
  });

  it('ranks name-prefix matches first, then priority, and enforces the limit', () => {
    const ranked = rankPoiSearchResults([
      poi('Old Alpha', { priority: 100 }),
      poi('Alpha Low', { priority: 1 }),
      poi('Alpha High', { priority: 9 }),
    ], 'alpha', 2);

    expect(ranked.map((feature) => feature.properties?.name)).toEqual([
      'Alpha High',
      'Alpha Low',
    ]);
    expect(rankPoiSearchResults(ranked, '   ')).toEqual([]);
  });
});
