// F-022 (#55) — the business-rule constraint registry and the `23505` classifier.
//
// The failure this closes: `POST /api/v1/admin/scales/licenses` for a scale that already has an
// active license answered `500 INTERNAL_ERROR / "An unexpected error occurred"` and logged
// `"unhandled error"`, because nothing inspected the Postgres `23505` inside Drizzle's wrapper. Four
// of the five `unhandled error` entries in a clean seed run were that one constraint.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import {
  businessRule,
  businessRuleConstraints,
  businessRuleMeaning,
  classifyDatabaseError,
} from "../src/business-rules";
// Importing the schema barrel is what RUNS the registrations — they are the index declarations.
import "../src/schema/index";

/** A `pg` DatabaseError as the driver actually presents one: `code` + `constraint` as own props. */
function pgUniqueViolation(constraint: string): Error {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  Object.assign(err, {
    code: "23505",
    constraint,
    table: "scale_license",
    severity: "ERROR",
  });
  return err;
}

function pgExclusionViolation(constraint: string): Error {
  const err = new Error(`conflicting key value violates exclusion constraint "${constraint}"`);
  Object.assign(err, {
    code: "23P01",
    constraint,
    table: "visit",
    severity: "ERROR",
  });
  return err;
}

/** What Drizzle hands the error handler: its own wrapper, the driver error on `.cause`. */
const wrapped = (cause: Error) =>
  new DrizzleQueryError("insert into scale_license …", ["org-1", "pps"], cause);

describe("businessRule() — the registration IS the index declaration", () => {
  it("returns the constraint name it was given, so it can be passed straight to uniqueIndex()", () => {
    expect(businessRule("fixture_rule_uq", "You already did that.")).toBe("fixture_rule_uq");
    expect(businessRuleMeaning("fixture_rule_uq")).toBe("You already did that.");
  });

  it("is idempotent for the same meaning — a schema module may be imported more than once", () => {
    businessRule("fixture_idempotent_uq", "Same sentence.");
    expect(() => businessRule("fixture_idempotent_uq", "Same sentence.")).not.toThrow();
  });

  it("refuses a second, DIFFERENT meaning for one constraint — one of the two is stale", () => {
    businessRule("fixture_conflict_uq", "The first sentence.");
    expect(() => businessRule("fixture_conflict_uq", "A different sentence.")).toThrow(
      /already registered with a different meaning/,
    );
  });

  it("registers the M9 scale-license rule by importing the schema, not a separate list", () => {
    const meaning = businessRuleMeaning("scale_license_active_per_org_scale_uq");
    expect(meaning).toBeDefined();
    expect(meaning).toMatch(/already has an active license/i);
    expect(businessRuleConstraints().map((c) => c.constraint)).toContain(
      "scale_license_active_per_org_scale_uq",
    );
  });

  it("every registered constraint actually exists in the migrations", () => {
    // The registry is a promise about a name Postgres will report. A typo, or a meaning left behind
    // after the index was renamed or dropped, is a rule that can never fire — indistinguishable from
    // one nobody wrote, which is the failure mode this whole mechanism exists to end.
    const dir = join(__dirname, "..", "migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    const registered = businessRuleConstraints().filter(
      (c) => !c.constraint.startsWith("fixture_"),
    );
    expect(registered.length).toBeGreaterThan(0);
    for (const { constraint } of registered) expect(sql).toContain(constraint);
  });
});

describe("classifyDatabaseError()", () => {
  it("recognises a registered constraint through Drizzle's wrapper", () => {
    const v = classifyDatabaseError(
      wrapped(pgUniqueViolation("scale_license_active_per_org_scale_uq")),
    );
    expect(v).toMatchObject({
      kind: "business-rule-violation",
      constraint: "scale_license_active_per_org_scale_uq",
    });
    expect(v?.meaning).toMatch(/already has an active license/i);
  });

  it("recognises the bare driver error too (no wrapper)", () => {
    expect(
      classifyDatabaseError(pgUniqueViolation("scale_license_active_per_org_scale_uq")),
    ).not.toBeNull();
  });

  it("translates a visit overlap exclusion violation into a business conflict", () => {
    const v = classifyDatabaseError(wrapped(pgExclusionViolation("visit_default_no_overlap")));
    expect(v).toMatchObject({
      kind: "business-rule-violation",
      constraint: "visit_default_no_overlap",
      reason: "CLINICIAN_SCHEDULE_CONFLICT",
    });
    expect(v?.meaning).toBe("This clinician already has another visit during this time.");
  });

  it("returns null for a 23505 on a constraint nobody has written a meaning for", () => {
    // The deliberate choice: silence, not a sentence guessed from the name. The caller keeps the
    // 500 it already got rather than being told something that might be wrong.
    expect(
      classifyDatabaseError(wrapped(pgUniqueViolation("some_index_nobody_declared_uq"))),
    ).toBeNull();
  });

  it("returns null for a different SQLSTATE on a registered constraint", () => {
    const err = new Error("null value in column violates not-null constraint");
    Object.assign(err, {
      code: "23502",
      constraint: "scale_license_active_per_org_scale_uq",
    });
    expect(classifyDatabaseError(wrapped(err))).toBeNull();
  });

  it("returns null for an ordinary error, a non-error, and a cause chain that never gets there", () => {
    expect(classifyDatabaseError(new Error("boom"))).toBeNull();
    expect(classifyDatabaseError("not an error")).toBeNull();
    expect(classifyDatabaseError(undefined)).toBeNull();
    expect(
      classifyDatabaseError(wrapped(new Error("some driver failure with no code"))),
    ).toBeNull();
  });

  it("does not follow a cause chain forever", () => {
    // A self-referential cause is pathological but cheap to survive; the bounded walk means a
    // malformed error can never hang the error handler.
    const loop = new Error("round and round");
    Object.assign(loop, { cause: loop });
    expect(classifyDatabaseError(loop)).toBeNull();
  });
});
