import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CompactDatasetSelector } from './DatasetSelector';

const registry = {
  active_dataset: 'a',
  datasets: [{
    id: 'a', name: 'Dataset A', priority: { rank_order: 'descending' as const, minimum: null, maximum: null },
    source_exists: true, stats: null, preparation_state: 'pending' as const,
  }],
};

function render(canPrepareDataset: boolean): string {
  return renderToStaticMarkup(<CompactDatasetSelector
    activeDataset={registry.datasets[0]}
    datasetRegistry={registry}
    datasetBusy={false}
    datasetMessage=""
    canPrepareDataset={canPrepareDataset}
    config={{
      project: {}, valhalla: { service_url: '', status_path: '', route_path: '' },
      osrm: { service_url: '', profile: '', route_path: '' }, engine: {}, data: {},
      frontend: { map_style_url: '', default_center: [0, 0], default_zoom: 1 }, config_path: '',
    }}
    onChangeDataset={vi.fn()}
    onReloadDataset={vi.fn()}
  />);
}

describe('CompactDatasetSelector maintenance controls', () => {
  it('hides preparation actions from ordinary users', () => {
    expect(render(false)).not.toContain('Prepare POIs');
  });

  it('shows preparation actions to Super Admins', () => {
    expect(render(true)).toContain('Prepare POIs');
  });
});
