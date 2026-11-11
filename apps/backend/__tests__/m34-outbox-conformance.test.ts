import type { TSchema } from "@sinclair/typebox";
// #107 — M34 lifecycle outbox binding: the regression guard. With the live transactional-outbox dispatcher
// bound, a non-conformant publish ROLLS BACK the lifecycle mutation. The runSideEffects gate emits ONLY
// `m34.tenant.provisioned` (its generic payload conforms exactly); this asserts that conformance AND that the
// generic payload does NOT satisfy the other lifecycle events' schemas (the reason they stay un-emitted).
import { Value } from "@sinclair/typebox/value";
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

describe("slice 7 support consent events (7S)", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  const AT = "2026-11-09T10:00:00.000Z";
  const entry = (eventName: string) => {
    const e = M34_OUTBOX_EVENTS.find((x) => x.eventName === eventName);
    if (!e) throw new Error(`event ${eventName} not in M34_OUTBOX_EVENTS`);
    return e;
  };

  it("declares issued and revoked as outbox-only events consumed by the M36 seam", () => {
    for (const name of ["m34.support_consent_grant.issued", "m34.support_consent_grant.revoked"]) {
      expect(entry(name)).toMatchObject({
        moduleOwner: "m34",
        declaredConsumers: [],
        seamConsumers: ["m36"],
        isOutboxOnly: true,
      });
    }
  });

  it("issued carries the grant, scope, expiry and a nullable help request; revoked the closed-session count", () => {
    const issued = schemaFor("m34.support_consent_grant.issued");
    const body = { grantId: ID, tenantAccountId: ID, scope: "assist", expiresAt: AT };
    expect(Value.Check(issued, { ...body, helpRequestId: null })).toBe(true);
    expect(Value.Check(issued, { ...body, helpRequestId: ID })).toBe(true);
    expect(Value.Check(issued, body)).toBe(false);
    const revoked = schemaFor("m34.support_consent_grant.revoked");
    expect(
      Value.Check(revoked, {
        grantId: ID,
        tenantAccountId: ID,
        revokedAt: AT,
        closedSessionCount: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(revoked, {
        grantId: ID,
        tenantAccountId: ID,
        revokedAt: AT,
        closedSessionCount: -1,
      }),
    ).toBe(false);
  });

  it("the session-expired event names every way a session ends, manual as manual_close", () => {
    const expired = schemaFor("m34.support_session.expired");
    const body = { sessionId: ID, grantId: ID, tenantAccountId: ID, closedAt: AT };
    for (const closeReason of ["expired", "grant_revoked", "manual_close", "forced_terminated"]) {
      expect(Value.Check(expired, { ...body, closeReason })).toBe(true);
    }
    expect(Value.Check(expired, { ...body, closeReason: "manual" })).toBe(false);
  });
});
