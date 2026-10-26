import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PANEL_MIN_HEIGHT,
  MAP_WORKSPACE_MIN_HEIGHT,
  renderableVerticalPanelHeight,
  verticalPanelBounds,
} from './useVerticalPanelResize';

describe('analysis panel resize geometry', () => {
  it('keeps an in-range preferred height', () => {
    expect(renderableVerticalPanelHeight(320, 720)).toBe(320);
  });

  it('protects the usable map height', () => {
    expect(verticalPanelBounds(720).maximum).toBe(720 - MAP_WORKSPACE_MIN_HEIGHT);
    expect(renderableVerticalPanelHeight(900, 720)).toBe(540);
  });

  it('enforces the analysis minimum when room permits', () => {
    expect(renderableVerticalPanelHeight(40, 720)).toBe(ANALYSIS_PANEL_MIN_HEIGHT);
  });

  it('produces valid non-negative bounds in a tiny workspace', () => {
    expect(verticalPanelBounds(100)).toEqual({ minimum: 0, maximum: 0 });
    expect(renderableVerticalPanelHeight(320, 100)).toBe(0);
  });

  it('can shrink temporarily without changing the preferred value', () => {
    const preferred = 500;
    expect(renderableVerticalPanelHeight(preferred, 600)).toBe(420);
    expect(renderableVerticalPanelHeight(preferred, 900)).toBe(500);
  });
});
