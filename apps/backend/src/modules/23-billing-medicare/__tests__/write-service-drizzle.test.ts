// TASK-066 (DB-005) — `forwardDateSequestrationPolicy`'s forward-only invariant is now enforced at
// write time in application code, not by a `CURRENT_DATE` DB CHECK (packages/db/migrations/
// 0162_drop_time_relative_checks.sql). This is a focused unit test of that new validation ONLY: the
// reject path is provable without any database at all (it throws BEFORE the first `db`/`tx` access),
// which this test asserts directly via a `db` stub that throws on ANY property access — proving the
// short-circuit, not just the error. The accept path (falling through to the pre-existing,
// already-covered `inOrgCtx(...)` transaction) is unchanged code and not re-tested here.
import type { BillingDb } from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import type { M23WriteActor } from "../routes/actor";
import {
  buildDrizzleM23WriteService,
  buildRefusingM23JobEnqueue,
} from "../routes/write-service-drizzle";

/** Throws on any property access — proves a rejected call never touches the database. */
const UNTOUCHED_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("forwardDateSequestrationPolicy must reject before touching the database");
    },
  },
) as BillingDb;

const ACTOR: M23WriteActor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: [],
  membershipId: "33333333-3333-4333-8333-333333333333",
  stepUpRecent: false,
  actorKind: "user",
};

describe("buildDrizzleM23WriteService — forwardDateSequestrationPolicy forward-only (DB-005)", () => {
  const service = buildDrizzleM23WriteService(UNTOUCHED_DB, {
    now: () => new Date("2026-08-04T12:00:00Z"),
  });

  it("rejects a past effectiveFrom before touching the database", async () => {
    await expect(
      service.forwardDateSequestrationPolicy(ACTOR, {
        providerEntityId: "44444444-4444-4444-8444-444444444444",
        percentage: "2.00",
        effectiveFrom: "2020-01-01",
      }),
    ).rejects.toMatchObject({
      code: "SEQUESTRATION_POLICY_NOT_FORWARD_DATED",
      statusCode: 422,
    });
  });

  it("rejects effectiveFrom == today (not forward-dated) before touching the database", async () => {
    await expect(
      service.forwardDateSequestrationPolicy(ACTOR, {
        providerEntityId: "44444444-4444-4444-8444-444444444444",
        percentage: "2.00",
        effectiveFrom: "2026-08-04",
      }),
    ).rejects.toMatchObject({ code: "SEQUESTRATION_POLICY_NOT_FORWARD_DATED" });
  });

  it("passes the guard (reaches the database) for a genuinely future effectiveFrom", async () => {
    // The DB stub throws the instant ANYTHING touches it — reaching that throw (rather than the
    // WardenXError above) is itself proof the forward-only guard let this call through.
    await expect(
      service.forwardDateSequestrationPolicy(ACTOR, {
        providerEntityId: "44444444-4444-4444-8444-444444444444",
        percentage: "2.00",
        effectiveFrom: "2030-01-01",
      }),
    ).rejects.toThrow("must reject before touching the database");
  });

  it("is a real WardenXError (matches the M1 envelope contract)", async () => {
    try {
      await service.forwardDateSequestrationPolicy(ACTOR, {
        providerEntityId: "44444444-4444-4444-8444-444444444444",
        percentage: "2.00",
        effectiveFrom: "2020-01-01",
      });
      expect.unreachable("expected forwardDateSequestrationPolicy to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(WardenXError);
    }
  });
});

describe("M23 production queue containment", () => {
  it("refuses every job type instead of minting a synthetic accepted id", async () => {
    await expect(
      buildRefusingM23JobEnqueue().enqueue("claim.submit", "dedupe", { claimId: "claim-1" }),
    ).rejects.toMatchObject({ code: "SEAM_UNBOUND", statusCode: 503 });
  });
});
