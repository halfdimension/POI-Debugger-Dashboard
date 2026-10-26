import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './DashboardLayout';

function renderSidebars(leftCollapsed: boolean, rightCollapsed: boolean) {
  return renderToStaticMarkup(
    <main className={`workspace${leftCollapsed ? ' left-collapsed' : ''}${rightCollapsed ? ' right-collapsed' : ''}`}>
      <Sidebar side="left" label="Route controls" collapsed={leftCollapsed} onToggle={vi.fn()}>
        <span>Left contents</span>
      </Sidebar>
      <Sidebar side="right" label="Context inspector" collapsed={rightCollapsed} onToggle={vi.fn()}>
        <span>Right contents</span>
      </Sidebar>
    </main>,
  );
}

describe('Sidebar', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('keeps independent controls for left=%s and right=%s collapse state', (leftCollapsed, rightCollapsed) => {
    const markup = renderSidebars(leftCollapsed, rightCollapsed);

    expect(markup).toContain(`aria-label="${leftCollapsed ? 'Expand' : 'Collapse'} Route controls"`);
    expect(markup).toContain(`aria-label="${rightCollapsed ? 'Expand' : 'Collapse'} Context inspector"`);
    expect(markup.includes('Left contents')).toBe(!leftCollapsed);
    expect(markup.includes('Right contents')).toBe(!rightCollapsed);
  });
});
