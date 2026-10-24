import { useLayoutEffect, useRef, useState } from 'react';
import type { LngLat } from '../../types';

export type ContextMenuSelection = 'start' | 'end';

export interface MapContextMenuLocation {
  coordinate: LngLat;
  x: number;
  y: number;
}

interface ContextMenuActions {
  setStart: (coordinate: LngLat) => void;
  setEnd: (coordinate: LngLat) => void;
}

export interface MapContextMenuProps extends MapContextMenuLocation {
  onSetStart: (coordinate: LngLat) => void;
  onSetEnd: (coordinate: LngLat) => void;
  onClose: () => void;
}

const MENU_MARGIN = 8;

export function clampContextMenuPosition(
  requested: { x: number; y: number },
  boundary: { width: number; height: number },
  menu: { width: number; height: number },
  margin = MENU_MARGIN,
) {
  return {
    left: Math.max(margin, Math.min(requested.x, boundary.width - menu.width - margin)),
    top: Math.max(margin, Math.min(requested.y, boundary.height - menu.height - margin)),
  };
}

export function applyContextMenuSelection(
  selection: ContextMenuSelection,
  coordinate: LngLat,
  actions: ContextMenuActions,
) {
  if (selection === 'start') actions.setStart(coordinate);
  else actions.setEnd(coordinate);
}

export function MapContextMenu({
  coordinate,
  x,
  y,
  onSetStart,
  onSetEnd,
  onClose,
}: MapContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = menu?.parentElement;
    if (!menu || !boundary) return;

    const updatePosition = () => {
      setPosition(clampContextMenuPosition(
        { x, y },
        { width: boundary.clientWidth, height: boundary.clientHeight },
        { width: menu.offsetWidth, height: menu.offsetHeight },
      ));
    };

    updatePosition();
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updatePosition);
    observer?.observe(boundary);
    window.addEventListener('resize', updatePosition);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [x, y]);

  useLayoutEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const select = (selection: ContextMenuSelection) => {
    applyContextMenuSelection(selection, coordinate, {
      setStart: onSetStart,
      setEnd: onSetEnd,
    });
    onClose();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') items[0].focus();
    else if (event.key === 'End') items[items.length - 1].focus();
    else if (event.key === 'ArrowDown') items[(currentIndex + 1) % items.length].focus();
    else items[(currentIndex - 1 + items.length) % items.length].focus();
  };

  return (
    <div
      ref={menuRef}
      className="map-context-menu"
      role="menu"
      aria-label="Map location actions"
      style={{ left: position.left, top: position.top }}
      onKeyDown={handleMenuKeyDown}
    >
      <div className="map-context-menu__coordinates" aria-label="Selected coordinates">
        <span>Latitude <strong>{coordinate[1].toFixed(6)}</strong></span>
        <span>Longitude <strong>{coordinate[0].toFixed(6)}</strong></span>
      </div>
      <button type="button" role="menuitem" onClick={() => select('start')}>
        <i className="map-context-menu__marker map-context-menu__marker--start" aria-hidden="true" />
        Set as Start
      </button>
      <button type="button" role="menuitem" onClick={() => select('end')}>
        <i className="map-context-menu__marker map-context-menu__marker--end" aria-hidden="true" />
        Set as Destination
      </button>
    </div>
  );
}
