import type { UserPreferences } from '../../types';
import type { BuildingLayerStatus } from '../map/geo/buildingLayerManager';

export type MapPerspectivePreferences = Pick<UserPreferences, 'show_3d_buildings'>;

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
        <small>{preferences.show_3d_buildings ? '3D buildings on' : '3D buildings off'}</small>
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
      </div>
    </details>
  );
}
