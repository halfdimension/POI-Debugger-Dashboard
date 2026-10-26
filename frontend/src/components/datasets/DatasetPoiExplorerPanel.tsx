import { propText } from '../../poi';
import type { DatasetRegistryResponse, DatasetSummary, DebuggerConfig } from '../../types';
import { AdvancedPoiFilters, type AdvancedPoiFiltersProps } from './PoiExplorer';

export interface DatasetPoiExplorerPanelProps {
  activeDataset: DatasetSummary | null;
  datasetRegistry: DatasetRegistryResponse | null;
  datasetBusy: boolean;
  datasetMessage: string;
  config: DebuggerConfig;
  filteredPoiFeatures: GeoJSON.Feature<GeoJSON.Point>[];
  searchResults: GeoJSON.Feature<GeoJSON.Point>[];
  availablePoiTypes: string[];
  fullTypeStats: [string, number][];
  poiSearch: string;
  advancedFilters: AdvancedPoiFiltersProps;
  showPois: boolean;
  searchLoading: boolean;
  searchLoadingMore: boolean;
  searchError: string;
  searchHasMore: boolean;
  onChangeDataset: (datasetId: string) => void;
  onReloadDataset: () => void;
  onSearchChange: (value: string) => void;
  onShowPoisChange: (value: boolean) => void;
  onResetFilters: () => void;
  onFocusPoi: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
  onLoadMore: () => void;
  onRetrySearch: () => void;
}

function basename(path?: string): string {
  if (!path) return 'not configured';
  const pieces = path.split('/');
  return pieces[pieces.length - 1] || path;
}

export function DatasetPoiExplorerPanel({
  activeDataset, datasetRegistry, datasetBusy, datasetMessage, config,
  filteredPoiFeatures, searchResults, availablePoiTypes, fullTypeStats,
  poiSearch, advancedFilters, showPois,
  searchLoading, searchLoadingMore, searchError, searchHasMore,
  onChangeDataset: changeDataset, onReloadDataset: reloadActiveDataset,
  onSearchChange: setPoiSearch,
  onShowPoisChange: setShowPois, onResetFilters: resetPoiFilters,
  onFocusPoi: focusPoiFeature,
  onLoadMore, onRetrySearch,
}: DatasetPoiExplorerPanelProps) {
  return (
    <>
      <section className="card dataset-card">
        <div className="maneuver-heading">
          <h2>Dataset Pipeline</h2>
          <span>POI data</span>
        </div>
        <label>Active POI dataset</label>
        <div className="dataset-actions">
          <select
            value={datasetRegistry?.active_dataset ?? ''}
            disabled={datasetBusy || !datasetRegistry}
            onChange={(event) => changeDataset(event.target.value)}
          >
            {(datasetRegistry?.datasets ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
            ))}
          </select>
          <button onClick={reloadActiveDataset} disabled={datasetBusy || !activeDataset}>
            {datasetBusy ? 'Working…' : 'Reload POIs'}
          </button>
        </div>
        {datasetMessage && <div className="dataset-message">{datasetMessage}</div>}
        {activeDataset?.error && <div className="dataset-warning">{activeDataset.error}</div>}
        {activeDataset?.preparation_state === 'pending' && <div className="dataset-message" role="status">Statistics are pending. Reload POIs to prepare them.</div>}
        {activeDataset?.preparation_state === 'preparing' && <div className="dataset-message" role="status">Statistics are being prepared.</div>}
        <div className="kv"><span>Source</span><code title={activeDataset?.source_path ?? ''}>{activeDataset?.source_kind ?? '—'} · {basename(activeDataset?.source_path ?? undefined)}</code></div>
        <div className="kv"><span>PBF</span><code title={activeDataset?.pbf_path ?? config.data.pbf_path}>{basename(activeDataset?.pbf_path ?? config.data.pbf_path)}</code></div>
        <div className="dataset-stats">
          <div><strong>{activeDataset?.stats?.total_rows ?? '—'}</strong><span>rows</span></div>
          <div><strong>{activeDataset?.stats?.valid_pois ?? '—'}</strong><span>valid POIs</span></div>
          <div><strong>{activeDataset?.stats?.invalid_coordinates ?? '—'}</strong><span>bad coords</span></div>
          <div><strong>{activeDataset?.stats?.duplicate_poi_ids ?? '—'}</strong><span>duplicate POI IDs</span></div>
          <div><strong>{activeDataset?.stats?.duplicate_node_ids ?? '—'}</strong><span>duplicate node IDs</span></div>
        </div>
        <div className="dataset-note">Dataset switching changes the debugger POI layer only. It does not restart Valhalla or swap the tile set used by the running Valhalla service.</div>
      </section>
  
      <section className="card poi-explorer-card">
        <div className="maneuver-heading">
          <h2>POI Explorer</h2>
          <span>{filteredPoiFeatures.length} in view</span>
        </div>
  
        <label className="poi-search-label" htmlFor="dataset-poi-search">Search by name or identifier</label>
        <div className="poi-search-row">
          <input
            id="dataset-poi-search"
            value={poiSearch}
            placeholder="Name, Mappls ID, node ID, OSM ID or type"
            onChange={(event) => setPoiSearch(event.target.value)}
          />
          <button type="button" onClick={resetPoiFilters}>Reset filters</button>
        </div>
  
        <AdvancedPoiFilters {...advancedFilters} availablePoiTypes={availablePoiTypes} />
  
        <div className="poi-checkboxes">
          <label><input type="checkbox" checked={showPois} onChange={(event) => setShowPois(event.target.checked)} /> Show POIs on map</label>
        </div>
  
        <div className="poi-filter-summary">
          <strong>{filteredPoiFeatures.length}</strong> POIs loaded in the current viewport.
          <span>Map/search filters do not change either routing engine.</span>
        </div>
  
        {(poiSearch.trim() || advancedFilters.conditions.length > 0) && (
          <div className="poi-search-results">
            <div className="poi-section-title">Search results</div>
            {searchLoading && <div className="empty-state" role="status">Searching POIs…</div>}
            {searchError && <div className="dataset-warning" role="alert">{searchError} <button onClick={onRetrySearch}>Retry</button></div>}
            {!searchLoading && !searchError && searchResults.length === 0 ? (
              <div className="empty-state">No POIs match the current search and filters.</div>
            ) : searchResults.map((feature, index) => (
              <button
                key={`${propText(feature.properties, 'new_node_id', '')}-${index}`}
                className="poi-search-result"
                onClick={() => focusPoiFeature(feature)}
              >
                <span>
                  <strong>{propText(feature.properties, 'name', 'Unnamed POI')}</strong>
                  <small>{propText(feature.properties, 'landmark_type', 'unknown')} · {propText(feature.properties, 'mappls_poi_id', 'no Mappls ID')}</small>
                </span>
                <span className="poi-search-meta">
                  <strong>{propText(feature.properties, 'priority', '—')}</strong>
                  <small>priority</small>
                </span>
              </button>
            ))}
            {searchHasMore && <button onClick={onLoadMore} disabled={searchLoadingMore}>{searchLoadingMore ? 'Loading…' : 'Load more results'}</button>}
            {!searchLoading && searchResults.length > 0 && <small>{searchResults.length}{searchHasMore ? '+' : ''} results loaded</small>}
          </div>
        )}
  
        <div className="poi-type-stats">
          <div className="poi-section-title">Dataset type distribution</div>
          {fullTypeStats.slice(0, 8).map(([type, count]) => (
            <button key={type} disabled={advancedFilters.conditions.length >= 10} onClick={() => advancedFilters.onConditionsChange([
              ...advancedFilters.conditions,
              { id: `${Date.now()}-${type}`, field: 'landmark_type', operator: 'eq', value: type },
            ])} title={`Add ${type} as an advanced condition`}>
              <span>{type}</span><strong>{count}</strong>
            </button>
          ))}
          {fullTypeStats.length > 8 && <small>+ {fullTypeStats.length - 8} more landmark types</small>}
        </div>
      </section>
    </>
  );
}
