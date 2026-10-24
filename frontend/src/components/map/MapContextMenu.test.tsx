import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  applyContextMenuSelection,
  clampContextMenuPosition,
  MapContextMenu,
} from './MapContextMenu';

describe('MapContextMenu', () => {
  it('assigns the exact clicked coordinate to the selected route endpoint', () => {
    const setStart = vi.fn();
    const setEnd = vi.fn();
    const coordinate: [number, number] = [77.123456789, 28.987654321];

    applyContextMenuSelection('start', coordinate, { setStart, setEnd });
    expect(setStart).toHaveBeenCalledWith(coordinate);
    expect(setEnd).not.toHaveBeenCalled();

    applyContextMenuSelection('end', coordinate, { setStart, setEnd });
    expect(setEnd).toHaveBeenCalledWith(coordinate);
  });

  it('keeps the menu inside all map edges', () => {
    const boundary = { width: 500, height: 300 };
    const menu = { width: 180, height: 120 };

    expect(clampContextMenuPosition({ x: 490, y: 290 }, boundary, menu))
      .toEqual({ left: 312, top: 172 });
    expect(clampContextMenuPosition({ x: -20, y: -10 }, boundary, menu))
      .toEqual({ left: 8, top: 8 });
  });

  it('renders coordinates and accessible menu actions', () => {
    const markup = renderToStaticMarkup(
      <MapContextMenu
        coordinate={[77.1234567, 28.7654321]}
        x={100}
        y={80}
        onSetStart={vi.fn()}
        onSetEnd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('role="menu"');
    expect(markup.match(/role="menuitem"/g)).toHaveLength(2);
    expect(markup).toContain('Latitude <strong>28.765432</strong>');
    expect(markup).toContain('Longitude <strong>77.123457</strong>');
    expect(markup).toContain('Set as Start');
    expect(markup).toContain('Set as Destination');
  });
});
