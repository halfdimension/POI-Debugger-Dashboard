import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ManeuverInspection } from './ManeuverInspection';

const maneuver = {
  index: 0,
  legIndex: 0,
  maneuverIndex: 0,
  maneuver: { instruction: 'Turn left' },
  coordinate: [77, 28] as [number, number],
};

function renderDiagnostic(status: 'complete' | 'incomplete' | 'unavailable') {
  return renderToStaticMarkup(<ManeuverInspection
    route={null}
    osrmRoute={null}
    maneuverViews={[maneuver]}
    osrmStepViews={[]}
    selectedManeuverIndex={0}
    selectedOsrmStepIndex={null}
    selectedManeuver={maneuver}
    narrationEvidenceByManeuver={new Map()}
    osrmPoiNamesByStep={new Map()}
    primaryNarrationEvidence={null}
    selectedNarrationEvidence={[]}
    nearbyPois={[]}
    diagnosticStatus={status}
    diagnosticMessage={status === 'incomplete' ? 'Configured diagnostic limit reached.' : ''}
    getOsrmInstruction={() => ''}
    onFocusManeuver={vi.fn()}
    onFocusOsrmStep={vi.fn()}
    onFocusNarrationEvidence={vi.fn()}
    onFocusPoi={vi.fn()}
  />);
}

describe('ManeuverInspection diagnostic completeness', () => {
  it('reports absence only for complete source-POI retrieval', () => {
    const markup = renderDiagnostic('complete');
    expect(markup).toContain('NO SOURCE MATCH');
    expect(markup).toContain('No source POIs within 100 m.');
  });

  it('does not interpret incomplete retrieval as evidence of absence', () => {
    const markup = renderDiagnostic('incomplete');
    expect(markup).toContain('SOURCE DATA INCOMPLETE');
    expect(markup).toContain('Configured diagnostic limit reached.');
    expect(markup).toContain('cannot be ruled out');
    expect(markup).not.toContain('No source POIs within 100 m.');
  });

  it('shows a BEFORE relation even when no source POI is resolved', () => {
    const osrmStep = {
      index: 0, legIndex: 0, stepIndex: 0, coordinate: [77, 28] as [number, number],
      step: { maneuver: { instruction: 'Before RBL Bank: Enter the roundabout and take the 1st exit' } },
    };
    const markup = renderToStaticMarkup(<ManeuverInspection
      route={null}
      osrmRoute={{ routes: [{ legs: [{ steps: [osrmStep.step] }] }] }}
      maneuverViews={[]}
      osrmStepViews={[osrmStep]}
      selectedManeuverIndex={null}
      selectedOsrmStepIndex={0}
      selectedManeuver={null}
      selectedOsrmStep={osrmStep}
      narrationEvidenceByManeuver={new Map()}
      osrmPoiNamesByStep={new Map()}
      primaryNarrationEvidence={null}
      selectedNarrationEvidence={[]}
      nearbyPois={[]}
      diagnosticStatus="complete"
      diagnosticMessage=""
      getOsrmInstruction={(step) => step.maneuver?.instruction ?? ''}
      onFocusManeuver={vi.fn()}
      onFocusOsrmStep={vi.fn()}
      onFocusNarrationEvidence={vi.fn()}
      onFocusPoi={vi.fn()}
    />);
    expect(markup).toContain('BEFORE · PREFIX');
    expect(markup).toContain('Before RBL Bank: Enter the roundabout and take the 1st exit');
    expect(markup).not.toContain('POI in instruction:');
  });
});
