# Valhalla POI Debugger — Phase 1

Phase 1 is the runnable foundation for visually testing POI/landmark behavior against a local Valhalla service.

## Included now

- Configurable Valhalla URL.
- Configurable Valhalla engine root and PBF/data paths.
- Configurable MapLibre style and initial map position.
- Backend health/config endpoints.
- Valhalla `/status` connectivity check.
- Load POIs from a configured GeoJSON file and render them as points.
- Click map to set route start/end coordinates.
- Call the configured local Valhalla `/route` endpoint.
- Decode Valhalla polyline6 route geometry and draw it on the map.
- Display Odin maneuver instructions beside the map.
- Display raw Valhalla JSON for debugging.

## Configure it

Edit:

```text
config/debugger.yaml
```

The main values you will normally change are:

```yaml
valhalla:
  service_url: "http://localhost:8002"

engine:
  root: "/home/cn004231/harsh/VALHALLA/engine/default/routing-nextgen-routing_nextgen_ETA"

data:
  pbf_path: "/path/to/current-test.osm.pbf"
  poi_geojson_path: "./data/landmarks.geojson"
  poi_csv_path: "./data/landmarks.csv"
```

You can also override them without editing YAML:

```bash
export VPD_VALHALLA_URL=http://localhost:8002
export VPD_ENGINE_ROOT=/path/to/engine
export VPD_PBF_PATH=/path/to/test.osm.pbf
export VPD_POI_GEOJSON_PATH=/path/to/landmarks.geojson
```

## Run backend

From repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
./scripts/run_backend.sh
```

Backend API:

```text
http://127.0.0.1:8010
```

FastAPI docs:

```text
http://127.0.0.1:8010/docs
```

## Run frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

## POI file expected by Phase 1

`data/landmarks.geojson` is initially empty. You may put test POIs into it manually for now:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [77.209, 28.6139]
      },
      "properties": {
        "osm_id": 123456,
        "name": "Example Petrol Pump",
        "type": "fuel",
        "priority": 90
      }
    }
  ]
}
```

Coordinate order in GeoJSON is `[longitude, latitude]`.

## Planned next phases

### Phase 2 — PBF → POI extraction

- Read the actual `.osm.pbf` configured in `debugger.yaml`.
- Apply your POI/landmark tag rules.
- Generate `landmarks.geojson` and `landmarks.csv` automatically.
- Reload POIs from the dashboard.
- Filter/search POIs by name, type, OSM ID, priority.

### Phase 3 — route debugging UX

- Manual Valhalla JSON/curl request editor.
- Costing and route options.
- Click a maneuver to zoom to the corresponding route location.
- Maneuver markers on map.
- Copy generated curl.
- Saved route scenarios.

### Phase 4 — landmark implementation introspection

- Source PBF POI vs tile-associated landmark vs Odin candidate vs selected landmark.
- Candidate score/distance/priority table.
- Rejection reason.
- Optional local debug fields from your custom Valhalla build.

### Phase 5 — regression runner

- Save expected landmark/maneuver behavior.
- Run a suite against a newly rebuilt tile set.
- PASS/FAIL comparison and summary report.

## Important note

`engine.root` and `data.pbf_path` are deliberately present in Phase 1 even though the browser does not directly use the engine source tree. Later extraction/build/debug tools will consume these same settings, so you will not have to redesign the configuration when the project grows.


## Phase 2A

Phase 2A adds a runtime dataset registry and removes the manual CSV-to-GeoJSON step for normal testing.

- If `poi_csv_path` exists, `/api/pois` is generated directly from that CSV in memory.
- CSV rows are validated for coordinates and summarized in the dashboard.
- `Reload POIs` rereads the source file without restarting the debugger.
- Optional `datasets:` entries can be activated at runtime.
- Dataset activation changes debugger-side POI data only; it does not restart Valhalla or change the tiles used by the running Valhalla process.

## Phase 3A — saved route scenarios

Phase 3A adds file-backed route scenarios for repeatable landmark testing.

- Save the current START/END coordinates from the dashboard.
- Each scenario records its debugger dataset and Valhalla costing.
- Load a scenario without routing, or run it immediately.
- Delete scenarios from the dashboard.
- Scenarios are stored under `data/scenarios/`.
- Useful scenarios can be committed to Git as regression cases.
- The scenario directory can be configured with `scenarios.directory` or `VPD_SCENARIO_DIR`.
- Running is blocked when the saved dataset differs from the active debugger dataset.

Phase 3A does not yet perform PASS/FAIL assertions. Those come in Phase 3B.

## Phase 3B — scenario assertions

Phase 3B adds automatic regression assertions to saved route scenarios.

- A scenario may require Odin text / landmark text to appear.
- A scenario may define text that must not appear.
- Assertions inspect both maneuver `instruction` and `verbal_pre_transition_instruction`.
- `Run` evaluates one scenario and shows PASS / FAIL / NO EXPECTATION / ERROR.
- `Run All Matching Dataset` executes all scenarios for the active debugger dataset.
- Existing Phase 3A scenarios remain valid; use `Expect` to add assertions.
- Results are runtime-only; expected behavior remains stored in scenario JSON.

## Phase 4A — external landmark verification

Phase 4A keeps the Valhalla engine and `/route` contract unchanged. The dashboard externally correlates existing Odin narration with loaded source POIs.

- Matches POI names against maneuver instruction and verbal pre-transition text.
- Treats an `at <POI>` narration pattern as strong landmark evidence.
- Treats a plain name occurrence as ambiguous because it may be a road/place-name coincidence.
- Uses maneuver distance to disambiguate duplicate POI names and ignores matches beyond 500 m.
- Highlights the primary observed source POI on the map and exposes its Mappls ID, type, priority and distance.
- This is external evidence only; it does not claim access to Odin's internal candidate or selected-landmark object.

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

## Phase 4B — external predicted winner comparison

Phase 4B remains dashboard-only. It approximates the candidate set for each maneuver from source POIs near the preceding approach-route segment, ranks those candidates using the inspected Odin ordering (priority descending, distance-to-maneuver ascending, then POI id ascending), and compares the external predicted winner with the POI strongly observed in existing Odin narration.

The candidate set is an external approximation, not Odin's private `maneuver.landmarks()` vector. MATCH/MISMATCH therefore compares dashboard prediction with narration evidence and must not be interpreted as direct runtime introspection.

