import type { UserPreferences } from '../../types';
import type { BuildingLayerStatus } from '../map/geo/buildingLayerManager';

export type MapPerspectivePreferences = Pick<
  UserPreferences,
  | 'show_3d_buildings'
  | 'imagery_mode'
  | 'street_imagery_enabled'
  | 'street_coverage_enabled'
  | 'driver_perspective_sync_enabled'
>;

function savedPreferenceSummary(
  preferences: MapPerspectivePreferences,
  buildingStatus: BuildingLayerStatus,
): string {
  const saved: string[] = [];
  if (preferences.imagery_mode !== 'standard') saved.push(`${preferences.imagery_mode[0].toUpperCase()}${preferences.imagery_mode.slice(1)} imagery`);
  if (preferences.street_imagery_enabled) saved.push('Street Imagery');
  if (preferences.street_coverage_enabled) saved.push('Street Imagery Coverage');
  if (preferences.driver_perspective_sync_enabled) saved.push('Driver Perspective Sync');

  const buildingSummary = !buildingStatus.ready
    ? 'Building data is loading.'
    : preferences.show_3d_buildings && buildingStatus.effective
      ? '3D buildings are active where height data is available.'
      : preferences.show_3d_buildings && !buildingStatus.sourceAvailable
        ? '3D buildings are saved but vector building data is unavailable in this map style.'
        : '3D building extrusions are off; 2D map detail remains visible.';
  return saved.length > 0
    ? `${buildingSummary} Saved for future availability: ${saved.join(', ')}. Standard imagery remains active.`
    : `${buildingSummary} Standard imagery is active.`;
}

export function MapPerspectiveMenu({
  preferences,
  buildingStatus,
  onShow3DBuildingsChange,
}: {
  preferences: MapPerspectivePreferences;
  buildingStatus: BuildingLayerStatus;
  onShow3DBuildingsChange: (enabled: boolean) => void;
}) {
  return (
    <details className="map-perspective-menu">
      <summary>
        <span>Map &amp; Perspective</span>
        <small>Standard</small>
      </summary>
      <div className="map-perspective-menu__body">
        <fieldset>
          <legend>Building visualization</legend>
          <label className="map-perspective-option">
            <input
              type="checkbox"
              checked={preferences.show_3d_buildings}
              onChange={(event) => onShow3DBuildingsChange(event.target.checked)}
            />
            <span>3D Buildings <small>{buildingStatus.ready && !buildingStatus.sourceAvailable
              ? 'Vector building data unavailable'
              : 'Uses available building height data'}</small></span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Aerial imagery</legend>
          <label className="map-perspective-option">
            <input type="radio" name="effective-imagery-mode" defaultChecked />
            <span>Standard</span>
          </label>
          <label className="map-perspective-option is-unavailable">
            <input type="radio" name="effective-imagery-mode" disabled />
            <span>Satellite <small>Provider not available</small></span>
          </label>
          <label className="map-perspective-option is-unavailable">
            <input type="radio" name="effective-imagery-mode" disabled />
            <span>Hybrid <small>Provider not available</small></span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Street-level inspection</legend>
          <label className="map-perspective-option is-unavailable">
            <input type="checkbox" checked={false} disabled readOnly />
            <span>Street Imagery <small>Provider not available</small></span>
          </label>
          <label className="map-perspective-option is-unavailable">
            <input type="checkbox" checked={false} disabled readOnly />
            <span>Street Imagery Coverage <small>Provider not available</small></span>
          </label>
          <label className="map-perspective-option is-unavailable">
            <input type="checkbox" checked={false} disabled readOnly />
            <span>Driver Perspective Sync <small>Requires street imagery</small></span>
          </label>
        </fieldset>

        <p className="map-perspective-menu__availability" role="status">
          {savedPreferenceSummary(preferences, buildingStatus)}
        </p>
      </div>
    </details>
  );
}
