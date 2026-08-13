import type { LngLat } from './types';

// Valhalla route shapes use precision 6. Returns [lon, lat] for GeoJSON/MapLibre.
export function decodePolyline6(encoded: string): LngLat[] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: LngLat[] = [];

  const readValue = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error('Invalid encoded polyline');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += readValue();
    lon += readValue();
    coordinates.push([lon / 1e6, lat / 1e6]);
  }

  return coordinates;
}
