import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  stdin: {
    contents: 'export * from "./overview-definitions"; export * from "./sorting";',
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { overviewDefinitions, schemaKey, workflowKey, workflowSortValue, fieldSortValue, compare } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const root = {
  type: "requirement", kind: "entry", displayName: "Root requirement", workflows: ["dev"],
  fields: [{ id: "priority", type: "enum", options: [{ value: "low" }, { value: "high" }] }],
  presentation: { columns: ["priority"] },
};
const scoped = {
  ...root, displayName: "Data requirement", workflows: ["delivery"],
  fields: [
    { id: "priority", type: "enum", options: [{ value: "high" }, { value: "low" }] },
    { id: "gate", type: "workflow", workflow: "approval" },
  ],
  presentation: { columns: ["priority", "gate"] },
};
const folder = "scale-lab/harbor-data/cache/invalidation";
const row = (guid, path, state, priority) => ({
  guid, folder: path, type: "requirement", kind: "entry", path: `${path}/${guid}`,
  workflows: path ? { delivery: state } : { dev: state },
  fields: { priority, gate: "review" }, links: 0, comments: 0,
});
const workflow = (id, states) => ({ id, initial: states[0], states: states.map((id) => ({ id })), transitions: [] });

test("mixed-scope requirements use their own schemas, enums and workflow definitions", async () => {
  const rows = [row("root", "", "open", "low"), row("early", folder, "draft", "high"),
    row("late", folder, "operational", "low")];
  const typeRequests = [], workflowRequests = [];
  const definitions = await overviewDefinitions(rows, "", [root], {
    types: async (path) => {
      typeRequests.push(path);
      assert.equal(path, folder);
      return { types: [scoped] };
    },
    workflowDef: async (id, type, path) => {
      workflowRequests.push([id, type, path]);
      assert.equal(type, "requirement");
      if (!path) {
        assert.equal(id, "dev");
        return workflow(id, ["open", "done"]);
      }
      assert.notEqual(id, "dev", "must not request a non-inherited root workflow in the seed");
      return workflow(id, id === "delivery" ? ["draft", "load-tested", "operational"] : ["review", "approved"]);
    },
  });
  assert.deepEqual(typeRequests, [folder], "one types request per distinct folder");
  assert.equal(workflowRequests.length, 3, "deduplicate workflow requests for rows sharing a scope");
  assert.equal(definitions.schemas[schemaKey(rows[0])].displayName, "Root requirement");
  assert.equal(definitions.schemas[schemaKey(rows[1])].displayName, "Data requirement");
  assert.deepEqual(definitions.schemas[schemaKey(rows[1])].presentation.columns, ["priority", "gate"]);
  const lookup = (r) => (id) => definitions.workflows[workflowKey(r, id)];
  const state = (r) => workflowSortValue(r, definitions.schemas[schemaKey(r)], lookup(r));
  assert.ok(compare(state(rows[1]), state(rows[2]), 1) < 0);
  assert.ok(compare(state(rows[1]), state(rows[2]), -1) > 0);
  const priority = (r) => fieldSortValue(r, "priority", definitions.schemas[schemaKey(r)], lookup(r));
  assert.ok(compare(priority(rows[1]), priority(rows[2]), 1) < 0, "scoped high precedes low");
  assert.equal(compare(priority(rows[0]), priority(rows[1]), 1), 0, "each scope's first enum option has rank zero");
  assert.equal(fieldSortValue(rows[1], "gate", scoped, lookup(rows[1])).rank, 0);
});

test("browsing inside the scope reuses the already loaded folder types", async () => {
  const rows = [row("local", folder, "draft", "high")];
  const definitions = await overviewDefinitions(rows, folder, [scoped], {
    types: async () => assert.fail("must reuse the browsing folder's types"),
    workflowDef: async (id) => workflow(id, ["draft", "operational"]),
  });
  assert.equal(definitions.schemas[schemaKey(rows[0])], scoped);
});

test("the same workflow ID in two folders keeps each folder's state order", async () => {
  const rows = [row("data", folder, "draft", "high"), row("other", "other-project", "draft", "high")];
  const definitions = await overviewDefinitions(rows, "", [root], {
    types: async () => ({ types: [{ ...root, workflows: ["delivery"] }] }),
    workflowDef: async (id, type, path) => {
      assert.equal(id, "delivery");
      return workflow(id, path === folder ? ["draft", "operational"] : ["operational", "draft"]);
    },
  });
  const values = rows.map((r) => workflowSortValue(r, definitions.schemas[schemaKey(r)],
    (id) => definitions.workflows[workflowKey(r, id)]));
  assert.ok(compare(values[0], values[1], 1) < 0);
  assert.ok(compare(values[0], values[1], -1) > 0);
});

test("undefined descendant types never fall back to a root schema with the same name", async () => {
  const definitions = await overviewDefinitions([row("unknown", folder, "draft", "low")], "", [root], {
    types: async () => ({ types: [] }),
    workflowDef: async (id) => {
      assert.equal(id, "delivery", "only the stored workflow is requested for an undefined type");
      return workflow(id, ["draft", "operational"]);
    },
  });
  assert.deepEqual(definitions.schemas, {});
});

test("schema and workflow loading failures are surfaced", async () => {
  const rows = [row("child", folder, "draft", "high")];
  await assert.rejects(overviewDefinitions(rows, "", [root], {
    types: async () => { throw new Error("schema unavailable"); },
    workflowDef: async () => assert.fail("no workflows before schemas load"),
  }), /schema unavailable/);
  await assert.rejects(overviewDefinitions(rows, folder, [scoped], {
    types: async () => assert.fail("unexpected types request"),
    workflowDef: async () => { throw new Error("workflow unavailable"); },
  }), /workflow unavailable/);
});
