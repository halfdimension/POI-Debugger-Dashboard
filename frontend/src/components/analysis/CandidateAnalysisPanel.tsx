import type { CandidateAnalysis, CandidateAnalysisManeuver } from '../../types';
import type { ManeuverView, OsrmStepView } from '../inspection/viewModels';
import { CandidateDecisionList } from './CandidateDecisionList';

export interface CandidateAnalysisPanelProps {
  selectedManeuver: ManeuverView | null;
  selectedOsrmStep: OsrmStepView | null;
  valhallaAnalysis: CandidateAnalysis | null;
  osrmAnalysis: CandidateAnalysis | null;
  selectedValhallaAnalysis: CandidateAnalysisManeuver | null;
  selectedOsrmAnalysis: CandidateAnalysisManeuver | null;
  showCandidatesOnMap: boolean;
  onToggleCandidatesOnMap: () => void;
}

export function CandidateAnalysisPanel({
  selectedManeuver,
  selectedOsrmStep,
  valhallaAnalysis,
  osrmAnalysis,
  selectedValhallaAnalysis,
  selectedOsrmAnalysis,
  showCandidatesOnMap,
  onToggleCandidatesOnMap,
}: CandidateAnalysisPanelProps) {
  return (
    <section className="card candidate-analysis-card">
      <div className="maneuver-heading">
        <h2>Candidate Analysis</h2>
        {selectedManeuver ? (
          <span>Valhalla · Odin #{selectedManeuver.index + 1}</span>
        ) : selectedOsrmStep ? (
          <span>OSRM · step #{selectedOsrmStep.index + 1}</span>
        ) : (
          <span>authoritative engine evidence</span>
        )}
      </div>

      {!selectedManeuver && !selectedOsrmStep ? (
        <div className="empty-state">
          Click a Valhalla maneuver or an OSRM step to inspect the candidates actually considered by that engine.
        </div>
      ) : selectedManeuver ? (
        !valhallaAnalysis ? (
          <div className="empty-state">No Valhalla candidate-analysis response was returned.</div>
        ) : !valhallaAnalysis.available ? (
          <div className="candidate-analysis-error">{valhallaAnalysis.error ?? 'Valhalla candidate analysis is unavailable.'}</div>
        ) : !selectedValhallaAnalysis ? (
          <div className="empty-state">
            This Odin maneuver has no embedded authoritative landmark_debug candidate record. No candidate decision is inferred by the frontend.
          </div>
        ) : (
          <CandidateDecisionList engine="valhalla" analysis={selectedValhallaAnalysis} showCandidatesOnMap={showCandidatesOnMap} onToggleCandidatesOnMap={onToggleCandidatesOnMap} />
        )
      ) : selectedOsrmStep ? (
        !osrmAnalysis ? (
          <div className="empty-state">No OSRM candidate-analysis response was returned.</div>
        ) : !osrmAnalysis.available ? (
          <div className="candidate-analysis-error">{osrmAnalysis.error ?? 'OSRM candidate analysis is unavailable.'}</div>
        ) : !selectedOsrmAnalysis ? (
          <div className="empty-state">
            This OSRM step has no authoritative turn_id candidate record. Depart/arrive steps normally do not carry a guidance turn_id.
          </div>
        ) : (
          <CandidateDecisionList engine="osrm" analysis={selectedOsrmAnalysis} showCandidatesOnMap={showCandidatesOnMap} onToggleCandidatesOnMap={onToggleCandidatesOnMap} />
        )
      ) : null}

      {selectedManeuver && (valhallaAnalysis?.limitations?.length ?? 0) > 0 ? (
        <details className="candidate-analysis-limitations">
          <summary>Valhalla diagnostic limitations</summary>
          {(valhallaAnalysis?.limitations ?? []).map((limitation, index) => <p key={index}>{limitation}</p>)}
        </details>
      ) : null}
    </section>
  );
}
