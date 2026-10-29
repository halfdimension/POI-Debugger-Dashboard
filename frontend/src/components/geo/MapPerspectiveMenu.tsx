import type { UserPreferences } from '../../types';

export type MapPerspectivePreferences = Pick<
  UserPreferences,
  | 'show_3d_buildings'
  | 'imagery_mode'
  | 'street_imagery_enabled'
  | 'street_coverage_enabled'
  | 'driver_perspective_sync_enabled'
>;

function savedPreferenceSummary(preferences: MapPerspectivePreferences): string {
  const saved: string[] = [];
  if (preferences.show_3d_buildings) saved.push('3D Buildings');
  if (preferences.imagery_mode !== 'standard') saved.push(`${preferences.imagery_mode[0].toUpperCase()}${preferences.imagery_mode.slice(1)} imagery`);
  if (preferences.street_imagery_enabled) saved.push('Street Imagery');
  if (preferences.street_coverage_enabled) saved.push('Street Imagery Coverage');
  if (preferences.driver_perspective_sync_enabled) saved.push('Driver Perspective Sync');

  return saved.length > 0
    ? `Saved for future availability: ${saved.join(', ')}. Standard imagery remains active.`
    : 'Standard imagery is active. Additional visualization providers are not available yet.';
}

export function MapPerspectiveMenu({ preferences }: { preferences: MapPerspectivePreferences }) {
  return (
    <details className="map-perspective-menu">
      <summary>
        <span>Map &amp; Perspective</span>
        <small>Standard</small>
      </summary>
      <div className="map-perspective-menu__body">
        <fieldset>
          <legend>Building visualization</legend>
          <label className="map-perspective-option is-unavailable">
            <input type="checkbox" checked={false} disabled readOnly />
            <span>3D Buildings <small>Available in Stage 1C</small></span>
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
          {savedPreferenceSummary(preferences)}
        </p>
      </div>
    </details>
  );
}
