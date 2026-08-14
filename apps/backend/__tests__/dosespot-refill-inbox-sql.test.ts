/**
 * M12 §2.7 — the refill-inbox narrowing must be a `WHERE` clause, not a post-read `.filter()`.
 *
 * GAP-026 closed the AUTHORIZATION half of this: before it, `listRefills` returned every refill row
 * in the tenant to every clinician. The fix filtered the rows in the service, which is correct and
 * which a behavioural test cannot tell apart from the query-side version — both return exactly the
 * caller's refills. What it does NOT fix is that the statement still reads every refill in the tenant:
 * the cost of MY inbox scales with EVERY OTHER clinician's refill volume, and the whole tenant's
 * refill PHI is pulled into app memory to be thrown away.
 *
 * So this suite asserts on the emitted SQL. `refillInboxWhere` is the predicate `listRefills` puts in
 * its `WHERE`; rendering it with drizzle's `toSQL()` is the only assertion that distinguishes
 * "narrowed by the database" from "narrowed after the database handed us everything".
 *
 * No database is touched — `createDbClient` builds a `pg.Pool` lazily, and `toSQL()` renders without
 * connecting.
 */
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { refillInboxWhere } from "../src/modules/12-dosespot/dosespot-route-service-db";

const ME = "22222222-2222-2222-2222-222222222222";
const PATIENT_A = "33333333-3333-3333-3333-333333333333";
const PATIENT_B = "44444444-4444-4444-4444-444444444444";

/** A never-connected handle — enough for drizzle to RENDER sql. */
const handle = createDbClient({ connectionString: "postgres://render-only/none" });
const db = handle.db as unknown as DbClient;

/** Render the predicate the way `listRefills` uses it: as the WHERE of a select over refill_request. */
function render(caseloadPatientIds: readonly string[], membershipId: string | null) {
  const where = refillInboxWhere(db, {
    caseloadPatientIds,
    actor: { userId: "user-1", membershipId },
  });
  if (where === null) return null;
  return db.select().from(schema.refillRequests).where(where).toSQL();
}

describe("M12 refill inbox — the narrowing is in the WHERE clause (§2.7)", () => {
  it("emits all three axes as SQL, none of them as an app-side filter", () => {
    const q = render([PATIENT_A, PATIENT_B], ME);
    expect(q).not.toBeNull();
    const sql = q!.sql.toLowerCase();

    // The statement is filtered at all — the pre-fix version had no `where` beyond RLS.
    expect(sql).toContain("where");
    // Axis 1 — caseload, as a bound id list rather than a `Set.has` in JS.
    expect(sql).toContain('"refill_request"."patient_id" in');
    // Axis 2 — the approver column on the row itself.
    expect(sql).toContain('"refill_request"."approved_by_membership_id" =');
    // Axis 3 — the source order's prescriber, as a correlated semi-join into M12's OWN table.
    expect(sql).toContain("exists");
    expect(sql).toContain('from "medication_order"');
    expect(sql).toContain('"medication_order"."prescriber_membership_id" =');
    // …correlated on BOTH the join key and the tenant, so a same-id order in another tenant (which
    // RLS on the outer table would already have hidden) cannot satisfy the sub-select either.
    expect(sql).toContain(
      '"medication_order"."id" = "refill_request"."source_medication_order_id"',
    );
    expect(sql).toContain(
      '"medication_order"."organization_id" = "refill_request"."organization_id"',
    );
    // The axes are alternatives, not requirements — a caseload patient's refill counts even when I
    // never prescribed it.
    expect(sql).toContain(" or ");

    // Every value is BOUND, never inlined — the caseload ids and my membership id, nothing else.
    expect(q!.params).toEqual([PATIENT_A, PATIENT_B, ME, ME]);
  });

  it("drops the caseload axis when M5 resolved no caseload, keeping the prescriber axes", () => {
    const q = render([], ME);
    expect(q).not.toBeNull();
    const sql = q!.sql.toLowerCase().split(" where ")[1]!;
    expect(sql).not.toContain('"refill_request"."patient_id" in');
    expect(sql).toContain('"refill_request"."approved_by_membership_id" =');
    expect(sql).toContain("exists");
    expect(q!.params).toEqual([ME, ME]);
  });

  it("drops both membership axes for an actor with no membership id, keeping the caseload", () => {
    const q = render([PATIENT_A], null);
    expect(q).not.toBeNull();
    // Assert on the WHERE half only — every column name also appears in the SELECT list.
    const where = q!.sql.toLowerCase().split(" where ")[1]!;
    expect(where).toContain('"refill_request"."patient_id" in');
    expect(where).not.toContain("exists");
    expect(where).not.toContain("approved_by_membership_id");
    expect(q!.params).toEqual([PATIENT_A]);
  });

  it("returns null — never an unfiltered query — when NO axis can name a row", () => {
    // An empty `or()` folds to `undefined` in drizzle, and a select with `where(undefined)` is an
    // UNFILTERED read: the exact tenant-wide leak the narrowing exists to close. The predicate says
    // "no query" so the caller returns an empty inbox without issuing one.
    expect(
      refillInboxWhere(db, { caseloadPatientIds: [], actor: { userId: "u", membershipId: null } }),
    ).toBeNull();
  });
});
