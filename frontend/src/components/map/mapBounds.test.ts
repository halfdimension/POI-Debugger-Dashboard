import { describe, expect, it } from 'vitest';
import { visibleMapBounds } from './mapBounds';

function mapBounds(west: number, south: number, east: number, north: number) {
  return {
    getBounds: () => ({
      getWest: () => west,
      getSouth: () => south,
      getEast: () => east,
      getNorth: () => north,
    }),
  };
}

describe('visibleMapBounds', () => {
  it('returns ordinary bounds and clamps latitude to the valid range', () => {
    expect(visibleMapBounds(mapBounds(77, -95, 78, 94)))
      .toEqual([77, -90, 78, 90]);
  });

  it('normalizes viewports wholly outside the standard longitude range', () => {
    expect(visibleMapBounds(mapBounds(190, 20, 200, 30)))
      .toEqual([-170, 20, -160, 30]);
    expect(visibleMapBounds(mapBounds(-540, 20, -500, 30)))
      .toEqual([-180, 20, -140, 30]);
  });

  it('uses the established full-world result for widths of at least 360 degrees', () => {
    expect(visibleMapBounds(mapBounds(-200, -92, 200, 93)))
      .toEqual([-180, -92, 180, 93]);
  });

  it('rejects antimeridian crossings and reversed bounds', () => {
    expect(visibleMapBounds(mapBounds(170, -20, 190, 20))).toBeNull();
    expect(visibleMapBounds(mapBounds(20, -20, 10, 20))).toBeNull();
  });
});
