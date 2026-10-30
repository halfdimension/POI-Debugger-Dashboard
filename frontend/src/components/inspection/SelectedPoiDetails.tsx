import { propNumber, propText } from '../../poi';
import { osrmInstructionText } from '../../narration';
import type { ManeuverView, NarrationPoiEvidence, OsrmPassByLandmark, OsrmStepView } from './viewModels';

export type PoiGuidanceContext =
  | { kind: 'osrm-step'; category: 'AT' | 'AFTER' | 'BEFORE'; placement: 'inline' | 'prefix'; selectedStep: OsrmStepView; relatedSteps: OsrmStepView[]; evidence: NarrationPoiEvidence }
  | { kind: 'valhalla-maneuver'; category: 'AT'; selectedManeuver: ManeuverView; relatedManeuvers: ManeuverView[]; evidence: NarrationPoiEvidence }
  | { kind: 'pass-by'; landmark: OsrmPassByLandmark };

export interface SelectedPoiDetailsProps {
  poi: GeoJSON.Feature<GeoJSON.Point> | null;
  guidance?: PoiGuidanceContext | null;
}

const DISPLAYED_SOURCE_KEYS = new Set([
  'name', 'landmark_type', 'category', 'priority', 'visibility', 'visible',
  'mappls_poi_id', 'new_node_id', 'osm_node_id', 'osm_source_id', 'source', 'source_id',
]);

function coordinateText(coordinate: number[] | null | undefined): string {
  if (!coordinate || coordinate.length < 2 || !coordinate.every(Number.isFinite)) return 'Unavailable';
  return `${coordinate[1].toFixed(6)}, ${coordinate[0].toFixed(6)}`;
}

function optionalText(value: unknown): string {
  return value === undefined || value === null || value === '' ? 'Unavailable' : String(value);
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  return <div className="property-row"><span>{label}</span><code>{optionalText(value)}</code></div>;
}

export function SelectedPoiDetails({ poi, guidance = null }: SelectedPoiDetailsProps) {
  if (!poi && !guidance) return null;

  const passBy = guidance?.kind === 'pass-by' ? guidance.landmark : null;
  const evidence = guidance?.kind === 'osrm-step' || guidance?.kind === 'valhalla-maneuver'
    ? guidance.evidence
    : passBy?.sourceEvidence ?? null;
  const properties = poi?.properties ?? evidence?.feature.properties ?? {};
  const heading = evidence?.name || passBy?.event.name || propText(properties, 'name', 'Unnamed POI');
  const category = evidence?.landmarkType || propText(properties, 'landmark_type', propText(properties, 'category', 'unknown'));
  const priority = evidence?.priority ?? propNumber(properties, 'priority');
  const visibility = properties?.visibility ?? properties?.visible;
  const physicalCoordinate = evidence?.coordinate ?? (poi?.geometry.coordinates as [number, number] | undefined);

  return (
    <section className="card selected-poi-card landmark-inspector-card">
      <div className="maneuver-heading">
        <h2>Landmark</h2>
        <span>{passBy ? 'PASS-BY' : category}</span>
      </div>
      <strong className="selected-poi-name">{heading}</strong>
      <div className="landmark-summary-grid">
        <div><span>Category</span><strong>{category}</strong></div>
        <div><span>Priority</span><strong>{priority ?? '—'}</strong></div>
        <div><span>Visibility</span><strong>{optionalText(visibility)}</strong></div>
      </div>

      {guidance?.kind === 'osrm-step' && <section className="landmark-inspector-section">
        <div className="landmark-section-heading"><strong>Related guidance</strong><b className={`guidance-kind-badge ${guidance.category.toLowerCase()}`}>{guidance.category}</b></div>
        <p className="landmark-instruction">{osrmInstructionText(guidance.selectedStep.step)}</p>
        <div className="property-grid compact-property-grid">
          <DetailRow label="Maneuver" value={`${guidance.selectedStep.step.maneuver?.type ?? 'maneuver'}${guidance.selectedStep.step.maneuver?.modifier ? ` / ${guidance.selectedStep.step.maneuver.modifier}` : ''}`} />
          <DetailRow label="OSRM occurrence" value={`Step ${guidance.selectedStep.index + 1} · leg ${guidance.selectedStep.legIndex + 1} · leg step ${guidance.selectedStep.stepIndex + 1}`} />
          <DetailRow label="Instruction grammar" value={guidance.placement === 'prefix' ? 'Relation prefix' : 'Relation suffix'} />
          <DetailRow label="Distance" value={typeof guidance.selectedStep.step.distance === 'number' ? `${guidance.selectedStep.step.distance.toFixed(1)} m` : null} />
          <DetailRow label="Duration" value={typeof guidance.selectedStep.step.duration === 'number' ? `${guidance.selectedStep.step.duration.toFixed(1)} s` : null} />
        </div>
        {guidance.relatedSteps.length > 1 && <details className="landmark-related-occurrences">
          <summary>{guidance.relatedSteps.length - 1} other instruction reference{guidance.relatedSteps.length === 2 ? '' : 's'}</summary>
          {guidance.relatedSteps.filter((step) => step.index !== guidance.selectedStep.index).map((step) => (
            <div key={step.index}><strong>Step {step.index + 1} · leg {step.legIndex + 1}</strong><span>{osrmInstructionText(step.step)}</span></div>
          ))}
        </details>}
      </section>}

      {guidance?.kind === 'valhalla-maneuver' && <section className="landmark-inspector-section">
        <div className="landmark-section-heading"><strong>Related guidance</strong><b className="guidance-kind-badge at">{guidance.category}</b></div>
        <p className="landmark-instruction">{guidance.selectedManeuver.maneuver.instruction ?? guidance.evidence.matchedInstruction}</p>
        <div className="property-grid compact-property-grid">
          <DetailRow label="Maneuver type" value={guidance.selectedManeuver.maneuver.type} />
          <DetailRow label="Occurrence" value={`Maneuver ${guidance.selectedManeuver.index + 1} · leg ${guidance.selectedManeuver.legIndex + 1} · leg maneuver ${guidance.selectedManeuver.maneuverIndex + 1}`} />
          <DetailRow label="Distance" value={typeof guidance.selectedManeuver.maneuver.length === 'number' ? `${guidance.selectedManeuver.maneuver.length.toFixed(2)} km` : null} />
          <DetailRow label="Duration" value={typeof guidance.selectedManeuver.maneuver.time === 'number' ? `${guidance.selectedManeuver.maneuver.time.toFixed(1)} s` : null} />
        </div>
        {guidance.relatedManeuvers.length > 1 && <details className="landmark-related-occurrences">
          <summary>{guidance.relatedManeuvers.length - 1} other instruction reference{guidance.relatedManeuvers.length === 2 ? '' : 's'}</summary>
          {guidance.relatedManeuvers.filter((item) => item.index !== guidance.selectedManeuver.index).map((item) => (
            <div key={item.index}><strong>Maneuver {item.index + 1} · leg {item.legIndex + 1}</strong><span>{item.maneuver.instruction ?? 'Unnamed maneuver'}</span></div>
          ))}
        </details>}
      </section>}

      {passBy && <section className="landmark-inspector-section">
        <div className="landmark-section-heading"><strong>Related guidance</strong><b className="guidance-kind-badge pass-by">PASS-BY</b></div>
        <p className="landmark-instruction">{passBy.event.instruction}</p>
        <div className="property-grid compact-property-grid">
          <DetailRow label="Event location" value={coordinateText(passBy.event.coordinate)} />
          <DetailRow label="Event identity" value={passBy.event.key} />
          <DetailRow label="Leg" value={passBy.event.legIndex + 1} />
          <DetailRow label="Along leg" value={passBy.event.legDistanceM === null ? null : `${passBy.event.legDistanceM.toFixed(1)} m`} />
          <DetailRow label="Along route" value={passBy.event.routeDistanceM === null ? null : `${passBy.event.routeDistanceM.toFixed(1)} m`} />
          <DetailRow label="Side" value={passBy.event.event.side} />
          <DetailRow label="Event POI ID" value={passBy.event.event.poi_id} />
          <DetailRow label="Event OSM node" value={passBy.event.event.osm_node_id} />
        </div>
        <p className="landmark-location-note">The engine event location is distinct from the physical source POI location below.</p>
      </section>}

      <section className="landmark-inspector-section">
        <div className="landmark-section-heading"><strong>Source POI details</strong></div>
        <div className="property-grid compact-property-grid">
          <DetailRow label="POI ID" value={properties?.mappls_poi_id ?? evidence?.poiId} />
          <DetailRow label="OSM node ID" value={properties?.osm_node_id ?? properties?.osm_source_id} />
          <DetailRow label="Source node ID" value={properties?.new_node_id ?? evidence?.sourceNodeId} />
          <DetailRow label="Source identity" value={properties?.source_id ?? properties?.source ?? poi?.id} />
          <DetailRow label="Physical location" value={coordinateText(physicalCoordinate)} />
        </div>
      </section>

      {guidance && <section className="landmark-inspector-section landmark-diagnostics">
        <div className="landmark-section-heading"><strong>Correlation and evidence</strong></div>
        <div className="property-grid compact-property-grid">
          <DetailRow label="Source match" value={passBy ? (passBy.sourceMatch ? passBy.sourceMatch.replaceAll('-', ' ') : 'Unresolved') : 'Instruction name + source POI'} />
          <DetailRow label="Evidence" value={passBy
            ? passBy.sourceMatch === 'poi-id' || passBy.sourceMatch === 'osm-node-id'
              ? 'stable source identity'
              : passBy.sourceMatch === 'name-and-proximity' ? 'name/proximity candidate' : 'unresolved'
            : evidence?.evidence} />
          {evidence?.distanceM !== null && evidence?.distanceM !== undefined && <DetailRow label="Correlation distance" value={`${evidence.distanceM.toFixed(1)} m`} />}
        </div>
      </section>}

      {poi && Object.entries(properties ?? {}).some(([key, value]) => !key.startsWith('_') && !DISPLAYED_SOURCE_KEYS.has(key) && value !== '') && <details className="landmark-source-diagnostics">
        <summary>Additional source fields</summary>
        <div className="property-grid">
          {Object.entries(properties ?? {}).filter(([key, value]) => !key.startsWith('_') && !DISPLAYED_SOURCE_KEYS.has(key) && value !== '').map(([key, value]) => (
            <div className="property-row" key={key}><span>{key}</span><code>{String(value)}</code></div>
          ))}
        </div>
      </details>}
    </section>
  );
}
