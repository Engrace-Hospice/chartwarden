// F-212 - the sequestration-policy service's VALIDATION runs before any database access: a rejected entry provably never
// opens a transaction (the `db` stub throws on ANY property access), so a bad percentage/window cannot half-write.
import type { BillingDb } from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import type { M23WriteActor } from "../routes/actor";
import { buildDrizzleSequestrationPolicyService } from "../routes/sequestration-policy-service";

const UNTOUCHED_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("validation must reject before touching the database");
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
const PE = "44444444-4444-4444-8444-444444444444";

describe("sequestration policy service - validation short-circuit", () => {
  const svc = buildDrizzleSequestrationPolicyService(
    UNTOUCHED_DB,
    () => new Date("2026-09-29T12:00:00Z"),
  );

  it.each([
    [
      "a percentage above the statutory cap",
      { percentage: "20", effectiveFrom: "2026-10-01" },
      /plausible band/,
    ],
    [
      "a non-2% percentage without a reason",
      { percentage: "0.00", effectiveFrom: "2026-10-01" },
      /requires a setReason/,
    ],
    [
      "a start before sequestration began",
      { percentage: "2.00", effectiveFrom: "2012-01-01" },
      /precedes 2013-04-01/,
    ],
    [
      "a window that ends before it starts",
      { percentage: "2.00", effectiveFrom: "2026-10-01", effectiveTo: "2026-09-01" },
      /must not precede/,
    ],
  ])("createPolicy rejects %s as a typed 422 before any DB access", async (_n, body, message) => {
    await expect(svc.createPolicy(ACTOR, { providerEntityId: PE, ...body })).rejects.toMatchObject({
      code: "SEQUESTRATION_POLICY_INVALID",
      statusCode: 422,
      message: expect.stringMatching(message),
    });
  });

  it("supersedePolicy validates the successor before touching the database", async () => {
    await expect(
      svc.supersedePolicy(ACTOR, "55555555-5555-4555-8555-555555555555", {
        providerEntityId: PE,
        percentage: "200",
        effectiveFrom: "2026-10-01",
      }),
    ).rejects.toMatchObject({ code: "SEQUESTRATION_POLICY_INVALID" });
  });
});
