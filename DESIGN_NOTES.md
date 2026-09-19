# Design notes — the design guide vs. this implementation

How this code base relates to the *Origoa Foundation* design guide (the project was since renamed Corestone): what was adopted as
written, what was adapted and why, what was deliberately not built, what testing changed, and
what remains. Section numbers (§) refer to the guide.

## 1. Adopted as specified

**Git as the single source of truth, everything else a projection (§1.3, §3.8, §5.2).** A bare
repository holds artifacts, links, comments, schemas, workflows and the scanner configuration.
The projection is rebuilt from Git by `Reindex` and, in tests, after every scenario the live
projection is compared table by table with a fresh rebuild.

**Plumbing only, one commit per logical operation, CAS publication (§5.3, §5.4).** `hash-object`,
`update-index --index-info`, `write-tree`, `commit-tree` on a private index, then
`update-ref <ref> <new> <old>`. No working directory exists anywhere.

**The repository update transaction (§10.1), literally.** `Foundation.write` runs: sync the
projection to HEAD → build the changeset and the (unpublished) commit → begin the PostgreSQL
transaction → project the commit excluding `processed_hash` → acquire the short-lived mutex →
publish with CAS → advance `processed_hash` → release → commit. A stale CAS rolls back and
rebuilds the changeset on the new head; every validation is redone. If the database commit fails
after publication, Git is ahead and the next synchronization replays the commit.

**Sequential replay, then full rebuild (§5.13, §5.14).** `Sync` reads `processed_hash`, walks the
first-parent chain to HEAD and replays each commit in its own transaction with a CAS on
`processed_hash`. Only when the stored revision is missing, not on the chain, or the branch was
rewound does a rebuild run.

**The phased reindex (§3.15, §5.15, §10.3).** Maintenance mode → phase 1 identity rows (GUID →
path; lookup available) → phase 2 field indexing (metadata and key/value index; queries available)
→ phase 3 drop the GIN index, parallel workers stream searchable text from Git, recreate the index
(search available) → phase 4 a single first-parent history walk records deleted artifacts (§5.16),
HID history (§2.2.1) and creation/modification times. Progress and capabilities are exposed in the
status and pushed over the session channel.

**Hierarchy with PostgreSQL's hierarchical path type (§3.11, §5.8).** Folder paths are stored as
`ltree` (each name encoded exactly into a label) with a GiST index; subtree queries use `<@`.

**Structured commit messages (§3.9, §5.5)** with human subjects plus `Corestone-Op`, `Corestone-Guid`
and related trailers; never interpreted, only displayed.

**Metadata locality (§3.4).** Links and comments are stored in the nearest `.corestone` above their
source/subject; moving an artifact or a folder relocates them, and a maintenance operation restores
locality after manual Git changes. The validation service reports misplaced metadata.

**Identity (§2.2.1–§2.2.2).** Permanent GUIDs; all references GUID-based; HIDs generated from a
schema prefix (optionally zero-padded), editable, unique across the repository, with a queryable
history that never re-issues a number.

**Schema composition (§4.3–§4.4)** root → artifact, nearest definition wins per property, fields
and link rules replaced completely by nearer definitions, `inheritance: off` severs. Artifact types
exist for all four kinds (§4.5): link types carry endpoint constraints and cardinality (§4.8),
comment types can add fields.

**Field types (§4.6).** hid, boolean, integer, float, currency, date, time, datetime, text,
multiline, richtext, enum (single/multiple, user-extendable), hyperlink, reference(s), attachment,
json, workflow.

**Stable JSON serialization (§3.16).** Unchanged objects are written verbatim from their source
text; edits keep positions; new properties append; indentation, line endings and trailing-newline
style are detected and kept; unknown properties pass through untouched.

**Configurable scanner (§10.4)** with `guid_files`, `config_folders` and an indexer registry.

**The frontend (§7).** Lit + TypeScript Web Components, central store, URL router with deep links
for folder, artifact, query, filters, detail section, sidebars and layout, REST client, WebSocket
session client with presence and conflict warnings (§7.16.3), schema-driven views (§7.10), the
three-area layout (§7.2), the entry detail sections (§7.5), the document view with sidebars (§7.6).

## 2. Adapted — same intent, different mechanics

**Validation boundary (§4.11).** The guide assigns business validation to applications. The
Foundation enforces exactly the invariants whose violation would corrupt the repository contract:
HID uniqueness, overlay acyclicity, reference integrity (bases, link endpoints, comment subjects and
parents, reference fields, entry blocks), link endpoint types and cardinality when a link schema is
visible, workflow legality, field *type* validity and `required` fields. Unknown fields are allowed
so applications and tools can extend files.

**The publish mutex is per process; correctness across processes rests on the two CAS operations
(§5.12).** The Git `update-ref` and the `processed_hash` update are both compare-and-swap, so a
second server sharing the repository and database cannot skip or double-apply a commit. Maintenance
mode is additionally advertised through the database so other processes refuse writes during a
rebuild.

**Large structural operations (§10.2).** Folder moves count affected files and enter maintenance
mode above a threshold; the whole move is still one commit and one projection transaction.
Estimated durations are not computed — at this scale a count is the useful signal.

**Full-text and field indexing scope.** Every artifact's fields are indexed as key/value pairs and
all string content is searchable, rather than only fields marked by the effective schema. It is a
superset that avoids re-projecting artifacts when a schema changes; a `searchable: false` flag is
accepted in schemas for applications that want to narrow presentation.

**Reads that hit a stale projection.** Instead of a continuous synchronization service, a
background watcher checks the head every few seconds, and every read that notices a lag
resynchronizes first. Direct pushes therefore appear within seconds.

**Document editor.** The guide names BlockSuite. The client ships a small block editor of its own
(sections, paragraphs, entry reference cards, lists, code, images) with the same content model, so
the MVP's "compose documents from reusable entries" criterion is met without a large dependency.
Swapping in BlockSuite is a component-level change: the content tree is the contract.

## 3. Deliberately not built

Listed by the guide as outside or beyond the MVP (§9.8, §9.10):

- Authentication, permissions, TLS — the server must sit behind a trusted proxy.
- Extension hooks and UI extensions (§8) — the indexer registry and the pass-through of unknown
  properties are the only extension seams.
- Anchored comments inside document text ranges — comments carry an optional `anchor` object, but
  the editor does not maintain anchors while editing.
- Branching/merging, distributed repositories, historical-revision reads.
- Enumerations generated by extensions or from repository artifacts (§4.6) — user-defined and
  user-extendable enumerations are implemented.

## 4. What testing changed

Real defects found while building, each fixed and covered by a test:

1. **Reading HEAD before `processed_hash` escalated a benign race into a full rebuild.** A second
   process could publish and advance the projection between the two reads, making the projection
   look "ahead" of the head. Reading `processed_hash` first, and treating "projection ahead of a
   re-read head" as a rewind only when it persists, fixed it.
2. **HID history was reconstructed out of order.** Buffering modification pairs until the end of the
   history walk put an artifact's creation event before its rename events. Events are now applied in
   walk order in batches, and deleted artifacts' HID history is reconstructed too, so the rebuild
   equals the incrementally maintained tables.
3. **A `\u0000` escape in a field wedged the projection.** PostgreSQL rejects it in `jsonb`; the
   sanitizer only looked for raw NUL bytes. All projected text and JSON is now cleaned, and a test
   commits NULs, invalid JSON and mismatched schema files to prove the projection stays rebuildable.
4. **A transient HID conflict inside validation was reported as final.** Two processes generating
   the same next number: the loser now retries on the new head instead of failing the request.
5. **The client dropped `subtree=false`.** Booleans that were false were omitted from query strings,
   so the server default (`true`) applied and folder views showed nested content.
6. **A soft refresh while editing replaced the ETag.** After another user's change, the view was
   swapped in even with a dirty draft, so the next save succeeded and silently overwrote the other
   change. The draft and its original ETag are now kept; saving is rejected with 412 and the user is
   offered a reload.
7. **Two overlapping loads mixed artifacts.** Navigating from one artifact to another while a
   refresh for the first was in flight showed the second's title with the first's schema and draft.
   Loads carry a sequence token; stale results are discarded.
8. **A CSS class collision made navigation rows 80 px tall**, and grid items without
   `min-width: 0` let a wide table scroll the whole shell sideways. Both were caught from screenshots
   taken by the browser tests.

The adversarial round (hostile inputs, validation races, hostile repository content, HTTP abuse,
browser injection) added these:

9. **A pushed file claiming an existing GUID displaced the real artifact.** The projection now keeps
   the first owner of a GUID; the claimant is recorded in `file_issues`, reported by validation as
   `duplicate-guid`, and promoted only if the owner disappears.
10. **The history phase identified artifacts by directory name**, so files whose GUID differs from
    their directory (hand-made or hostile) got no timestamps or HID history on rebuild, and an
    impostor's commits were attributed to the real artifact. Identity is now resolved per path from
    the projected rows or the blob, moves are recognized as deletion + addition of the same GUID in
    one commit, and other paths claiming a live GUID are ignored.
11. **Attachment names could contain path separators** (`../x` reached Git). Segment validation now
    rejects `/` and `\`.
12. **`javascript:` and `data:` URLs passed hyperlink validation**; only http(s), ftp(s) and mailto
    are accepted, and the client never renders other schemes as links or image sources.
13. **Titles and texts were unbounded and accepted NUL bytes**; they are capped and control
    characters are rejected. NUL in query parameters produced a 503 from PostgreSQL instead of a
    400; free-text query inputs are sanitized and GUID/HID path parameters are validated first.
14. **The ordered JSON parser had no nesting limit** (Go's limit applies only to `Unmarshal`), so a
    100 000-deep array in an ignored property was accepted; nesting is capped at 256.
15. **A double click on Create submitted twice** because the busy flag was only reflected after the
    next render; the handlers now check the flag synchronously.

The extended browser suites (every field type through the generated form, attachments, the block
editor, navigation and deep links, relationships, workflows, overlays, HID renames, moves, and two
users in separate browser contexts) added these:

16. **Buttons inside the generated form submitted it.** The reference pickers' "Select…" and the
    remove buttons lacked `type="button"`, and Enter in the extendable-enum input submitted the
    form. Picking a reference while creating an artifact created it half-filled.
17. **The picker replaced the dialog it was opened from**, losing the form state; pickers are now
    a layer above the current dialog.
18. **The detail view rendered for one frame between the artifact arriving and its draft being
    built**, throwing on `draft.title` on every navigation.
19. **A refresh while typing wiped the draft**: dirtiness was judged before the secondary fetches,
    so edits made during a refresh looked untouched and were reset. It is now judged after every
    await, against the view the draft was made from; after a refresh an untouched draft follows the
    new version (the other user's change becomes visible), a touched one is kept with its ETag.
20. **Under a continuous stream of repository events a refresh never completed**, each one being
    superseded by the next; soft refreshes are now coalesced (one in flight, one queued).
21. **Typing in the search box was wiped by any store update** arriving during the debounce; the
    box only adopts the URL's query when that query itself changes.
22. **The block editor's handle toolbar overlapped the block text** and intercepted clicks; it now
    floats above the block. Typing in a block did not mark the document dirty until blur; text is
    bound with `live()` so re-renders never move the caret and input marks the draft dirty.
23. **The sidebar reloaded its tree while a deep link was expanding it**, expanding the tree that
    was being replaced; reloads and expansions are serialized.
24. **The header status only refreshed every 15 s**; it now also refreshes on commit events.
25. **A burst of 120 concurrent creates exhausted the retry loop**; writers within one process are
    now queued on a mutex (Git commits are serial anyway) while processes stay coordinated by the
    two compare-and-swaps.
26. A test-harness lesson recorded as a rule: two servers with different repositories must never
    share one projection database; `make e2e` and `make test-ui` use their own.
27. **Production pass.** Native browser `prompt()` dialogs are replaced by an in-app prompt;
    icon-only buttons carry accessible names; on phone widths the navigation is an overlay that
    starts closed and closes after a choice (the main area was previously placed in the collapsed,
    zero-width column). Server side: `GET /api/health` for probes, a build-time version, security
    headers and a content security policy for the client, a sandboxed policy for attachments,
    same-origin WebSocket sessions (plus an explicit allow-list), an optional access log, shutdown
    that closes sessions, cancelled requests recognized even when the killed git subprocess hides
    the cancellation, and golangci-lint in CI. Packaging: a multi-stage `Dockerfile`, a
    `docker-compose.yml` with PostgreSQL, and an image job in CI.
28. **A client that gave up could poison the schema cache for everyone.** The shared
    configuration cache was filled by a query bound to the requesting client's context; when that
    client navigated away mid-query, the iteration ended early, the error went unchecked, and the
    truncated (often empty) schema set was cached until the next commit: artifacts rendered as
    "no schema" and validation stopped. The cache is now filled without the caller's
    cancellation, a truncated result is never cached, and every row iteration in the projection
    checks its error (enforced by the `rowserrcheck` linter). Found by the browser suite on its
    third consecutive run against one server, which is why the suite is now pinned to one worker
    and the reindex test waits for the rebuild to finish.
29. **Writes queued behind a rebuild.** Synchronization waited on the rebuild's lock, so a save
    issued during a reindex hung for the rebuild's whole duration. It now reports maintenance
    mode at once (503 with `Retry-After`), and the client retries for up to a minute while the
    header shows the rebuild's progress. The status reports `lastRebuild` so operators and tests
    can tell when a rebuild completed.

## 5. Remaining gaps

1. Pagination is offset-based (`limit`/`offset`); fine for MVP volumes.
2. Presence and the WebSocket session hub are per process; with several servers, clients see only
   the users connected to their own server.
3. `ltree` labels longer than 200 characters are hashed; hierarchy queries stay exact, but such a
   label is not human-readable in the database.
4. The `searchable` flag and presentation metadata beyond `columns`, `icon` and `color` are stored
   and returned but not interpreted by the generic client.
5. Rich text is stored as plain text; no inline formatting yet.
6. Writes are serialized per process (one Git commit at a time, about ten per second here), so a
   burst of a hundred creates from one client delays another client's single save by seconds. A
   batch endpoint that commits many artifacts at once would remove that; the transaction already
   supports multi-file changesets.
