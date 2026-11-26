// apps/backend/__tests__/critical-lab-resolution.test.ts — #1136 (CW-CS-01): the resolve workflow's refusals that fire
// BEFORE any database access (who may resolve, the required reason, the order/decision shape). The database half (RLS,
// append-only, audit, outbox, the sweep) is proven live in m11-critical-lab-resolution.live.test.ts.
import type { DbClient } from "@chartwarden/db";
import { ForbiddenError, ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_LAB_REASON_MIN_LENGTH,
  type ResolveCriticalLabInput,
  resolveCriticalLabResult,
} from "../src/modules/11-orders/critical-lab-resolution";
import type { OrderWriteOutboxPort } from "../src/modules/11-orders/orders-route-service-db";

const ORG = "11111111-1111-4111-8111-111111111111";
const RESULT = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const REASON = "Reviewed with the attending; no matching order exists for this specimen.";

/** A db and outbox that fail the test if the service reaches either: every refusal here must precede them. */
const untouched = {
  db: new Proxy(
    {},
    {
      get: () => () => expect.unreachable("the database was reached"),
    },
  ) as unknown as DbClient,
  outbox: {
    publish: async () => expect.unreachable("an event was published"),
  } satisfies OrderWriteOutboxPort,
};
const inScope = async () => undefined;
const prescriber = { membershipId: MEMBERSHIP, userId: "u1", disciplines: ["hospice_physician"] };
const noAction: ResolveCriticalLabInput = { resolution: "reviewed_no_action", reason: REASON };
const run = (input: ResolveCriticalLabInput, actor: Parameters<typeof resolveCriticalLabResult>[4] = prescriber) =>
  resolveCriticalLabResult(untouched, ORG, RESULT, input, actor, inScope);

describe("resolveCriticalLabResult — refusals before any database access", () => {
  it("refuses a non-prescriber discipline (403)", async () => {
    await expect(
      run(noAction, { ...prescriber, disciplines: ["rn_case_manager"] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a system actor and an actor with no membership (403)", async () => {
    await expect(run(noAction, { ...prescriber, kind: "system" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(run(noAction, { ...prescriber, membershipId: "" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("refuses a reason shorter than the minimum once trimmed (422)", async () => {
    const padded = `  ${"x".repeat(CRITICAL_LAB_REASON_MIN_LENGTH - 1)}   `;
    await expect(run({ resolution: "reviewed_no_action", reason: padded })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(run({ resolution: "reviewed_no_action", reason: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses a matched_to_order with no order, and a reviewed_no_action that names one (422)", async () => {
    await expect(run({ resolution: "matched_to_order", reason: REASON })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      run({ resolution: "reviewed_no_action", matchedOrderId: ORDER, reason: REASON }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("never echoes the reason in a refusal message", async () => {
    const secret = "patient Pat Synthetic asked us not to say";
    const error = await run({ resolution: "matched_to_order", reason: secret }).catch(
      (e: unknown) => e,
    );
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("Pat Synthetic");
  });
});
