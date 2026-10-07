// apps/backend/__tests__/m6-unique-violation.test.ts — Bug 4: the backstop that maps a `23505` on a named
// M6 unique index (behind the explicit pre-checks) to the same 409 domain error instead of a 500.
import { describe, expect, it } from "vitest";
import { AdmissionStateError } from "../src/modules/06-admission/state-machines/errors";
import {
  mapUniqueViolation,
  uniqueViolationConstraint,
} from "../src/modules/06-admission/unique-violation";

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code, constraint });
const drizzleWrap = (cause: Error): Error => new Error("Failed query: insert ...", { cause });

const toConflict = () => new AdmissionStateError("ELECTION_STATEMENT_CONFLICT", "dup");

describe("uniqueViolationConstraint", () => {
  it("reads the constraint through Drizzle's cause wrapper", () => {
    expect(
      uniqueViolationConstraint(drizzleWrap(pgError("23505", "election_statement_period_idx"))),
    ).toBe("election_statement_period_idx");
  });

  it("is null for a different SQLSTATE or a non-error", () => {
    expect(uniqueViolationConstraint(pgError("23503", "fk"))).toBeNull();
    expect(uniqueViolationConstraint("boom")).toBeNull();
  });
});

describe("mapUniqueViolation", () => {
  it("maps the named constraint to the 409 domain error", () => {
    const mapped = mapUniqueViolation(
      drizzleWrap(pgError("23505", "election_statement_period_idx")),
      { election_statement_period_idx: toConflict },
    );
    expect(mapped).toBeInstanceOf(AdmissionStateError);
    expect(mapped).toMatchObject({ code: "ELECTION_STATEMENT_CONFLICT", statusCode: 409 });
  });

  it("leaves an unlisted constraint and any other error untouched", () => {
    const other = drizzleWrap(pgError("23505", "some_other_idx"));
    expect(mapUniqueViolation(other, { election_statement_period_idx: toConflict })).toBe(other);
    const fault = new Error("connection reset");
    expect(mapUniqueViolation(fault, { election_statement_period_idx: toConflict })).toBe(fault);
  });
});
