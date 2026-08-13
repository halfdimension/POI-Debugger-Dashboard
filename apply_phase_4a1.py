#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path.cwd()
PHASE_FILE = ROOT / "PHASE"
APP = ROOT / "frontend/src/App.tsx"
CSS = ROOT / "frontend/src/styles.css"
README = ROOT / "README.md"
GITIGNORE = ROOT / ".gitignore"
BACKUP = ROOT / ".phase4a1_backup"


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def require_text(path: Path, needle: str) -> str:
    if not path.exists():
        fail(f"Missing required file: {path.relative_to(ROOT)}")
    text = path.read_text()
    if needle not in text:
        fail(f"{path.relative_to(ROOT)} is not the expected Phase 4A baseline. Missing anchor: {needle!r}")
    return text


if not PHASE_FILE.exists():
    fail("PHASE file is missing")

phase = PHASE_FILE.read_text().strip()
if phase == "4A.1":
    print("Phase 4A.1 is already applied.")
    raise SystemExit(0)
if phase != "4A":
    fail(f"Expected PHASE=4A, found {phase!r}")

app = require_text(APP, "const narrationEvidenceByManeuver = useMemo(() => {")
require_text(APP, "map.addSource('narration-poi', { type: 'geojson', data: EMPTY_FC });")
require_text(APP, "Phase 4A · external Odin narration ↔ source POI verification")
css = require_text(CSS, "/* ===== Phase 4A: external narration ↔ POI verification ===== */")

# Backup only files touched by this phase.
if BACKUP.exists():
    shutil.rmtree(BACKUP)
for path in [PHASE_FILE, APP, CSS, README, GITIGNORE]:
    if path.exists():
        destination = BACKUP / path.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)

# ---------------------------------------------------------------------------
# App.tsx
# ---------------------------------------------------------------------------

old = '''type NarrationPoiEvidence = {
  feature: GeoJSON.Feature<GeoJSON.Point>;
  coordinate: LngLat;
  distanceM: number | null;
  priority: number | null;
  name: string;
  landmarkType: string;
  poiId: string;
  sourceNodeId: string;
  evidence: 'strong' | 'ambiguous';
  matchedInstruction: string;
};
'''
new = old + '''
type RouteNarrationPoi = {
  key: string;
  evidence: NarrationPoiEvidence;
  maneuverIndexes: number[];
  primaryManeuverIndex: number;
};
'''
if old not in app:
    fail("Could not find NarrationPoiEvidence type")
app = app.replace(old, new, 1)

anchor = '''function hasStrongLandmarkCue(instruction: string, name: string): boolean {
  const normalizedInstruction = ` ${normalizeNarrationText(instruction)} `;
  const normalizedName = normalizeNarrationText(name);
  if (!normalizedName) return false;
  return normalizedInstruction.includes(` at ${normalizedName} `) ||
    normalizedInstruction.includes(` at the ${normalizedName} `);
}
'''
insert = anchor + '''
function narrationPoiKey(item: NarrationPoiEvidence): string {
  if (item.poiId) return `poi:${item.poiId}`;
  if (item.sourceNodeId) return `node:${item.sourceNodeId}`;
  return `name:${normalizeNarrationText(item.name)}|${item.coordinate[0].toFixed(7)}|${item.coordinate[1].toFixed(7)}`;
}
'''
if anchor not in app:
    fail("Could not find hasStrongLandmarkCue helper")
app = app.replace(anchor, insert, 1)

anchor = '''  const selectedNarrationEvidence = useMemo(
    () => selectedManeuverIndex === null ? [] : narrationEvidenceByManeuver.get(selectedManeuverIndex) ?? [],
    [narrationEvidenceByManeuver, selectedManeuverIndex],
  );

  const primaryNarrationEvidence = selectedNarrationEvidence[0] ?? null;
'''
replacement = '''  const routeNarrationPois = useMemo<RouteNarrationPoi[]>(() => {
    const grouped = new Map<string, RouteNarrationPoi>();

    for (const item of maneuverViews) {
      // Phase 4A sorts evidence strongest-first. For the route-wide map layer we
      // intentionally keep one primary source-POI match per maneuver, then
      // deduplicate the same POI across maneuvers.
      const primary = (narrationEvidenceByManeuver.get(item.index) ?? [])[0];
      if (!primary) continue;

      const key = narrationPoiKey(primary);
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          key,
          evidence: primary,
          maneuverIndexes: [item.index],
          primaryManeuverIndex: item.index,
        });
        continue;
      }

      if (!existing.maneuverIndexes.includes(item.index)) {
        existing.maneuverIndexes.push(item.index);
      }

      // If the same source POI is only an ambiguous match on one maneuver but
      // a strong landmark-style match on another, represent the route-wide POI
      // using the stronger evidence.
      if (existing.evidence.evidence === 'ambiguous' && primary.evidence === 'strong') {
        existing.evidence = primary;
        existing.primaryManeuverIndex = item.index;
      }
    }

    return Array.from(grouped.values()).sort((a, b) => {
      if (a.evidence.evidence !== b.evidence.evidence) {
        return a.evidence.evidence === 'strong' ? -1 : 1;
      }
      return a.primaryManeuverIndex - b.primaryManeuverIndex;
    });
  }, [maneuverViews, narrationEvidenceByManeuver]);

  const routeNarrationStrongCount = useMemo(
    () => routeNarrationPois.filter((item) => item.evidence.evidence === 'strong').length,
    [routeNarrationPois],
  );

  const routeNarrationAmbiguousCount = routeNarrationPois.length - routeNarrationStrongCount;

  const selectedNarrationEvidence = useMemo(
    () => selectedManeuverIndex === null ? [] : narrationEvidenceByManeuver.get(selectedManeuverIndex) ?? [],
    [narrationEvidenceByManeuver, selectedManeuverIndex],
  );

  const primaryNarrationEvidence = selectedNarrationEvidence[0] ?? null;
'''
if anchor not in app:
    fail("Could not find selected narration evidence anchor")
app = app.replace(anchor, replacement, 1)

# Add persistent route-wide narration source/layers before the selected narration POI layer.
anchor = '''      map.addSource('narration-poi', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'narration-poi',
        type: 'circle',
        source: 'narration-poi',
        paint: {
          'circle-radius': 13,
          'circle-stroke-width': 4,
          'circle-stroke-color': '#0f172a',
          'circle-color': '#22c55e',
          'circle-opacity': 0.85,
        },
      });
'''
replacement = '''      map.addSource('route-narration-pois', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'route-narration-pois-halo',
        type: 'circle',
        source: 'route-narration-pois',
        paint: {
          'circle-radius': ['case', ['==', ['get', '_route_evidence'], 'strong'], 16, 13],
          'circle-color': ['case', ['==', ['get', '_route_evidence'], 'strong'], '#22c55e', '#f59e0b'],
          'circle-opacity': 0.22,
          'circle-stroke-width': 0,
        },
      });
      map.addLayer({
        id: 'route-narration-pois',
        type: 'circle',
        source: 'route-narration-pois',
        paint: {
          'circle-radius': ['case', ['==', ['get', '_route_evidence'], 'strong'], 10, 8],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
          'circle-color': ['case', ['==', ['get', '_route_evidence'], 'strong'], '#16a34a', '#f59e0b'],
          'circle-opacity': 0.98,
        },
      });

      map.addSource('narration-poi', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'narration-poi',
        type: 'circle',
        source: 'narration-poi',
        paint: {
          'circle-radius': 14,
          'circle-stroke-width': 4,
          'circle-stroke-color': '#0f172a',
          'circle-color': ['case', ['==', ['get', '_narration_evidence'], 'strong'], '#22c55e', '#f59e0b'],
          'circle-opacity': 0.82,
        },
      });
'''
if anchor not in app:
    fail("Could not find narration-poi map layer anchor")
app = app.replace(anchor, replacement, 1)

# Add special route narration marker click handler and retain ordinary popup behavior.
anchor = '''      map.on('click', 'pois', showPoiPopup);
      map.on('click', 'selected-poi', showPoiPopup);
      map.on('click', 'nearby-pois', showPoiPopup);
      map.on('click', 'narration-poi', showPoiPopup);

      map.on('click', 'maneuver-points', (event) => {
'''
replacement = '''      map.on('click', 'pois', showPoiPopup);
      map.on('click', 'selected-poi', showPoiPopup);
      map.on('click', 'nearby-pois', showPoiPopup);
      map.on('click', 'narration-poi', showPoiPopup);

      map.on('click', 'route-narration-pois', (event) => {
        const rawFeature = event.features?.[0];
        if (!rawFeature || rawFeature.geometry.type !== 'Point') return;

        const feature = rawFeature as GeoJSON.Feature<GeoJSON.Point>;
        const coordinates = feature.geometry.coordinates.slice() as LngLat;
        const maneuverIndex = Number(feature.properties?._primary_maneuver_index);
        if (Number.isFinite(maneuverIndex)) {
          setSelectedManeuverIndex(maneuverIndex);
          window.setTimeout(() => {
            document.querySelector(`[data-maneuver-index="${maneuverIndex}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 80);
        }

        setSelectedPoi(feature);
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 17), essential: true });
        new maplibregl.Popup({ maxWidth: '420px' })
          .setLngLat(coordinates)
          .setHTML(poiPopupHtml(feature.properties ?? {}))
          .addTo(map);
      });

      map.on('click', 'maneuver-points', (event) => {
'''
if anchor not in app:
    fail("Could not find map click handler anchor")
app = app.replace(anchor, replacement, 1)

# Add route narration layer to interactive cursor and generic click suppression lists.
old = "      for (const layerId of ['pois', 'selected-poi', 'nearby-pois', 'narration-poi', 'maneuver-points']) {"
new = "      for (const layerId of ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points']) {"
if old not in app:
    fail("Could not find interactive layer list")
app = app.replace(old, new, 1)

old = "        const candidateLayers = ['pois', 'selected-poi', 'nearby-pois', 'narration-poi', 'maneuver-points', 'route-points']"
new = "        const candidateLayers = ['pois', 'selected-poi', 'nearby-pois', 'route-narration-pois', 'narration-poi', 'maneuver-points', 'route-points']"
if old not in app:
    fail("Could not find map pick suppression layer list")
app = app.replace(old, new, 1)

# Add persistent route-wide GeoJSON source updater before selected narration updater.
anchor = '''  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('narration-poi') as maplibregl.GeoJSONSource | undefined;
    if (!primaryNarrationEvidence) {
      source?.setData(EMPTY_FC);
      return;
    }
'''
insert = '''  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const features: GeoJSON.Feature<GeoJSON.Point>[] = routeNarrationPois.map((item) => ({
      ...item.evidence.feature,
      properties: {
        ...(item.evidence.feature.properties ?? {}),
        _route_evidence: item.evidence.evidence,
        _primary_maneuver_index: item.primaryManeuverIndex,
        _maneuver_indexes: item.maneuverIndexes.map((index) => index + 1).join(', '),
        _matched_instruction: item.evidence.matchedInstruction,
        _debug_distance_m: item.evidence.distanceM === null ? '' : item.evidence.distanceM.toFixed(1),
      },
    }));

    const source = map.getSource('route-narration-pois') as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features });
  }, [routeNarrationPois]);

''' + anchor
if anchor not in app:
    fail("Could not find selected narration source updater")
app = app.replace(anchor, insert, 1)

# Cross-link helper for route-wide overlay item.
anchor = '''  function focusNarrationEvidence(item: NarrationPoiEvidence) {
    focusPoiFeature(item.feature, item.distanceM ?? undefined);
  }

  function resetPoiFilters() {
'''
replacement = '''  function focusNarrationEvidence(item: NarrationPoiEvidence) {
    focusPoiFeature(item.feature, item.distanceM ?? undefined);
  }

  function focusRouteNarrationPoi(item: RouteNarrationPoi) {
    setSelectedManeuverIndex(item.primaryManeuverIndex);
    focusPoiFeature(item.evidence.feature, item.evidence.distanceM ?? undefined);
    window.setTimeout(() => {
      document.querySelector(`[data-maneuver-index="${item.primaryManeuverIndex}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function resetPoiFilters() {
'''
if anchor not in app:
    fail("Could not find focusNarrationEvidence helper")
app = app.replace(anchor, replacement, 1)

# Phase label.
app = app.replace(
    '<div className="subtitle">Phase 4A · external Odin narration ↔ source POI verification</div>',
    '<div className="subtitle">Phase 4A.1 · route-wide narration POI highlighting</div>',
    1,
)
app = app.replace('<span>Phase 4A</span>', '<span>Phase 4A.1</span>', 1)

# Add legend + compact route-wide observed POI overlay directly on the map.
anchor = '''          </div>
          <div ref={mapContainer} className="map" />
        </section>
'''
replacement = '''          </div>
          <div ref={mapContainer} className="map" />

          <div className="landmark-map-legend">
            <div className="landmark-map-legend-title">Map POI evidence</div>
            <span><i className="legend-dot source" />Source POI</span>
            <span><i className="legend-dot strong" />Observed in Odin narration</span>
            <span><i className="legend-dot ambiguous" />Ambiguous name match</span>
            <span><i className="legend-dot selected" />Currently inspected match</span>
          </div>

          {route && (
            <div className="route-narration-overlay">
              <div className="route-narration-overlay-heading">
                <strong>Narration POIs on this route</strong>
                <span>{routeNarrationStrongCount} observed · {routeNarrationAmbiguousCount} ambiguous</span>
              </div>
              {routeNarrationPois.length === 0 ? (
                <div className="route-narration-empty">No loaded source POI name was correlated with this route's Odin narration.</div>
              ) : (
                <div className="route-narration-overlay-list">
                  {routeNarrationPois.slice(0, 8).map((item) => (
                    <button
                      key={item.key}
                      className={`route-narration-overlay-item ${item.evidence.evidence}`}
                      onClick={() => focusRouteNarrationPoi(item)}
                      title={item.evidence.matchedInstruction}
                    >
                      <i />
                      <span>
                        <strong>{item.evidence.name}</strong>
                        <small>
                          maneuver {item.primaryManeuverIndex + 1} · {item.evidence.poiId || item.evidence.sourceNodeId || 'source POI'}
                        </small>
                      </span>
                    </button>
                  ))}
                  {routeNarrationPois.length > 8 && (
                    <div className="route-narration-more">+{routeNarrationPois.length - 8} more narration match(es)</div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
'''
if anchor not in app:
    fail("Could not find map section render anchor")
app = app.replace(anchor, replacement, 1)

# Add DOM anchor for marker -> maneuver scrolling.
old = "                  <li key={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}>"
new = "                  <li key={item.index} data-maneuver-index={item.index} className={selectedManeuverIndex === item.index ? 'selected' : ''}>"
if old not in app:
    fail("Could not find maneuver list item anchor")
app = app.replace(old, new, 1)

APP.write_text(app)

# ---------------------------------------------------------------------------
# styles.css (append only)
# ---------------------------------------------------------------------------
marker = "/* ===== Phase 4A.1: route-wide narration POI map highlighting ===== */"
if marker in css:
    fail("Phase 4A.1 CSS already exists unexpectedly")

css_addition = r'''

/* ===== Phase 4A.1: route-wide narration POI map highlighting ===== */
.landmark-map-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 4;
  display: grid;
  gap: 5px;
  min-width: 185px;
  padding: 8px 10px;
  border: 1px solid rgba(15, 23, 42, .18);
  border-radius: 8px;
  background: rgba(255, 255, 255, .94);
  box-shadow: 0 3px 12px rgba(15, 23, 42, .12);
  backdrop-filter: blur(4px);
  pointer-events: none;
}
.landmark-map-legend-title {
  margin-bottom: 1px;
  color: #0f172a;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.landmark-map-legend span {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #334155;
  font-size: 9px;
}
.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  border: 2px solid white;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, .35);
}
.legend-dot.source { background: #8b5cf6; }
.legend-dot.strong { width: 14px; height: 14px; background: #16a34a; box-shadow: 0 0 0 4px rgba(34, 197, 94, .18); }
.legend-dot.ambiguous { width: 13px; height: 13px; background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, .18); }
.legend-dot.selected { width: 14px; height: 14px; background: #22c55e; border-color: #0f172a; box-shadow: none; }

.route-narration-overlay {
  position: absolute;
  top: 60px;
  left: 12px;
  z-index: 4;
  width: min(310px, calc(100% - 80px));
  max-height: 250px;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, .16);
  border-radius: 9px;
  background: rgba(255, 255, 255, .95);
  box-shadow: 0 5px 18px rgba(15, 23, 42, .15);
  backdrop-filter: blur(5px);
}
.route-narration-overlay-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding: 8px 9px;
  border-bottom: 1px solid #e2e8f0;
}
.route-narration-overlay-heading strong { color: #0f172a; font-size: 10px; }
.route-narration-overlay-heading span { color: #64748b; font-size: 8px; white-space: nowrap; }
.route-narration-empty { padding: 9px; color: #64748b; font-size: 9px; line-height: 1.35; }
.route-narration-overlay-list { max-height: 205px; overflow-y: auto; padding: 5px; }
.route-narration-overlay-item {
  width: 100%;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}
.route-narration-overlay-item:hover { background: #f8fafc; }
.route-narration-overlay-item > i {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  border: 2px solid white;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, .28);
}
.route-narration-overlay-item.strong > i { background: #16a34a; box-shadow: 0 0 0 3px rgba(34, 197, 94, .16); }
.route-narration-overlay-item.ambiguous > i { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, .14); }
.route-narration-overlay-item > span { min-width: 0; display: grid; gap: 1px; }
.route-narration-overlay-item strong { overflow: hidden; color: #0f172a; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.route-narration-overlay-item small { overflow: hidden; color: #64748b; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.route-narration-more { padding: 5px 7px 7px; color: #64748b; font-size: 8px; }

@media (max-width: 760px) {
  .route-narration-overlay { top: 58px; width: min(270px, calc(100% - 75px)); max-height: 190px; }
  .route-narration-overlay-list { max-height: 145px; }
  .landmark-map-legend { min-width: 160px; }
}
'''
CSS.write_text(css.rstrip() + css_addition + "\n")

PHASE_FILE.write_text("4A.1\n")

# Append backup ignore safely without replacing user's existing ignore file.
gitignore = GITIGNORE.read_text() if GITIGNORE.exists() else ""
entry = ".phase4a1_backup/"
if entry not in gitignore.splitlines():
    if gitignore and not gitignore.endswith("\n"):
        gitignore += "\n"
    gitignore += entry + "\n"
GITIGNORE.write_text(gitignore)

readme = README.read_text() if README.exists() else ""
if "## Phase 4A.1 — route-wide narration POI highlighting" not in readme:
    readme = readme.rstrip() + '''

## Phase 4A.1 — route-wide narration POI highlighting

Phase 4A.1 makes Phase 4A evidence visible across the whole route without changing Valhalla.

- Small purple dots remain the loaded source POIs.
- Strong POI names observed in Odin landmark-style narration are persistently highlighted in green.
- Ambiguous source-name matches are persistently highlighted in orange rather than being called selected landmarks.
- The currently inspected narration match receives a larger dark-outlined marker.
- A map legend explains all POI evidence states.
- A compact route overlay lists narration-correlated POIs and their associated maneuver number.
- Clicking a route-wide narration marker or overlay item selects the associated maneuver and zooms to the source POI.
- The same source POI is deduplicated if it appears in multiple maneuvers.

All correlation remains external. The production Valhalla engine, tiles, protobufs and route response are unchanged.
'''
    README.write_text(readme + "\n")

print("Phase 4A.1 applied successfully.")
print("Scope:    dashboard only — no Valhalla engine/PBF/tile/API changes")
print("Added:    persistent route-wide green markers for strong narration-observed POIs")
print("Added:    persistent orange markers for ambiguous source-name matches")
print("Added:    map legend + compact narration-POI route summary")
print("Added:    click marker/summary → zoom to POI + select associated Odin maneuver")
print("Added:    route-wide POI deduplication")
print("Preserved: Phase 4A per-maneuver verification and all earlier debugger features")
print("Backup:   .phase4a1_backup/")
