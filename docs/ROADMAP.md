# Roadmap: what is still missing, and how to build it

An honest assessment of the gaps in Corestone as of the production pass, ranked by how much each
one would block a real deployment, with a concrete plan for each. Plans name the packages that
exist today (`internal/gitx`, `internal/projection`, `internal/foundation`, `internal/httpapi`,
`web/`) so that each one can be started without a design phase. Effort is a working estimate for
one engineer who knows the code base, including tests and documentation.

Groups:

1. [Blocking for production use](#1-blocking-for-production-use)
2. [Will hurt as the repository grows](#2-will-hurt-as-the-repository-grows)
3. [Product features a requirements or PLM team will ask for early](#3-product-features-a-requirements-or-plm-team-will-ask-for-early)
4. [Engineering hygiene](#4-engineering-hygiene)
5. [Suggested order](#5-suggested-order)

---

## 1. Blocking for production use

### 1.1 Authentication and authorization

**Gap.** There is none. Anyone who reaches the port can read and rewrite everything, and the commit
author is whatever name the browser sends.

**Design.** Identity comes from an existing provider; the server never becomes one.

- **Built-in OIDC as the primary mode.** The OpenID Connect authorization-code flow with PKCE
  against whatever the team already runs (Entra, Google, Keycloak, Okta), using `coreos/go-oidc`
  for discovery and token validation. The result is an encrypted, HttpOnly, SameSite session
  cookie, which keeps the single-binary deployment. A `-auth proxy` mode trusts identity headers
  from a listed proxy address only, for teams that already run oauth2-proxy or Authelia. A
  `-auth none` mode keeps today's behaviour for local development and is never the default.
- **Personal access tokens** for scripts, CI and the seed script: generated in the client, stored
  as a hash in PostgreSQL rather than in Git, sent as a bearer header, scoped to a role and an
  expiry.
- **The identity reaches Git.** The Foundation sets the author name and email of every commit
  from the verified principal and refuses a client-supplied author; the presence hub uses the same
  name. That is what turns the history into an audit trail.
- **Authorization as configuration.** An `access.json` in a folder's `.corestone` directory,
  inherited down the tree with nearest-wins exactly like schemas and workflows. Four roles:
  reader (artifacts and history), editor (create, update, transition, comment, attach),
  maintainer (schemas, workflows, folder moves, deletes) and admin (reindex, relocate metadata,
  tokens, access). Grants name users or identity-provider groups, so membership is maintained
  once. The root access file is bootstrapped from an `-admin` flag on first start.
- **Enforcement in the Foundation**, not the HTTP layer, with the principal carried in the
  request context, so the WebSocket and any future transport inherit the rules. Reads are
  filtered by permitted scopes through the existing `ltree` hierarchy: one prefix filter on the
  allowed paths, resolved once per request.
- **Two consequences to document.** Direct access to the bare repository is admin access, so
  only the service account may reach it and mirrors need hooks on the hosting side. Cookies bring
  CSRF into scope: SameSite=Lax plus a required custom header on every state-changing request
  closes it.

**Plan.**

1. `internal/auth`: a `Principal{Subject, Name, Email, Groups}` type, a context accessor, and the
   three authenticators (`none`, `proxy`, `oidc`) behind one interface. Session cookies sealed with
   a key from `-session-key` (or generated and persisted in `repo_state` on first start).
2. `internal/foundation`: every operation takes the principal from the context; `write()` builds
   the commit author from it and rejects any author field in request bodies. The `Corestone-Actor`
   trailer records the subject for audit queries.
3. `internal/httpapi`: an authentication middleware, `GET /api/me`, `POST /api/logout`, the OIDC
   callback route, the CSRF header check on non-GET requests, and token management routes.
   Personal access tokens live in a new `tokens` table (hash, subject, role, expiry, last use).
4. `internal/model`: parse and compose `access.json` in the same lexical, nearest-wins way as
   schemas; `internal/projection` indexes it as a config category so the effective role for a
   path is one lookup. `Search` and `Tree` gain a `scopes` filter expressed as `ltree` prefixes.
5. `web/`: a sign-in redirect on 401, the current user in the header instead of the free-text
   name, a token page, and hiding of actions the role does not allow (the server still enforces).
6. Tests: Foundation tests for every role boundary and for the author override; HTTP tests for
   the CSRF check, the proxy allow-list and expired tokens; a browser test that a reader sees no
   edit controls and a direct API write from that session is refused.

**Order of work.**

1. Proxy-header mode, verified commit authors, and a single all-or-nothing role. About a day, and
   it makes the system deployable behind what most teams already run.
2. Built-in OIDC and personal access tokens.
3. Folder-scoped roles with filtered reads, plus Foundation and browser tests for every role
   boundary.

**Effort.** 6 to 8 days in total.

### 1.2 Operational visibility

**Gap.** Logs and a health probe exist, but there are no metrics and no structured logging.
Saturation of the write mutex is invisible until users notice.

**Plan.**

1. Metrics with `prometheus/client_golang`, served on a separate `-metrics-addr` listener (default
   off) so they are never exposed with the application port. The set that matters:
   - `http_requests_total{route,method,status}` and `http_request_duration_seconds{route}`,
     recorded in the existing access-log middleware.
   - `write_wait_seconds` (time spent waiting for `writeMu`), `write_attempts_total{outcome}`
     (published, stale retry, conflict, maintenance) and `commit_duration_seconds`, recorded in
     `foundation.write`.
   - `projection_lag_commits` (head minus processed, from `Watch`), `reindex_duration_seconds{phase}`
     and `maintenance` (0/1), recorded in `projection`.
   - `ws_sessions` from `Hub.Clients()`, and `database/sql` pool stats via the standard collector.
2. Structured logging with `log/slog`: `-log-format text|json`, one logger passed down instead of
   the package-level `log`, a request id generated per request and echoed in an `X-Request-Id`
   response header, and the same id on every log line the request produces.
3. Alert-ready documentation in INSTALL: which metric to alert on and at what threshold (write
   wait p95 above one second, lag above zero for more than a minute, maintenance longer than the
   last reindex duration times two).
4. Tests: a metrics test in `httpapi` that scrapes the registry after a request and checks the
   counters moved; a test that a log line for a failing request carries the request id.

**Effort.** 2 days.

### 1.3 Schema editing in the client

**Gap.** Schemas and workflows are JSON files managed through the API or Git. Fine for
developers, a wall for everyone else.

**Plan.**

1. Server: `POST /api/schemas/{type}/preview?scope=` takes a candidate schema and returns the
   impact without writing: the artifacts of that type in scope that would become invalid, each
   with the field and reason, using the existing validation in `internal/model` against the
   candidate `SchemaIndex`. The same for `POST /api/workflows/{id}/preview` (artifacts whose
   current state no longer exists). Both are cheap because the projection already indexes fields.
2. Client, schema editor (`web/src/schema-editor.ts`): a form over the schema document, not a JSON
   text area. Field list with drag ordering, per-field type, required, options for enums, target
   types for references, presentation columns, HID prefix and digits, workflow assignment. Link
   schemas get source and target types and cardinality. A JSON tab shows the exact file that will
   be committed, because the file is the contract.
3. Client, workflow editor: the existing state diagram becomes editable; states and transitions
   are added by clicking, with the initial state and transition names in a side panel.
4. Impact panel: before saving, the preview endpoint runs and the editor lists what would break,
   with a link to each artifact. Saving with impact requires an explicit confirmation.
5. Scope chooser: the editor shows where the file lives (which folder's `.corestone`) and which
   folders inherit it, using the existing types endpoint.
6. Tests: Foundation tests for both preview endpoints; browser tests that create a type from
   scratch, add an enum field, see the impact of removing a required field, and edit a workflow
   transition.

**Effort.** 5 to 7 days.

---

## 2. Will hurt as the repository grows

### 2.1 Write throughput

**Gap.** Commits are serialized, roughly ten per second per process. A burst of creates from one
client delays another client's single save by seconds.

**Plan.**

1. `POST /api/batch`: an ordered list of operations (create, update, delete, move, transition,
   link, comment), at most 500, executed as one changeset in one commit through the existing
   `write()`; the transaction already builds multi-file changesets. All-or-nothing: the first
   validation failure aborts with the index of the failing operation. The response carries the
   per-operation result (GUID, ETag) in order. Operations in one batch may reference each other
   by index (`"$0"`), so a batch can create an entry and link it in one commit.
2. Commit message: the subject summarizes counts per operation, and one `Corestone-Op` trailer
   per operation keeps the history greppable, exactly as single operations do today.
3. The seed script, the end-to-end script and the browser tests' fixtures use the batch endpoint,
   which also makes the suites faster.
4. Fairness: `writeMu` is first come, first served in practice, but a batch holds it once for
   many operations, so a burst no longer starves single saves.
5. Measure before and after with the load test from 4.2; publish the numbers in INSTALL.

**Effort.** 3 days.

### 2.2 Reindex time

**Gap.** A full rebuild walks the entire history; on a repository with years of commits this takes
minutes, and writes are refused meanwhile.

**Plan.**

1. Phases one to three (identity, fields, full text) already build from the head tree and scale
   with the tree, not the history. Only phase four, the history walk, scales with the number of
   commits. Make it incremental: `repo_state` records `history_cursor`, the last commit whose
   history events are stored. A rebuild keeps `hid_history` and `deleted_artifacts` rows from
   before the cursor and walks only newer commits, unless the branch was rewound (already detected
   by `Sync`), in which case it walks from the root as today.
2. Let the phases overlap with service: reads already follow the capability flags, so publish
   capabilities per phase more finely (lookup after phase one, queries after two, search after
   three) and let writes through once phase two is complete, since phase four never blocks a
   write's validation.
3. `POST /api/repository/reindex?history=defer` runs phases one to three now and schedules the
   history phase in the background at low priority.
4. Tests: a test that rebuilds after a rewind walks from the root; a test that a rebuild after
   normal commits keeps the older history rows and reaches the same snapshot as a full walk (the
   suites already compare live against rebuilt projections).

**Effort.** 3 days.

### 2.3 Attachments in Git

**Gap.** Binaries bloat the repository forever; the cap is 32 MiB per file.

**Plan.**

1. A blob store behind an interface with two implementations: a directory (`-blobs /var/lib/...`)
   and S3-compatible object storage (`-blobs s3://bucket/prefix`), content-addressed by SHA-256.
2. Attachments above a threshold (`-blob-threshold`, default 1 MiB) are stored there; the
   repository holds a pointer file in the Git LFS pointer format (`version`, `oid sha256:…`,
   `size`), so standard `git lfs` clients read a mirror correctly and nothing custom is invented.
3. The scanner classifies pointer files as attachments; `GET /files/{name}` streams from the store
   with the existing ETag and sandbox headers; deletion removes the pointer and leaves the blob to
   a garbage-collection command (`corestone gc-blobs`) that walks the head tree and history.
4. Tests: round trip through both stores, a pointer read by the `git lfs` command line in the
   end-to-end script, and the garbage collector on a repository with a deleted attachment.

**Effort.** 3 to 4 days.

### 2.4 Presence is per process

**Gap.** With two servers, users only see collaborators on their own server.

**Plan.**

1. PostgreSQL `LISTEN/NOTIFY` on a `corestone_events` channel: every hub publishes its presence
   changes and the Foundation's commit and status events with a process id; every hub subscribes
   (one dedicated connection per process, reconnecting with backoff) and rebroadcasts to its own
   clients. Payloads above the 8 KB notify limit fall back to a `hub_events` table row plus a
   notification carrying its id.
2. Presence becomes a merge: each hub keeps the last presence of every remote process with a
   timestamp; a process that stops heartbeating for thirty seconds is dropped.
3. The Watch loop no longer needs to poll for other processes' commits: the publisher notifies,
   the others sync at once; polling remains as the fallback for direct pushes.
4. Tests: the existing two-process Foundation test grows a hub on each side and asserts that a
   viewer on one appears on the other; a browser test with two servers behind the same database.

**Effort.** 2 days.

---

## 3. Product features a requirements or PLM team will ask for early

### 3.1 Baselines

**Gap.** Tagging a release and diffing two baselines is standard in this domain.

**Plan.**

1. A baseline is a Git tag `refs/tags/baselines/<name>` on the managed branch, created through
   `gitx` with `update-ref` (compare-and-swap against a missing ref) and an annotated message that
   carries the description and the actor. `POST /api/repository/baselines {name, description}`,
   `GET /api/repository/baselines`, `DELETE` for maintainers.
2. `GET /api/repository/diff?from=<baseline|commit>&to=<baseline|commit|head>&path=` uses the
   existing `DiffTree` to list changed files, maps them to artifacts through the history table
   (GUID by path at each commit), and reports added, removed and changed artifacts; for changed
   ones, field-level differences computed on the two `ojson` documents, so key order and formatting
   never show up as changes.
3. Reading as of a baseline: `GET /api/artifacts/{guid}?at=<baseline>` resolves the path at that
   commit and reads the blob with `gitx.ReadPath`; the client shows a read-only banner.
4. Client: a baselines list in the repository view, a "compare" picker producing a three-column
   diff (removed, changed with field diffs, added), and an "as of" switch on the detail view.
5. Tests: create a baseline, change two artifacts and delete one, diff, assert the three lists;
   the same through the browser.

**Effort.** 4 days.

### 3.2 Import and export

**Gap.** No way in from spreadsheets or ReqIF, no way out to documents.

**Plan.**

1. CSV import: `POST /api/import/csv?path=&type=&dryRun=1` (multipart). Columns map to fields by
   id or display name, with `title`, `hid` and `folder` as reserved columns; an existing HID means
   update, otherwise create. Dry run returns a row-by-row validation report using the same
   validation as single writes; a real run goes through the batch endpoint (2.1) so one import is
   one commit. Client: an import dialog with column mapping and the report.
2. CSV export: `GET /api/repository/search?…&format=csv` streams the current overview columns.
3. ReqIF import: parse SPEC-OBJECTS into entries (attribute definitions map to fields, created as
   a schema in the target folder when absent), SPEC-RELATIONS into links, SPEC-HIERARCHY into a
   document whose content references the entries. Dry run first, then one batch commit per
   specification. Export in a later step if a customer needs round-tripping.
4. Document export: server-side HTML rendering of a document with resolved entry references and
   a print stylesheet, downloadable as HTML; PDF through headless Chromium when
   `-chromium` is configured; DOCX through a pure-Go writer (`gomutex/godocx`), mapping section,
   paragraph, list, code, image and entry-reference blocks.
5. Tests: fixtures for each format, dry-run reports with deliberate errors, and a round trip
   CSV export, edit, import.

**Effort.** CSV 2 days, ReqIF 5 days, export 3 days.

### 3.3 Bulk operations

**Gap.** One artifact at a time.

**Plan.**

1. Overview: a checkbox column, shift-click ranges, select all in view, and a selection bar with
   transition (only transitions valid for every selected artifact), move, set field, delete.
2. Every bulk action is one batch request (2.1), so it is one commit with per-item outcomes; the
   bar shows progress and lists failures with links.
3. Keyboard: space toggles, `x` selects all, `Escape` clears.
4. Tests: browser tests for a bulk transition with a mixed selection (the disallowed transition
   is not offered), a bulk move that updates the tree, and a bulk delete with confirmation.

**Effort.** 2 days, after 2.1.

### 3.4 Rich text

**Gap.** Content is plain text blocks.

**Plan.**

1. Inline marks stored as a constrained Markdown subset inside block text: bold, italic, code,
   links. Storage stays text, so full-text extraction, diffs and the existing size limits are
   untouched, and no HTML is ever stored. A small parser in `web/src/inline.ts` renders marks to
   DOM nodes directly (never `innerHTML`), and the server validates that links use safe schemes,
   as it already does for fields.
2. A `table` block: `{type:"table", header: bool, rows: [[text]]}`, rendered as a grid editor with
   add and remove row and column; full-text extraction concatenates cells.
3. Editor: a floating toolbar on selection (bold, italic, code, link), keyboard shortcuts, and
   paste handling that strips formatting to the subset.
4. Tests: parser tests for every mark and for malformed input; a browser test that formats text,
   saves, reloads and finds the same marks; adversarial tests that pasted HTML never becomes markup.

**Effort.** 4 days.

### 3.5 Saved views and notifications

**Gap.** No persisted filters; the only notification channel is the open WebSocket.

**Plan.**

1. Shared saved views as configuration: `.corestone/views/<id>.json` with folder, subtree,
   kind, type, query, field filters, sort and columns, inherited like schemas and listed in the
   sidebar under "Views". Personal views live in a `user_prefs` table in PostgreSQL, since they
   are not part of the repository's content.
2. Subscriptions: a `subscriptions` table (subject, target artifact or folder, channel). The
   Foundation already emits commit events; a dispatcher matches events to subscriptions and
   delivers them.
3. Channels: webhooks (JSON body, HMAC-SHA256 signature header, retries with backoff, a dead-letter
   list visible to admins) and email through SMTP with a daily digest option. Web push later if
   asked for.
4. Client: a "watch" toggle on artifacts and folders, a notifications page, and view management.
5. Tests: dispatcher tests with a fake webhook server (signature, retry, dead letter); a browser
   test that a saved view reproduces its filter from the sidebar.

**Effort.** 4 days, after 1.1 (subscriptions need identities).

---

## 4. Engineering hygiene

### 4.1 OpenAPI description

**Plan.**

1. Write `api/openapi.yaml` by hand; the routes are stable and small enough that a generator
   would add more noise than value. Serve it at `GET /api/openapi.json`.
2. A test in `httpapi` walks every registered route and fails when the specification does not
   mention it, and vice versa, so the two cannot drift.
3. Generate the client's `types.ts` from the specification with `openapi-typescript` in the web
   build, replacing the hand-written types; the browser suite catches any mismatch.
4. Link the specification from the README and serve a rendered version at `/api/docs` using a
   vendored, offline copy of a viewer so the content security policy stays strict.

**Effort.** 2 days.

### 4.2 Load and soak tests

**Plan.**

1. `perf/` with k6 scripts: a create burst, a mixed read and write profile modelled on the
   browser suite's request pattern, a search-heavy profile, and a reindex during load.
2. A nightly CI job runs them against `docker compose` with a repository seeded to ten thousand
   artifacts, with thresholds that fail the job: p95 read under 100 ms, p95 single write under
   300 ms at twenty virtual users, zero 5xx.
3. A one-hour soak once a week that samples `/metrics` for goroutine, connection and memory growth
   and fails on a monotonic trend.
4. The numbers go into INSTALL under a "Capacity" heading and get refreshed by the job.

**Effort.** 2 days, after 1.2.

### 4.3 Releases and changelog

**Plan.**

1. Semantic version tags `vX.Y.Z`; `-version` already reports the tag through `ldflags`.
2. A release workflow on tag push builds binaries for linux/amd64, linux/arm64 and darwin/arm64
   with `goreleaser`, attaches them and their checksums to the GitHub release, and pushes the
   container image to the GitHub container registry with the version and `latest` tags.
3. `CHANGELOG.md` in Keep a Changelog format, maintained by hand in every pull request; the
   release workflow refuses a tag whose version has no changelog section.
4. INSTALL gains an upgrade section: the projection schema is created with `IF NOT EXISTS` today;
   introduce a `schema_version` row in `repo_state` and forward-only migrations before the first
   release that changes a table.

**Effort.** 1 day.

---

## 5. Suggested order

| Step | Items | Why now | Effort |
|---|---|---|---|
| 1 | 1.1 authentication (proxy mode, verified authors, one role) | makes the system deployable behind what teams already run | 1 day |
| 2 | 1.2 operational visibility | needed before any real traffic | 2 days |
| 3 | 1.1 authentication (OIDC, tokens, folder roles) | complete the security model | 5 to 7 days |
| 4 | 2.1 write throughput, then 3.3 bulk operations | one endpoint unlocks batch, import and bulk | 5 days |
| 5 | 1.3 schema editor | the feature that lets non-developers own the domain model | 5 to 7 days |
| 6 | 4.3 releases, 4.1 OpenAPI, 4.2 load tests | hygiene before the first external users | 5 days |
| 7 | 3.1 baselines, 3.2 CSV import and export | the two most-requested features in this domain | 6 days |
| 8 | 2.2 reindex, 2.3 attachments, 2.4 presence | scale work, when the repository size demands it | 8 to 9 days |
| 9 | 3.4 rich text, 3.5 views and notifications, 3.2 ReqIF and document export | breadth | 16 days |

Authentication first, then metrics, then the schema editor: those three turn a working system into
one that can be handed to a team.
