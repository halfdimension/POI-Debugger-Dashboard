import type { PoiBounds } from '../../poiSearchApi';

interface MapBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

interface MapWithBounds {
  getBounds(): MapBoundsLike;
}

export function visibleMapBounds(map: MapWithBounds): PoiBounds | null {
  const bounds = map.getBounds();
  let west = bounds.getWest();
  let east = bounds.getEast();
  const width = east - west;

  if (width >= 360) {
    return [-180, bounds.getSouth(), 180, bounds.getNorth()];
  }

  while (west < -180 && east <= -180) {
    west += 360;
    east += 360;
  }
  while (east > 180 && west >= 180) {
    west -= 360;
    east -= 360;
  }

  if (west < -180 || east > 180 || west > east) return null;

  return [
    west,
    Math.max(-90, bounds.getSouth()),
    east,
    Math.min(90, bounds.getNorth()),
  ];
}
