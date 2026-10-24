import { PanelSection } from '../DashboardLayout';

export interface RouteComparisonMetrics {
  valhallaDistanceKm: number | null;
  valhallaDurationMin: number | null;
  osrmDistanceKm: number | null;
  osrmDurationMin: number | null;
  distanceDeltaKm: number | null;
  timeDeltaMin: number | null;
  distanceDeltaPct: number | null;
  timeDeltaPct: number | null;
}

export interface RouteComparisonSummaryProps {
  hasRoute: boolean;
  comparison: RouteComparisonMetrics;
  maneuverCount: number;
  osrmStepCount: number;
  onOpenComparison: () => void;
}

export function RouteComparisonSummary({
  hasRoute,
  comparison,
  maneuverCount,
  osrmStepCount,
  onOpenComparison,
}: RouteComparisonSummaryProps) {
  return (
    <PanelSection title="Route comparison" meta={hasRoute ? 'Latest run' : 'No route'} className="right-route-summary">
      {!hasRoute ? (
        <div className="empty-state">Run a route to compare engine distance, duration and guidance.</div>
      ) : (
        <>
          <div className="engine-summary-grid">
            <div className="engine-summary valhalla"><span>Valhalla</span><strong>{comparison.valhallaDistanceKm === null ? '—' : `${comparison.valhallaDistanceKm.toFixed(2)} km`}</strong><small>{comparison.valhallaDurationMin === null ? 'Time unavailable' : `${comparison.valhallaDurationMin.toFixed(1)} min`} · {maneuverCount} maneuvers</small></div>
            <div className="engine-summary osrm"><span>OSRM</span><strong>{comparison.osrmDistanceKm === null ? '—' : `${comparison.osrmDistanceKm.toFixed(2)} km`}</strong><small>{comparison.osrmDurationMin === null ? 'Time unavailable' : `${comparison.osrmDurationMin.toFixed(1)} min`} · {osrmStepCount} steps</small></div>
          </div>
          <button className="text-action" onClick={onOpenComparison}>Open full comparison</button>
        </>
      )}
    </PanelSection>
  );
}
