// GAP-174 — `GET /admin/mdm/nppes/sync-log` must read through the migration-0470 SECURITY DEFINER
// function, never `nppes_sync_log` directly (the app role has no grant on it → `permission denied`).
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createDbMdmRouteService } from "../src/modules/40-mdm/index";

function chunkText(chunk: unknown): string {
  if (typeof chunk === "object" && chunk !== null && "value" in chunk) {
    return String((chunk as { value: unknown }).value);
  }
  return "";
}

function fakeDb(rows: readonly Record<string, unknown>[]) {
  const executed: string[] = [];
  const db = {
    execute: async (query: { queryChunks?: readonly unknown[] }) => {
      executed.push((query.queryChunks ?? []).map(chunkText).join(""));
      return { rows };
    },
    select: () => {
      throw new Error("direct table read — the app role has no grant on nppes_sync_log");
    },
  } as unknown as DbClient;
  return { db, executed };
}

describe("GAP-174 — nppesSyncLog reads through the SECURITY DEFINER function", () => {
  it("calls mdm_canonical_writer_list_nppes_sync_log and maps the rows", async () => {
    const { db, executed } = fakeDb([
      { id: "r1", mode: "nightly_delta", outcome: "success" },
      { id: "r2", mode: "on_demand", outcome: "failed" },
    ]);

    const runs = await createDbMdmRouteService(db).nppesSyncLog();

    expect(executed.join("")).toContain("mdm_canonical_writer_list_nppes_sync_log");
    expect(runs).toEqual([
      { id: "r1", mode: "nightly_delta", outcome: "success" },
      { id: "r2", mode: "on_demand", outcome: "failed" },
    ]);
  });

  it("returns an empty list when the function yields no rows", async () => {
    const { db } = fakeDb([]);
    expect(await createDbMdmRouteService(db).nppesSyncLog()).toEqual([]);
  });
});
