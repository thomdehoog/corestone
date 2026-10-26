# Installing and running Corestone

## 1. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Go | ≥ 1.24 | builds the server |
| git | ≥ 2.38 | the storage engine: the server drives git plumbing as subprocesses |
| PostgreSQL | ≥ 14 (16 recommended) | the projection database; the `ltree` extension must be installable (it ships with `postgresql-contrib`) |
| Node.js + npm | ≥ 20 | builds the web client (not needed for API-only use) |

```sh
go version && git --version && psql --version && node --version
```

## 2. Database

Create a database. The server creates the extension and all tables on first start, so the
connecting role needs `CREATE` on the database (or create the extension once as a superuser:
`CREATE EXTENSION ltree;`).

```sh
createdb corestone
```

The database is disposable: everything in it is rebuilt from Git by `POST /api/repository/reindex`
or automatically when the stored revision no longer matches the repository.

## 3. Build

```sh
git clone https://github.com/thomdehoog/corestone.git
cd corestone
make build            # builds web/dist (npm install + typecheck + bundle) and bin/corestone
```

API-only build without Node:

```sh
go build -o bin/corestone ./cmd/corestone
```

## 4. Run

```sh
./bin/corestone -repo data/corestone.git -addr 127.0.0.1:8080 -web web/dist \
  -db "postgres://user:password@localhost:5432/corestone?sslmode=disable"
```

| Flag / env | Default | Meaning |
|---|---|---|
| `-repo` / `CORESTONE_REPO` | `data/corestone.git` | path of the **bare** Git repository; created if missing. This is your data. |
| `-branch` / `CORESTONE_BRANCH` | `main` | the branch the Foundation owns |
| `-db` / `CORESTONE_DB` | *(required)* | PostgreSQL connection string |
| `-addr` / `CORESTONE_ADDR` | `127.0.0.1:8080` | listen address |
| `-web` / `CORESTONE_WEB` | `web/dist` | directory with the built client; `""` for API only |
| `-watch` / `CORESTONE_WATCH` | `3s` | how often to check for direct Git pushes and resynchronize; `0` disables |
| `-allow-origin` / `CORESTONE_ALLOW_ORIGIN` | *(none)* | extra origins (host patterns such as `app.example.com`, `*.example.com`) allowed to open WebSocket sessions; same-origin is always allowed |
| `-access-log` / `CORESTONE_ACCESS_LOG=1` | off | one log line per HTTP request (method, path, status, size, duration, client) |
| `-version` | | print the build version and exit |

Check it is alive:

```sh
curl -s http://127.0.0.1:8080/api/health       # {"status":"ok","database":true,...}; 503 when the database is down
curl -s http://127.0.0.1:8080/api/repository   # head, projection state, statistics
```

Populate a demo domain and open <http://127.0.0.1:8080>:

```sh
./examples/seed.sh http://127.0.0.1:8080
```

### Large technical portfolio

The separate [seed-large.sh](.bash examples/seed-large.sh) leaves the small seed unchanged and creates
an isolated portfolio below `scale-lab/`. It requires Bash and Python 3.9+ (standard library only).
It creates **exactly 1,000 entries**, plus documents, links, threaded comments and lifecycle
transitions. The six projects deliberately use overlapping and different artifact types:

| Project | Entries | Layout and focus |
|---|---:|---|
| Tideline Pi | 200 | Deep Raspberry Pi CM4 firmware, ADC drivers, gateway services and OTA updates |
| Verdant MCU | 120 | Flat STM32 irrigation controller requirements, verification, defects and tasks |
| Harbor Web | 220 | Wide frontend, gateway, identity, billing and notification component trees |
| Harbor Data | 220 | Web counterpart: PostgreSQL, ingestion, migrations, isolation and recovery |
| Prism ASIC | 160 | Mixed-signal optical sensor, analog/digital blocks, PCB and bench characterization |
| Moss LoRa | 80 | Flat low-power telemetry requirements, tests and tasks; no documents or comments |

The default workload has 123 configuration files across 47 scopes. It exercises inherited and
independent type systems, project-specific workflow sequences, scoped enum ordering, and module
field refinements. Documents embed real entry references. Links connect requirements,
specifications, verification evidence, defects and implementation work; cross-project links and
an interface-contract document pair Harbor Web with Harbor Data.

```sh
# Generate and check counts without any server access or writes.
bash examples/seed-large.sh --dry-run

# Seed a running server, then verify all artifact counts and configuration validity.
bash examples/seed-large.sh http://127.0.0.1:8080

# Different deterministic content and a fresh namespace.
bash examples/seed-large.sh http://127.0.0.1:8080 --root another-portfolio --seed 42

# Preview 100,000 or 1,000,000 entries, excluding documents/links/comments.
bash examples/seed-large.sh --dry-run --scale 100
bash examples/seed-large.sh --dry-run --scale 1000

# A custom exact size; --scale multiplies this number.
bash examples/seed-large.sh --dry-run --count 2500

# Offline tests: definitions, references, counts, layout and repeatability.
python3 examples/seed-large.test.py
```

Add the server URL and a fresh `--root` to a large-scale command to actually persist it.
Every configuration/artifact write and transition goes through the API and creates a Git commit;
this is a baseline workload generator, **not** a bulk-import facility or a promise of million-entry
throughput. It prints progress, elapsed time, per-project counts and a workload digest. The digest
is repeatable for identical dry-run arguments (live GUIDs are server-assigned). Memory retains
only a small reference set per module rather than every artifact. Directory and title variants
expand as the requested count grows.

The script refuses an occupied namespace, including configuration-only scopes. It never deletes
or rewrites existing artifacts and does not resume a partial run: after a failed run, inspect the
reported API error and use a new namespace. Only explicit maintenance responses with `Retry-After`
are retried; network errors and ambiguous write outcomes fail visibly rather than duplicating
artifacts. Set `PYTHON=python` on systems where Python 3 is named `python` instead of `python3`.

## 5. Define your own domain

Corestone has no built-in types. A domain is a set of configuration files in a folder's
`.corestone/config/` directory, laid out per kind and described in
[CONFIGURATION.md](CONFIGURATION.md). Store them through the API — one commit per file — or commit
them directly into the repository. The examples write to the repository root (`scope=`); add a folder
to define or refine types for a subtree only.

```sh
cfg() { curl -sfS -X PUT "http://127.0.0.1:8080/api/config?scope=$1&path=$2" -H 'Content-Type: application/json' -d "$3"; }
```

**A workflow** — a state machine that entry types can reference:

```sh
cfg "" entries/workflows/dev-workflow.json '{
  "initial": "open",
  "states": ["open", {"id": "review", "name": "In review"}, "done"],
  "transitions": [
    {"id": "submit",  "name": "Submit for review", "from": "open",   "to": "review"},
    {"id": "approve", "from": "review", "to": "done"},
    {"id": "rework",  "from": "review", "to": "open"}
  ]}'
```

**Fields and an enumeration** — shared by the kind's types, or `<type>-fields.json` for one type:

```sh
cfg "" entries/enums/priority-enum.json '{"options": [{"value": "low"}, {"value": "medium"}, {"value": "high"}]}'
cfg "" entries/fields.json '{"fields": [
  {"id": "priority",  "name": "Priority",  "type": "enum", "enum": "priority"},
  {"id": "rationale", "name": "Rationale", "type": "multiline"},
  {"id": "due",       "name": "Due",       "type": "date"}]}'
```

Field types: `hid`, `boolean`, `integer`, `float`, `currency`, `date`, `time`, `datetime`, `text`,
`multiline`, `richtext`, `enum` (options inline or `"enum": "<id>"`; single or `"multiple": true`;
`"extendable": true` allows other values, which are stored in the artifact only), `hyperlink`,
`reference`, `references`, `attachment`, `json`, `workflow`.

**Entry types** — HID generation, workflows, the fields they use (order and `required` per type),
presentation:

```sh
cfg "" entries/types.json '{"types": [
  {"id": "requirement", "displayName": "Requirement", "hid": {"prefix": "REQ"}, "workflows": ["dev"],
   "fields": [{"id": "priority", "required": true}, "rationale", "due"],
   "presentation": {"columns": ["priority", "due"]}},
  {"id": "testcase", "displayName": "Test case", "hid": {"prefix": "TC"}}]}'
```

**Link and comment types** — a kind without types is not available, so define at least a comment
type if you want comments:

```sh
cfg "" links/types.json '{"types": [
  {"id": "verifies", "sourceTypes": ["testcase"], "targetTypes": ["requirement"], "cardinality": "many-to-many"},
  {"id": "related"}]}'
cfg "" comments/types.json '{"types": [{"id": "comment"}]}'
```

The response of each write lists `warnings`: references that do not resolve yet, such as a field a
type uses but no file defines. A file that does not parse is refused.

**Scoped refinement and independent subtrees** — definitions resolve nearest folder first, so
`specs/safety` can add an `asil` field to `requirement` without touching the root definition, and a
kind's `types.json` with `"inheritance": "off"` ignores everything above for that kind:

```sh
cfg specs/safety entries/requirement-fields.json '{"fields": [{"id": "asil", "type": "enum", "options": [{"value": "A"}, {"value": "D"}]}]}'
cfg specs/safety entries/types.json '{"types": [{"id": "requirement", "fields": ["asil"]}]}'
cfg tasks entries/types.json '{"inheritance": "off", "types": [{"id": "task", "hid": {"prefix": "TSK"}}]}'
```

**A document type** — in `documents/types.json`; documents carry `content`, a tree of blocks:
`section` (title, children), `paragraph` (text), `entry` (guid), `list` (items), `code`, `image`
(src = attachment name or URL).

The server enforces the configuration: an artifact's type must be defined where it lives (also when
it is moved), and fields its type does not define cannot be added or changed.

Create an entry:

```sh
curl -X POST http://127.0.0.1:8080/api/entries -H 'Content-Type: application/json' -d '{
  "path": "specs/boot", "type": "requirement", "title": "System boots in under 2 seconds",
  "fields": {"priority": "high"}}'
```

The response carries the permanent `guid`, the generated HID (`REQ-1`), the initial workflow state
and an `ETag`. Every write is a Git commit:

```sh
git --git-dir=data/corestone.git log --oneline
```

## 6. Direct Git access

The repository is an ordinary bare repository. Clone it, edit files, push: the server picks up the
new head within `-watch` seconds (and on the next API call), replays the commits into the
projection, tolerates malformed files (they are reported by `GET /api/repository/validate`), and
can always be rebuilt with `POST /api/repository/reindex`. Metadata scattered by manual
restructuring is restored with `POST /api/repository/maintenance/relocate-metadata`.

## 7. Deployment notes

- **Authentication and TLS are not included** (outside the MVP scope of the design guide). Put an
  authenticating reverse proxy in front; do not expose the port directly. The proxy must pass
  WebSocket upgrades for `/api/ws` and keep the `Host` header (or list the public origin with
  `-allow-origin`), since sessions are refused for foreign origins.
- **Health probes**: `GET /api/health` answers 200 while the projection database is reachable and
  503 otherwise; it reports the version, maintenance mode and the number of live sessions. Use it
  for load-balancer and container health checks.
- **Response headers**: every response carries `X-Content-Type-Options`, `X-Frame-Options` and
  `Referrer-Policy`; the web client is served with a content security policy that only allows its
  own scripts, and attachments are served under a sandboxed policy so an uploaded HTML file cannot
  act as the application.
- **Shutdown**: `SIGTERM` or `SIGINT` stops accepting requests, waits up to 10 seconds for in-flight
  ones, closes WebSocket sessions with "going away" and exits. A write that was already published to
  Git is never lost: the projection replays it on the next start.
- **Back up the bare repository**: `git clone --mirror data/corestone.git` is a complete backup. The
  database is derived.
- **Several server processes** may share one repository and one database; writes are protected by
  the Git compare-and-swap and the database `processed_hash` CAS, and maintenance mode is
  advertised through the database.
- **Containers**: the `Dockerfile` builds the client and the server into one image that runs as an
  unprivileged user, keeps the repository under `/data` and has a health check on `/api/health`.
  `docker-compose.yml` starts it together with PostgreSQL:

  ```sh
  docker compose up --build          # http://127.0.0.1:8080
  CORESTONE_VERSION=1.0.0 make docker   # or just the image, tagged corestone:1.0.0
  ```

- A minimal systemd unit:

  ```ini
  [Unit]
  Description=Corestone
  After=network.target postgresql.service

  [Service]
  ExecStart=/opt/corestone/bin/corestone -repo /var/lib/corestone/corestone.git -addr 127.0.0.1:8080 \
    -web /opt/corestone/web/dist -db postgres://corestone:secret@localhost/corestone?sslmode=disable
  Restart=on-failure
  User=corestone

  [Install]
  WantedBy=multi-user.target
  ```

## Troubleshooting

- **`-db (or CORESTONE_DB) is required`** — the projection database is mandatory; see §2.
- **`projection schema: ... ltree`** — the `ltree` extension could not be created: install
  `postgresql-contrib` or create the extension as a superuser once.
- **HTTP 503 with `Retry-After`** — maintenance mode (a reindex or a large folder move is running;
  `GET /api/repository` shows the phase and progress) or the database is unreachable. Reads fail
  closed on purpose: a fabricated empty answer could, for example, let a duplicate HID through.
- **HTTP 412** — your `If-Match` ETag is stale; someone changed the artifact. Re-read and merge.
- **HTTP 409** — duplicate HID, cardinality violation, or too much write contention (retry).
- **The client shows "syncing…"** — a direct push landed; the server replays it within seconds.
