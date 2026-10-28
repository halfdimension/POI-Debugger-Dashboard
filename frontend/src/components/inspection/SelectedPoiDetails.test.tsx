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

  it('combines an exact OSRM occurrence with its source POI details', () => {
    const feature: GeoJSON.Feature<GeoJSON.Point> = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [77.2, 28.6] },
      properties: { name: 'Union Bank of India', mappls_poi_id: 'bank-1', priority: 4 },
    };
    const step = {
      index: 37, legIndex: 0, stepIndex: 37, coordinate: [77.21, 28.61] as [number, number],
      step: { distance: 82.5, duration: 14, maneuver: { type: 'turn', modifier: 'right', instruction: 'Keep right after Union Bank of India' }, name: '' },
    };
    const markup = renderToStaticMarkup(<SelectedPoiDetails poi={feature} guidance={{
      kind: 'osrm-step', category: 'AFTER', selectedStep: step, relatedSteps: [step],
      evidence: { feature, coordinate: [77.2, 28.6], distanceM: 12, priority: 4, name: 'Union Bank of India', landmarkType: 'bank', poiId: 'bank-1', sourceNodeId: 'node-1', evidence: 'strong', matchedInstruction: 'Keep right after Union Bank of India' },
    }} />);

    expect(markup).toContain('Keep right after Union Bank of India');
    expect(markup).toContain('Step 38 · leg 1 · leg step 38');
    expect(markup).toContain('turn / right');
    expect(markup).toContain('82.5 m');
    expect(markup).toContain('14.0 s');
  });

  it('keeps pass-by event and physical POI locations distinct without a maneuver index', () => {
    const feature: GeoJSON.Feature<GeoJSON.Point> = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [77.2, 28.6] },
      properties: { name: 'College of Art', mappls_poi_id: 'college-1' },
    };
    const sourceEvidence = { feature, coordinate: [77.2, 28.6] as [number, number], distanceM: 18, priority: 2, name: 'College of Art', landmarkType: 'education', poiId: 'college-1', sourceNodeId: 'node-2', evidence: 'strong' as const, matchedInstruction: 'Pass College of Art on your left' };
    const markup = renderToStaticMarkup(<SelectedPoiDetails poi={feature} guidance={{
      kind: 'pass-by',
      landmark: {
        key: 'college-1', sourceEvidence, sourceMatch: 'poi-id',
        event: { key: 'pass-by:0:0', index: 0, legIndex: 0, eventIndex: 0, instruction: 'Pass College of Art on your left', name: 'College of Art', coordinate: [77.21, 28.61], legDistanceM: 50, routeDistanceM: 150, event: { side: 'left', poi_id: 'college-1' } },
      },
    }} />);

    expect(markup).toContain('PASS-BY');
    expect(markup).toContain('28.610000, 77.210000');
    expect(markup).toContain('28.600000, 77.200000');
    expect(markup).toContain('150.0 m');
    expect(markup).not.toContain('OSRM occurrence');
  });
});
