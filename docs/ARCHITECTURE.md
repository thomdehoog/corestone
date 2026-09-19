# Source structure

A guided tour of the repository: what each package does and how a request flows through them.
Layers only depend downward.

```
cmd/corestone              wiring: flags, HTTP server, response headers, access log, graceful shutdown
  └─ internal/httpapi      REST + WebSocket: decoding, ETag/If-Match, status codes, presence hub
       └─ internal/foundation   the service: operations, the §10.1 transaction, service views
            ├─ internal/projection   PostgreSQL projection (sync, replay, reindex, queries, validation)
            │     └─ internal/scanner    configurable repository scanner + foundation indexer
            ├─ internal/gitx         bare-repository Git plumbing
            └─ internal/model        domain rules (pure): identity, folders, fields, schemas, workflows, overlays
                  └─ internal/ojson      order- and format-preserving JSON
web/                     Lit + TypeScript client (talks only to /api)
```

## internal/gitx — Git as a storage engine

Drives a bare repository through plumbing subprocesses; there is never a working tree.

- `Open` creates the repository if needed and forces `core.quotepath=false`; `Head` maps only
  exit code 1 to "unborn branch" so a broken repository can never look empty.
- `BuildCommit(parent, message, ops)` hashes blobs, feeds one NUL-terminated `update-index
  --index-info` stream into a private temporary index, `write-tree`s and `commit-tree`s. The commit
  exists but is invisible until `Publish(old, new)` — a compare-and-swap `update-ref` that returns
  `ErrStale` when the branch moved.
- Reads are batched: `ListTree` (`ls-tree -r -z -l`), `ReadBlobs` (`cat-file --batch`), `ReadPath`
  with `:(literal)` pathspecs so folder names are never interpreted as pathspec magic.
- History: `FirstParentChain` (`rev-list --first-parent --parents`) for replay, `DiffTree` (raw,
  `-z`, no renames) for per-commit changes, `Log` with trailer parsing, and `Walk` — one `git log
  --raw` process streaming the whole first-parent history for the reindex history phase.
- `BlobSHA` computes an object name without touching the repository: it is the artifact ETag.

## internal/ojson — stable JSON

`Object` is an ordered JSON object; numbers keep their literal text. `Parse` records the source
text of every object; `Encode` writes an unchanged object verbatim, edits values in place, appends
new keys, and formats changed objects in the file's detected style (indent, line ending, trailing
newline). `MarshalJSON`/`UnmarshalJSON` let API responses carry documents in repository order.
Fuzzed for the fixed-point property.

## internal/model — the domain vocabulary

- `identity.go` — kinds, GUID generation/validation, HID and type-id rules.
- `folder.go` — `CleanFolder`, the single gate for user-supplied folder paths (traversal, `.corestone`,
  GUID-shaped segments, control characters, pathspec magic, depth/length limits), plus lineage
  helpers.
- `fields.go` — the field types of design guide §4.6 and value validation.
- `schema.go` — schema definitions, `Compose` (root → artifact, nearest wins, fields merge by id
  with complete replacement, `inheritance: off`), and the `SchemaIndex` used to resolve effective
  schemas, visible types and allowed link types.
- `workflow.go` — definitions, lexical resolution (nearest wins wholesale), transition lookup.
- `artifact.go` — the typed view over an artifact document; writes go back into the document so
  unknown properties survive.
- `overlay.go` — base-chain resolution with cycle and depth detection, per-field origin.
- `content.go` — document block validation, referenced GUIDs, searchable text.

## internal/scanner — which files matter

`scanner.json` (`guid_files`, `config_folders`, `indexers`) with defaults. `Classify` turns a path
into *artifact file*, *attachment*, *configuration file* (schemas, workflows, links, comments,
scanner, other) or *ignore*; configured indexers decide whether a match is processed. Only the
`foundation` indexer is built in; the registry is the extension point for application indexers.

## internal/projection — the PostgreSQL projection

- `projection.go` — connection, DDL (`repo_state.processed_hash`, `artifacts` with an `ltree` path,
  `artifact_fields`, `artifact_files`, `config_files`, `hid_history`, `deleted_artifacts`), status
  and maintenance mode (also advertised through `repo_state.maintenance` for other processes), the
  §10.1 publish mutex, ltree label encoding.
- `extract.go` — turns a blob into a row: metadata, key/value field index, sanitized search text;
  malformed files become rows with `valid = false`, never failures.
- `sync.go` — `Sync` compares `processed_hash` with HEAD and replays the first-parent chain one
  commit per transaction (`ProjectCommit` + CAS advance); anything else triggers a rebuild. Also the
  cached schema/workflow indexes.
- `reindex.go` — the phased rebuild: identity (GUID → path), fields, full text (drop GIN index,
  parallel workers stream text, recreate index), history scan (deletions, HID history, timestamps).
- `query.go` — locate, get, search (filters, states, fields, full text), folders, scopes, HID
  helpers, links/comments, attachments, configuration files, HID history, deleted artifacts,
  statistics.
- `validate.go` — the repository validation service.

## internal/foundation — the service

- `foundation.go` — `write(prepare)`: the repository update transaction. `prepare` builds the
  changeset against the head it will be published on; on a stale CAS it is re-run from scratch.
- `artifacts.go` — create/update/delete/move for entries and documents, HID generation, field and
  reference validation, workflow initialization, cascading deletes, folder moves with metadata
  relocation and maintenance mode for large operations, the relocate-metadata maintenance job.
- `metadata.go` — links (endpoint rules, cardinality, duplicates), comments (threads), transitions.
- `config.go` — schema and workflow files, attachments.
- `read.go` — views: artifact, effective schema, visible types, overlay analysis, workflow
  evaluation, relationship analysis, comments, history across moves, tree, search, status.

## internal/httpapi — transport

Routes (Go 1.22 method patterns), 4 MiB body cap, ETag/If-Match/If-None-Match per RFC 9110, error
mapping (400/404/409/412/503), kind-checked collections. `ws.go` is the session hub: hello, commit
and status broadcasts, viewer/editor presence per artifact.

## web — the client

`store.ts` (central state), `router.ts` (URL ⇄ state), `api.ts`, `ws.ts`; components `app`
(shell), `sidebar`, `overview` (with the ＋ New menu), `dialogs` (type choice → generated form →
create; picker; confirm), `fields` (one input per field type), `detail` (entry sections), `document`
(block editor + sidebars), `toast`. Components observe the store and never talk to each other. Tests
in `web/tests` drive the built client in Chromium against a live server.

## A request, end to end

`POST /api/entries` → `httpapi.create` parses the body as an ordered object → `Foundation.
CreateArtifact` enters `write`: `DB.Sync` (replay if a push landed), `prepare` validates against
the effective schema (fields, required, references, HID uniqueness, overlay chain) and stages the
file → `gitx.BuildCommit` → `DB.ProjectCommit` inside a transaction → mutex → `gitx.Publish` (CAS)
→ `DB.AdvanceProcessed` (CAS) → commit → an event is broadcast to WebSocket clients → the response
carries the document, its metadata and the ETag.
