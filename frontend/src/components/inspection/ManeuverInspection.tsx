import type { OsrmRouteResponse, OsrmStep, ValhallaRouteResponse } from '../../types';
import { parseOsrmLandmarkInstruction } from '../../narration';
import type { ManeuverView, NarrationPoiEvidence, NearbyPoi, OsrmPassByEventView, OsrmPassByLandmark, OsrmStepView } from './viewModels';

const NEARBY_POI_RADIUS_M = 100;

export interface ManeuverInspectionProps {
  route: ValhallaRouteResponse | null;
  osrmRoute: OsrmRouteResponse | null;
  maneuverViews: ManeuverView[];
  osrmStepViews: OsrmStepView[];
  selectedManeuverIndex: number | null;
  selectedOsrmStepIndex: number | null;
  selectedManeuver: ManeuverView | null;
  selectedOsrmStep?: OsrmStepView | null;
  selectedPassBy?: OsrmPassByEventView | null;
  selectedPassByLandmark?: OsrmPassByLandmark | null;
  compact?: boolean;
  narrationEvidenceByManeuver: Map<number, NarrationPoiEvidence[]>;
  osrmPoiNamesByStep: Map<number, string[]>;
  primaryNarrationEvidence: NarrationPoiEvidence | null;
  selectedNarrationEvidence: NarrationPoiEvidence[];
  nearbyPois: NearbyPoi[];
  diagnosticStatus: 'idle' | 'loading' | 'complete' | 'incomplete' | 'unavailable';
  diagnosticMessage: string;
  getOsrmInstruction: (step: OsrmStep) => string;
  onFocusManeuver: (item: ManeuverView) => void;
  onFocusOsrmStep: (item: OsrmStepView) => void;
  onFocusNarrationEvidence: (item: NarrationPoiEvidence) => void;
  onFocusPoi: (item: NearbyPoi) => void;
  onFocusPassBySource?: (item: NarrationPoiEvidence) => void;
}

export function ManeuverInspection({
  route, osrmRoute, maneuverViews, osrmStepViews,
  selectedManeuverIndex, selectedOsrmStepIndex, selectedManeuver, selectedOsrmStep = null, compact = false,
  selectedPassBy = null, selectedPassByLandmark = null,
  narrationEvidenceByManeuver, osrmPoiNamesByStep,
  primaryNarrationEvidence, selectedNarrationEvidence, nearbyPois,
  diagnosticStatus, diagnosticMessage,
  getOsrmInstruction: osrmInstructionText,
  onFocusManeuver: focusManeuver,
  onFocusOsrmStep: focusOsrmStep,
  onFocusNarrationEvidence: focusNarrationEvidence,
  onFocusPoi: focusPoi,
  onFocusPassBySource: focusPassBySource = () => undefined,
}: ManeuverInspectionProps) {
  return (
    <>
      {!compact && <section className="card maneuvers-card">
        <div className="maneuver-heading">
          <h2>Odin Maneuvers</h2>
          {route?.trip?.summary && (
            <span>{route.trip.summary.length?.toFixed(2)} km · {Math.round((route.trip.summary.time ?? 0) / 60)} min</span>
          )}
        </div>
        {maneuverViews.length === 0 ? (
          <div className="empty-state">Run a route to inspect Odin instructions.</div>
        ) : (
          <ol className="maneuver-list">
            {maneuverViews.map((item) => (
              <li key={item.index} data-maneuver-index={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}>
                <button className="maneuver-button" onClick={() => focusManeuver(item)}>
                  <strong>{item.maneuver.instruction ?? 'Unnamed maneuver'}</strong>
                  {(() => {
                    const evidence = narrationEvidenceByManeuver.get(item.index) ?? [];
                    if (evidence.some((match) => match.evidence === 'strong')) {
                      return <span className="narration-mini-badge strong">POI in instruction</span>;
                    }
                    return null;
                  })()}
                  {item.maneuver.verbal_pre_transition_instruction && (
                    <div>{item.maneuver.verbal_pre_transition_instruction}</div>
                  )}
                  <small>
                    {typeof item.maneuver.length === 'number' ? `${item.maneuver.length.toFixed(2)} km` : ''}
                    {typeof item.maneuver.time === 'number' ? ` · ${Math.round(item.maneuver.time)} s` : ''}
                    {item.coordinate ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}` : ''}
                  </small>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>}
  
      {!compact && <section className="card maneuvers-card osrm-maneuvers-card">
        <div className="maneuver-heading">
          <h2>OSRM Maneuvers</h2>
          {osrmRoute?.routes?.[0] && (
            <span>
              {((osrmRoute.routes[0].distance ?? 0) / 1000).toFixed(2)} km ·
              {' '}{Math.round((osrmRoute.routes[0].duration ?? 0) / 60)} min
            </span>
          )}
        </div>
  
        {osrmStepViews.length === 0 ? (
          <div className="empty-state">
            Run a route to inspect OSRM instructions.
          </div>
        ) : (
          <ol className="maneuver-list osrm-maneuver-list">
            {osrmStepViews.map((item) => {
              const poiNames = osrmPoiNamesByStep.get(item.index) ?? [];
              const landmark = parseOsrmLandmarkInstruction(osrmInstructionText(item.step));
  
              return (
                <li
                  key={item.index}
                  data-osrm-step-index={item.index}
                  className={selectedOsrmStepIndex === item.index ? 'selected' : ''}
                >
                  <button
                    className="osrm-step"
                    onClick={() => focusOsrmStep(item)}
                  >
                    <strong>{osrmInstructionText(item.step)}</strong>
                    {landmark && <span className={`narration-mini-badge landmark-${landmark.relation}`}>{landmark.relation.toUpperCase()}{landmark.placement === 'prefix' ? ' · PREFIX' : ''}</span>}
  
                    {poiNames.length > 0 && (
                      <span className="narration-mini-badge osrm">
                        POI in instruction: {poiNames.join(', ')}
                      </span>
                    )}
  
                    <small>
                      {typeof item.step.distance === 'number'
                        ? `${item.step.distance.toFixed(1)} m`
                        : ''}
                      {typeof item.step.duration === 'number'
                        ? ` · ${Math.round(item.step.duration)} s`
                        : ''}
                      {item.coordinate
                        ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}`
                        : ''}
                    </small>
  
                    {(item.step.maneuver?.type || item.step.maneuver?.modifier) && (
                      <code>
                        {item.step.maneuver?.type ?? ''}
                        {item.step.maneuver?.modifier
                          ? ` / ${item.step.maneuver.modifier}`
                          : ''}
                      </code>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>}
  
      <section className="card inspection-card">
        <div className="maneuver-heading">
          <h2>Maneuver details</h2>
          <span>{NEARBY_POI_RADIUS_M} m radius</span>
        </div>
        {!selectedManeuver && !selectedOsrmStep && !selectedPassBy ? (
          <div className="empty-state">Select a Valhalla maneuver or OSRM step on the map or in the analysis workspace.</div>
        ) : selectedPassBy ? (
          <div className="selected-maneuver-summary selected-osrm-summary pass-by-summary">
            <strong>OSRM pass-by event #{selectedPassBy.index + 1}</strong>
            <span>{selectedPassBy.instruction}</span>
            <code>Engine pass-by event · {selectedPassBy.event.side ?? 'side unavailable'}</code>
            <small>
              Leg {selectedPassBy.legIndex + 1}
              {selectedPassBy.legDistanceM === null ? ' · leg distance unavailable' : ` · ${selectedPassBy.legDistanceM.toFixed(1)} m from leg start`}
              {selectedPassBy.coordinate ? ` · ${selectedPassBy.coordinate[1].toFixed(6)}, ${selectedPassBy.coordinate[0].toFixed(6)} (event location)` : ' · event location unavailable'}
            </small>
            <small>POI ID {String(selectedPassBy.event.poi_id ?? 'unavailable')} · OSM node {String(selectedPassBy.event.osm_node_id ?? 'unavailable')}</small>
            {selectedPassByLandmark?.sourceEvidence ? (
              <button className="narration-primary-match" onClick={() => focusPassBySource(selectedPassByLandmark.sourceEvidence!)}>
                <span>
                  <strong>{selectedPassByLandmark.sourceEvidence.name}</strong>
                  <small>{selectedPassByLandmark.sourceMatch === 'poi-id' || selectedPassByLandmark.sourceMatch === 'osm-node-id'
                    ? `Source POI matched via ${selectedPassByLandmark.sourceMatch}`
                    : 'Name/proximity candidate; source identity unresolved'}</small>
                </span>
                <span><strong>Inspect source record</strong><small>physical coordinate is separate from event location</small></span>
              </button>
            ) : (
              <p>Source POI correlation is unresolved. The engine event remains authoritative; its location is not presented as the physical POI coordinate.</p>
            )}
            <p>Candidate extraction and turn-selection diagnostics are unavailable for pass-by events.</p>
          </div>
        ) : !selectedManeuver && selectedOsrmStep ? (
          <div className="selected-maneuver-summary selected-osrm-summary">
            <strong>OSRM step #{selectedOsrmStep.index + 1}</strong>
            <span>{osrmInstructionText(selectedOsrmStep.step)}</span>
            {(() => {
              const landmark = parseOsrmLandmarkInstruction(osrmInstructionText(selectedOsrmStep.step));
              return landmark ? <b className={`guidance-kind-badge ${landmark.relation}`}>{landmark.relation.toUpperCase()}{landmark.placement === 'prefix' ? ' · PREFIX' : ''}</b> : null;
            })()}
            <code>{selectedOsrmStep.step.maneuver?.type ?? 'maneuver'}{selectedOsrmStep.step.maneuver?.modifier ? ` / ${selectedOsrmStep.step.maneuver.modifier}` : ''}</code>
            <small>Leg {selectedOsrmStep.legIndex + 1} · leg step {selectedOsrmStep.stepIndex + 1}{typeof selectedOsrmStep.step.distance === 'number' ? ` · ${selectedOsrmStep.step.distance.toFixed(1)} m` : ''}{typeof selectedOsrmStep.step.duration === 'number' ? ` · ${selectedOsrmStep.step.duration.toFixed(1)} s` : ''}</small>
            {selectedOsrmStep.coordinate && <small>{selectedOsrmStep.coordinate[1].toFixed(6)}, {selectedOsrmStep.coordinate[0].toFixed(6)}</small>}
            {(selectedOsrmStep.step.maneuver?.maneuver_id !== undefined || selectedOsrmStep.step.maneuver?.turn_id !== undefined) && <small>
              {selectedOsrmStep.step.maneuver?.maneuver_id !== undefined ? `Maneuver ID ${selectedOsrmStep.step.maneuver.maneuver_id}` : ''}
              {selectedOsrmStep.step.maneuver?.maneuver_id !== undefined && selectedOsrmStep.step.maneuver?.turn_id !== undefined ? ' · ' : ''}
              {selectedOsrmStep.step.maneuver?.turn_id !== undefined ? `Turn ID ${selectedOsrmStep.step.maneuver.turn_id}` : ''}
            </small>}
          </div>
        ) : (
          <>
            <div className="selected-maneuver-summary">
              <strong>#{selectedManeuver!.index + 1} {selectedManeuver!.maneuver.instruction ?? 'Unnamed maneuver'}</strong>
              <code>Type {selectedManeuver!.maneuver.type ?? 'unavailable'} · leg {selectedManeuver!.legIndex + 1} · leg maneuver {selectedManeuver!.maneuverIndex + 1}</code>
              <small>{typeof selectedManeuver!.maneuver.length === 'number' ? `${selectedManeuver!.maneuver.length.toFixed(2)} km` : 'Distance unavailable'}{typeof selectedManeuver!.maneuver.time === 'number' ? ` · ${selectedManeuver!.maneuver.time.toFixed(1)} s` : ' · duration unavailable'}</small>
              <span>
                {selectedManeuver!.coordinate
                  ? `${selectedManeuver!.coordinate![1].toFixed(6)}, ${selectedManeuver!.coordinate![0].toFixed(6)}`
                  : 'No begin_shape_index coordinate available'}
              </span>
            </div>
            {diagnosticStatus === 'loading' && (
              <div className="empty-state" role="status">Loading nearby source POIs…</div>
            )}
            {(diagnosticStatus === 'incomplete' || diagnosticStatus === 'unavailable') && (
              <div className="dataset-warning" role="alert">
                {diagnosticMessage || (diagnosticStatus === 'incomplete'
                  ? 'Nearby source-POI retrieval is incomplete. Missing POIs must not be interpreted as absent.'
                  : 'Nearby source-POI data is unavailable.')}
              </div>
            )}
            <div className="narration-verification">
              <div className="narration-verification-heading">
                <strong>POI in Odin Instruction</strong>
                {!primaryNarrationEvidence ? (
                  <span className="narration-status none">
                    {diagnosticStatus === 'complete' ? 'NO SOURCE MATCH' : diagnosticStatus === 'loading' ? 'LOADING' : 'SOURCE DATA INCOMPLETE'}
                  </span>
                ) : (
                  <span className="narration-status strong">POI FOUND</span>
                )}
              </div>
  
              {!primaryNarrationEvidence ? (
                <p>{diagnosticStatus === 'complete'
                  ? "No source POI name was identified in this maneuver's Odin instruction."
                  : 'A source-POI narration match cannot be ruled out until nearby retrieval is complete.'}</p>
              ) : (
                <>
                  <button className="narration-primary-match" onClick={() => focusNarrationEvidence(primaryNarrationEvidence)}>
                    <span>
                      <strong>{primaryNarrationEvidence.name}</strong>
                      <small>{primaryNarrationEvidence.landmarkType} · {primaryNarrationEvidence.poiId || 'no mappls_poi_id'}</small>
                    </span>
                    <span>
                      <strong>{primaryNarrationEvidence.distanceM === null ? 'distance n/a' : `${primaryNarrationEvidence.distanceM.toFixed(1)} m`}</strong>
                      <small>priority {primaryNarrationEvidence.priority ?? '—'}</small>
                    </span>
                  </button>
                  <code className="narration-matched-instruction">{primaryNarrationEvidence.matchedInstruction}</code>
                  {primaryNarrationEvidence.evidence === 'ambiguous' && (
                    <p className="narration-caution">The POI name appears in narration, but not in the strong “at &lt;POI&gt;” landmark pattern. It may be a road/place-name coincidence.</p>
                  )}
                  {selectedNarrationEvidence.length > 1 && (
                    <details className="narration-other-matches">
                      <summary>{selectedNarrationEvidence.length - 1} additional source-name match(es)</summary>
                      {selectedNarrationEvidence.slice(1).map((match, index) => (
                        <button key={`${match.poiId}-${match.sourceNodeId}-${index}`} onClick={() => focusNarrationEvidence(match)}>
                          <span>{match.name}</span>
                          <small>{match.distanceM === null ? 'n/a' : `${match.distanceM.toFixed(1)} m`} · priority {match.priority ?? '—'}</small>
                        </button>
                      ))}
                    </details>
                  )}
                </>
              )}
            </div>
            {nearbyPois.length === 0 && diagnosticStatus === 'complete' ? (
              <div className="empty-state">No source POIs within {NEARBY_POI_RADIUS_M} m.</div>
            ) : nearbyPois.length > 0 ? (
              <div className="nearby-list">
                {nearbyPois.map((item, index) => (
                  <button key={`${item.feature.id ?? item.name}-${index}`} className="nearby-poi" onClick={() => focusPoi(item)}>
                    <span className="nearby-rank">{index + 1}</span>
                    <span className="nearby-main">
                      <strong>{item.name}</strong>
                      <small>{item.landmarkType}</small>
                    </span>
                    <span className="nearby-metrics">
                      <strong>{item.distanceM.toFixed(1)} m</strong>
                      <small>priority {item.priority ?? '—'}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : diagnosticStatus === 'incomplete' ? (
              <div className="empty-state">No nearby POI appears in the returned subset; retrieval is incomplete.</div>
            ) : diagnosticStatus === 'unavailable' ? (
              <div className="empty-state">Nearby source-POI inspection is unavailable.</div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
