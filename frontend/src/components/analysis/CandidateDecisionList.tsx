import type { CandidateAnalysisCandidate, CandidateAnalysisManeuver } from '../../types';

function analysisValue(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';

    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(digits);
  }

  return String(value);
}

function candidateStatusClass(status?: string): string {
  if (status === 'SELECTED') {
    return 'selected';
  }

  if (status === 'ELIGIBLE / LOST RANKING') {
    return 'eligible';
  }

  if (status === 'REJECTED') {
    return 'rejected';
  }

  if (status === 'DEDUPLICATED') {
    return 'deduplicated';
  }

  return 'unknown';
}

function candidateCoordinateText(
  candidate: CandidateAnalysisCandidate,
): string {
  const coordinate = candidate.coordinate;

  if (
    !Array.isArray(coordinate) ||
    coordinate.length < 2 ||
    !Number.isFinite(Number(coordinate[0])) ||
    !Number.isFinite(Number(coordinate[1]))
  ) {
    return '—';
  }

  return (
    `${Number(coordinate[1]).toFixed(6)}, ` +
    `${Number(coordinate[0]).toFixed(6)}`
  );
}

export function CandidateDecisionList({
  engine,
  analysis,
  showCandidatesOnMap,
  onToggleCandidatesOnMap,
}: {
  engine: 'valhalla' | 'osrm';
  analysis: CandidateAnalysisManeuver;
  showCandidatesOnMap: boolean;
  onToggleCandidatesOnMap: () => void;
}) {
  const candidates = analysis.candidates ?? [];

  const selected =
    candidates.find((candidate) => candidate.selected) ?? null;

  const identity = analysis.identity ?? {};
  const maneuver = analysis.maneuver ?? {};
  const selector = analysis.selector ?? {};

  return (
    <div className={`candidate-analysis-engine ${engine}`}>
      <div className="candidate-analysis-engine-header">
        <span className={`candidate-engine-badge ${engine}`}>
          {engine === 'valhalla' ? 'VALHALLA' : 'OSRM'}
        </span>

        <div>
          <strong>
            {selected?.name
              ? `Selected: ${selected.name}`
              : 'No candidate selected'}
          </strong>

          <small>
            {candidates.length} candidate
            {candidates.length === 1 ? '' : 's'} considered
          </small>
        </div>
      </div>

      {engine === 'osrm' ? (
        <div className="candidate-context-grid">
          <div>
            <span>turn_id</span>
            <strong>{analysisValue(identity.turn_id)}</strong>
          </div>

          <div>
            <span>intersection node</span>
            <strong>
              {analysisValue(identity.intersection_node)}
            </strong>
          </div>

          <div>
            <span>maneuver coordinate</span>
            <strong>
              {Array.isArray(maneuver.coordinate)
                ? (
                  `${Number(maneuver.coordinate[1]).toFixed(6)}, ` +
                  `${Number(maneuver.coordinate[0]).toFixed(6)}`
                )
                : '—'}
            </strong>
          </div>

          <div>
            <span>incoming bearing</span>
            <strong>
              {typeof maneuver.incoming_bearing === 'number'
                ? `${maneuver.incoming_bearing.toFixed(2)}°`
                : '—'}
            </strong>
          </div>

          <div>
            <span>outgoing bearing</span>
            <strong>
              {typeof maneuver.outgoing_bearing === 'number'
                ? `${maneuver.outgoing_bearing.toFixed(2)}°`
                : '—'}
            </strong>
          </div>

          <div>
            <span>delayed turn</span>
            <strong>{analysisValue(identity.delayed)}</strong>
          </div>
        </div>
      ) : (
        <div className="candidate-analysis-limitation">
          Valhalla's current runtime landmark debug does not expose an
          authoritative maneuver coordinate or incoming/outgoing bearings.
          They are intentionally not reconstructed here.
        </div>
      )}

      {Object.keys(selector).length > 0 && (
        <details className="candidate-selector-details">
          <summary>Engine selection policy</summary>

          <div className="candidate-policy-grid">
            {Object.entries(selector).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <code>{analysisValue(value, 3)}</code>
              </div>
            ))}
          </div>
        </details>
      )}

      <button
        type="button"
        className={
          showCandidatesOnMap
            ? 'candidate-map-toggle active'
            : 'candidate-map-toggle'
        }
        disabled={candidates.length === 0}
        onClick={onToggleCandidatesOnMap}
      >
        <span>
          {showCandidatesOnMap ? 'Hide' : 'Show'}
          {' '}candidate POIs on map
        </span>

        <small>
          Draw the selected maneuver → every engine candidate
        </small>
      </button>

      {candidates.length === 0 ? (
        <div className="empty-state">
          The engine emitted no candidate decisions for this maneuver.
        </div>
      ) : (
        <div className="candidate-decision-list">
          {candidates.map((candidate, index) => {
            const runtimeAssociation =
              candidate.association?.runtime;

            const buildAssociation =
              candidate.association?.build;

            const selectedBuildEvent =
              buildAssociation?.selected_event;

            return (
              <div
                className={
                  `candidate-decision ` +
                  `${candidateStatusClass(candidate.status)}`
                }
                key={
                  `${
                    candidate.poi_id ??
                    candidate.osm_node_id ??
                    candidate.name ??
                    'candidate'
                  }-${index}`
                }
              >
                <div className="candidate-decision-heading">
                  <span className="candidate-rank">
                    {index + 1}
                  </span>

                  <div className="candidate-name">
                    <strong>
                      {candidate.name || 'Unnamed POI'}
                    </strong>

                    <small>
                      {candidate.poi_id
                        ? candidate.poi_id
                        : (
                          candidate.osm_node_id !== null &&
                          candidate.osm_node_id !== undefined
                        )
                          ? `OSM node ${candidate.osm_node_id}`
                          : 'no POI identifier'}
                    </small>
                  </div>

                  <span
                    className={
                      `candidate-status ` +
                      `${candidateStatusClass(candidate.status)}`
                    }
                  >
                    {candidate.status || 'UNKNOWN'}
                  </span>
                </div>

                <div className="candidate-metric-grid">
                  <div>
                    <span>priority</span>
                    <strong>
                      {analysisValue(candidate.priority)}
                    </strong>
                  </div>

                  <div>
                    <span>
                      {engine === 'osrm'
                        ? 'maneuver distance'
                        : 'distance'}
                    </span>
                    <strong>
                      {engine === 'osrm'
                        ? (
                          typeof candidate.maneuver_distance_m ===
                          'number'
                            ? `${
                                candidate.maneuver_distance_m
                                  .toFixed(2)
                              } m`
                            : '—'
                        )
                        : (
                          typeof candidate.distance_m === 'number'
                            ? `${candidate.distance_m.toFixed(2)} m`
                            : '—'
                        )}
                    </strong>
                  </div>

                  <div>
                    <span>coordinate</span>
                    <strong>
                      {candidateCoordinateText(candidate)}
                    </strong>
                  </div>

                  {engine === 'osrm' && (
                    <>
                      <div>
                        <span>route edge role</span>
                        <strong>
                          {candidate.on_incoming &&
                          candidate.on_outgoing
                            ? 'incoming + outgoing'
                            : candidate.on_incoming
                              ? 'incoming'
                              : candidate.on_outgoing
                                ? 'outgoing'
                                : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>perpendicular distance</span>
                        <strong>
                          {typeof candidate.perpendicular_distance_m ===
                          'number'
                            ? `${
                                candidate.perpendicular_distance_m
                                  .toFixed(2)
                              } m`
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>incoming → turn</span>
                        <strong>
                          {typeof candidate
                            .incoming_distance_to_turn_m === 'number'
                            ? `${
                                candidate
                                  .incoming_distance_to_turn_m
                                  .toFixed(2)
                              } m`
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>turn → outgoing</span>
                        <strong>
                          {typeof candidate
                            .outgoing_distance_from_turn_m === 'number'
                            ? `${
                                candidate
                                  .outgoing_distance_from_turn_m
                                  .toFixed(2)
                              } m`
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>incoming perpendicular</span>
                        <strong>
                          {typeof candidate
                            .incoming_perpendicular_distance_m ===
                          'number'
                            ? `${
                                candidate
                                  .incoming_perpendicular_distance_m
                                  .toFixed(2)
                              } m`
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>outgoing perpendicular</span>
                        <strong>
                          {typeof candidate
                            .outgoing_perpendicular_distance_m ===
                          'number'
                            ? `${
                                candidate
                                  .outgoing_perpendicular_distance_m
                                  .toFixed(2)
                              } m`
                            : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>visible</span>
                        <strong>
                          {analysisValue(candidate.visible)}
                        </strong>
                      </div>

                      <div>
                        <span>eligible</span>
                        <strong>
                          {analysisValue(candidate.eligible)}
                        </strong>
                      </div>

                      <div>
                        <span>OSM node</span>
                        <strong>
                          {analysisValue(candidate.osm_node_id)}
                        </strong>
                      </div>
                    </>
                  )}

                  {engine === 'valhalla' && (
                    <>
                      <div>
                        <span>side</span>
                        <strong>
                          {candidate.right === true
                            ? 'right'
                            : candidate.right === false
                              ? 'left'
                              : '—'}
                        </strong>
                      </div>

                      <div>
                        <span>route edge role</span>
                        <strong>
                          {analysisValue(
                            runtimeAssociation?.route_edge_role,
                          )}
                        </strong>
                      </div>
                    </>
                  )}
                </div>

                {engine === 'osrm' && (
                  <div className="candidate-metric-grid">
                    <div>
                      <span>association confidence</span>
                      <strong>
                        {candidate.association_augmented === true
                          ? 'augmented fallback'
                          : candidate.association_augmented === false
                            ? 'normal'
                            : '—'}
                      </strong>
                    </div>

                    <div>
                      <span>incoming association</span>
                      <strong>
                        {!candidate.on_incoming
                          ? '—'
                          : candidate.incoming_association_augmented === true
                            ? 'augmented'
                            : candidate.incoming_association_augmented === false
                              ? 'normal'
                              : 'unknown'}
                      </strong>
                    </div>

                    <div>
                      <span>outgoing association</span>
                      <strong>
                        {!candidate.on_outgoing
                          ? '—'
                          : candidate.outgoing_association_augmented === true
                            ? 'augmented'
                            : candidate.outgoing_association_augmented === false
                              ? 'normal'
                              : 'unknown'}
                      </strong>
                    </div>
                  </div>
                )}

                {candidate.reason && (
                  <div className="candidate-reason">
                    <strong>Decision reason</strong>
                    <span>{candidate.reason}</span>
                  </div>
                )}

                {(candidate.rejection_reasons?.length ?? 0) > 0 && (
                  <div className="candidate-structured-reasons">
                    {(candidate.rejection_reasons ?? []).map(
                      (reason, reasonIndex) => (
                        <code
                          key={
                            `${
                              reason.code ?? 'reason'
                            }-${reasonIndex}`
                          }
                        >
                          {reason.code || 'rejection'}

                          {reason.actual !== undefined
                            ? (
                              ` · actual=${
                                analysisValue(
                                  reason.actual,
                                  3,
                                )
                              }`
                            )
                            : ''}

                          {reason.operator
                            ? ` ${reason.operator}`
                            : ''}

                          {reason.threshold !== undefined
                            ? (
                              ` ${
                                analysisValue(
                                  reason.threshold,
                                  3,
                                )
                              }`
                            )
                            : ''}

                          {reason.unit
                            ? ` ${reason.unit}`
                            : ''}
                        </code>
                      ),
                    )}
                  </div>
                )}

                {engine === 'valhalla' &&
                  runtimeAssociation && (
                    <details className="candidate-association-details">
                      <summary>
                        Route / build association
                        {buildAssociation?.matched
                          ? (
                            ` · MATCHED (${
                              buildAssociation.match_kind ??
                              'unknown'
                            })`
                          )
                          : ' · UNMATCHED'}
                      </summary>

                      <div className="candidate-association-grid">
                        <div>
                          <span>runtime graph_id</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation.graph_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>directed edge</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .directed_edge_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>way_id</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation.way_id,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>trip edge node</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .trip_edge_node_index,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>distance along edge</span>
                          <code>
                            {typeof runtimeAssociation
                              .distance_along_used_edge_m ===
                            'number'
                              ? (
                                `${
                                  runtimeAssociation
                                    .distance_along_used_edge_m
                                    .toFixed(3)
                                } m`
                              )
                              : '—'}
                          </code>
                        </div>

                        <div>
                          <span>full-edge fraction</span>
                          <code>
                            {analysisValue(
                              runtimeAssociation
                                .fraction_along_full_edge,
                              4,
                            )}
                          </code>
                        </div>

                        <div>
                          <span>build match</span>
                          <code>
                            {buildAssociation?.matched
                              ? (
                                buildAssociation.match_kind ??
                                'matched'
                              )
                              : 'unmatched'}
                          </code>
                        </div>

                        <div>
                          <span>POI build events</span>
                          <code>
                            {analysisValue(
                              buildAssociation
                                ?.poi_event_count,
                            )}
                          </code>
                        </div>
                      </div>

                      {selectedBuildEvent && (
                        <div className="candidate-build-selected">
                          <strong>
                            Selected Mjolnir association
                          </strong>

                          <span>
                            {selectedBuildEvent.road_name ||
                              'unnamed road'}

                            {typeof selectedBuildEvent
                              .distance_m === 'number'
                              ? (
                                ` · ${
                                  selectedBuildEvent
                                    .distance_m
                                    .toFixed(3)
                                } m`
                              )
                              : ''}
                          </span>

                          <small>
                            edge{' '}
                            {analysisValue(
                              selectedBuildEvent.edge
                                ?.graph_id,
                            )}
                            {' · opposing '}
                            {analysisValue(
                              selectedBuildEvent
                                .opposing_edge
                                ?.graph_id,
                            )}
                          </small>

                          {selectedBuildEvent.reason && (
                            <small>
                              {selectedBuildEvent.reason}
                            </small>
                          )}
                        </div>
                      )}

                      {(buildAssociation?.warnings?.length ??
                        0) > 0 && (
                        <div className="candidate-association-warnings">
                          {(buildAssociation?.warnings ?? [])
                            .map(
                              (warning, warningIndex) => (
                                <span key={warningIndex}>
                                  {warning}
                                </span>
                              ),
                            )}
                        </div>
                      )}
                    </details>
                  )}
              </div>
            );
          })}
        </div>
      )}

      {(analysis.warnings?.length ?? 0) > 0 && (
        <div className="candidate-analysis-warnings">
          {(analysis.warnings ?? []).map(
            (warning, index) => (
              <span key={index}>{warning}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
}
