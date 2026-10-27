import { propText } from '../../poi';

export interface SelectedPoiDetailsProps {
  poi: GeoJSON.Feature<GeoJSON.Point> | null;
}

export function SelectedPoiDetails({ poi }: SelectedPoiDetailsProps) {
  if (!poi) return null;
  const properties = poi.properties ?? {};
  const routeRelated = properties._route_poi === true;
  const sourceIdentifier = propText(properties, 'mappls_poi_id', '') ||
    propText(properties, 'new_node_id', '') ||
    propText(properties, 'osm_source_id', '') || 'Unavailable';

  return (
    <section className="card selected-poi-card">
      <div className="maneuver-heading">
        <h2>Selected POI</h2>
        <span>{propText(poi.properties, 'landmark_type', '')}</span>
      </div>
      <strong className="selected-poi-name">{propText(poi.properties, 'name', 'Unnamed POI')}</strong>
      {routeRelated && <div className="route-poi-evidence-summary">
        <div><span>Source identifier</span><strong>{sourceIdentifier}</strong></div>
        <div><span>Classification</span><strong>{propText(properties, '_association_label', 'Evidence unavailable')}</strong></div>
        {propText(properties, '_associated_engines', '') && <div><span>Routing engine</span><strong>{propText(properties, '_associated_engines', '')}</strong></div>}
        {propText(properties, '_association_details', '') && <div><span>Engine evidence</span><strong>{propText(properties, '_association_details', '')}</strong></div>}
        {propText(properties, '_related_route_position', '') && <div><span>Related guidance</span><strong>{propText(properties, '_related_route_position', '')}</strong></div>}
        {propText(properties, '_instruction_text', '') && <div><span>Instruction</span><strong>{propText(properties, '_instruction_text', '')}</strong></div>}
        {propText(properties, '_debug_distance_m', '') && <div><span>Distance</span><strong>{propText(properties, '_debug_distance_m', '')} m</strong></div>}
        {propText(properties, '_candidate_status', '') && <div><span>Candidate status</span><strong>{propText(properties, '_candidate_status', '')}</strong></div>}
        {propText(properties, '_candidate_reason', '') && <div><span>Candidate evidence</span><strong>{propText(properties, '_candidate_reason', '')}</strong></div>}
      </div>}
      <div className="property-grid">
        {Object.entries(properties)
          .filter(([key, value]) => value !== '' && !key.startsWith('_'))
          .map(([key, value]) => (
            <div className="property-row" key={key}>
              <span>{key}</span><code>{String(value)}</code>
            </div>
          ))}
      </div>
    </section>
  );
}
