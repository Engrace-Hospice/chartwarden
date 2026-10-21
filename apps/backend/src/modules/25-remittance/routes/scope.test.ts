// GAP-148 — the M25 provider-entity read scope is fail-closed and never client-widened.
import { schema } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { providerEntityScopeCondition } from "./scope";

const COLUMN = schema.denialCase.providerEntityId;
const render = (cond: ReturnType<typeof providerEntityScopeCondition>) =>
  cond ? new PgDialect().sqlToQuery(cond) : null;
const PE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("providerEntityScopeCondition", () => {
  it("applies no condition for an unrestricted actor without a filter", () => {
    expect(providerEntityScopeCondition(COLUMN, undefined)).toBeUndefined();
  });

  it("honours the filter for an unrestricted actor", () => {
    expect(render(providerEntityScopeCondition(COLUMN, undefined, PE_A))?.params).toEqual([PE_A]);
  });

  it("narrows a scoped actor to exactly its entities", () => {
    const q = render(providerEntityScopeCondition(COLUMN, [PE_A, PE_B]));
    expect(q?.sql).toContain("in (");
    expect(q?.params).toEqual([PE_A, PE_B]);
  });

  it("matches nothing when the requested entity is outside the scope (PE-B cannot read PE-A)", () => {
    const q = render(providerEntityScopeCondition(COLUMN, [PE_B], PE_A));
    expect(q?.sql).toBe("false");
  });

  it("matches nothing for an empty scope, even with a filter (fail-closed)", () => {
    expect(render(providerEntityScopeCondition(COLUMN, []))?.sql).toBe("false");
    expect(render(providerEntityScopeCondition(COLUMN, [], PE_A))?.sql).toBe("false");
  });

  it("allows the requested entity when it is inside the scope", () => {
    expect(render(providerEntityScopeCondition(COLUMN, [PE_A, PE_B], PE_A))?.params).toEqual([
      PE_A,
    ]);
  });
});
