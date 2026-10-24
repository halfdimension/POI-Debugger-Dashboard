import type { OsrmRouteResponse, ValhallaRouteResponse } from '../../types';

export interface RawResponseInspectionProps {
  valhallaRoute: ValhallaRouteResponse | null;
  osrmRoute: OsrmRouteResponse | null;
}

export function RawResponseCards({ valhallaRoute, osrmRoute }: RawResponseInspectionProps) {
  return (
    <>
      <details className="card raw-card">
        <summary>Raw Valhalla JSON</summary>
        <pre>{valhallaRoute ? JSON.stringify(valhallaRoute, null, 2) : 'No Valhalla route response yet.'}</pre>
      </details>
      <details className="card raw-card">
        <summary>Raw OSRM JSON</summary>
        <pre>{osrmRoute ? JSON.stringify(osrmRoute, null, 2) : 'No OSRM route response yet.'}</pre>
      </details>
    </>
  );
}

export function RawResponseInspection({ valhallaRoute, osrmRoute }: RawResponseInspectionProps) {
  return (
    <div className="analysis-columns raw-response-grid">
      <section><div className="analysis-column-heading"><h3>Valhalla response</h3><span>{valhallaRoute ? 'Available' : 'Empty'}</span></div><pre>{valhallaRoute ? JSON.stringify(valhallaRoute, null, 2) : 'No Valhalla route response yet.'}</pre></section>
      <section><div className="analysis-column-heading"><h3>OSRM response</h3><span>{osrmRoute ? 'Available' : 'Empty'}</span></div><pre>{osrmRoute ? JSON.stringify(osrmRoute, null, 2) : 'No OSRM route response yet.'}</pre></section>
    </div>
  );
}
