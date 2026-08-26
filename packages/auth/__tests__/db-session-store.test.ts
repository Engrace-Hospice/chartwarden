// packages/auth/__tests__/db-session-store.test.ts — AUTH-T05b (ADR-0033).
// Pure mapping logic of the DB-backed SessionContextStore (the Drizzle query is verified in the
// AUTH-T06 live-PG lane). membershipId/roles are empty UNLESS an ActorEnrichment is supplied (the
// M3-owned reader path); both branches are covered here.
import { describe, expect, it } from "vitest";
import { toSessionContextRecord } from "../src/identity/db-session-store";

describe("toSessionContextRecord (AUTH-T05b)", () => {
  it("maps a session row to a context record (roles/membership deferred to M3)", () => {
    const at = new Date("2026-01-02T03:04:05Z");
    expect(
      toSessionContextRecord(
        {
          userId: "u1",
          activeOrganizationId: "org1",
          lastStepUpAt: at,
          lastStepUpFactor: "totp",
          sessionClass: "staff",
          scope: null,
        },
        "s1",
      ),
    ).toEqual({
      sessionId: "s1",
      userId: "u1",
      membershipId: null,
      organizationId: "org1",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: at,
      lastStepUpFactor: "totp",
      // F-030 — the class and the portal scope now ride the record. Nothing carried them off the row
      // before, so M16/M19/M31's predicates read an absent class, defaulted it to `staff`, and denied.
      sessionClass: "staff",
      portalAccountId: null,
      portalPatientId: null,
    });
  });

  it("carries a portal session's class + account, and its patient only once bound", () => {
    const unbound = toSessionContextRecord(
      {
        userId: "u3",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "caregiver_portal",
        scope: { portalAccountId: "acct-1" },
      },
      "s3",
    );
    expect(unbound.sessionClass).toBe("caregiver_portal");
    expect(unbound.portalAccountId).toBe("acct-1");
    expect(unbound.portalPatientId).toBeNull(); // before select-patient (M31 §2.3 / D2)

    const bound = toSessionContextRecord(
      {
        userId: "u3",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "caregiver_portal",
        scope: { portalAccountId: "acct-1", patientId: "pt-9" },
      },
      "s3",
    );
    expect(bound.portalPatientId).toBe("pt-9");
  });

  it("survives a malformed or absent `scope` rather than throwing on it", () => {
    // `scope` is jsonb and nullable; a row written before the portal classes existed has none, and a
    // hand-edited row could have anything. Neither may take down the authenticate hook.
    for (const scope of [null, undefined, "not-an-object", 42, { portalAccountId: 7 }, {}]) {
      const rec = toSessionContextRecord(
        {
          userId: "u4",
          activeOrganizationId: "org1",
          lastStepUpAt: null,
          lastStepUpFactor: null,
          sessionClass: "staff",
          scope,
        },
        "s4",
      );
      expect(rec.portalAccountId).toBeNull();
      expect(rec.portalPatientId).toBeNull();
    }
  });

  it("defaults an absent class to `staff` — the column is NOT NULL DEFAULT 'staff'", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u5",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: null,
        scope: null,
      },
      "s5",
    );
    expect(rec.sessionClass).toBe("staff");
  });

  it("maps a pre-org session to organizationId '' (resolver org-guard yields null)", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u2",
        activeOrganizationId: null,
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "staff",
        scope: null,
      },
      "s2",
    );
    expect(rec.organizationId).toBe("");
    expect(rec.lastStepUpAt).toBeNull();
    expect(rec.lastStepUpFactor).toBeNull();
  });

  it("merges M3 actor enrichment (membershipId + roles + PE/location scope) when supplied", () => {
    const rec = toSessionContextRecord(
      { userId: "u3", activeOrganizationId: "org3", lastStepUpAt: null, lastStepUpFactor: null },
      "s3",
      {
        membershipId: "m3",
        roles: ["nurse", "on_call"],
        providerEntityIds: ["pe-1"],
        locationIds: ["loc-1", "loc-2"],
      },
    );
    expect(rec.membershipId).toBe("m3");
    expect(rec.roles).toEqual(["nurse", "on_call"]);
    expect(rec.providerEntityIds).toEqual(["pe-1"]);
    expect(rec.locationIds).toEqual(["loc-1", "loc-2"]);
  });

  it("keeps empty membership/roles/scope when enrichment is null (no active membership in scope)", () => {
    const rec = toSessionContextRecord(
      { userId: "u4", activeOrganizationId: "org4", lastStepUpAt: null, lastStepUpFactor: null },
      "s4",
      null,
    );
    expect(rec.membershipId).toBeNull();
    expect(rec.roles).toEqual([]);
    expect(rec.providerEntityIds).toEqual([]);
    expect(rec.locationIds).toEqual([]);
  });
});
