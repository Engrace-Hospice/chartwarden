// GAP-008 - the legal-hold overlay's pure parts: the criteria -> SQL predicate (rendered, not run), the certificate status
// once overlay-held rows are accounted for, and the retention-scan grouping that reports a held row as `legal_hold`. The
// SQL/TS parity of the predicate against `holdCoversGroup` and the whole enforcement chain are proven live
// (apps/backend/__tests__/gap-008-m4-legal-hold-overlay.live.test.ts).
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { holdCriteriaPredicate, rowHeldByActiveLegalHold } from "../src";

const dialect = new PgDialect();
const render = (criteria: unknown) => {
  const predicate = holdCriteriaPredicate(criteria);
  if (predicate === null) return null;
  return dialect.sqlToQuery(predicate);
};
const P1 = "11111111-1111-4111-8111-111111111111";

describe("holdCriteriaPredicate", () => {
  it("a hold naming no selector selects nothing (null), whatever junk it carries", () => {
    for (const criteria of [null, undefined, {}, { patientIds: [] }, { resourceKinds: [] }, "x"]) {
      expect(holdCriteriaPredicate(criteria)).toBeNull();
    }
  });

  it("patientIds match the row's context.patientId OR its resource_id", () => {
    const q = render({ patientIds: [P1] });
    expect(q?.sql).toContain(`"context"->>'patientId'`);
    expect(q?.sql).toContain('"resource_id"');
    expect(q?.params).toContain(P1);
  });

  it("a non-uuid patient id can only ever match through the context arm (it can never equal a uuid resource id)", () => {
    const q = render({ patientIds: ["not-a-uuid"] });
    expect(q?.sql).toContain(`"context"->>'patientId'`);
    expect(q?.sql).not.toContain('"resource_id"');
  });

  it("every named selector is AND-ed: kinds and a date range", () => {
    const q = render({
      resourceKinds: ["note"],
      dateRange: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
    });
    expect(q?.sql).toContain('"resource_kind" in');
    expect(q?.sql).toContain('"created_at" >=');
    expect(q?.sql).toContain('"created_at" <=');
    expect(q?.sql.match(/ and /g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("a date bound that does not parse is dropped (over-holding), and a hold left with no bound holds every row", () => {
    const half = render({ dateRange: { from: "2026-04-01T00:00:00Z", to: "garbage" } });
    expect(half?.sql).toContain('"created_at" >=');
    expect(half?.sql).not.toContain('"created_at" <=');
    const none = render({ dateRange: { from: "garbage", to: "garbage" } });
    expect(none?.sql.trim()).toBe("true");
  });

  it("the outer-row EXISTS is spelled with an explicit audit_event qualifier (an unqualified column binds to the overlay)", () => {
    const q = dialect.sqlToQuery(rowHeldByActiveLegalHold());
    expect(q.sql).toContain('"audit_event"."organization_id"');
    expect(q.sql).toContain('"audit_event"."id"');
    expect(q.sql).toContain('"audit_event"."created_at"');
    expect(q.sql).toContain("l.status = 'active'");
  });
});
