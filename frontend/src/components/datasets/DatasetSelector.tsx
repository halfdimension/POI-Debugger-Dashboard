import { PanelSection } from '../DashboardLayout';
import type { DatasetRegistryResponse, DatasetSummary, DebuggerConfig } from '../../types';

export interface CompactDatasetSelectorProps {
  activeDataset: DatasetSummary | null;
  datasetRegistry: DatasetRegistryResponse | null;
  datasetBusy: boolean;
  datasetMessage: string;
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
  config,
  onChangeDataset: changeDataset,
  onReloadDataset: reloadActiveDataset,
}: CompactDatasetSelectorProps) {
  return (
    <PanelSection title="Dataset" meta={activeDataset?.stats?.valid_pois ?? 0}>
      <div className="dataset-actions">
        <select
          aria-label="Active POI dataset"
          value={datasetRegistry?.active_dataset ?? ''}
          disabled={datasetBusy || !datasetRegistry}
          onChange={(event) => changeDataset(event.target.value)}
        >
          {(datasetRegistry?.datasets ?? []).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
        </select>
        <button onClick={reloadActiveDataset} disabled={datasetBusy || !activeDataset}>{datasetBusy ? 'Working…' : 'Reload'}</button>
      </div>
      {datasetMessage && <div className="dataset-message" role="status">{datasetMessage}</div>}
      {activeDataset?.error && <div className="dataset-warning">{activeDataset.error}</div>}
      <details className="panel-disclosure">
        <summary>Dataset details</summary>
        <div className="kv"><span>Source</span><code title={activeDataset?.source_path ?? ''}>{activeDataset?.source_kind ?? '—'} · {basename(activeDataset?.source_path ?? undefined)}</code></div>
        <div className="kv"><span>PBF</span><code title={activeDataset?.pbf_path ?? config.data.pbf_path}>{basename(activeDataset?.pbf_path ?? config.data.pbf_path)}</code></div>
        <div className="dataset-stats compact">
          <div><strong>{activeDataset?.stats?.total_rows ?? 0}</strong><span>rows</span></div>
          <div><strong>{activeDataset?.stats?.valid_pois ?? 0}</strong><span>valid POIs</span></div>
          <div><strong>{activeDataset?.stats?.invalid_coordinates ?? 0}</strong><span>bad coords</span></div>
          <div><strong>{activeDataset?.stats?.duplicate_poi_ids ?? 0}</strong><span>duplicate IDs</span></div>
        </div>
        <div className="dataset-note">Dataset switching changes the debugger POI layer only; it does not restart either routing engine.</div>
      </details>
    </PanelSection>
  );
}
