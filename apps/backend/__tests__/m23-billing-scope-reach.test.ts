// billingScopeReach: the one definition of a billing actor's provider-entity reach (shared by the detail route's
// provider_entity_billing_scope predicate and the DDE list query).
import { describe, expect, it } from "vitest";
import { billingScopeReach } from "../src/modules/23-billing-medicare/abac-predicates";

const A = "77777777-7777-4777-8777-777777777777";
const B = "88888888-8888-4888-8888-888888888888";
const ctx = (roles: string[], providerEntityIds: string[], actorKind?: string) => ({
  roles,
  providerEntityIds,
  attributes: actorKind ? { actorKind } : {},
});

describe("billingScopeReach", () => {
  it("lets the org-wide billing roles and the system principal reach everything", () => {
    expect(billingScopeReach(ctx(["org_admin"], [])).all).toBe(true);
    expect(billingScopeReach(ctx(["compliance_officer"], [A])).all).toBe(true);
    expect(billingScopeReach(ctx([], [], "system")).all).toBe(true);
  });

  it("limits anyone else to their own provider entities, and no reach is nothing", () => {
    expect(billingScopeReach(ctx(["billing_manager"], [A, B]))).toEqual({
      all: false,
      providerEntityIds: [A, B],
    });
    expect(billingScopeReach(ctx(["billing_manager"], []))).toEqual({
      all: false,
      providerEntityIds: [],
    });
  });

  it("drops entries that are not uuids, so a malformed id can never reach a uuid-typed query", () => {
    const reach = billingScopeReach(ctx(["billing_manager"], [A, "not-a-uuid", "", "'; --"]));
    expect(reach).toEqual({ all: false, providerEntityIds: [A] });
  });
});
