// packages/auth/__tests__/db-session-store.test.ts — AUTH-T05b (ADR-0033).
// Pure mapping logic of the DB-backed SessionContextStore (the Drizzle query is verified in the
// AUTH-T06 live-PG lane). membershipId/roles are intentionally empty here — M3 owns those tables.
import { describe, expect, it } from "vitest";
import { toSessionContextRecord } from "../src/identity/db-session-store";

describe("toSessionContextRecord (AUTH-T05b)", () => {
  it("maps a session row to a context record (roles/membership deferred to M3)", () => {
    const at = new Date("2026-01-02T03:04:05Z");
    expect(
      toSessionContextRecord({ userId: "u1", activeOrganizationId: "org1", lastStepUpAt: at, lastStepUpFactor: "totp" }, "s1"),
    ).toEqual({
      sessionId: "s1",
      userId: "u1",
      membershipId: null,
      organizationId: "org1",
      roles: [],
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
});
