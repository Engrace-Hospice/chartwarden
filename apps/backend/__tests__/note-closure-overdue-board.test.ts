// ADR-0113 — the supervisor overdue board: SQL narrows to clocked open notes old enough to be at risk, the pure clock stages each
// one, and the scope (org-wide vs the supervisor's sites) fails closed. Real RLS and the query plan are the live suite's.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  closureLocationScope,
  listOverdueNotes,
} from "../src/modules/08-encounters/closure/overdue-board";
import type { ClosurePolicy } from "../src/modules/08-encounters/closure/policy-service";
import { fakeTx } from "./_closure-fake-tx";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const SITE = "00000000-0000-4000-8000-0000000000f1";

const policy = (mode: ClosurePolicy["mode"], thresholdHours = 24): ClosurePolicy => ({
  mode,
  thresholdHours,
  enforceFrom: null,
});
const row = (id: string, ageHours: number) => ({
  encounterId: id,
  authoredByMembershipId: "00000000-0000-4000-8000-0000000000b1",
  patientId: "00000000-0000-4000-8000-0000000000c1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-16",
  status: "draft",
  clockStartedAt: new Date(NOW.getTime() - ageHours * HOUR_MS),
});
/** The bind parameters of the board query's WHERE clause (the real SQL drizzle would send). */
const whereParams = (calls: readonly { op: string; args: readonly unknown[] }[]): unknown[] => {
  const where = calls.find((c) => c.op === "where")?.args[0] as SQL;
  return new PgDialect().sqlToQuery(where).params;
};
const base = { organizationId: ORG, now: NOW, limit: 50, locationIds: null };

describe("listOverdueNotes", () => {
  it("stages every row with the pure clock and returns the deadline as an ISO instant", async () => {
    const fake = fakeTx([[row("e1", 40), row("e2", 26), row("e3", 20)]]);
    const out = await listOverdueNotes(fake.tx, { ...base, policy: policy("warn") });
    expect(out.items.map((i) => [i.encounterId, i.stage])).toEqual([
      ["e1", "escalated"],
      ["e2", "overdue"],
      ["e3", "at_risk"],
    ]);
    expect(out.items[1]?.deadlineAt).toBe("2026-11-17T10:00:00.000Z");
    expect(out.items[1]?.hoursOverdue).toBe(2);
    expect(out.mode).toBe("warn");
    expect(out.thresholdHours).toBe(24);
    expect(out.truncated).toBe(false);
  });

  it("drops a row the pure clock still calls ok, whatever SQL returned", async () => {
    const fake = fakeTx([[row("early", 3), row("late", 30)]]);
    const out = await listOverdueNotes(fake.tx, { ...base, policy: policy("warn") });
    expect(out.items.map((i) => i.encounterId)).toEqual(["late"]);
  });

  it("reports truncation when SQL returned more than the limit", async () => {
    const fake = fakeTx([[row("e1", 40), row("e2", 39), row("e3", 38)]]);
    const out = await listOverdueNotes(fake.tx, { ...base, limit: 2, policy: policy("warn") });
    expect(out.items).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("mode off lists nothing and reads nothing", async () => {
    const fake = fakeTx([]);
    const out = await listOverdueNotes(fake.tx, { ...base, policy: policy("off") });
    expect(out).toMatchObject({ mode: "off", items: [], truncated: false });
    expect(fake.queriesRun()).toBe(0);
  });

  it("a supervisor with no sites sees nothing and no query runs (fail closed)", async () => {
    const fake = fakeTx([]);
    const out = await listOverdueNotes(fake.tx, {
      ...base,
      locationIds: [],
      policy: policy("block"),
    });
    expect(out.items).toEqual([]);
    expect(fake.queriesRun()).toBe(0);
  });

  it("a site-scoped supervisor's query is limited to their locations", async () => {
    const fake = fakeTx([[row("e1", 30)]]);
    await listOverdueNotes(fake.tx, { ...base, locationIds: [SITE], policy: policy("warn") });
    expect(fake.queriesRun()).toBe(1);
    expect(whereParams(fake.calls)).toContain(SITE);
  });

  it("a site-scoped supervisor also sees a note that has no location (the alert falls back org-wide for it)", async () => {
    const fake = fakeTx([[row("e1", 30)]]);
    await listOverdueNotes(fake.tx, { ...base, locationIds: [SITE], policy: policy("warn") });
    const where = fake.calls.find((c) => c.op === "where")?.args[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(where).sql;
    expect(rendered).toMatch(/"location_id" in \(\$\d+\) or "encounter"\."location_id" is null/i);
    // the organization filter stays outside the OR, so a null-location note of another tenant is never matched
    expect(rendered).toMatch(/"organization_id" = \$1/);
  });

  it("spells the open statuses as a literal list so the partial index can serve the board", async () => {
    const fake = fakeTx([[]]);
    await listOverdueNotes(fake.tx, { ...base, policy: policy("warn") });
    const where = fake.calls.find((c) => c.op === "where")?.args[0] as SQL;
    expect(new PgDialect().sqlToQuery(where).sql).toContain("IN ('draft', 'finalized')");
  });

  it("an org-wide scope adds no location predicate", async () => {
    const fake = fakeTx([[row("e1", 30)]]);
    await listOverdueNotes(fake.tx, { ...base, locationIds: null, policy: policy("warn") });
    expect(whereParams(fake.calls)).not.toContain(SITE);
  });
});

describe("closureLocationScope", () => {
  const render = (scope: SQL | undefined) =>
    scope === undefined ? null : new PgDialect().sqlToQuery(scope);

  it("is no predicate at all for an org-wide caller", () => {
    expect(closureLocationScope(null)).toBeUndefined();
  });

  it("matches the caller's locations or no location", () => {
    const query = render(closureLocationScope([SITE]));
    expect(query?.sql).toMatch(/"location_id" in \(\$1\) or "encounter"\."location_id" is null/i);
    expect(query?.params).toEqual([SITE]);
  });

  it("matches nothing for an empty scope, null-location notes included (fail closed)", () => {
    expect(render(closureLocationScope([]))?.sql).toBe("false");
  });
});
