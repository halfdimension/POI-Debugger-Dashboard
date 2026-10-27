import maplibregl from 'maplibre-gl';
import { propText } from '../../poi';
import type { LngLat } from '../../types';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function poiPopupHtml(properties: GeoJSON.GeoJsonProperties): string {
  const preferred = [
    'name', 'mappls_poi_id', 'new_node_id', 'landmark_type', 'priority', 'visible',
    '_association_label', '_associated_engines', '_association_details',
    '_related_route_position', '_instruction_text', '_candidate_status', '_candidate_reason',
    'osm_source_type', 'osm_source_id', 'osm_amenity', 'osm_tourism', 'osm_shop',
    'osm_historic', 'osm_leisure', 'osm_railway', 'lat', 'lon', '_debug_distance_m',
  ];
  const keys = [
    ...preferred.filter((key) => properties?.[key] !== undefined && properties?.[key] !== ''),
    ...Object.keys(properties ?? {}).filter((key) => !key.startsWith('_') && !preferred.includes(key) && properties?.[key] !== ''),
  ];
  const labels: Record<string, string> = {
    mappls_poi_id: 'Source POI ID',
    new_node_id: 'Source node ID',
    _association_label: 'Classification',
    _associated_engines: 'Routing engine',
    _association_details: 'Engine evidence',
    _related_route_position: 'Related guidance',
    _instruction_text: 'Instruction',
    _candidate_status: 'Candidate status',
    _candidate_reason: 'Candidate evidence',
    _debug_distance_m: 'Distance (m)',
  };
  const title = propText(properties, 'name', 'POI');
  const rows = keys
    .map((key) => `<div class="poi-popup-row"><strong>${escapeHtml(labels[key] ?? key)}</strong><span>${escapeHtml(properties?.[key])}</span></div>`)
    .join('');
  return `<div class="poi-popup"><div class="poi-popup-title">${escapeHtml(title)}</div>${rows}</div>`;
}

export function makePoiPopupDraggable(
  popup: maplibregl.Popup,
  map: maplibregl.Map,
): () => void {
  const popupElement = popup.getElement();
  const title = popupElement.querySelector<HTMLElement>('.poi-popup-title');
  if (!title) return () => {};

  let dragging = false;
  let pointerId: number | null = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let offsetStartX = 0;
  let offsetStartY = 0;
  let offsetX = 0;
  let offsetY = 0;

  popupElement.classList.add('draggable-poi-popup');

  const setClampedOffset = (nextX: number, nextY: number) => {
    popupElement.style.translate = `${nextX}px ${nextY}px`;

    const mapRect = map.getContainer().getBoundingClientRect();
    const popupRect = popupElement.getBoundingClientRect();
    const padding = 4;

    if (popupRect.width <= mapRect.width - padding * 2) {
      if (popupRect.left < mapRect.left + padding) {
        nextX += mapRect.left + padding - popupRect.left;
      } else if (popupRect.right > mapRect.right - padding) {
        nextX -= popupRect.right - (mapRect.right - padding);
      }
    }

    if (popupRect.height <= mapRect.height - padding * 2) {
      if (popupRect.top < mapRect.top + padding) {
        nextY += mapRect.top + padding - popupRect.top;
      } else if (popupRect.bottom > mapRect.bottom - padding) {
        nextY -= popupRect.bottom - (mapRect.bottom - padding);
      }
    }

    popupElement.style.translate = `${nextX}px ${nextY}px`;
    offsetX = nextX;
    offsetY = nextY;
  };

  const stopDragging = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
    popupElement.classList.remove('is-dragging');
    if (title.hasPointerCapture(event.pointerId)) {
      title.releasePointerCapture(event.pointerId);
    }
    pointerId = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    offsetStartX = offsetX;
    offsetStartY = offsetY;
    popupElement.classList.add('is-dragging');
    title.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setClampedOffset(
      offsetStartX + event.clientX - pointerStartX,
      offsetStartY + event.clientY - pointerStartY,
    );
  };

  const stopClickPropagation = (event: MouseEvent) => event.stopPropagation();

  title.addEventListener('pointerdown', onPointerDown);
  title.addEventListener('pointermove', onPointerMove);
  title.addEventListener('pointerup', stopDragging);
  title.addEventListener('pointercancel', stopDragging);
  title.addEventListener('lostpointercapture', stopDragging);
  title.addEventListener('click', stopClickPropagation);

  return () => {
    title.removeEventListener('pointerdown', onPointerDown);
    title.removeEventListener('pointermove', onPointerMove);
    title.removeEventListener('pointerup', stopDragging);
    title.removeEventListener('pointercancel', stopDragging);
    title.removeEventListener('lostpointercapture', stopDragging);
    title.removeEventListener('click', stopClickPropagation);
  };
}

export class PoiPopupController {
  private activePopup: maplibregl.Popup | null = null;

  close(): void {
    this.activePopup?.remove();
    this.activePopup = null;
  }

  open(
    map: maplibregl.Map,
    coordinate: LngLat,
    properties: GeoJSON.GeoJsonProperties,
  ): void {
    this.close();

    const popup = new maplibregl.Popup({ maxWidth: '420px' })
      .setLngLat(coordinate)
      .setHTML(poiPopupHtml(properties ?? {}))
      .addTo(map);
    const removeDragHandlers = makePoiPopupDraggable(popup, map);

    popup.on('close', () => {
      removeDragHandlers();
      if (this.activePopup === popup) this.activePopup = null;
    });

    this.activePopup = popup;
  }
}
