import type { ReactNode } from 'react';
import type { CandidateAnalysisManeuver, OsrmRouteResponse, OsrmStep, ValhallaRouteResponse } from '../../types';
import type { AnalysisTab } from '../../layoutState';
import type { RouteComparisonMetrics } from '../route/RouteComparisonSummary';
import type { ManeuverView, OsrmGuidanceEntry, OsrmPassByEventView, OsrmStepView } from '../inspection/viewModels';
import { CandidateDecisionList } from './CandidateDecisionList';
import { RawResponseInspection } from './RawResponseInspection';

export interface AnalysisTabContentProps {
  activeTab: AnalysisTab;
  comparison: RouteComparisonMetrics;
  route: ValhallaRouteResponse | null;
  osrmRoute: OsrmRouteResponse | null;
  maneuverViews: ManeuverView[];
  osrmStepViews: OsrmStepView[];
  osrmGuidanceEntries: OsrmGuidanceEntry[];
  osrmGuidanceExactOrdering: boolean;
  selectedManeuverIndex: number | null;
  selectedOsrmStepIndex: number | null;
  selectedManeuver: ManeuverView | null;
  selectedOsrmStep: OsrmStepView | null;
  selectedOsrmPassBy: OsrmPassByEventView | null;
  selectedValhallaAnalysis: CandidateAnalysisManeuver | null;
  selectedOsrmAnalysis: CandidateAnalysisManeuver | null;
  showCandidatesOnMap: boolean;
  testcaseWorkspace: ReactNode;
  getOsrmInstruction: (step: OsrmStep) => string;
  onFocusManeuver: (item: ManeuverView) => void;
  onFocusOsrmStep: (item: OsrmStepView) => void;
  onFocusOsrmPassBy: (item: OsrmPassByEventView) => void;
  onToggleCandidatesOnMap: () => void;
}

function fmtSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function AnalysisTabContent({
  activeTab, comparison: routeComparison, route, osrmRoute,
  maneuverViews, osrmStepViews, selectedManeuverIndex, selectedOsrmStepIndex,
  osrmGuidanceEntries, osrmGuidanceExactOrdering,
  selectedManeuver, selectedOsrmStep: selectedOsrmStepView,
  selectedOsrmPassBy,
  selectedValhallaAnalysis: selectedValhallaCandidateAnalysis,
  selectedOsrmAnalysis: selectedOsrmCandidateAnalysis,
  showCandidatesOnMap: showCandidateMap, testcaseWorkspace,
  getOsrmInstruction: osrmInstructionText, onFocusManeuver: focusManeuver,
  onFocusOsrmStep: focusOsrmStep, onToggleCandidatesOnMap,
  onFocusOsrmPassBy: focusOsrmPassBy,
}: AnalysisTabContentProps) {
  const layout = { activeAnalysisTab: activeTab };
  return (
    <>
      {layout.activeAnalysisTab === 'comparison' && (
        <div className="analysis-comparison">
          <div className="analysis-metric"><span>Valhalla distance</span><strong>{routeComparison.valhallaDistanceKm === null ? '—' : `${routeComparison.valhallaDistanceKm.toFixed(2)} km`}</strong></div>
          <div className="analysis-metric"><span>OSRM distance</span><strong>{routeComparison.osrmDistanceKm === null ? '—' : `${routeComparison.osrmDistanceKm.toFixed(2)} km`}</strong></div>
          <div className="analysis-metric"><span>Distance delta</span><strong>{routeComparison.distanceDeltaKm === null ? '—' : `${fmtSigned(routeComparison.distanceDeltaKm)} km`}</strong></div>
          <div className="analysis-metric"><span>Time delta</span><strong>{routeComparison.timeDeltaMin === null ? '—' : `${fmtSigned(routeComparison.timeDeltaMin, 1)} min`}</strong></div>
          {!route && !osrmRoute && <div className="analysis-empty">Run a route comparison to populate engine metrics.</div>}
        </div>
      )}
  
      {layout.activeAnalysisTab === 'maneuvers' && (
        <div className="analysis-columns">
          <section><div className="analysis-column-heading"><h3>Valhalla / Odin</h3><span>{maneuverViews.length} maneuvers</span></div>{maneuverViews.length === 0 ? <div className="analysis-empty">No Valhalla maneuvers yet.</div> : <ol className="maneuver-list">{maneuverViews.map((item) => <li key={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}><button className="maneuver-button" onClick={() => focusManeuver(item)}><strong>{item.maneuver.instruction ?? 'Unnamed maneuver'}</strong><small>{typeof item.maneuver.length === 'number' ? `${item.maneuver.length.toFixed(2)} km` : ''}{item.coordinate ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}` : ''}</small></button></li>)}</ol>}</section>
          <section><div className="analysis-column-heading"><h3>OSRM</h3><span>{osrmStepViews.length} steps</span></div>{osrmStepViews.length === 0 ? <div className="analysis-empty">No OSRM steps yet.</div> : <ol className="maneuver-list osrm-maneuver-list">{osrmStepViews.map((item) => <li key={item.index} className={selectedOsrmStepIndex === item.index ? 'selected' : ''}><button className="osrm-step" onClick={() => focusOsrmStep(item)}><strong>{osrmInstructionText(item.step)}</strong><small>{typeof item.step.distance === 'number' ? `${item.step.distance.toFixed(1)} m` : ''}{item.coordinate ? ` · ${item.coordinate[1].toFixed(6)}, ${item.coordinate[0].toFixed(6)}` : ''}</small></button></li>)}</ol>}
            <div className="analysis-column-heading guidance-heading"><h3>Unified OSRM guidance</h3><span>{osrmGuidanceEntries.length} entries</span></div>
            {!osrmGuidanceExactOrdering && osrmGuidanceEntries.length > 0 && <div className="analysis-empty guidance-warning">Exact interleaving is unavailable for entries without route-position data; no position was invented.</div>}
            <ol className="maneuver-list osrm-guidance-list">{osrmGuidanceEntries.map((entry) => <li key={entry.key} className={`${entry.category} ${entry.passBy?.key === selectedOsrmPassBy?.key ? 'selected' : ''}`}><button className="osrm-step" onClick={() => entry.passBy ? focusOsrmPassBy(entry.passBy) : entry.step && focusOsrmStep(entry.step)}><strong>{entry.instruction}</strong><span className={`narration-mini-badge ${entry.category}`}>{entry.category.replace('landmark-', '').replace('-', ' ')}</span><small>{entry.step ? `OSRM step ${entry.step.index + 1}` : `Pass-by event ${entry.passBy!.index + 1}`}{entry.routeDistanceM === null ? ' · route position unavailable' : ` · ${entry.routeDistanceM.toFixed(1)} m from route start`}{entry.coordinate ? ` · ${entry.coordinate[1].toFixed(6)}, ${entry.coordinate[0].toFixed(6)}` : ''}</small></button></li>)}</ol>
          </section>
        </div>
      )}
  
      {layout.activeAnalysisTab === 'candidates' && (
        <div className="analysis-columns candidate-overview">
          <section><div className="analysis-column-heading"><h3>Valhalla evidence</h3><span>Authoritative only</span></div>{!selectedManeuver ? <div className="analysis-empty">Select an Odin maneuver to inspect its embedded landmark_debug record.</div> : !selectedValhallaCandidateAnalysis ? <div className="analysis-empty">No authoritative candidate record exists for this maneuver. The UI does not infer a selection.</div> : <CandidateDecisionList engine="valhalla" analysis={selectedValhallaCandidateAnalysis} showCandidatesOnMap={showCandidateMap} onToggleCandidatesOnMap={onToggleCandidatesOnMap} />}</section>
          <section><div className="analysis-column-heading"><h3>OSRM evidence</h3><span>Authoritative only</span></div>{selectedOsrmPassBy ? <div className="analysis-empty">This is an authoritative engine pass-by event. Candidate extraction, rejected candidates, and turn_id selection diagnostics are not exposed for pass-by events.</div> : !selectedOsrmStepView ? <div className="analysis-empty">Select an OSRM step to inspect its turn_id candidate record.</div> : !selectedOsrmCandidateAnalysis ? <div className="analysis-empty">No authoritative turn_id candidate record exists for this step.</div> : <CandidateDecisionList engine="osrm" analysis={selectedOsrmCandidateAnalysis} showCandidatesOnMap={showCandidateMap} onToggleCandidatesOnMap={onToggleCandidatesOnMap} />}</section>
        </div>
      )}
  
      {layout.activeAnalysisTab === 'scenarios' && (
        <div className="analysis-testcases">{testcaseWorkspace}</div>
      )}
  
      {layout.activeAnalysisTab === 'raw' && (
        <RawResponseInspection valhallaRoute={route} osrmRoute={osrmRoute} />
      )}
    </>
  );
}
