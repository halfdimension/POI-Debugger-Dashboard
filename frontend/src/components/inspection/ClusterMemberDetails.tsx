import { propText } from '../../poi';
import type { ClusterMemberResponse, ViewportAggregate } from '../../poiSearchApi';

export interface ClusterMemberDetailsProps {
  aggregate: ViewportAggregate;
  response: ClusterMemberResponse | null;
  members: GeoJSON.Feature<GeoJSON.Point>[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  onSelect: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
  onLoadMore: () => void;
}

export function ClusterMemberDetails({ aggregate, response, members, loading, loadingMore, error, onSelect, onLoadMore }: ClusterMemberDetailsProps) {
  const total = response?.total_matching_pois ?? aggregate.source_record_count;
  return (
    <section className="card selected-poi-card cluster-member-card">
      <div className="maneuver-heading"><h2>Aggregate members</h2><span>{total.toLocaleString()} POIs</span></div>
      <p className="dataset-note">This marker summarizes a geographic region. Select a member to inspect the underlying POI.</p>
      {loading && <div className="empty-state" role="status">Loading aggregate members…</div>}
      {error && <div className="dataset-warning" role="alert">{error}</div>}
      <div className="poi-search-results">
        {members.map((feature, index) => (
          <button type="button" className="poi-search-result" key={`${feature.id ?? propText(feature.properties, 'mappls_poi_id', '')}-${index}`} onClick={() => onSelect(feature)}>
            <span><strong>{propText(feature.properties, 'name', 'Unnamed POI')}</strong><small>{propText(feature.properties, 'landmark_type', 'unknown')}</small></span>
          </button>
        ))}
      </div>
      {response?.has_more && <button type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more members'}</button>}
      {!loading && members.length > 0 && <small>{members.length.toLocaleString()} of {total.toLocaleString()} members loaded</small>}
    </section>
  );
}
