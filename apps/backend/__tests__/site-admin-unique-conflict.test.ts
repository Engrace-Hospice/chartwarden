/**
 * `uniqueConflictOf` names which unique index a Postgres 23505 hit. Drizzle wraps the driver error in a
 * `DrizzleQueryError` whose `.cause` is the pg `DatabaseError`, so the code and constraint live one level down:
 * reading only the top-level error answers "not a conflict" and a duplicate CCN/NPI/slug becomes a 500.
 */
import { describe, expect, it } from "vitest";
import { uniqueConflictOf } from "../src/bootstrap/site-admin-repository";

const pgError = (constraint: string, code = "23505") => ({
  code,
  constraint,
  message: `duplicate key value violates unique constraint "${constraint}"`,
});
const wrapped = (cause: unknown) => Object.assign(new Error("Failed query: insert ..."), { cause });

describe("uniqueConflictOf", () => {
  it("names the index from a raw driver error", () => {
    expect(uniqueConflictOf(pgError("provider_entity_ccn_idx"))).toBe("ccn");
    expect(uniqueConflictOf(pgError("provider_entity_npi_idx"))).toBe("npi");
    expect(uniqueConflictOf(pgError("organization_slug_key"))).toBe("slug");
  });

  it("names the index from a Drizzle-wrapped driver error (the shape the live database throws)", () => {
    expect(uniqueConflictOf(wrapped(pgError("provider_entity_ccn_idx")))).toBe("ccn");
    expect(uniqueConflictOf(wrapped(pgError("provider_entity_npi_idx")))).toBe("npi");
    expect(uniqueConflictOf(wrapped(pgError("organization_slug_key")))).toBe("slug");
  });

  it("is null for another SQLSTATE, an unknown index, or a non-error", () => {
    expect(uniqueConflictOf(wrapped(pgError("provider_entity_ccn_idx", "23503")))).toBeNull();
    expect(uniqueConflictOf(wrapped(pgError("something_else_idx")))).toBeNull();
    expect(uniqueConflictOf(wrapped(undefined))).toBeNull();
    expect(uniqueConflictOf(null)).toBeNull();
    expect(uniqueConflictOf("boom")).toBeNull();
  });
});
