// #107 — M34 lifecycle outbox binding: the regression guard. With the live transactional-outbox dispatcher
// bound, a non-conformant publish ROLLS BACK the lifecycle mutation. The runSideEffects gate emits ONLY
// `m34.tenant.provisioned` (its generic payload conforms exactly); this asserts that conformance AND that the
// generic payload does NOT satisfy the other lifecycle events' schemas (the reason they stay un-emitted).
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/index";

/** The generic payload runSideEffects builds for a lifecycle effect (from the tenant account row). */
const GENERIC_PAYLOAD = {
  tenantAccountId: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  legalBusinessName: "Acme Hospice LLC",
  billingContactEmail: "billing@acme.example",
};

const schemaFor = (eventName: string): TSchema => {
  const entry = M34_OUTBOX_EVENTS.find((e) => e.eventName === eventName);
  if (!entry) throw new Error(`event ${eventName} not in M34_OUTBOX_EVENTS`);
  return entry.payloadSchema as TSchema;
};

describe("M34 lifecycle outbox conformance (#107)", () => {
  it("the gated event m34.tenant.provisioned conforms to its registered schema", () => {
    expect(Value.Check(schemaFor("m34.tenant.provisioned"), GENERIC_PAYLOAD)).toBe(true);
  });

  it("the generic payload does NOT conform to offboarding_initiated (so it is correctly excluded)", () => {
    // offboarding_initiated requires purpose / initiatedByMembershipId / initiatedAt — absent from the generic
    // payload — so emitting it would roll back; the gate excludes it until a per-event payload is threaded.
    expect(Value.Check(schemaFor("m34.tenant.offboarding_initiated"), GENERIC_PAYLOAD)).toBe(false);
  });
});
