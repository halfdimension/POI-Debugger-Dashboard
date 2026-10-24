import { PanelSection } from '../DashboardLayout';
import type { LngLat } from '../../types';

type PickMode = 'start' | 'end';

export interface RouteSetupControlsProps {
  pickMode: PickMode;
  start: LngLat | null;
  end: LngLat | null;
  busy: boolean;
  error: string;
  onPickModeChange: (mode: PickMode) => void;
  onCoordinateChange: (kind: PickMode, axis: 0 | 1, value: string) => void;
  onRunRoute: () => void;
}

function formatCoordinate(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(6) : '';
}

export function RouteSetupControls({
  pickMode,
  start,
  end,
  busy,
  error,
  onPickModeChange,
  onCoordinateChange,
  onRunRoute,
}: RouteSetupControlsProps) {
  return (
    <PanelSection title="Route setup" meta="START / END">
      <div className="pick-mode-row" role="group" aria-label="Map coordinate target">
        <button className={pickMode === 'start' ? 'active' : ''} aria-pressed={pickMode === 'start'} onClick={() => onPickModeChange('start')}>Pick start</button>
        <button className={pickMode === 'end' ? 'active' : ''} aria-pressed={pickMode === 'end'} onClick={() => onPickModeChange('end')}>Pick end</button>
      </div>
      <label>Start <span>[longitude, latitude]</span></label>
      <div className="coord-row">
        <input aria-label="Start longitude" value={formatCoordinate(start?.[0])} placeholder="Longitude" onChange={(event) => onCoordinateChange('start', 0, event.target.value)} />
        <input aria-label="Start latitude" value={formatCoordinate(start?.[1])} placeholder="Latitude" onChange={(event) => onCoordinateChange('start', 1, event.target.value)} />
      </div>
      <label>End <span>[longitude, latitude]</span></label>
      <div className="coord-row">
        <input aria-label="End longitude" value={formatCoordinate(end?.[0])} placeholder="Longitude" onChange={(event) => onCoordinateChange('end', 0, event.target.value)} />
        <input aria-label="End latitude" value={formatCoordinate(end?.[1])} placeholder="Latitude" onChange={(event) => onCoordinateChange('end', 1, event.target.value)} />
      </div>
      <button className="route-button" onClick={onRunRoute} disabled={busy || !start || !end}>
        {busy ? 'Routing both engines…' : 'Run route comparison'}
      </button>
      {error && <div className="error-box" role="alert">{error}</div>}
    </PanelSection>
  );
}
