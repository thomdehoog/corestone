<div align="center">

# Corestone

**A Git-backed storage platform for building information management applications**
— requirements, issues, PLM, documentation — where the domain model is configuration, not code.

[![CI](https://github.com/thomdehoog/corestone/actions/workflows/ci.yml/badge.svg)](https://github.com/thomdehoog/corestone/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8?logo=go&logoColor=white)](go.mod)
[![Frontend](https://img.shields.io/badge/Frontend-Lit%20%2B%20TypeScript-324FFF?logo=lit&logoColor=white)](web/)
[![Projection](https://img.shields.io/badge/Projection-PostgreSQL-4169E1?logo=postgresql&logoColor=white)](docs/INSTALL.md)
[![Source of truth](https://img.shields.io/badge/Source%20of%20truth-Git-F05032?logo=git&logoColor=white)](#how-it-works)
[![License](https://img.shields.io/badge/License-Apache%202.0-D22128?logo=apache&logoColor=white)](LICENSE)

<img src="docs/screenshot.png" alt="Corestone web client: folder and type navigation, the artifact overview with HIDs and workflow states, and a schema-generated detail view" width="900">

*The generic client renders itself from the repository's schemas: navigation, overview columns,
detail sections, workflows and relationship types all come from configuration.*

</div>

---

## What it is

The Foundation stores, versions, organizes and relates structured information. It knows four
native artifact kinds and nothing about any business domain:

| Kind | Purpose | Stored at |
|---|---|---|
| **Entry** | Reusable structured object (requirement, ticket, part, …); may be an *overlay* of another entry | `<folder>/<guid>/.corestone.json` |
| **Document** | Hierarchical composition: sections, text, media and references to entries | `<folder>/<guid>/.corestone.json` |
| **Link** | Directed, typed relationship between any two artifacts | `<scope>/.corestone/links/<guid>.json` |
| **Comment** | Threaded annotation on any artifact (whole artifact, a field, a document element) | `<scope>/.corestone/comments/<guid>.json` |

Everything domain-specific lives in JSON configuration inside the repository:

- **Schemas** (`<scope>/.corestone/schemas/<type>.json`) define artifact types — fields with the
  Foundation's generic field types, HID generation, workflow assignments, link-type endpoint rules
  and cardinality, presentation hints. Schemas compose **lexically** from the repository root to the
  artifact: nearer definitions refine or replace, `"inheritance": "off"` severs everything above.
- **Workflows** (`<scope>/.corestone/workflows/<id>.json`) are state machines; an artifact can be in
  several at once, each with its own state.
- **Scanner configuration** (`.corestone/scanner.json`) tells the repository scanner which markers to
  look for (GUID files, configuration folders, indexers), so applications can extend the format.

## How it works

> **Never trust metadata when the primary data already exists.**

**Git is the single source of truth.** A bare repository holds every artifact and every piece of
configuration; each logical operation is exactly one commit with a structured message
(`Entry REQ-42 in specs/boot created`, plus `Corestone-Op` / `Corestone-Guid` trailers). Commits are built
with plumbing only — no working directory — and published with a compare-and-swap `update-ref`.

**PostgreSQL is a rebuildable projection.** Plain SQL, no ORM. It holds the GUID → path table, the
hierarchy as `ltree`, artifact metadata, an indexed key/value field index, a GIN full-text index,
HID history, deleted-artifact records and the `processed_hash` of the revision it represents.
Missing commits are replayed sequentially; when replay is impossible the projection is rebuilt in
the four phases of the design guide (identity → fields → full text → history scan) while the API
reports maintenance mode and progress.

**Every write runs the repository update transaction** (design guide §10.1):

```
sync projection to HEAD → validate & build the commit object (unpublished)
→ begin DB transaction → project the commit (not processed_hash)
→ [mutex] publish with CAS update-ref → advance processed_hash (CAS) → [release]
→ commit DB transaction        (stale CAS: rollback, rebuild on the new head, retry)
```

Validation therefore always sees the head it publishes on: HID uniqueness, overlay acyclicity,
link endpoint and cardinality rules, reference integrity and workflow legality hold under
concurrent writers and across several server processes sharing one repository and database.

**Repository files are stable.** An order-preserving JSON codec re-writes unchanged objects byte for
byte, keeps property positions, appends new properties, and preserves indentation, line endings
and trailing-newline style, so Git history shows logical changes only — and files edited by hand or
by other tools (including their unknown properties) survive API updates.

## Quick start

Requirements: Go 1.24+, git, Node 22+ (web client), PostgreSQL 14+ (16 recommended) with the
`ltree` extension available.

```sh
createdb corestone
make build                      # web/dist + bin/corestone
./bin/corestone -repo data/corestone.git -addr 127.0.0.1:8080 -web web/dist \
  -db "postgres://user:pass@localhost:5432/corestone?sslmode=disable"
./examples/seed.sh              # a demo requirements domain
```

Open <http://127.0.0.1:8080>. Or with containers: `docker compose up --build`. Full instructions,
including deployment notes, health probes and the systemd unit, are in
[docs/INSTALL.md](docs/INSTALL.md).

## The client

A Lit + TypeScript single-page application with a central store, a URL router (every state is a
deep link), a REST client and a WebSocket session client. It contains no domain knowledge:

- **Navigation** — search, subtree toggle, the physical folder tree, and artifacts grouped by type.
- **Overview** — a table whose columns come from schema presentation metadata, with kind filters and
  the **＋ New** flow: choose a type visible at the current folder, fill an empty schema-generated
  form, create.
- **Entry detail** — one scrollable page with quick links: general, fields, workflows (state
  dropdown with available transitions and a diagram), relationships (with allowed link types),
  threaded comments, attachments, overlay composition (chain and per-field origin), history, and
  pass-through metadata. Saves use `If-Match`; concurrent edits are announced over the session
  channel and rejected with 412 rather than silently overwritten.
- **Document view** — a distraction-free block editor (sections, paragraphs, entry reference cards,
  lists, code, images) with optional sidebars: properties, current entry, relationships, comments,
  versions.

## REST API

Artifact APIs (`{guid}` routes are kind-checked: an entry GUID is 404 under `/documents`):

```
POST /api/entries | /api/documents        {path, type, title, hid?, base?, fields?, content?}
POST /api/links                           {type, source, target, fields?}
POST /api/comments                        {subject, text, parent?, author?, type?, anchor?, fields?}
GET  PUT  DELETE /api/{entries|documents|links|comments|artifacts}/{guid}   ETag / If-Match
GET  PUT  DELETE /api/artifacts/{guid}/files/{name}                          attachments
```

Service APIs:

```
GET  /api/health                          liveness/readiness: 200 while the database answers, 503 otherwise; version, sessions
GET  /api/repository                      head, projection status, statistics, scanner config
GET  /api/repository/tree?path=&subtree=  folders and artifacts
GET  /api/repository/search?q=&kind=&type=&path=&subtree=&hid=&field.<id>=&state.<wf>=&sort=&limit=&offset=
GET  /api/repository/types?path=          effective schemas visible at a folder
GET  /api/repository/validate             repository invariants: dangling refs, duplicate HIDs, cycles, misplaced metadata, …
POST /api/repository/reindex              full phased rebuild (202; progress in status and over WebSocket)
POST /api/repository/folders/move         {from, to} — moves artifacts, attachments, configuration and metadata
POST /api/repository/maintenance/relocate-metadata     restore metadata locality after direct Git edits
GET  /api/repository/hids/{hid}           current and historical owners of a HID
GET  /api/repository/deleted?guid=        deleted artifacts with their deletion commit
GET  /api/artifacts/{guid}/schema | overlay | workflows | relationships | comments | history
POST /api/artifacts/{guid}/transition     {workflow, to}      POST /api/artifacts/{guid}/move  {path}
GET  /api/schemas | /api/schemas/effective?type=&path= | PUT DELETE /api/schemas/{type}?scope=
GET  /api/workflows | GET /api/workflows/{id}?path=       | PUT DELETE /api/workflows/{id}?scope=
WS   /api/ws                              session service: commits, status, presence
```

Errors are JSON `{"error": …, "status": …}`: 400 validation, 404, 409 conflict (duplicate HID,
cardinality, contention), 412 stale `If-Match`, 503 maintenance mode or projection unavailable
(reads fail closed), 504 when a request exceeds its deadline. Bodies are capped at 4 MiB
(attachments 32 MiB). WebSocket sessions are same-origin only unless origins are allowed explicitly.

## Repository layout

```
cmd/corestone       server binary: flags, security headers, access log, health probe, graceful shutdown
internal/gitx         bare-repository plumbing: CAS commits, batched reads, first-parent history walks
internal/ojson        order-preserving, format-preserving JSON
internal/model        kinds, GUIDs/HIDs, folder rules, field types, schema composition, workflows, overlays, content
internal/scanner      configurable repository scanner and the foundation indexer
internal/projection   PostgreSQL projection: sync/replay, phased reindex, queries, validation
internal/foundation   the service: operations, the §10.1 transaction, service views
internal/httpapi      REST layer and WebSocket hub
web/                  Lit + TypeScript client and Playwright tests
```

## Testing

```sh
export CORESTONE_TEST_DSN=postgres://postgres:postgres@127.0.0.1:5432/corestone_test?sslmode=disable
make test        # go vet, gofmt gate, all packages with -race (PostgreSQL-backed tests skip without the DSN)
make lint        # golangci-lint (errcheck, staticcheck, govet, unused, ...); CI runs it too
make fuzz        # fuzz smoke: JSON codec fixed point, folder validation envelope, scanner classification
make e2e         # REST end-to-end script against a temporary server
make test-ui     # Playwright smoke suite; make test-ui-all runs every browser suite (needs the corestone_e2e database): the + New flow, every field type through the
                 # generated form, attachments, the block editor, workflows, relationships, overlays, HID renames, moves,
                 # search and deep links, keyboard shortcuts, responsive and dark mode, reindex, two users in separate
                 # contexts (presence, live updates, conflicts), plus adversarial cases (script-looking content,
                 # javascript:/data: URLs, over-long input, double submit, garbage deep links)
```

Adversarial suites live next to the regular ones: `internal/foundation/adversarial_test.go` (hostile
inputs, validation races between concurrent writers, hostile direct pushes, writes during reindex,
branch rewinds), `internal/httpapi/adversarial_test.go` (limits, injection-shaped parameters, path
tricks, WebSocket abuse) and `web/tests/adversarial.spec.ts`.

Integration tests compare the live, incrementally maintained projection with a full rebuild after
every scenario (including concurrent writers in two server processes), so "rebuildable from Git" is
verified on every run rather than assumed.

## Documentation

| Document | Contents |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Install, run, define a domain, deploy |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Source tour and how a request flows |
| [DESIGN_NOTES.md](DESIGN_NOTES.md) | Design guide vs. implementation: adopted, adapted, deferred, and what testing found |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is still missing, ranked by how much it blocks a deployment, with a plan for each item |
| [docs/Corestone_Roadmap.docx](docs/Corestone_Roadmap.docx) ([PDF](docs/Corestone_Roadmap.pdf)) | The roadmap as a specification document in the format of the design guide, for sharing |

## License

Corestone is released under the [Apache License 2.0](LICENSE).
