/**
 * M35A-T03 — M2's `OrganizationReader` seam (org display-metadata reader).
 *
 * M2 owns the `organization` table (the tenancy root, NON_ORG_SCOPED), so it is the producer of the by-id
 * display-name reader M35's platform-ops admin lists consume. These pin the batching contract that keeps the
 * consumer's page enrichment N+1-free: an empty id set never touches the db, duplicate ids collapse to one
 * `WHERE id = ANY(...)`, and the org summaries flow through untouched.
 */
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createOrganizationReader } from "../organization-reader";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("M35A-T03 createOrganizationReader", () => {
  it("short-circuits an empty id set without touching the db", async () => {
    let hit = false;
    const db = {
      select: () => {
        hit = true;
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      },
    } as unknown as DbClient;
    expect(await createOrganizationReader(db).readByIds([])).toEqual([]);
    expect(hit).toBe(false);
  });

  it("dedups ids into a single batched WHERE and returns the db's org summaries", async () => {
    let whereCalls = 0;
    const rows = [{ organizationId: UUID, displayName: "Acme", legalName: "Acme LLC", slug: "acme" }];
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            whereCalls += 1;
            return Promise.resolve(rows);
          },
        }),
      }),
    } as unknown as DbClient;
    const out = await createOrganizationReader(db).readByIds([UUID, UUID]); // duplicate id
    expect(out).toEqual(rows);
    expect(whereCalls).toBe(1); // one batched query, not one per id
  });
});
