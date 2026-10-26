import { api } from "./api";
import { workflowKey } from "./sorting";
import type { Schema, Summary, Workflow } from "./types";

export function schemaKey(row: Pick<Summary, "folder" | "type">): string {
  return JSON.stringify([row.folder, row.type]);
}

/** Resolve each row at its own scope, sharing requests within a load. */
export async function overviewDefinitions(
  rows: Summary[], folder: string, types: Schema[],
  source: Pick<typeof api, "types" | "workflowDef"> = api,
): Promise<{ schemas: Record<string, Schema>; workflows: Record<string, Workflow> }> {
  const folders = new Map<string, Schema[]>([[folder, types]]);
  await Promise.all([...new Set(rows.map((row) => row.folder))].filter((path) => path !== folder).map(async (path) => {
    folders.set(path, (await source.types(path)).types);
  }));
  const schemas: Record<string, Schema> = {};
  const requests = new Map<string, { row: Summary; id: string }>();
  for (const row of rows) {
    const schema = folders.get(row.folder)?.find((s) => s.type === row.type);
    if (schema) schemas[schemaKey(row)] = schema;
    const ids = [
      ...(schema?.workflows ?? []), ...Object.keys(row.workflows ?? {}),
      ...(schema?.fields ?? []).flatMap((f) => f.type === "workflow" && f.workflow ? [f.workflow] : []),
    ];
    for (const id of ids) requests.set(workflowKey(row, id), { row, id });
  }
  const workflows: Record<string, Workflow> = {};
  await Promise.all([...requests].map(async ([key, { row, id }]) => {
    workflows[key] = await source.workflowDef(id, row.type, row.folder);
  }));
  return { schemas, workflows };
}
