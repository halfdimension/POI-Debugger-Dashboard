import { propText } from '../../poi';
import { PanelSection } from '../DashboardLayout';

export interface CompactPoiExplorerProps {
  filteredPoiFeatures: GeoJSON.Feature<GeoJSON.Point>[];
  searchResults: GeoJSON.Feature<GeoJSON.Point>[];
  availablePoiTypes: string[];
  poiSearch: string;
  poiType: string;
  minPriority: number;
  visibleOnly: boolean;
  showPois: boolean;
  searchLoading: boolean;
  searchLoadingMore: boolean;
  searchError: string;
  searchHasMore: boolean;
  onSearchChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onMinimumPriorityChange: (value: number) => void;
  onVisibleOnlyChange: (value: boolean) => void;
  onShowPoisChange: (value: boolean) => void;
  onResetFilters: () => void;
  onFocusPoi: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
  onLoadMore: () => void;
  onRetrySearch: () => void;
}

export function CompactPoiExplorer({
  filteredPoiFeatures, searchResults, availablePoiTypes,
  poiSearch, poiType, minPriority, visibleOnly, showPois,
  searchLoading, searchLoadingMore, searchError, searchHasMore,
  onSearchChange: setPoiSearch,
  onTypeChange: setPoiType,
  onMinimumPriorityChange: setMinPriority,
  onVisibleOnlyChange: setVisibleOnly,
  onShowPoisChange: setShowPois,
  onResetFilters: resetPoiFilters,
  onFocusPoi: focusPoiFeature,
  onLoadMore, onRetrySearch,
}: CompactPoiExplorerProps) {
  return (
    <PanelSection title="POI explorer" meta={`${filteredPoiFeatures.length} in view`}>
      <div className="poi-search-row">
        <input aria-label="Search POIs" value={poiSearch} placeholder="Name, POI ID, node ID or type" onChange={(event) => setPoiSearch(event.target.value)} />
        <button onClick={resetPoiFilters}>Reset</button>
      </div>
      <div className="poi-filter-grid">
        <label>Type<select value={poiType} onChange={(event) => setPoiType(event.target.value)}><option value="all">All types</option>{availablePoiTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label>Priority <strong>{minPriority}</strong><input className="priority-slider" type="range" min="0" max="100" step="5" value={minPriority} onChange={(event) => setMinPriority(Number(event.target.value))} /></label>
      </div>
      <div className="poi-checkboxes">
        <label><input type="checkbox" checked={visibleOnly} onChange={(event) => setVisibleOnly(event.target.checked)} /> Visible records only</label>
        <label><input type="checkbox" checked={showPois} onChange={(event) => setShowPois(event.target.checked)} /> Show on map</label>
      </div>
      {poiSearch.trim() && <div className="poi-search-results">
        {searchLoading && <div className="empty-state" role="status">Searching POIs…</div>}
        {searchError && <div className="dataset-warning" role="alert">{searchError} <button onClick={onRetrySearch}>Retry</button></div>}
        {!searchLoading && !searchError && searchResults.length === 0 ? <div className="empty-state">No matching POIs.</div> : searchResults.map((feature, index) => <button key={`${propText(feature.properties, 'mappls_poi_id', propText(feature.properties, 'new_node_id', ''))}-${index}`} className="poi-search-result" onClick={() => focusPoiFeature(feature)}><span><strong>{propText(feature.properties, 'name', 'Unnamed POI')}</strong><small>{propText(feature.properties, 'landmark_type', 'unknown')}</small></span><span className="poi-search-meta"><strong>{propText(feature.properties, 'priority', '—')}</strong><small>priority</small></span></button>)}
        {searchHasMore && <button onClick={onLoadMore} disabled={searchLoadingMore}>{searchLoadingMore ? 'Loading…' : 'Load more'}</button>}
        {!searchLoading && searchResults.length > 0 && <small>{searchResults.length}{searchHasMore ? '+' : ''} search results loaded</small>}
      </div>}
    </PanelSection>
  );
}
