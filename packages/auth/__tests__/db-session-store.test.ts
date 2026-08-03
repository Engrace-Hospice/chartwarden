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
        { userId: "u1", activeOrganizationId: "org1", lastStepUpAt: at, lastStepUpFactor: "totp" },
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
    });
  });

  it("maps a pre-org session to organizationId '' (resolver org-guard yields null)", () => {
    const rec = toSessionContextRecord(
      { userId: "u2", activeOrganizationId: null, lastStepUpAt: null, lastStepUpFactor: null },
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
