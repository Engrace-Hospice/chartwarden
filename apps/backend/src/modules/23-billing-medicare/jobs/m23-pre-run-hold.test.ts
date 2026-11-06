// A claim job for an org whose clearinghouse is not live is HELD before it runs (no DLQ, no half-written claim), whatever the
// claims-billing enforcement mode says (shadow is the default, and shadow lets the work through the gate).
import {
  type ClearinghouseBinding,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { DelayedError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { configureClaimsBillingGate } from "../../../bootstrap/claims-billing-gate";
import type { M23TransportDeps } from "./clearinghouse-submission";
import { M23_CLAIM_TRANSPORT_QUEUES, holdBeforeRun } from "./m23-jobs";
import { M23_QUEUES } from "./queues";

const ORG = "11111111-1111-4111-8111-111111111111";

function depsFor(binding: ClearinghouseBinding) {
  const alerts: unknown[] = [];
  const transport: M23TransportDeps = {
    binding: { ...UNBOUND_NOT_CHOSEN, forOrg: async () => binding },
    contexts: { contextFor: async () => ({}) as never, providerEntitiesFor: async () => [] },
  };
  return {
    deps: {
      db: {} as never,
      connection: {} as never,
      transport,
      alerts: { dispatch: async (a: unknown) => void alerts.push(a) },
    },
    alerts,
  };
}
const jobOf = () => {
  const moved: number[] = [];
  return { moved, job: { moveToDelayed: async (at: number) => void moved.push(at) } };
};
const run = (
  d: ReturnType<typeof depsFor>["deps"],
  job: { moveToDelayed(at: number): Promise<void> },
  queue: string,
) => holdBeforeRun(d as never, job, "tok", queue, { organizationId: ORG });

describe("holdBeforeRun", () => {
  beforeEach(() => configureClaimsBillingGate({ mode: "shadow" }));

  it("holds a claim job while the org has chosen nothing, or its config is a draft / verified, or it bills outside", async () => {
    for (const binding of [UNBOUND_NOT_CHOSEN, UNBOUND_NOT_ACTIVE, UNBOUND_OUTSIDE]) {
      const { deps, alerts } = depsFor(binding);
      for (const queue of M23_CLAIM_TRANSPORT_QUEUES) {
        const { job, moved } = jobOf();
        await expect(run(deps, job, queue)).rejects.toBeInstanceOf(DelayedError);
        expect(moved).toHaveLength(1);
      }
      expect(alerts.length).toBeLessThanOrEqual(M23_CLAIM_TRANSPORT_QUEUES.size);
    }
  });

  it("lets the job run when the org's vendor is live", async () => {
    const { deps } = depsFor({ vendor: "stedi", transport: new InMemoryClearinghouse() });
    const { job, moved } = jobOf();
    await expect(run(deps, job, M23_QUEUES.claimSubmit)).resolves.toBeUndefined();
    expect(moved).toHaveLength(0);
  });

  it("does not hold the queues that never touch the clearinghouse", async () => {
    const { deps } = depsFor(UNBOUND_NOT_ACTIVE);
    for (const queue of [M23_QUEUES.eligibilityRefresh, M23_QUEUES.validationRun]) {
      const { job } = jobOf();
      await expect(run(deps, job, queue)).resolves.toBeUndefined();
    }
  });
});
