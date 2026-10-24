import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RouteSetupControls } from './RouteSetupControls';

describe('RouteSetupControls', () => {
  it('preserves coordinate formatting and disables routing without both points', () => {
    const markup = renderToStaticMarkup(
      <RouteSetupControls
        pickMode="start"
        start={[77.1234567, 28.7654321]}
        end={null}
        busy={false}
        error=""
        onPickModeChange={vi.fn()}
        onCoordinateChange={vi.fn()}
        onRunRoute={vi.fn()}
      />,
    );

    expect(markup).toContain('value="77.123457"');
    expect(markup).toContain('value="28.765432"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Run route comparison<\/button>/);
  });

  it('shows the existing busy and error states', () => {
    const markup = renderToStaticMarkup(
      <RouteSetupControls
        pickMode="end"
        start={[77, 28]}
        end={[78, 29]}
        busy
        error="Route failed"
        onPickModeChange={vi.fn()}
        onCoordinateChange={vi.fn()}
        onRunRoute={vi.fn()}
      />,
    );

    expect(markup).toContain('Routing both engines…');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Route failed');
  });
});
