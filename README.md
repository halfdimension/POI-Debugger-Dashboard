# Valhalla POI Debugger Dashboard

The dashboard provides authenticated POI/landmark and routing diagnostics against Valhalla and OSRM.

## Authentication

Production supports local accounts, OpenID Connect, or both through `VPD_AUTH_MODE=local`, `oidc`, or `local_oidc`. Every production mode requires a random `VPD_SESSION_SECRET` of at least 32 characters. Local accounts are stored in `VPD_USERS_DB_PATH`; passwords use Argon2id and are never stored directly. Public registration always creates an active ordinary user and does not merge with an OIDC identity that happens to use the same email address.

Usernames are 3–32 ASCII characters, begin with a letter, cannot contain `@`, and are compared using trimmed Unicode case-folding. Emails are trimmed, validated as ASCII addresses, and case-folded in full for uniqueness and login. Database uniqueness constraints enforce both rules under concurrent registration.

For an OIDC-enabled mode, configure `VPD_OIDC_ISSUER`, `VPD_OIDC_CLIENT_ID`, and `VPD_OIDC_REDIRECT_URI`. Set `VPD_OIDC_CLIENT_SECRET` for a confidential client. The redirect URI must be HTTPS in production. Optional `VPD_AUTH_ALLOWED_USERS` and `VPD_AUTH_ALLOWED_GROUPS` restrict OIDC access after identity validation. The backend fails closed when settings required by the selected mode are missing.

For localhost development without SSO, explicitly start the backend with:

```bash
VPD_ENVIRONMENT=development VPD_AUTH_MODE=development ./scripts/run_backend.sh
```

This mode creates an ephemeral local-developer session and accepts development login only when the backend client, Host, and browser Origin are loopback addresses. It cannot be enabled while `VPD_ENVIRONMENT=production`. The Vite mock API remains separately opt-in with `VPD_MOCK_API=1` and supplies a clearly labelled synthetic user.

All dashboard APIs except `/api/health` and authentication initiation/callback/configuration require a valid signed, HttpOnly session cookie. Local registration and password login also require the pre-authentication CSRF token returned by `/api/auth/config`. Mutating APIs require the authenticated session CSRF token. Browser storage never receives OIDC access tokens.

Stage 3B stores each authenticated user's selected dataset, basemap, map mode, route view, and panel layout in a separate SQLite preference database. Dataset-dependent requests are explicitly scoped or resolve the authenticated user's persisted selection; changing one user's dataset does not alter another user's dashboard. If a saved dataset is removed, the API repairs the preference to the configured default and reports the fallback to the UI.

Local preference owners use a stable `local:<UUID>` key. Existing OIDC owner keys retain their issuer/subject-derived hashes, so enabling local accounts does not migrate, overwrite, or email-merge existing preferences. Shared rate-limit buckets live in the users database and work across backend workers using the same SQLite file.

New testcases are private, user-owned records in a dedicated SQLite database. Existing filesystem scenarios remain available as a clearly labeled, read-only legacy collection and are never assigned to a user automatically.

### Super Admin provisioning and RBAC

Self-registration always creates the `user` role. Administrative access is derived from the current server-side account row on every request, so disabling an account or changing its role affects existing sessions immediately. Development/mock identities are always ordinary users.

To provision an existing account, run the backend operator CLI from the repository root with the same configuration and database access as the service:

```bash
python -m backend.app.manage_users set-role <stable-user-id> super_admin
```

The command displays the target account and requires typing `<stable-user-id>:super_admin` before it changes the role. Revoke with the same command and the `user` role. For non-interactive operations, `--confirm '<stable-user-id>:<role>'` supplies the exact confirmation. Every role change is written to `admin_audit_log`, and the final active Super Admin cannot be revoked. Stable IDs can be obtained through authorized database access (or, after initial provisioning, from the protected Admin API).

Super Admins receive a separate Admin Console backed by `/api/admin/overview`, paginated/searchable `/api/admin/users`, `/api/admin/users/{id}`, and `/api/admin/users/{id}/status`. Status changes are limited to ordinary accounts and are audited. Responses exclude password hashes, sessions, and authentication secrets.

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
connections between their machines. Do not expose the Vite development server
to the public internet. Production must use HTTPS and one of the configured
application authentication modes.

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
| `VPD_POI_INDEX_DIR` | Rebuildable SQLite POI index directory | `/data/cache/poi-search` |
| `VPD_PREFERENCE_DB_PATH` | Durable per-user preference SQLite database | `/data/user-preferences.sqlite3` |
| `VPD_TESTCASE_DB_PATH` | Durable private testcase SQLite database | `/data/testcases.sqlite3` |
| `VPD_USERS_DB_PATH` | Local accounts and shared authentication rate limits | `/data/users.sqlite3` |
| `VPD_BACKEND_WORKERS` | Uvicorn worker count; preferences use WAL and busy timeouts | `2` |
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
configure the application OIDC client. A VPN or authenticated reverse proxy may
provide an additional security boundary but does not replace application setup.

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

Official company landmarks using the unprefixed tag schema can be regenerated
as a debugger-compatible CSV with:

```bash
python3 scripts/extract_official_landmarks.py \
  /home/cn004231/harsh/poi_official_data/delhi_small_lmg.osm.pbf \
  data/cp_official_lmg.landmarks.csv
```

This extraction only affects dashboard visualization. It does not rebuild or
switch Valhalla tiles or OSRM routing data.

### Rohtak Official LMG

Select **Rohtak - Official LMG** (`rohtak_lmg`) in the existing dataset selector.
The frontend discovers it from `/api/datasets`, activates it through
`POST /api/datasets/rohtak_lmg/activate`, and reloads `/api/pois`. Its optional
`map_bounds` metadata fits the map to the Rohtak bbox; datasets without bounds
use the existing `frontend.default_center` and `frontend.default_zoom`.
The configured initial dataset remains unchanged.

Regenerate the 576 landmark rows with the same extractor and 16-column CSV
schema used by CP Official LMG:

```bash
cd /home/cn004231/harsh/VALHALLA/custom_debugger_dashboard/valhalla-poi-debugger-phase1
python3 scripts/extract_official_landmarks.py \
  /home/cn004231/harsh/poi_official_data/Rohtak/rohtak_lmg.osm.pbf \
  data/rohtak_lmg.landmarks.csv
```

This requires `osmium-tool`. A separate GeoJSON file is unnecessary: the
backend generates the feature collection from CSV in memory, as it does for CP.

OSRM at `http://localhost:5000` is an external service. Dataset activation
changes debugger POIs and the dataset-specific debug JSONL path; it does not
preprocess a PBF, start OSRM, change its URL, or switch its routing graph.
For Rohtak guidance and Candidate Analysis, prepare and serve the matching
graph separately. The commands below follow the existing engine rebuild
script's extract/partition/customize/MLD sequence and its custom
`profiles/adv/fastest/Driving_Fastest.lua` profile (with local paths and port
5000). They rebuild the Rohtak graph files alongside the PBF:

```bash
OSRM_ROOT=/home/cn004231/harsh/OSRM/engines/poi_work/route_eta-route_eta_penalty
ROHTAK_DATA=/home/cn004231/harsh/poi_official_data/Rohtak
ROHTAK_DEBUG=/home/cn004231/harsh/VALHALLA/custom_debugger_dashboard/valhalla-poi-debugger-phase1/data/rohtak_lmg.turn_debug_v2.jsonl

OSRM_LANDMARK_DEBUG_JSONL="$ROHTAK_DEBUG" \
  "$OSRM_ROOT/build/osrm-extract" \
  -p "$OSRM_ROOT/profiles/adv/fastest/Driving_Fastest.lua" \
  "$ROHTAK_DATA/rohtak_lmg.osm.pbf" && \
  "$OSRM_ROOT/build/osrm-partition" "$ROHTAK_DATA/rohtak_lmg.osrm" && \
  "$OSRM_ROOT/build/osrm-customize" "$ROHTAK_DATA/rohtak_lmg.osrm" && \
  "$OSRM_ROOT/build/osrm-routed" -a MLD -p 5000 "$ROHTAK_DATA/rohtak_lmg.osrm"
```

Port 5000 must be free before starting this server. The JSONL must be produced
by the same extraction as the served graph; existing preprocessed Rohtak files
alone do not supply the matching Candidate Analysis sidecar. Selecting a CP
dataset later also requires separately serving its matching OSRM graph.

Start the debugger in two terminals using the existing scripts:

```bash
cd /home/cn004231/harsh/VALHALLA/custom_debugger_dashboard/valhalla-poi-debugger-phase1
./scripts/run_backend.sh
```

```bash
cd /home/cn004231/harsh/VALHALLA/custom_debugger_dashboard/valhalla-poi-debugger-phase1
./scripts/run_frontend.sh
```

Open `http://localhost:5173`, select Rohtak, and click START and END on the map.
The existing route comparison and OSRM instruction/debug display are reused.
Valhalla remains a separate service with its own tiles; its Rohtak response
depends on those tiles covering Rohtak, while the OSRM result is displayed
independently.

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

- If `poi_csv_path` exists, small compatibility datasets can be returned by `/api/pois`; large datasets use bounded search endpoints.
- Dataset selection and registry reads return lightweight metadata. Statistics are explicitly pending until prepared by `Reload POIs`.
- `Reload POIs` streams CSV statistics with bounded memory and rebuilds that dataset's search index without restarting the debugger.
- Optional `datasets:` entries can be activated at runtime.
- Dataset activation changes debugger-side POI data only; it does not restart Valhalla or change the tiles used by the running Valhalla process.

### Bounded POI search API

`GET /api/pois/search` searches a named dataset without activating it. The
legacy `/api/pois` remains available for small datasets but returns HTTP 413
above `backend.legacy_poi_feature_limit` (50,000 by default). Activation is
metadata-only; reload prepares statistics and atomically rebuilds one index.

Dataset preparation is a Super Admin maintenance operation. The reload endpoint
returns HTTP 202 with a bounded `pending`, `running`, `completed`, or `failed`
job record. Work runs in a separate, lower-priority Python process; the request
process never performs the CSV scan or FTS/R-tree build. Only one preparation
job may be active across backend workers sharing the job directory. Duplicate
requests for the same dataset return the existing job.

`GET /api/datasets/preparation-jobs/{job_id}` reports sanitized job state to an
authenticated user. Search, structured query, viewport visualization, cluster
drill-down, and nearby-diagnostics endpoints never implicitly build a missing
or stale index. They return HTTP 503 with `poi_index_not_ready` until a Super
Admin preparation job publishes an index.

| Parameter | Meaning |
| --- | --- |
| `dataset_id` | Required configured dataset ID; never a filesystem path. |
| `q` | Case-insensitive substring across `name`, `mappls_poi_id`, `new_node_id`, `osm_source_id`, and `landmark_type`. Maximum 200 characters. |
| `type` | Exact, case-sensitive `landmark_type` match. |
| `min_priority` | Includes numeric priorities at or above the boundary; missing/empty values follow the current browser's numeric conversion and are zero, while invalid values do not match. |
| `visible` | `true` or `false`; absent/empty values are visible and `no`, `false`, `0`, and `n` are invisible, matching the current frontend. |
| `bbox` | `west,south,east,north` in longitude/latitude order. Antimeridian-crossing boxes are rejected. |
| `limit` | Page size, default 100, minimum 1, maximum 500. |
| `cursor` | Opaque continuation returned by the previous response. |

Example:

```text
GET /api/pois/search?dataset_id=rohtak_lmg&q=school&visible=true&bbox=76.47,28.83,76.71,28.96&limit=100
```

```json
{
  "type": "FeatureCollection",
  "dataset_id": "rohtak_lmg",
  "features": [],
  "returned": 0,
  "has_more": false,
  "next_cursor": null
}
```

Text results preserve the browser ranking: POI names beginning with the query
first, then descending priority, then case-normalized name. Source row order is
the final deterministic tie-breaker. Without `q`, results retain source order.
SQLite binary ordering of normalized Unicode names can differ from JavaScript
`localeCompare`, but membership and the higher-value prefix/priority ordering
are unchanged. Duplicate names and identifiers remain separate features.

This legacy ranking treats larger numbers as higher-ranked, and
`min_priority` means the numeric predicate `priority >= value`. That conflicts
with the current company convention in which priority 1 ranks above priority
24. These GET semantics are intentionally retained for compatibility; callers
must not interpret `min_priority` as “higher priority than.”

### Structured POI query API

`POST /api/pois/query` adds field-specific conditions without changing the
legacy GET contract. It uses the same per-dataset SQLite index and returns the
same bounded FeatureCollection envelope.

```json
{
  "dataset_id": "rohtak_lmg",
  "q": "Delhi",
  "mode": "and",
  "conditions": [
    { "field": "name", "operator": "contains", "value": "Metro" },
    { "field": "priority", "operator": "gte", "value": 7 }
  ],
  "bbox": [76.47, 28.83, 76.71, 28.96],
  "limit": 50,
  "cursor": null
}
```

The allowlisted field/operator pairs are:

| Field | Operators |
| --- | --- |
| `name` | `contains`, `eq` |
| `priority` | `eq`, `gt`, `gte`, `lt`, `lte`, `between` (two-number array) |
| `landmark_type` | `eq` |
| `mappls_poi_id`, `new_node_id`, `osm_source_id` | `eq`, `contains` |
| `visible` | `is_visible`, `is_hidden` (no value) |

At most 10 conditions are accepted. Text is non-empty and at most 200
characters; priority values are finite and may be constrained by optional
dataset bounds. `mode` is
`and` or `or`. The exact expression is `q AND (condition group)`; an empty
`q` evaluates only the group. `bbox`, when present, is also ANDed with the
whole expression. There are no nested groups.

Structured results use the selected dataset's configured priority order, then
normalized name and source row ID. With `q`, name-prefix matches remain first,
followed by the configured priority order, name, and source row ID. Numeric
operators never change meaning: `gte` is numeric `>=`, even when smaller
numbers rank higher. Cursors bind the dataset, index generation, quick text,
mode, ordered conditions, bbox, and values; changing any of them rejects the
cursor. The builder's “Entire selected dataset” scope omits `bbox`, while
“Current map viewport” sends it.

Priority business rules are dataset metadata rather than global constants:

```yaml
datasets:
  company_data:
    priority:
      rank_order: ascending  # smaller values rank first
      minimum: 1             # optional
      maximum: 24            # optional
```

Omitting `priority` gives unbounded numeric filters and descending structured
ranking for compatibility with earlier dashboard behavior. Category choices
are never configured as a fixed list; the API derives `landmark_types` from
the selected dataset and the frontend rebuilds the dropdown when metadata
changes.

The endpoint uses a prepared SQLite FTS5 trigram index plus an R-tree. FTS
preserves partial substring matching; one- and two-character searches are
valid but cannot benefit from trigram pruning and should not be used for normal
interactive search. All filters are parameterized and combined in SQLite. The
index returns `limit + 1` rows to determine `has_more` and does not calculate an
exact total.

### Authoritative viewport visualization API

`GET /api/pois/viewport` is the dataset-coverage API for map rendering. It is
separate from ranked search and accepts no text or metadata filters.

| Parameter | Meaning |
| --- | --- |
| `dataset_id` | Required configured dataset ID. Unlike legacy endpoints, omission never falls back to a user preference. |
| `bbox` | Required inclusive `west,south,east,north` longitude/latitude bounds. Values must be finite and ordered. Antimeridian-crossing bounds (`west > east`) are explicitly rejected; clients must split them into two requests. |
| `zoom` | Required finite map zoom from 0 through 22. It selects the initial grid resolution. |
| `max_features` | Requested geographical feature budget, default 500, minimum 1, hard maximum 1,000. |

The full ordered world bounds are allowed; the level-0 aggregate guarantees a
bounded representation, so a separate area cap is unnecessary. Crossing the
antimeridian still requires two independent requests.

Every successful response has complete coverage. `total_matching_pois` is the
exact number of valid source rows inside the requested bounds, and
`meta.represented_poi_count` is the sum represented by the returned features.
For `complete: true`, these values are equal. There is no first-page count and
no silent truncation.

```json
{
  "dataset_id": "new_data",
  "generation": "8d62d64f4e9d4fd786e96a5aa14cdaf6",
  "bbox": [76.47, 28.83, 76.71, 28.96],
  "zoom": 10.0,
  "mode": "aggregated",
  "complete": true,
  "total_matching_pois": 18542,
  "aggregates": [
    {
      "id": "cluster-0123456789abcdef01234567",
      "source_record_count": 18542,
      "coordinates": [76.59, 28.895],
      "coordinate_kind": "represented_bounds_center",
      "bounds": [76.47, 28.83, 76.71, 28.96],
      "aggregation_level": 9,
      "cluster_ref": "opaque-generation-bound-reference"
    }
  ],
  "individual_pois": [],
  "meta": {
    "spatial_strategy": "equirectangular_grid_v1",
    "requested_aggregation_level": 13,
    "aggregation_level": 9,
    "adaptive_coarsening": true,
    "feature_count": 1,
    "aggregate_count": 1,
    "individual_count": 0,
    "represented_poi_count": 18542,
    "max_features": 500,
    "server_max_features": 1000,
    "max_payload_bytes": 2097152,
    "serialized_bytes": 714
  }
}
```

The prepared index contains exact occupied-cell counts for equirectangular grid
levels 0 through 16. A request starts at `floor(zoom) + 3`, capped at level 16,
and coarsens until the occupied cells fit `max_features` and the 2 MiB payload
budget. At zoom 15 and above, all matching rows are returned as
`individual_pois` only when both budgets permit it; otherwise the result stays
aggregated. Each individual entry has `id`, integer `source_record_id`,
`coordinates`, and the original GeoJSON `feature`. A level has `2^level`
columns and rows. Grid cells are half-open on
east/north edges, except the final world cells, so a coordinate on a shared
edge has exactly one owner. Viewport edges themselves are inclusive. Fully
covered cells use prepared counts; edge cells use the R-tree plus exact REAL
coordinate predicates and the same stored cell ownership.

Aggregate coordinates are the center of the aggregate's represented bounds
(the intersection of its grid cell and the viewport), not a POI location or a
data centroid. Distinct source rows use their internal ordinal row IDs for
identity, so duplicate external IDs and repeated coordinates remain separately
countable.

Dense aggregates are inspectable through:

```text
GET /api/pois/viewport/cluster-members?dataset_id=new_data&cluster_ref=...&limit=100&cursor=...
```

The endpoint returns exact `total_matching_pois`, source records ordered by
`source_record_id`, and an opaque `next_cursor`. `limit` is at most 500 and the
same 2 MiB payload budget applies. Both the aggregate reference and cursor bind
the dataset and index generation. A newly published generation makes them
stale (HTTP 409), so pages from different generations cannot be mixed.
If even one source member or the coarsest possible envelope cannot fit, the API
returns HTTP 413 with `code: poi_payload_too_large` instead of claiming complete
coverage.

Viewport tables are index schema version 6 and are built only by the existing
authorized preparation worker, in the same temporary SQLite file as FTS and
R-tree structures. Older indexes deliberately report not ready and require a
normal Super Admin preparation job. Publication remains one atomic
`os.replace`: readers already holding the old file descriptor finish against
that generation, while new readers open the complete new generation. A failed
build never replaces the previous file.

Indexes default to `.cache/poi-search`, which is ignored by Git, and can be
moved with `backend.poi_index_dir` or `VPD_POI_INDEX_DIR`. A source
path/size/mtime fingerprint is checked before every search. Builds use a
temporary database and atomic replacement; reload replaces only that dataset's
index and makes existing cursors stale. A failed rebuild preserves the previous
index file. Indexes are opened per request rather
than retained in an unbounded connection or feature cache.

Preparation submissions use the shared file-backed job coordinator and Linux
`flock`, so only one worker builds at a time across backend processes using the
same job directory. Ordinary request handlers never build an index.
SQLite FTS5 trigram and R-tree support must be present in the deployment
Python's standard-library SQLite build; the backend test suite validates this
requirement in the supported Linux environment.

Preparation workers default to niceness 10. Optional address-space, CPU-time,
and per-file limits can be configured with `preparation_worker_memory_bytes`,
`preparation_worker_cpu_seconds`, and `preparation_worker_file_bytes`. These
limits are disabled by default because safe values depend on dataset size and
host capacity.

Run the dependency-free search tests from the repository root:

```bash
python3 -m unittest backend.tests.test_poi_search backend.tests.test_viewport_aggregation
```

An opt-in generated 700,000-row benchmark reports measured build time, search
and viewport median/P95 latencies, represented/returned counts, response sizes,
spatial-table rows and page storage, query plans, index size, and Python-tracked
peak memory:

```bash
python3 -m backend.tests.benchmark_poi_search --rows 700000
```

## Stage 2B — bounded frontend POI loading

The frontend no longer downloads `/api/pois` during startup or dataset refresh.
It uses the explicit `dataset_id` search contract for three separate data flows:

- viewport POIs: a debounced query after MapLibre `moveend`, bounded by the
  visible west/south/east/north coordinates and capped at 500 features;
- explorer results: a debounced global query, 50 results per page, with
  explicit cursor-driven “Load more” pagination;
- route diagnostics: a separate bounding box expanded 500 m around route
  maneuvers, independent of the current viewport and explorer page.

Requests are cancelled when their bounds, dataset, or filters become stale.
Selected POI details are stored separately, so panning or changing filters does
not discard the selection. Candidate-analysis features remain sourced from the
routing response and are not reconstructed from POI search pages.

Dense viewport and route-diagnostic queries are deliberately not auto-paged.
The Stage 2B frontend still calls `/api/pois/search` with a 500-row viewport
cap and lets MapLibre cluster only those rows. Stage 5C.R3A adds the authoritative
backend contract above; the visible map remains non-authoritative until the
separate R3B frontend integration switches to it.
The dashboard displays a warning when the 500-feature cap is reached. In that
case map display, nearby-POI inspection, and narration correlation may be
incomplete. Fully authoritative dense route correlation needs a future bounded
route-corridor/identifier lookup contract (or a backend diagnostic endpoint);
the frontend does not fall back to downloading the complete dataset.

Stage 2B has been exercised with the development mock and frontend unit/build
checks. It still requires Linux FastAPI integration testing and the real
700,000-row dataset benchmark described above.

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

## Dashboard redesign Stage 4A — private testcases

Stage 4A adds the authenticated **My Testcases** library without changing route execution.

- `GET/POST /api/testcases` and `GET/PATCH/DELETE /api/testcases/{id}` provide owner-scoped CRUD.
- Ownership always comes from the signed session. Missing and other-user IDs both return 404.
- `GET /api/testcases` supports `q`, bounded `limit` (1–100), and bounded `offset`.
- Updates require the current `revision`; stale writes return 409.
- Records persist in `VPD_TESTCASE_DB_PATH` (default `data/testcases.sqlite3`) using WAL mode.
- The schema reserves a private `visibility` field so Stage 4B can add sharing through a migration.
- Legacy files under `VPD_SCENARIO_DIR` are preserved. `/api/scenarios` is read-only and the UI labels these records as legacy; there is no automatic ownership migration.

Existing legacy files can be migrated in a later, explicit owner-selected workflow. Stage 4A intentionally does not infer owners or expose another user's private records, and Super Admin receives no ownership bypass.

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
