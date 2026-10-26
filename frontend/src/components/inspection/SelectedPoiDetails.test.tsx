import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SelectedPoiDetails } from './SelectedPoiDetails';

describe('SelectedPoiDetails', () => {
  it('preserves and exposes source metadata from a selected individual POI snapshot', () => {
    const markup = renderToStaticMarkup(<SelectedPoiDetails poi={{
      type: 'Feature',
      id: 'dataset-row-17',
      geometry: { type: 'Point', coordinates: [77.2, 28.6] },
      properties: {
        name: 'Debug landmark',
        mappls_poi_id: 'shared-external-id',
        new_node_id: 'node-17',
        landmark_type: 'dynamic-category',
        priority: 1,
        source_marker: 'unchanged',
      },
    }} />);

    expect(markup).toContain('Debug landmark');
    expect(markup).toContain('shared-external-id');
    expect(markup).toContain('node-17');
    expect(markup).toContain('dynamic-category');
    expect(markup).toContain('source_marker');
    expect(markup).toContain('unchanged');
  });
});
