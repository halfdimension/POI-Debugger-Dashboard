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

## Run on your company network

Run both services on the machine that has access to Valhalla, OSRM, and the
configured data files. They now listen on all network interfaces by default.

Start the backend from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
./scripts/run_backend.sh
```

Backend API:

```text
http://<host-machine-ip>:8010
```

FastAPI docs:

```text
http://<host-machine-ip>:8010/docs
```

Open a second terminal:

```bash
# Vite 8 requires Node.js 20.19 or newer.
npm --prefix frontend install
./scripts/run_frontend.sh
```

Find the host machine's LAN/VPN address (`hostname -I` on Linux), then coworkers
can open:

```text
http://<host-machine-ip>:5173
```

The browser sends API requests to the frontend's `/api` path and Vite proxies
them to the backend on the host machine. Coworkers therefore do not need
Valhalla, OSRM, Node, Python, or this repository installed locally.

If the backend is on a different machine or port, start the frontend with:

```bash
VPD_BACKEND_URL=http://<backend-ip>:<backend-port> ./scripts/run_frontend.sh
```

If coworkers cannot connect, allow inbound TCP ports `5173` (frontend) and
`8010` (API) in the host firewall and make sure the company LAN/VPN permits
connections between their machines. Do not expose these ports to the public
internet: this is an unauthenticated debugger and its API can modify saved
scenarios.

Optional bind/port overrides for the backend are `VPD_BACKEND_HOST` and
`VPD_BACKEND_PORT`. For example:

```bash
VPD_BACKEND_PORT=9010 ./scripts/run_backend.sh
VPD_BACKEND_URL=http://127.0.0.1:9010 ./scripts/run_frontend.sh
```

## Production / AWS deployment

For production, do not keep the Vite development server running. Build the
frontend once; the FastAPI backend will automatically serve `frontend/dist` at
the root URL and serve the API below `/api`. DevOps then exposes only port
`8010` (normally through an HTTPS load balancer or reverse proxy).

All deployment-specific values can be supplied as environment variables, so no
Python or TypeScript source needs to be edited. Start from the tracked template:

```bash
cp .env.example .env
# Edit .env with the server/container URLs and mounted data paths.
set -a
source .env
set +a

npm --prefix frontend ci
npm --prefix frontend run build
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
./scripts/run_backend.sh
```

Then open `http://<server>:8010`. In AWS, point the load balancer target group at
port `8010` and use its HTTPS DNS name instead.

The main deployment variables are:

| Variable | Purpose | Example |
| --- | --- | --- |
| `VPD_VALHALLA_URL` | Valhalla URL reachable from the dashboard backend | `http://valhalla.internal:8002` |
| `VPD_OSRM_URL` | OSRM URL reachable from the dashboard backend | `http://osrm.internal:5000` |
| `VPD_POI_CSV_PATH` | POI CSV on the dashboard host/container | `/data/landmarks.csv` |
| `VPD_POI_GEOJSON_PATH` | GeoJSON fallback | `/data/landmarks.geojson` |
| `VPD_PBF_PATH` | Source PBF metadata path | `/data/map.osm.pbf` |
| `VPD_TILES_PATH` | Valhalla tiles metadata path | `/data/valhalla_tiles` |
| `VPD_VALHALLA_CONFIG_PATH` | Valhalla config metadata path | `/data/valhalla.json` |
| `VPD_SCENARIO_DIR` | Writable saved-scenario directory | `/data/scenarios` |
| `VPD_BACKEND_PORT` | Dashboard HTTP port | `8010` |
| `VPD_BACKEND_WORKERS` | Worker count; keep `1` because active-dataset state is in memory | `1` |
| `VPD_ALLOWED_ORIGINS` | Comma-separated browser origins | `https://debugger.company.com` |

See [.env.example](.env.example) for optional timeout, debug JSONL, map style,
map center, and route-path settings. Environment variables override YAML,
including the active named dataset. A clean checkout falls back to the tracked
`config/debugger.example.yaml`; `VPD_CONFIG` can point to a completely separate
YAML file if DevOps prefers file-based configuration.

### Candidate Analysis deployment contract

OSRM Candidate Analysis does not recompute landmark selection. It displays extraction-time evidence emitted by the custom OSRM build and joins that evidence to runtime maneuvers using `maneuver.turn_id`.

Therefore the OSRM routing dataset and debugger sidecar must come from the same `osrm-extract` execution. Configure the debugger with:

```bash
VPD_OSRM_LANDMARK_DEBUG_JSONL=/data/osrm/turn_debug_v2.jsonl
```

The matching `.osrm` and `.osrm.*` files belong to the OSRM service. The debugger only needs the corresponding JSONL sidecar. Do not mix a sidecar from another extraction, even when the source PBF is the same.

The OSRM v2 sidecar includes P2 association provenance: `incoming_association_augmented`, `outgoing_association_augmented`, and `association_augmented`. The dashboard displays effective evidence as `normal` or `augmented fallback`. Augmented evidence is valid evidence; it is not automatically rejected.

A typical debugger mount contains `/data/landmarks.csv`, `/data/landmarks.geojson`, `/data/osrm/turn_debug_v2.jsonl`, and `/data/scenarios/`. Valhalla association diagnostics may also be mounted when required.

In production the React frontend and FastAPI `/api` endpoints are served from the same origin, so CORS is disabled by default. Set `VPD_ALLOWED_ORIGINS` only when another browser origin must call the API.

### Docker

The included Dockerfile builds the React frontend and packages it with the API:

```bash
docker build -t valhalla-poi-debugger .
docker run --rm \
  --env-file .env \
  -p 8010:8010 \
  -v /absolute/host/data:/data \
  valhalla-poi-debugger
```

The Valhalla and OSRM URLs are resolved from inside this container. Do not use
`localhost` for services running in other containers or machines; use their
Docker/Kubernetes service name, private DNS name, or private IP. Valhalla and
OSRM remain separate services and must be started with their own tiles/config.
The dashboard only calls their HTTP endpoints.

The dashboard itself reads the POI CSV or GeoJSON and the writable scenarios
directory. PBF, tile, and Valhalla-config paths are currently displayed as
dataset metadata; the Valhalla/OSRM services must receive their actual routing
files through their own deployment configuration and volume mounts.

For an internet-facing AWS deployment, place the dashboard behind HTTPS and
company authentication (ALB/OIDC, VPN, or an authenticated reverse proxy). The
application itself does not provide login protection.

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

## Product-facing dashboard scope

The product-facing dashboard intentionally keeps only directly observable POI verification features.

Included:
- configurable POI dataset loading/reload
- POI search and filters
- START/END selection and Valhalla route rendering
- Odin maneuver instructions
- route-wide highlighting of landmark POIs that appear in landmark-style Odin narration
- click-through between route POIs, maneuver inspection and source POI metadata
- saved repeatable route scenarios and instruction assertions

Intentionally removed:
- debugger-side predicted landmark winners
- approximate candidate ranking
- prediction MATCH/MISMATCH/NOT OBSERVED scoring
- route-level prediction scorecards and prediction JSON reports

The dashboard does not claim access to Odin private runtime landmark-selection state.
