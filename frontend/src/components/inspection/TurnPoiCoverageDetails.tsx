import { osrmInstructionText } from '../../narration';
import { haversineMeters } from '../../coordinates';
import { classifyCoveragePoi, poiDisplayName, poiPriority, TURN_COVERAGE_RADIUS_M, type CoveragePoi, type TurnOccurrence } from '../../turnPoiCoverage';
import type { DatasetSummary } from '../../types';

export function TurnPoiCoverageDetails({
  turn,
  pois,
  status,
  message,
  dataset,
  selectedLandmark,
  onSelectPoi,
}: {
  turn: TurnOccurrence;
  pois: CoveragePoi[];
  status: 'idle' | 'loading' | 'complete' | 'incomplete' | 'unavailable';
  message: string;
  dataset: DatasetSummary | null;
  selectedLandmark?: CoveragePoi['feature'] | null;
  onSelectPoi: (feature: CoveragePoi['feature']) => void;
}) {
  const inside = pois.filter((poi) => poi.inside);
  const boundaryUncertain = pois.filter((poi) => poi.boundary);
  const leftCount = inside.filter((poi) => poi.lateral === 'LEFT').length;
  const rightCount = inside.filter((poi) => poi.lateral === 'RIGHT').length;
  const selectedCoverage = selectedLandmark ? (() => {
    const classified = classifyCoveragePoi(turn, selectedLandmark);
    return classified ? { ...classified, distanceM: haversineMeters(turn.origin, classified.coordinate) } : null;
  })() : null;
  const priorityMeaning = dataset?.priority
    ? `${dataset.priority.rank_order === 'ascending' ? 'Lower' : 'Higher'} values rank first (configured range ${dataset.priority.minimum ?? '—'}–${dataset.priority.maximum ?? '—'}).`
    : 'Dataset priority semantics unavailable.';
  return <section className="turn-coverage-details" aria-label="Turn POI coverage details">
    <div className="maneuver-heading"><h2>Turn coverage details</h2><span>{TURN_COVERAGE_RADIUS_M} m</span></div>
    <div className="coverage-kv">
      <span>Occurrence</span><code>leg {turn.legIndex + 1} · step {turn.stepIndex + 1} · turn ID {turn.turnId}</code>
      <span>Maneuver</span><code>{turn.step.maneuver?.type ?? 'unknown'}{turn.step.maneuver?.modifier ? ` / ${turn.step.maneuver.modifier}` : ''}</code>
      <span>Instruction</span><span>{osrmInstructionText(turn.step)}</span>
      <span>Origin</span><code>{turn.origin[1].toFixed(6)}, {turn.origin[0].toFixed(6)}</code>
      <span>Incoming</span><code>{turn.incoming ? `${turn.incoming.bearing.toFixed(1)}°` : 'unavailable'}</code>
      <span>Orientation</span><span>Incoming approach half-plane</span>
      <span>Query</span><span className={`coverage-source-status ${status}`}>{status === 'complete' ? 'Complete' : status === 'loading' ? 'Loading…' : status === 'incomplete' ? 'Incomplete' : status === 'unavailable' ? 'Unavailable' : 'Awaiting selection'}</span>
      <span>Inside region</span><strong>{status === 'complete' ? inside.length : '—'}</strong>
      <span>LEFT / RIGHT</span><strong>{status === 'complete' ? `${leftCount} / ${rightCount}` : '—'}</strong>
      <span>Boundary-uncertain</span><strong>{status === 'complete' ? boundaryUncertain.length : '—'}</strong>
      {selectedCoverage && <><span>Selected landmark</span><strong>{selectedCoverage.inside ? 'Inside actual footprint' : 'Outside actual footprint'}{selectedCoverage.boundary ? ' · boundary uncertain' : ''}</strong>
      <span>Landmark to turn</span><strong>{selectedCoverage.distanceM.toFixed(1)} m</strong></>}
    </div>
    {!turn.incoming && <div className="dataset-warning">Approach direction unavailable: {turn.directionStatus} No directionally authoritative dome is shown.</div>}
    {status === 'loading' && <div className="empty-state">Loading indexed source POIs…</div>}
    {(status === 'incomplete' || status === 'unavailable') && <div className="dataset-warning">{message || 'Source retrieval is not complete; absent POIs must not be treated as none.'}</div>}
    {turn.incoming && status === 'complete' && inside.length === 0 && <div className="empty-state">Complete source query: no physical POIs are inside this turn’s incoming 30 m semicircle.</div>}
    <div className="landmark-section-heading"><strong>Physical POIs inside the region</strong><span>{inside.length}</span></div>
    <small className="coverage-priority-note">{priorityMeaning}</small>
    <div className="coverage-poi-list">
    {inside.map((poi, index) => <button className="coverage-poi-row" key={`${poi.feature.id ?? poiDisplayName(poi.feature)}-${index}`} onClick={() => onSelectPoi(poi.feature)}>
      <span><strong>{poiDisplayName(poi.feature)}</strong><small>ID {String(poi.feature.properties?.mappls_poi_id ?? poi.feature.properties?.new_node_id ?? poi.feature.id ?? '—')}</small></span>
      <span><strong>{poi.distanceM.toFixed(2)} m · {poi.lateral}</strong><small>{poi.inside ? 'Inside actual footprint' : 'Outside actual footprint'}{poi.boundary ? ' · boundary uncertain' : ''} · priority {poiPriority(poi.feature) ?? '—'}</small></span>
      <span><strong>{poi.engineEvidence}</strong><small>{poi.engineReason}</small></span>
    </button>)}
    </div>
    {pois.filter((poi) => !poi.inside).length > 0 && <details className="inspector-disclosure"><summary>{pois.filter((poi) => !poi.inside).length} retrieved POI(s) outside this half-dome</summary>
      {pois.filter((poi) => !poi.inside).map((poi, index) => <div className="coverage-outside" key={index}>{poiDisplayName(poi.feature)} · {poi.distanceM.toFixed(1)} m · {poi.halfPlane}</div>)}
    </details>}
    <p className="coverage-disclaimer">Diagnostic spatial region only — not the OSRM engine’s candidate-eligibility region. The footprint remains exactly 30 m; ±0.35 m only marks numerical boundary uncertainty and never expands inclusion.</p>
  </section>;
}
