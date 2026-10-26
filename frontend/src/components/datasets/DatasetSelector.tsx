import { PanelSection } from '../DashboardLayout';
import type { DatasetRegistryResponse, DatasetSummary, DebuggerConfig } from '../../types';

export interface CompactDatasetSelectorProps {
  activeDataset: DatasetSummary | null;
  datasetRegistry: DatasetRegistryResponse | null;
  datasetBusy: boolean;
  datasetMessage: string;
  canPrepareDataset: boolean;
  config: DebuggerConfig;
  onChangeDataset: (datasetId: string) => void;
  onReloadDataset: () => void;
}

function basename(path?: string): string {
  if (!path) return 'not configured';
  const pieces = path.split('/');
  return pieces[pieces.length - 1] || path;
}

export function CompactDatasetSelector({
  activeDataset,
  datasetRegistry,
  datasetBusy,
  datasetMessage,
  canPrepareDataset,
  config,
  onChangeDataset: changeDataset,
  onReloadDataset: reloadActiveDataset,
}: CompactDatasetSelectorProps) {
  return (
    <PanelSection title="Dataset" meta={activeDataset?.stats?.valid_pois ?? '—'}>
      <div className="dataset-actions">
        <select
          aria-label="Active POI dataset"
          value={datasetRegistry?.active_dataset ?? ''}
          disabled={datasetBusy || !datasetRegistry}
          onChange={(event) => changeDataset(event.target.value)}
        >
          {(datasetRegistry?.datasets ?? []).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
        </select>
        {canPrepareDataset && <button onClick={reloadActiveDataset} disabled={datasetBusy || !activeDataset}>{datasetBusy ? 'Preparing…' : 'Prepare POIs'}</button>}
      </div>
      {datasetMessage && <div className="dataset-message" role="status">{datasetMessage}</div>}
      {activeDataset?.error && <div className="dataset-warning">{activeDataset.error}</div>}
      {activeDataset?.preparation_state === 'pending' && <div className="dataset-message" role="status">{activeDataset.index_state === 'ready' ? 'Search index ready; statistics are pending.' : 'Statistics and search index are not prepared.'}</div>}
      {activeDataset?.preparation_state === 'preparing' && <div className="dataset-message" role="status">Statistics are being prepared.</div>}
      <details className="panel-disclosure">
        <summary>Dataset details</summary>
        <div className="kv"><span>Source</span><code title={activeDataset?.source_path ?? ''}>{activeDataset?.source_kind ?? '—'} · {basename(activeDataset?.source_path ?? undefined)}</code></div>
        <div className="kv"><span>PBF</span><code title={activeDataset?.pbf_path ?? config.data.pbf_path}>{basename(activeDataset?.pbf_path ?? config.data.pbf_path)}</code></div>
        <div className="dataset-stats compact">
          <div><strong>{activeDataset?.stats?.total_rows ?? '—'}</strong><span>rows</span></div>
          <div><strong>{activeDataset?.stats?.valid_pois ?? '—'}</strong><span>valid POIs</span></div>
          <div><strong>{activeDataset?.stats?.invalid_coordinates ?? '—'}</strong><span>bad coords</span></div>
          <div><strong>{activeDataset?.stats?.duplicate_poi_ids ?? '—'}</strong><span>duplicate IDs</span></div>
        </div>
        <div className="dataset-note">Dataset switching changes the debugger POI layer only; it does not restart either routing engine.</div>
      </details>
    </PanelSection>
  );
}
