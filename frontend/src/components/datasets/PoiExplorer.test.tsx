import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PoiSearchCondition } from '../../poiSearchApi';
import { AdvancedPoiFilters, createPoiCondition, poiConditionError, removePoiCondition, updatePoiCondition } from './PoiExplorer';

describe('AdvancedPoiFilters', () => {
  it('adds, edits and removes condition models without mutating prior state', () => {
    const first = createPoiCondition('one');
    const conditions = [first, createPoiCondition('two')];
    const edited: PoiSearchCondition = { ...first, field: 'priority', operator: 'gte', value: 70 };
    const updated = updatePoiCondition(conditions, 0, edited);
    expect(updated).toEqual([edited, conditions[1]]);
    expect(conditions[0]).toBe(first);
    expect(removePoiCondition(updated, 1)).toEqual([edited]);
  });

  it('validates numeric ranges and text values', () => {
    expect(poiConditionError({ id: '1', field: 'priority', operator: 'between', value: [90, 60] })).toMatch(/Lower/);
    expect(poiConditionError(
      { id: '2', field: 'priority', operator: 'gte', value: 25 },
      { rank_order: 'ascending', minimum: 1, maximum: 24 },
    )).toMatch(/at most 24/);
    expect(poiConditionError(
      { id: '2b', field: 'priority', operator: 'gte', value: 1000 },
      { rank_order: 'descending', minimum: null, maximum: null },
    )).toBe('');
    expect(poiConditionError({ id: '3', field: 'name', operator: 'contains', value: '' })).toMatch(/Enter/);
    expect(poiConditionError({ id: '4', field: 'visible', operator: 'is_hidden' })).toBe('');
  });

  it('is collapsed by default and renders mode, scope and type controls', () => {
    const markup = renderToStaticMarkup(<AdvancedPoiFilters
      conditions={[
        { id: '1', field: 'landmark_type', operator: 'eq', value: 'fuel' },
        { id: '2', field: 'priority', operator: 'gte', value: 12 },
      ]}
      mode="or"
      scope="viewport"
      availablePoiTypes={['fuel', 'school']}
      priorityPolicy={{ rank_order: 'ascending', minimum: 1, maximum: 24 }}
      onConditionsChange={vi.fn()}
      onModeChange={vi.fn()}
      onScopeChange={vi.fn()}
      onApply={vi.fn()}
      onClear={vi.fn()}
    />);
    expect(markup).toContain('<details class="poi-advanced-filters">');
    expect(markup).not.toContain('<details class="poi-advanced-filters" open="">');
    expect(markup).toContain('Match ANY (OR)');
    expect(markup).toContain('Current map viewport');
    expect(markup).toContain('fuel');
    expect(markup).toContain('smaller numbers first');
    expect(markup).toContain('Numerically greater than');
  });
});
