import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MapPerspectiveMenu, type MapPerspectivePreferences } from './MapPerspectiveMenu';

const defaults: MapPerspectivePreferences = {
  show_3d_buildings: false,
  imagery_mode: 'standard',
  street_imagery_enabled: false,
  street_coverage_enabled: false,
  driver_perspective_sync_enabled: false,
};

describe('MapPerspectiveMenu', () => {
  it('is closed by default with Standard as the only effective imagery mode', () => {
    const markup = renderToStaticMarkup(<MapPerspectiveMenu preferences={defaults} />);

    expect(markup).toContain('<details class="map-perspective-menu">');
    expect(markup).not.toContain('<details class="map-perspective-menu" open=""');
    expect(markup).toMatch(/type="radio"[^>]*checked=""/);
    expect(markup.match(/disabled=""/g)).toHaveLength(6);
  });

  it('reports saved future preferences without activating unavailable controls', () => {
    const markup = renderToStaticMarkup(<MapPerspectiveMenu preferences={{
      show_3d_buildings: true,
      imagery_mode: 'hybrid',
      street_imagery_enabled: true,
      street_coverage_enabled: true,
      driver_perspective_sync_enabled: true,
    }} />);

    expect(markup).toContain('Saved for future availability: 3D Buildings, Hybrid imagery, Street Imagery, Street Imagery Coverage, Driver Perspective Sync. Standard imagery remains active.');
    expect(markup.match(/type="checkbox"[^>]*checked=""/g)).toBeNull();
    expect(markup.match(/type="radio"[^>]*checked=""/g)).toHaveLength(1);
  });
});
