import type { Feature, FeatureCollection, Point } from 'geojson';
import type maplibregl from 'maplibre-gl';
import type { PoiBounds } from '../../poiSearchApi';

export const EXPLORER_POI_SOURCE_ID = 'pois';
export const POI_CLUSTER_LAYER_ID = 'poi-clusters';
export const POI_CLUSTER_COUNT_LAYER_ID = 'poi-cluster-count';
export const INDIVIDUAL_POI_LAYER_ID = 'pois';

export const POI_CLUSTER_RADIUS = 48;
export const POI_CLUSTER_MAX_ZOOM = 14;
export const VIEWPORT_MOVE_DEBOUNCE_MS = 180;

export function explorerPoiSource(
  data: FeatureCollection,
): maplibregl.GeoJSONSourceSpecification {
  return {
    type: 'geojson',
    data,
    cluster: true,
    clusterRadius: POI_CLUSTER_RADIUS,
    clusterMaxZoom: POI_CLUSTER_MAX_ZOOM,
  };
}

export function isPoiClusterFeature(feature: Feature): boolean {
  const clusterId = feature.properties?.cluster_id;
  return feature.geometry.type === 'Point' &&
    (feature.properties?.cluster === true ||
      ((typeof clusterId === 'number' || typeof clusterId === 'string') &&
        String(clusterId).length > 0 && Number.isFinite(Number(clusterId))));
}

export function isIndividualPoiFeature(feature: Feature): feature is Feature<Point> {
  return feature.geometry.type === 'Point' && !isPoiClusterFeature(feature);
}

type ClusterExpansionMap = Pick<maplibregl.Map, 'getSource' | 'getZoom' | 'easeTo'>;

export async function expandPoiCluster(
  map: ClusterExpansionMap,
  feature: Feature,
): Promise<boolean> {
  if (!isPoiClusterFeature(feature) || feature.geometry.type !== 'Point') return false;
  const clusterId = Number(feature.properties?.cluster_id);
  const source = map.getSource(EXPLORER_POI_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source?.getClusterExpansionZoom) return false;

  try {
    const expansionZoom = await source.getClusterExpansionZoom(clusterId);
    map.easeTo({
      center: feature.geometry.coordinates as [number, number],
      zoom: Math.max(map.getZoom(), Math.min(expansionZoom, map.getZoom() + 4)),
      duration: 350,
      essential: true,
    });
    return true;
  } catch {
    // A style/source replacement can invalidate a cluster between click and lookup.
    return false;
  }
}

export function viewportRequestKey(datasetId: string, bounds: PoiBounds): string {
  // Sub-metre map jitter should not issue another backend request.
  return `${datasetId}|${bounds.map((value) => value.toFixed(5)).join(',')}`;
}

export function viewportPoiLabel(count: number, incomplete: boolean): string {
  return incomplete ? `${count} loaded viewport POIs` : `${count} viewport POIs`;
}

export function incompleteViewportMessage(count: number, incomplete: boolean): string {
  return incomplete
    ? `Showing the first ${count} POIs in this area. Additional POIs are available. Zoom in to narrow the view.`
    : '';
}

export interface ViewportRequestTicket {
  key: string;
  sequence: number;
  controller: AbortController;
}

export class ViewportRequestCoordinator {
  private active: ViewportRequestTicket | null = null;
  private completedKey = '';
  private sequence = 0;

  begin(key: string): ViewportRequestTicket | null {
    if (key === this.active?.key || key === this.completedKey) return null;
    this.active?.controller.abort();
    const ticket = { key, sequence: ++this.sequence, controller: new AbortController() };
    this.active = ticket;
    return ticket;
  }

  accepts(ticket: ViewportRequestTicket): boolean {
    return this.active?.sequence === ticket.sequence && !ticket.controller.signal.aborted;
  }

  complete(ticket: ViewportRequestTicket): boolean {
    if (!this.accepts(ticket)) return false;
    this.completedKey = ticket.key;
    this.active = null;
    return true;
  }

  fail(ticket: ViewportRequestTicket): boolean {
    if (!this.accepts(ticket)) return false;
    this.active = null;
    return true;
  }

  invalidate(): void {
    this.cancel();
    this.completedKey = '';
  }

  cancel(): void {
    this.active?.controller.abort();
    this.active = null;
  }
}

interface ViewportEventMap {
  loaded(): boolean;
  on(type: 'moveend', listener: () => void): unknown;
  off(type: 'moveend' | 'load', listener: () => void): unknown;
  once(type: 'load', listener: () => void): unknown;
}

export function bindDebouncedViewportListener(
  map: ViewportEventMap,
  onSettled: () => void,
  delay = VIEWPORT_MOVE_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onSettled();
    }, delay);
  };

  map.on('moveend', settled);
  if (map.loaded()) settled();
  else map.once('load', settled);

  return () => {
    if (timer !== null) clearTimeout(timer);
    map.off('moveend', settled);
    map.off('load', settled);
  };
}
