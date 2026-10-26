# Repository configuration — layout and resolution

**Status: implemented**, except the copy and move dialog of section 6. This layout replaced one
schema file per type (`<scope>/.corestone/schemas/<type>.json`) and `<scope>/.corestone/workflows/`
without a migration; those directories are no longer read. Files are written through
`GET/PUT/DELETE /api/config?scope=<folder>&path=<path below config/>` (see [INSTALL.md](INSTALL.md))
or committed directly; `examples/seed.sh` sets up a complete example.

Goals:

- One place per folder: everything that defines a folder's type system lives under
  `<scope>/.corestone/config/`, so it can be reviewed, diffed and copied as a unit.
- All four artifact kinds — entries, documents, links, comments — are configured the same way.
- Definitions can be shared within a kind or belong to one type, without duplication.
- A folder can establish an independent type system (design guide §4.4, `inheritance: off`).
- The server enforces the configuration; files make clear what they are when browsing.

## 1. Layout

```
<scope>/.corestone/config/
  entries/
    types.json                          the entry types of this scope
    fields.json                         fields shared by entry types
    <type_id>-fields.json               fields of one type
    enums/<id>-enum.json                shared enumeration
    enums/<type_id>-<id>-enum.json      enumeration of one type
    workflows/<id>-workflow.json        shared workflow
    workflows/<type_id>-<id>-workflow.json
  documents/   (same structure)
  links/       (same structure)
  comments/    (same structure)
```

- The `config/` directory separates type definitions from the artifacts stored in
  `.corestone/` (`links/<guid>.json`, `comments/<guid>.json`).
- The `-fields`, `-enum` and `-workflow` suffixes are redundant with the folders on purpose: a file
  name alone says what the file is, in a file browser and in Git history.
- The `<type_id>-` prefix is optional. Without it a definition is shared by all types of the kind;
  with it, it belongs to that type. Type-specific and shared definitions sit side by side, so a
  directory listing groups them by type.
- Sharing stops at the kind directory: an enumeration needed by entry and document types exists
  once in each.

## 2. Files

**`types.json`** — the types of one kind in this scope, and the kind's inheritance switch:

```json
{
  "inheritance": "off",
  "types": [
    { "id": "task", "displayName": "Task", "hid": { "prefix": "TSK" },
      "workflows": ["task"],
      "fields": [ { "id": "priority", "required": true }, "effort", "description", "tags" ],
      "presentation": { "columns": ["priority", "effort"] } }
  ]
}
```

Kind-specific properties belong here: link types carry `sourceTypes`, `targetTypes` and
`cardinality`; comment types may add their own rules later.

A type's `fields` list names the shared fields it uses and sets their order and whether they are
required for this type. Fields defined in `<type_id>-fields.json` belong to the type without being
listed, and may set `required` directly.

**`fields.json` / `<type_id>-fields.json`** — field definitions with the Foundation's field types
(design guide §4.6). Enumeration fields reference an enumeration by id; single or multiple choice
is a property of the field, so one enumeration can back both:

```json
{ "fields": [
    { "id": "priority", "name": "Priority", "type": "enum", "enum": "priority" },
    { "id": "tags", "name": "Tags", "type": "enum", "enum": "tags", "multiple": true } ] }
```

**`<id>-enum.json`** — options of one enumeration:

```json
{ "name": "Priority", "extendable": false,
  "options": [ { "value": "low" }, { "value": "high", "color": "#d6455d" } ] }
```

**`<id>-workflow.json`** — a state machine, in today's workflow format.

## 3. Identifiers and file names

- Identifiers may contain letters, digits, `_`, `-` and `.` (as today). File names are
  *constructed* from identifiers — `<type_id>-<id>-enum.json` — and never split to recover them.
- Because `-` is allowed, two meanings can produce the same name (type `a` + enum `b-c` and
  type `a-b` + enum `c` both give `a-b-c-enum.json`; a shared enum `task-priority` has the name
  of task's own `priority`). Enumeration and workflow files may therefore optionally state
  `"id"` and, for type-specific definitions, `"type"`. When present, a file only matches a lookup
  whose identifiers equal them; validation warns when a name and its content disagree or when two
  files claim the same identity. Without them, the file name decides.
- Type identifiers are unique across all four kinds: link rules and reference fields name types
  without a kind. A second definition of the same id under another kind is a configuration error.

## 4. Resolution

All lookups walk the folder lineage of the artifact, **nearest folder first**, towards the root.

- **Inheritance.** Each kind's `types.json` may set `"inheritance": "off"`. For that kind,
  everything defined above the folder is ignored — types, fields, enumerations and workflows — in
  the folder and all folders below it. Other kinds keep inheriting: a task folder can cut off the
  root's entry types and still use the root's link and comment types.
- **Kinds without types.** A kind is available in a folder only if at least one type of that kind
  is visible there. There are no built-in types: without a comment type, a folder has no comments;
  without a link type, no links — the same for entries and documents.
- **Types.** The types visible in a folder are those of every `types.json` of the kind on the
  lineage, up to the cut-off. A type defined at several levels composes as today: the nearer
  definition wins per property.
- **Fields of a type** compose by field id across the lineage, nearer wins; within one folder
  `<type_id>-fields.json` wins over `fields.json`.
- **Enumerations and workflows** referenced by id: in each folder, `<type_id>-<id>` first, then
  the shared `<id>`; the first folder on the lineage that has either wins.
- **Invalid files** (not valid JSON, unknown field type, dangling reference) are ignored and
  reported: the repository status lists them and the client shows them in a banner. Because
  resolution depends on location, a reference can be valid in one folder and dangling in another;
  validation reports such problems per folder.

## 5. Enforcement

The server enforces the effective configuration at the artifact's location:

- Creating, retyping or moving an artifact into a folder where its type is not defined is
  rejected. This applies to links and comments as well.
- Adding or changing a field the type does not define is rejected. Fields already present in an
  artifact but no longer defined — for example after a field was removed from the configuration —
  are kept unchanged on save, shown read-only by the client, and may be deleted.
- Field values are validated against their definitions (field type, enumeration options unless
  extendable, reference targets).
- Required fields are enforced on every save, including fields made required after an artifact was
  created: such an artifact can only be saved once the field is filled.
- **Extendable enumerations:** values outside the options are stored only in the artifact; the
  enumeration file is not changed. Autocomplete offers the configured options plus the values in
  use, read from the projection's field index.
- **Overview sorting:** enumeration columns use the configured option sequence, reversed for
  descending order, rather than alphabetical order. Multiple-choice fields sort by their highest
  selected option in that sequence, regardless of selection order. Unlisted values follow configured
  options and sort alphabetically (reversed when descending); empty cells stay last in both directions.
  Text and numeric columns keep their natural and numeric ordering. Each row uses its own folder's
  effective schema, including scoped option orders, type labels and declared columns, even when
  a search or subtree view combines artifacts with the same type name from different scopes.
- **Workflow sorting:** workflow fields and the overview's State column use the sequence of the
  workflow's `states` list, reversed for descending order, not state names or transitions.
  The State column compares workflows in the type's declared `workflows` order, using subsequent
  workflows to break ties. Definitions are loaded for each artifact's folder and type. Unlisted
  states follow defined states; missing states stay last in both directions.
- Direct Git pushes cannot be refused. Violations they introduce are reported by the validation
  service (`unknown-type`, `undeclared-field`) and surfaced in the client.

This is schema conformance, which belongs to the Foundation; business validation stays with
server-side extensions (design guide §4.11).

## 6. Copying and moving configuration (planned)

Copying or moving a folder whose configuration depends on definitions above it triggers an
analysis of what would no longer resolve at the destination, and the client offers:

1. **Clone the complete settings** — write the effective configuration (inherited and local) into
   the destination and set `inheritance: off`; the copy is self-contained.
2. **Keep only local definitions** — set `inheritance: off` at the destination; values of fields
   that are no longer defined are removed (or, alternatively, kept as undefined fields shown
   read-only — to be decided).
3. **Ignore** — leave the gaps; validation reports them.

The analysis is a dry run of the resolution above against the destination path. Copies or moves
made directly in Git bypass it; validation remains the safety net.

## 7. Seed data

`examples/seed.sh` is rewritten for this layout. Besides the demo requirements domain it sets up
the dogfooding task tracker in `corestone_tasks/`: entry types cut off from the root
(`"inheritance": "off"` in `entries/types.json`), the `task` type with its fields and
enumerations, and the `task` workflow.
