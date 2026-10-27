import { useState } from 'react';
import { propText } from '../../poi';
import type { PoiConditionField, PoiConditionOperator, PoiSearchCondition, PoiVisualizationMode } from '../../poiSearchApi';
import type { PriorityPolicy } from '../../types';
import { PanelSection } from '../DashboardLayout';

const FIELD_OPTIONS: Array<[PoiConditionField, string]> = [
  ['name', 'Name'], ['priority', 'Priority'], ['landmark_type', 'Landmark type'],
  ['mappls_poi_id', 'Mappls POI ID'], ['new_node_id', 'Node ID'],
  ['osm_source_id', 'OSM source ID'], ['visible', 'Visibility'],
];
const OPERATORS: Record<PoiConditionField, Array<[PoiConditionOperator, string]>> = {
  name: [['contains', 'Contains'], ['eq', 'Equals']],
  priority: [['eq', 'Equals'], ['gt', 'Numerically greater than'], ['gte', 'Numerically greater than or equal'], ['lt', 'Numerically less than'], ['lte', 'Numerically less than or equal'], ['between', 'Numeric range']],
  landmark_type: [['eq', 'Equals']],
  mappls_poi_id: [['eq', 'Equals'], ['contains', 'Contains']],
  new_node_id: [['eq', 'Equals'], ['contains', 'Contains']],
  osm_source_id: [['eq', 'Equals'], ['contains', 'Contains']],
  visible: [['is_visible', 'Is visible'], ['is_hidden', 'Is hidden']],
};

export interface AdvancedPoiFiltersProps {
  conditions: PoiSearchCondition[];
  mode: 'and' | 'or';
  scope: 'dataset' | 'viewport';
  availablePoiTypes: string[];
  priorityPolicy: PriorityPolicy;
  onConditionsChange: (conditions: PoiSearchCondition[]) => void;
  onModeChange: (mode: 'and' | 'or') => void;
  onScopeChange: (scope: 'dataset' | 'viewport') => void;
  onApply: () => void;
  onClear: () => void;
}

export function poiConditionError(condition: PoiSearchCondition, policy: PriorityPolicy = { rank_order: 'descending', minimum: null, maximum: null }): string {
  if (condition.field === 'visible') return '';
  if (condition.field === 'priority') {
    const values = condition.operator === 'between' ? condition.value as [number, number] : [condition.value];
    if (!Array.isArray(values) || values.some((value) => value === '' || !Number.isFinite(Number(value)))) return 'Priority must be numeric.';
    if (policy.minimum !== null && values.some((value) => Number(value) < policy.minimum!)) return `Priority must be at least ${policy.minimum}.`;
    if (policy.maximum !== null && values.some((value) => Number(value) > policy.maximum!)) return `Priority must be at most ${policy.maximum}.`;
    if (condition.operator === 'between' && Number(values[0]) > Number(values[1])) return 'Lower priority must not exceed upper priority.';
    return '';
  }
  return typeof condition.value === 'string' && condition.value.trim() ? '' : 'Enter a value for every condition.';
}

export function createPoiCondition(id = `${Date.now()}-${Math.random()}`): PoiSearchCondition {
  return { id, field: 'name', operator: 'contains', value: '' };
}

export function updatePoiCondition(conditions: PoiSearchCondition[], index: number, next: PoiSearchCondition): PoiSearchCondition[] {
  return conditions.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function removePoiCondition(conditions: PoiSearchCondition[], index: number): PoiSearchCondition[] {
  return conditions.filter((_, itemIndex) => itemIndex !== index);
}

function defaultCondition(): PoiSearchCondition {
  return createPoiCondition();
}

export function AdvancedPoiFilters({ conditions, mode, scope, availablePoiTypes, priorityPolicy, onConditionsChange, onModeChange, onScopeChange, onApply, onClear }: AdvancedPoiFiltersProps) {
  const [attempted, setAttempted] = useState(false);
  const errors = conditions.map((condition) => poiConditionError(condition, priorityPolicy));
  const defaultPriority = priorityPolicy.minimum ?? 0;
  const defaultPriorityMaximum = priorityPolicy.maximum ?? defaultPriority;
  const update = (index: number, next: PoiSearchCondition) => onConditionsChange(updatePoiCondition(conditions, index, next));
  return (
    <details className="poi-advanced-filters">
      <summary>
        <span>Advanced search</span>
        <small>{conditions.length ? `${conditions.length} condition${conditions.length === 1 ? '' : 's'}` : 'No conditions'}</small>
      </summary>
      <div className="poi-advanced-filters__body">
        <div className="poi-advanced-toolbar">
          <fieldset><legend>Combine conditions</legend>
            <label><input type="radio" checked={mode === 'and'} onChange={() => onModeChange('and')} /> Match ALL (AND)</label>
            <label><input type="radio" checked={mode === 'or'} onChange={() => onModeChange('or')} /> Match ANY (OR)</label>
          </fieldset>
          <label>Search scope<select value={scope} onChange={(event) => onScopeChange(event.target.value as 'dataset' | 'viewport')}><option value="dataset">Entire selected dataset</option><option value="viewport">Current map viewport</option></select></label>
        </div>
        <small>Quick search is always combined as Quick Search AND ({mode === 'and' ? 'all' : 'any'} advanced conditions).</small>
        <small>Priority operators are numeric. Results rank {priorityPolicy.rank_order === 'ascending' ? 'smaller numbers first' : 'larger numbers first'}{priorityPolicy.minimum !== null || priorityPolicy.maximum !== null ? ` (configured range ${priorityPolicy.minimum ?? 'unbounded'}–${priorityPolicy.maximum ?? 'unbounded'})` : ''}.</small>
        <div className="poi-condition-list">
          {conditions.map((condition, index) => (
            <div className="poi-condition-row" key={condition.id}>
              <select aria-label={`Condition ${index + 1} field`} value={condition.field} onChange={(event) => {
                const field = event.target.value as PoiConditionField;
                const operator = OPERATORS[field][0][0];
                const value = field === 'visible' ? undefined : field === 'priority' ? (operator === 'between' ? [defaultPriority, defaultPriorityMaximum] as [number, number] : defaultPriority) : '';
                update(index, { ...condition, field, operator, value });
              }}>{FIELD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select aria-label={`Condition ${index + 1} operator`} value={condition.operator} onChange={(event) => {
                const operator = event.target.value as PoiConditionOperator;
                const value = condition.field === 'visible' ? undefined : operator === 'between' ? [defaultPriority, defaultPriorityMaximum] as [number, number] : condition.operator === 'between' ? defaultPriority : condition.value;
                update(index, { ...condition, operator, value });
              }}>{OPERATORS[condition.field].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              {condition.field === 'landmark_type' ? <select aria-label={`Condition ${index + 1} value`} value={String(condition.value ?? '')} onChange={(event) => update(index, { ...condition, value: event.target.value })}><option value="">Select type</option>{availablePoiTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
                : condition.field === 'priority' && condition.operator === 'between' ? <span className="poi-between-inputs"><input aria-label={`Condition ${index + 1} minimum`} type="number" min={priorityPolicy.minimum ?? undefined} max={priorityPolicy.maximum ?? undefined} value={(condition.value as [number, number])?.[0] ?? ''} onChange={(event) => update(index, { ...condition, value: [Number(event.target.value), Number((condition.value as [number, number])?.[1] ?? defaultPriorityMaximum)] })} /><span>to</span><input aria-label={`Condition ${index + 1} maximum`} type="number" min={priorityPolicy.minimum ?? undefined} max={priorityPolicy.maximum ?? undefined} value={(condition.value as [number, number])?.[1] ?? ''} onChange={(event) => update(index, { ...condition, value: [Number((condition.value as [number, number])?.[0] ?? defaultPriority), Number(event.target.value)] })} /></span>
                  : condition.field === 'priority' ? <input aria-label={`Condition ${index + 1} value`} type="number" min={priorityPolicy.minimum ?? undefined} max={priorityPolicy.maximum ?? undefined} value={String(condition.value ?? '')} onChange={(event) => update(index, { ...condition, value: event.target.value })} />
                    : condition.field !== 'visible' ? <input aria-label={`Condition ${index + 1} value`} type="text" maxLength={200} value={String(condition.value ?? '')} onChange={(event) => update(index, { ...condition, value: event.target.value })} /> : <span className="poi-condition-no-value">No value needed</span>}
              <button type="button" aria-label={`Remove condition ${index + 1}`} onClick={() => onConditionsChange(removePoiCondition(conditions, index))}>Remove</button>
              {attempted && errors[index] && <small className="poi-condition-error" role="alert">{errors[index]}</small>}
            </div>
          ))}
        </div>
        <div className="poi-advanced-actions">
          <button type="button" disabled={conditions.length >= 10} onClick={() => onConditionsChange([...conditions, defaultCondition()])}>Add condition</button>
          <button type="button" onClick={onClear}>Clear all</button>
          <button type="button" className="primary" onClick={() => { setAttempted(true); if (errors.every((error) => !error)) onApply(); }}>Apply filters</button>
        </div>
      </div>
    </details>
  );
}

export interface CompactPoiExplorerProps {
  viewportSummary: string;
  searchResults: GeoJSON.Feature<GeoJSON.Point>[];
  availablePoiTypes: string[];
  poiSearch: string;
  advancedFilters: AdvancedPoiFiltersProps;
  showPois: boolean;
  hasRoute: boolean;
  showGuidancePois: boolean;
  showNearbyDiagnosticPois: boolean;
  highlightSelectedManeuver: boolean;
  visualizationMode: PoiVisualizationMode;
  visualizationStatus: string;
  densityLegend: boolean;
  searchLoading: boolean;
  searchLoadingMore: boolean;
  searchError: string;
  searchHasMore: boolean;
  onSearchChange: (value: string) => void;
  onShowPoisChange: (value: boolean) => void;
  onShowGuidancePoisChange: (value: boolean) => void;
  onShowNearbyDiagnosticPoisChange: (value: boolean) => void;
  onHighlightSelectedManeuverChange: (value: boolean) => void;
  onVisualizationModeChange: (value: PoiVisualizationMode) => void;
  onResetFilters: () => void;
  onFocusPoi: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
  onLoadMore: () => void;
  onRetrySearch: () => void;
}

export function CompactPoiExplorer({
  viewportSummary, searchResults, availablePoiTypes,
  poiSearch, advancedFilters, showPois, hasRoute,
  showGuidancePois, showNearbyDiagnosticPois, highlightSelectedManeuver,
  visualizationMode, visualizationStatus, densityLegend,
  searchLoading, searchLoadingMore, searchError, searchHasMore,
  onSearchChange: setPoiSearch,
  onShowPoisChange: setShowPois,
  onShowGuidancePoisChange: setShowGuidancePois,
  onShowNearbyDiagnosticPoisChange: setShowNearbyDiagnosticPois,
  onHighlightSelectedManeuverChange: setHighlightSelectedManeuver,
  onVisualizationModeChange: setVisualizationMode,
  onResetFilters: resetPoiFilters,
  onFocusPoi: focusPoiFeature,
  onLoadMore, onRetrySearch,
}: CompactPoiExplorerProps) {
  return (
    <PanelSection title="POI explorer" meta={viewportSummary}>
      <label className="poi-search-label" htmlFor="compact-poi-search">Search by name or identifier</label>
      <div className="poi-search-row">
        <input id="compact-poi-search" value={poiSearch} placeholder="Name, Mappls ID, node ID, OSM ID or type" onChange={(event) => setPoiSearch(event.target.value)} />
        <button type="button" onClick={resetPoiFilters}>Reset filters</button>
      </div>
      <AdvancedPoiFilters {...advancedFilters} availablePoiTypes={availablePoiTypes} />
      <div className="poi-visualization-controls">
        <button
          type="button"
          className={`poi-master-toggle ${showPois ? 'is-on' : 'is-off'}`}
          aria-pressed={showPois}
          onClick={() => setShowPois(!showPois)}
        >
          <span>POIs on map</span><strong>{showPois ? 'ON' : 'OFF'}</strong>
        </button>
        {showPois && <>
          <div className="poi-visualization-label">Visualization</div>
          <div className="poi-mode-selector" role="group" aria-label="POI visualization mode">
            {(['auto', 'density', 'clusters', 'points'] as PoiVisualizationMode[]).map((mode) => (
              <button
                type="button"
                key={mode}
                className={visualizationMode === mode ? 'is-active' : ''}
                aria-pressed={visualizationMode === mode}
                title={mode === 'auto' ? 'Adapt to zoom and viewport POI density' : mode === 'density' ? 'Show relative geographical concentration' : mode === 'clusters' ? 'Show exact server-generated aggregate counts' : 'Show complete individual source records when feasible'}
                onClick={() => setVisualizationMode(mode)}
              >{mode[0].toUpperCase() + mode.slice(1)}</button>
            ))}
          </div>
        </>}
        <div className="poi-visualization-status" role="status">{visualizationStatus}</div>
        {showPois && densityLegend && <div className="poi-density-legend" aria-label="Relative POI density from low to high">
          <span>Low</span><i /><span>High</span>
          <small>Relative concentration</small>
        </div>}
      </div>
      {hasRoute && <fieldset className="route-poi-layer-controls" disabled={!showPois}>
        <legend>Route POI layers</legend>
        <label><input type="checkbox" checked={showGuidancePois} onChange={(event) => setShowGuidancePois(event.target.checked)} /><span>Guidance-related POIs</span></label>
        <label><input type="checkbox" checked={showNearbyDiagnosticPois} onChange={(event) => setShowNearbyDiagnosticPois(event.target.checked)} /><span>Nearby diagnostic POIs</span></label>
        <label><input type="checkbox" checked={highlightSelectedManeuver} onChange={(event) => setHighlightSelectedManeuver(event.target.checked)} /><span>Highlight selected maneuver</span></label>
        {!showPois && <small>Enable POIs on map to display route POI layers.</small>}
      </fieldset>}
      {(poiSearch.trim() || advancedFilters.conditions.length > 0) && <div className="poi-search-results">
        {searchLoading && <div className="empty-state" role="status">Searching POIs…</div>}
        {searchError && <div className="dataset-warning" role="alert">{searchError} <button onClick={onRetrySearch}>Retry</button></div>}
        {!searchLoading && !searchError && searchResults.length === 0 ? <div className="empty-state">No matching POIs.</div> : searchResults.map((feature, index) => <button key={`${propText(feature.properties, 'mappls_poi_id', propText(feature.properties, 'new_node_id', ''))}-${index}`} className="poi-search-result" onClick={() => focusPoiFeature(feature)}><span><strong>{propText(feature.properties, 'name', 'Unnamed POI')}</strong><small>{propText(feature.properties, 'landmark_type', 'unknown')}</small></span><span className="poi-search-meta"><strong>{propText(feature.properties, 'priority', '—')}</strong><small>priority</small></span></button>)}
        {searchHasMore && <button onClick={onLoadMore} disabled={searchLoadingMore}>{searchLoadingMore ? 'Loading…' : 'Load more'}</button>}
        {!searchLoading && searchResults.length > 0 && <small>{searchResults.length}{searchHasMore ? '+' : ''} search results loaded</small>}
      </div>}
    </PanelSection>
  );
}
