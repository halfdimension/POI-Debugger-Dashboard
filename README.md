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
