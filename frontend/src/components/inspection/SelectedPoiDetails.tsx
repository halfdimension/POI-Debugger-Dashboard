import { propText } from '../../poi';

export interface SelectedPoiDetailsProps {
  poi: GeoJSON.Feature<GeoJSON.Point> | null;
}

export function SelectedPoiDetails({ poi }: SelectedPoiDetailsProps) {
  if (!poi) return null;

  return (
    <section className="card selected-poi-card">
      <div className="maneuver-heading">
        <h2>Selected POI</h2>
        <span>{propText(poi.properties, 'landmark_type', '')}</span>
      </div>
      <strong className="selected-poi-name">{propText(poi.properties, 'name', 'Unnamed POI')}</strong>
      <div className="property-grid">
        {Object.entries(poi.properties ?? {})
          .filter(([, value]) => value !== '')
          .map(([key, value]) => (
            <div className="property-row" key={key}>
              <span>{key}</span><code>{String(value)}</code>
            </div>
          ))}
      </div>
    </section>
  );
}
