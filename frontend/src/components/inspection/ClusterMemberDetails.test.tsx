import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClusterMemberDetails } from './ClusterMemberDetails';

const aggregate = {
  id: 'cluster-1', source_record_count: 2500, coordinates: [77, 28] as [number, number],
  coordinate_kind: 'represented_bounds_center' as const, bounds: [76, 27, 78, 29] as [number, number, number, number],
  aggregation_level: 12, cluster_ref: 'ref',
};
const member = {
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [77, 28] },
  properties: { name: 'Cafe One', landmark_type: 'food' },
};

describe('ClusterMemberDetails', () => {
  it('shows authoritative totals, bounded progress, and pagination', () => {
    const markup = renderToStaticMarkup(<ClusterMemberDetails
      aggregate={aggregate}
      response={{ dataset_id: 'weekly', generation: 'g1', cluster_id: 'cluster-1', cluster_ref: 'ref', bounds: aggregate.bounds, aggregation_level: 12, total_matching_pois: 2500, individual_pois: [], returned: 1, has_more: true, next_cursor: 'next', meta: { order: 'source_record_id_ascending', max_limit: 500, max_payload_bytes: 1000, serialized_bytes: 500 } }}
      members={[member]}
      loading={false}
      loadingMore={false}
      error=""
      onSelect={vi.fn()}
      onLoadMore={vi.fn()}
    />);
    expect(markup).toContain('2,500 POIs');
    expect(markup).toContain('Cafe One');
    expect(markup).toContain('Load more members');
    expect(markup).toContain('1 of 2,500 members loaded');
  });
});
