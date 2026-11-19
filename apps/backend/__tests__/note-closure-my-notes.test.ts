// ADR-0113 slice 1 — "My notes": GET /api/v1/encounters/my-drafts returns the author's OPEN notes (draft + finalized) with a
// per-row `closure {clockStartedAt, deadlineAt, stage}` computed by the SAME pure clock the gate and the alerts use. Driven over
// a recording Drizzle fake (the projection, the stage, the sort, and the WHERE parameters that scope the query to the author) and
// over the in-memory twin (which has no clock, so every row is legacy). Real RLS and the partial index are the live suite's.
import type { DbClient } from "@chartwarden/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  myNotesOf,
  noteClosureView,
  sortByDeadline,
} from "../src/modules/08-encounters/closure/my-notes";
import type { ClosurePolicy } from "../src/modules/08-encounters/closure/policy-service";
import { createDbEncounterRouteService } from "../src/modules/08-encounters/encounters-route-service-db";
import { createInMemoryEncounterBackend } from "../src/modules/08-encounters/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const POLICY: ClosurePolicy = { mode: "warn", thresholdHours: 24, enforceFrom: null };
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR_MS);

describe("noteClosureView", () => {
  it("stages a clocked note with the pure clock and renders instants as ISO strings", () => {
    expect(noteClosureView(hoursAgo(30), POLICY, NOW)).toEqual({
      clockStartedAt: "2026-11-16T06:00:00.000Z",
      deadlineAt: "2026-11-17T06:00:00.000Z",
      stage: "overdue",
    });
    expect(noteClosureView(hoursAgo(19), POLICY, NOW).stage).toBe("at_risk");
    expect(noteClosureView(hoursAgo(5), POLICY, NOW).stage).toBe("ok");
    expect(noteClosureView(hoursAgo(40), POLICY, NOW).stage).toBe("escalated");
  });

  it("a legacy (clockless) note has no clock, no deadline and never alerts", () => {
    expect(noteClosureView(null, POLICY, NOW)).toEqual({
      clockStartedAt: null,
      deadlineAt: null,
      stage: "ok",
    });
  });

  it("honours the tenant threshold, not a fixed 24h", () => {
    const short: ClosurePolicy = { ...POLICY, thresholdHours: 8 };
    expect(noteClosureView(hoursAgo(9), short, NOW).stage).toBe("overdue");
  });

  it("does not move the alert stage or deadline for a tenant's enforceFrom grace (it only delays the block)", () => {
    const grace: ClosurePolicy = { ...POLICY, mode: "block", enforceFrom: hoursAgo(1) };
    expect(noteClosureView(hoursAgo(30), grace, NOW)).toMatchObject({
      deadlineAt: "2026-11-17T06:00:00.000Z",
      stage: "overdue",
    });
  });
});

describe("sortByDeadline", () => {
  const note = (id: string, clockStartedAt: Date | null) => ({
    id,
    closure: noteClosureView(clockStartedAt, POLICY, NOW),
  });

  it("sorts the nearest deadline first and legacy notes last, keeping input order among ties", () => {
    const sorted = sortByDeadline([
      note("legacy-a", null),
      note("fresh", hoursAgo(2)),
      note("oldest", hoursAgo(40)),
      note("legacy-b", null),
      note("middle", hoursAgo(20)),
    ]);
    expect(sorted.map((n) => n.id)).toEqual(["oldest", "middle", "fresh", "legacy-a", "legacy-b"]);
  });

  it("does not mutate its input", () => {
    const input = [note("b", hoursAgo(1)), note("a", hoursAgo(2))];
    sortByDeadline(input);
    expect(input.map((n) => n.id)).toEqual(["b", "a"]);
  });
});

describe("myNotesOf", () => {
  it("adds closure to each view without altering the view", () => {
    const out = myNotesOf(
      [{ view: { id: "e1", status: "draft" }, clockStartedAt: null }],
      POLICY,
      NOW,
    );
    expect(out).toEqual([
      {
        id: "e1",
        status: "draft",
        closure: { clockStartedAt: null, deadlineAt: null, stage: "ok" },
      },
    ]);
  });
});

// ── the production service over a recording Drizzle fake ─────────────────────────────────────────────────────────────────────
const noteRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG,
  patientId: PATIENT,
  admissionId: ADMISSION,
  visitId: null,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-16",
  status: "draft",
  lateEntryTier: "normal",
  version: 0,
  authoredByMembershipId: ME,
  faceToFaceEncounterId: null,
  signedAt: null,
  cosignedAt: null,
  clockStartedAt: null,
  ...over,
});

/** A Drizzle fake that hands back the programmed rows per table and records every `where` condition it was given. */
function recordingDb(rowsByTable: Record<string, unknown[]>): { db: DbClient; wheres: SQL[] } {
  const wheres: SQL[] = [];
  const tableNameOf = (table: unknown): string => {
    const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
      String(s).includes("drizzle:Name"),
    );
    return String((table as Record<symbol, unknown>)[sym as symbol]);
  };
  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      where: (condition: SQL) => {
        wheres.push(condition);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: a deliberate thenable stand-in for an awaited Drizzle query
      then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
    };
    return chain;
  };
  const tx = {
    execute: async () => [],
    select: () => ({ from: (table: unknown) => thenable(rowsByTable[tableNameOf(table)] ?? []) }),
  };
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as DbClient, wheres };
}

const dialect = new PgDialect();
const paramsOf = (condition: SQL): unknown[] => dialect.sqlToQuery(condition).params;
const textOf = (condition: SQL): string => dialect.sqlToQuery(condition).sql;

describe("createDbEncounterRouteService.myDrafts", () => {
  const serviceOver = (rowsByTable: Record<string, unknown[]>) => {
    const { db, wheres } = recordingDb(rowsByTable);
    return { service: createDbEncounterRouteService(db, undefined, undefined, () => NOW), wheres };
  };

  it("returns draft and finalized notes with their stage, deadline first and legacy notes last", async () => {
    const { service } = serviceOver({
      encounter: [
        noteRow("legacy", { serviceDate: "2026-11-17" }),
        noteRow("fresh", { clockStartedAt: hoursAgo(2) }),
        noteRow("signing", { status: "finalized", clockStartedAt: hoursAgo(30) }),
        noteRow("risk", { clockStartedAt: hoursAgo(19) }),
      ],
      documentation_obligation_policy: [],
    });

    const { encounters } = await service.myDrafts(ORG, ME);

    expect(encounters.map((e) => [e.id, e.status, e.closure.stage])).toEqual([
      ["signing", "finalized", "overdue"],
      ["risk", "draft", "at_risk"],
      ["fresh", "draft", "ok"],
      ["legacy", "draft", "ok"],
    ]);
    expect(encounters[0]?.closure).toEqual({
      clockStartedAt: "2026-11-16T06:00:00.000Z",
      deadlineAt: "2026-11-17T06:00:00.000Z",
      stage: "overdue",
    });
    expect(encounters[3]?.closure).toEqual({
      clockStartedAt: null,
      deadlineAt: null,
      stage: "ok",
    });
  });

  it("reads the tenant's policy: a stored 8h threshold makes a 9h-old note overdue", async () => {
    const { service } = serviceOver({
      encounter: [noteRow("short", { clockStartedAt: hoursAgo(9) })],
      documentation_obligation_policy: [{ mode: "warn", thresholdHours: 8, enforceFrom: null }],
    });
    const { encounters } = await service.myDrafts(ORG, ME);
    expect(encounters[0]?.closure.stage).toBe("overdue");
  });

  it("falls back to warn / 24h when the tenant has no policy row", async () => {
    const { service } = serviceOver({
      encounter: [noteRow("default", { clockStartedAt: hoursAgo(25) })],
      documentation_obligation_policy: [],
    });
    const { encounters } = await service.myDrafts(ORG, ME);
    expect(encounters[0]?.closure.stage).toBe("overdue");
  });

  it("scopes the query to the caller's own open notes: organization, author and the two open statuses", async () => {
    const { service, wheres } = serviceOver({ encounter: [], documentation_obligation_policy: [] });

    await service.myDrafts(ORG, ME);

    const encounterWhere = wheres.find((w) => textOf(w).includes("authored_by_membership_id"));
    expect(encounterWhere).toBeDefined();
    const params = paramsOf(encounterWhere as SQL);
    expect(params).toContain(ME);
    expect(params).toContain(ORG);
    expect(params).not.toContain(OTHER);
    expect(textOf(encounterWhere as SQL)).toContain("('draft', 'finalized')");
  });

  it("keeps the shared EncounterView untouched: closure rides only on this view", async () => {
    const { service } = serviceOver({
      encounter: [noteRow("e1", { clockStartedAt: hoursAgo(1) })],
      documentation_obligation_policy: [],
    });
    const { encounters: mine } = await service.myDrafts(ORG, ME);
    const listed = await service.listEncounters(ORG);
    expect(mine[0]).toHaveProperty("closure");
    expect(listed.encounters[0]).not.toHaveProperty("closure");
  });
});

// ── the in-memory twin: no clock, so every row is legacy; the author scope and the open statuses still hold ─────────────────────
describe("in-memory myDrafts", () => {
  const seeded = (status: string, authoredByUserId: string, id: string) => ({
    id,
    organizationId: ORG,
    patientId: PATIENT,
    discipline: "rn" as const,
    status: status as never,
    authoredByUserId,
  });

  it("includes finalized notes and excludes signed, cosigned and voided ones", async () => {
    const { service } = createInMemoryEncounterBackend({
      encounters: [
        seeded("draft", ME, "e0000000-0000-4000-8000-000000000001"),
        seeded("finalized", ME, "e0000000-0000-4000-8000-000000000002"),
        seeded("signed", ME, "e0000000-0000-4000-8000-000000000003"),
        seeded("cosign_pending", ME, "e0000000-0000-4000-8000-000000000004"),
        seeded("voided", ME, "e0000000-0000-4000-8000-000000000005"),
      ],
    });
    const { encounters } = await service.myDrafts(ORG, ME);
    expect(encounters.map((e) => e.status).sort()).toEqual(["draft", "finalized"]);
    for (const e of encounters) {
      expect(e.closure).toEqual({ clockStartedAt: null, deadlineAt: null, stage: "ok" });
    }
  });

  it("never shows another author's notes, nor another organization's", async () => {
    const { service } = createInMemoryEncounterBackend({
      encounters: [
        seeded("draft", ME, "e0000000-0000-4000-8000-000000000011"),
        seeded("draft", OTHER, "e0000000-0000-4000-8000-000000000012"),
        { ...seeded("draft", ME, "e0000000-0000-4000-8000-000000000013"), organizationId: "org_b" },
      ],
    });
    const { encounters } = await service.myDrafts(ORG, ME);
    expect(encounters.map((e) => e.id)).toEqual(["e0000000-0000-4000-8000-000000000011"]);
  });
});
