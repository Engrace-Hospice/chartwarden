// M30 D9 backfill cron — unit tests over a fake transactional db (the SQL itself is proven live in
// apps/backend/__tests__/gap-089-090-m30-worker-inputs.live.test.ts).
import type { DbClient } from "@wardenx/db";
import { describe, expect, it, vi } from "vitest";
import {
  M30_ASSIGN_UNASSIGNED_MORTALITY_QUEUE,
  assignUnassignedMortalityReviews,
} from "../jobs/assign-unassigned-mortality-reviews";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PE_1 = "bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb";
const PE_2 = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const MD = "ffffffff-1111-4fff-8fff-ffffffffffff";

const textOf = (q: unknown): string =>
  ((q as { queryChunks?: unknown[] }).queryChunks ?? [])
    .map((c) => (c as { value?: string[] }).value?.join("") ?? "")
    .join("");

interface Candidate {
  id: string;
  deathAt: string;
  providerEntityId: string;
}

function fakeDb(
  candidatesByOrg: Record<string, Candidate[]>,
  raced: ReadonlySet<string> = new Set(),
) {
  const updates: string[] = [];
  let org = "";
  const tx = {
    async execute(q: unknown) {
      const text = textOf(q);
      const chunks = (q as { queryChunks: unknown[] }).queryChunks;
      if (text.includes("set_config('app.org_id'")) org = String(chunks[1] ?? "");
      if (text.includes("SELECT id, death_at")) {
        return { rows: candidatesByOrg[org] ?? [] };
      }
      if (text.includes("UPDATE mortality_review")) {
        // primitive params in template order: reviewer, org, id, deathAt
        const params = chunks.filter((c): c is string => typeof c === "string");
        const idParam = String(params[2]);
        updates.push(idParam);
        return { rows: raced.has(idParam) ? [] : [{ id: idParam }] };
      }
      return { rows: [] };
    },
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as DbClient;
  return { db, updates };
}

describe("m30.assign-unassigned-mortality-reviews", () => {
  it("uses a hyphenated, colon-free queue name", () => {
    expect(M30_ASSIGN_UNASSIGNED_MORTALITY_QUEUE).toBe("m30.assign-unassigned-mortality-reviews");
    expect(M30_ASSIGN_UNASSIGNED_MORTALITY_QUEUE).not.toContain(":");
  });

  it("assigns every candidate the resolver can staff, resolving once per provider entity", async () => {
    const { db, updates } = fakeDb({
      [ORG_A]: [
        { id: "r1", deathAt: "2026-01-01T00:00:00.000Z", providerEntityId: PE_1 },
        { id: "r2", deathAt: "2026-01-02T00:00:00.000Z", providerEntityId: PE_1 },
        { id: "r3", deathAt: "2026-01-03T00:00:00.000Z", providerEntityId: PE_2 },
      ],
    });
    const resolve = vi.fn(async (_o: string, pe: string) => (pe === PE_1 ? MD : null));
    const result = await assignUnassignedMortalityReviews({
      db,
      listActiveOrgs: async () => [{ organizationId: ORG_A }],
      resolveMedicalDirectorForOrg: resolve,
    });
    expect(result).toEqual({ orgsScanned: 1, assigned: 2, unresolved: 1, failedOrgs: 0 });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(2);
  });

  it("does not count a row another writer assigned first (optimistic UPDATE matched nothing)", async () => {
    const { db } = fakeDb(
      { [ORG_A]: [{ id: "r1", deathAt: "2026-01-01T00:00:00.000Z", providerEntityId: PE_1 }] },
      new Set(["r1"]),
    );
    const result = await assignUnassignedMortalityReviews({
      db,
      listActiveOrgs: async () => [{ organizationId: ORG_A }],
      resolveMedicalDirectorForOrg: async () => MD,
    });
    expect(result.assigned).toBe(0);
  });

  it("an org failure is logged and does not stop the next org", async () => {
    const { db } = fakeDb({
      [ORG_A]: [{ id: "r8", deathAt: "2026-01-01T00:00:00.000Z", providerEntityId: PE_1 }],
      [ORG_B]: [{ id: "r9", deathAt: "2026-01-01T00:00:00.000Z", providerEntityId: PE_1 }],
    });
    const warn = vi.fn();
    const result = await assignUnassignedMortalityReviews({
      db,
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      resolveMedicalDirectorForOrg: async (org) => {
        if (org === ORG_A) throw new Error("boom");
        return MD;
      },
      warn,
    });
    expect(result.failedOrgs).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(result.assigned).toBe(1);
  });

  it("no active orgs is a no-op", async () => {
    const { db } = fakeDb({});
    await expect(
      assignUnassignedMortalityReviews({
        db,
        listActiveOrgs: async () => [],
        resolveMedicalDirectorForOrg: async () => MD,
      }),
    ).resolves.toEqual({ orgsScanned: 0, assigned: 0, unresolved: 0, failedOrgs: 0 });
  });
});
