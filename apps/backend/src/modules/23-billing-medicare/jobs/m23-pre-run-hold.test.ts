// A claim job for an org whose clearinghouse is not live is HELD before it runs (no DLQ, no half-written claim), whatever the
// claims-billing enforcement mode says (shadow is the default, and shadow lets the work through the gate).
import { ChartWardenError } from "@chartwarden/types";
import {
  type ClearinghouseBinding,
  UNBOUND_BAA_REVOKED,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { DelayedError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { configureClaimsBillingGate } from "../../../bootstrap/claims-billing-gate";
import type { M23TransportDeps } from "./clearinghouse-submission";
import {
  CLEARINGHOUSE_UNBOUND_ALERT,
  __resetClearinghouseAlertMemoryForTest,
} from "./clearinghouse-unbound-hold";
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

  // ADR-0053 amendment ("build it"): a platform operator revoked the tenant's vendor BAA, so the resolver binds nothing and every job
  // that would send through the vendor is HELD (no attempt spent, no DLQ), a NOE / NOTR / transfer notice with a CRITICAL alert that
  // says why. Nothing is sent, and nothing is failed.
  it.each([
    ["claim", M23_QUEUES.claimSubmit, "warn"],
    ["claim retry", M23_QUEUES.claimSubmitRetry, "warn"],
    ["NOE", M23_QUEUES.noeSubmit, "critical"],
    ["NOTR", M23_QUEUES.notrSubmit, "critical"],
    ["transfer notice", M23_QUEUES.transferNoticeSubmit, "critical"],
  ])(
    "holds a %s job of an org whose BAA was revoked, and says why (%s alert)",
    async (_l, queue, severity) => {
      __resetClearinghouseAlertMemoryForTest();
      const { deps, alerts } = depsFor(UNBOUND_BAA_REVOKED);
      const { job, moved } = jobOf();

      await expect(run(deps, job, queue)).rejects.toBeInstanceOf(DelayedError);

      expect(moved).toHaveLength(1);
      expect(alerts).toEqual([
        expect.objectContaining({
          alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
          severity,
          organizationId: ORG,
          payload: { queue, reason: "baa_revoked" },
        }),
      ]);
    },
  );

  it("lets the job run when the org's vendor is live", async () => {
    const { deps } = depsFor({ vendor: "stedi", transport: new InMemoryClearinghouse() });
    const { job, moved } = jobOf();
    await expect(run(deps, job, M23_QUEUES.claimSubmit)).resolves.toBeUndefined();
    expect(moved).toHaveLength(0);
  });

  it.each(["claimmd", "stedi"] as const)(
    "holds notice submissions for %s because 837I claim support does not verify hospice notice capability",
    async (vendor) => {
      __resetClearinghouseAlertMemoryForTest();
      const { deps, alerts } = depsFor({
        vendor,
        transport: new InMemoryClearinghouse(),
      } as unknown as ClearinghouseBinding);
      const { job, moved } = jobOf();

      await expect(run(deps, job, M23_QUEUES.noeSubmit)).rejects.toBeInstanceOf(DelayedError);

      expect(moved).toHaveLength(1);
      expect(alerts).toEqual([
        expect.objectContaining({
          severity: "critical",
          payload: {
            queue: M23_QUEUES.noeSubmit,
            reason: `M23_NOTICE_${vendor.toUpperCase()}_CAPABILITY_UNVERIFIED`,
          },
        }),
      ]);
    },
  );

  it("holds a direct-MAC notice when its gateway capability is absent", async () => {
    __resetClearinghouseAlertMemoryForTest();
    const { deps, alerts } = depsFor({
      vendor: "direct_mac",
      transport: new InMemoryClearinghouse(),
    } as unknown as ClearinghouseBinding);
    const { job, moved } = jobOf();

    await expect(run(deps, job, M23_QUEUES.transferNoticeSubmit)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moved).toHaveLength(1);
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: "critical",
        payload: {
          queue: M23_QUEUES.transferNoticeSubmit,
          reason: "M23_NOTICE_DIRECT_MAC_GATEWAY_UNAVAILABLE",
        },
      }),
    ]);
  });

  it("holds Direct-MAC notices when the internal renderer is not bound", async () => {
    __resetClearinghouseAlertMemoryForTest();
    const { deps, alerts } = depsFor({
      vendor: "direct_mac",
      transport: new InMemoryClearinghouse(),
    } as unknown as ClearinghouseBinding);
    Object.assign(deps, { x12: {} as never, macPortal: {} as never });
    const { job, moved } = jobOf();

    await expect(run(deps, job, M23_QUEUES.noeSubmit)).rejects.toBeInstanceOf(DelayedError);
    expect(moved).toHaveLength(1);
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: "critical",
        payload: {
          queue: M23_QUEUES.noeSubmit,
          reason: "M23_NOTICE_AUTHORITATIVE_RENDERER_NOT_BOUND",
        },
      }),
    ]);
  });

  it.each([
    [M23_QUEUES.noeSubmit, "noeId"],
    [M23_QUEUES.notrSubmit, "notrId"],
    [M23_QUEUES.transferNoticeSubmit, "transferNoticeId"],
  ] as const)("does not render or disclose MBI for %s when the gateway contract guarantees a hold", async (queue, idField) => {
    __resetClearinghouseAlertMemoryForTest();
    const { deps, alerts } = depsFor({
      vendor: "direct_mac",
      transport: new InMemoryClearinghouse(),
    } as unknown as ClearinghouseBinding);
    Object.assign(deps, { x12: {} as never, macPortal: {} as never });
    const calls: unknown[] = [];
    Object.assign(deps, {
      noticeRenderer: Object.fromEntries(["renderNoe", "renderNotr", "renderTransfer", "renderCancellation"].map((name) => [
        name,
        async (input: unknown) => { calls.push({ method: name, input }); return {}; },
      ])),
    });
    const { job, moved } = jobOf();
    await expect(holdBeforeRun(deps as never, job, "tok", queue, {
      organizationId: ORG,
      [idField]: "notice-id",
      submissionId: "submission-id",
    })).rejects.toBeInstanceOf(DelayedError);
    expect(calls).toEqual([]);
    expect(moved).toHaveLength(1);
    expect(alerts).toEqual([expect.objectContaining({
      severity: "critical",
      payload: { queue, reason: "M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED" },
    })]);
  });

  it("does not hold the queues that never touch the clearinghouse", async () => {
    const { deps } = depsFor(UNBOUND_NOT_ACTIVE);
    for (const queue of [M23_QUEUES.eligibilityRefresh, M23_QUEUES.validationRun]) {
      const { job } = jobOf();
      await expect(run(deps, job, queue)).resolves.toBeUndefined();
    }
  });

  // F1: a held NOE / NOTR / transfer notice may cost a CMS deadline, and shadow mode (set above) does not shield it. Its alert is
  // critical; a held claim's is a warning; and neither silences the other (each severity has its own quiet window).
  describe("the hold alert", () => {
    beforeEach(() => __resetClearinghouseAlertMemoryForTest());

    it.each([
      ["NOE", M23_QUEUES.noeSubmit, "critical"],
      ["NOTR", M23_QUEUES.notrSubmit, "critical"],
      ["transfer notice", M23_QUEUES.transferNoticeSubmit, "critical"],
      ["claim", M23_QUEUES.claimSubmit, "warn"],
    ])("a held %s raises a %s alert", async (_label, queue, severity) => {
      const { deps, alerts } = depsFor(UNBOUND_NOT_ACTIVE);
      const { job } = jobOf();

      await expect(run(deps, job, queue)).rejects.toBeInstanceOf(DelayedError);

      expect(alerts).toEqual([
        expect.objectContaining({
          alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
          severity,
          organizationId: ORG,
          payload: { queue, reason: "not_active" },
        }),
      ]);
    });

    it("a held claim's earlier warning does not silence the critical alert of a held NOE of the same org", async () => {
      const { deps, alerts } = depsFor(UNBOUND_NOT_ACTIVE);
      await expect(run(deps, jobOf().job, M23_QUEUES.claimSubmit)).rejects.toBeInstanceOf(
        DelayedError,
      );
      await expect(run(deps, jobOf().job, M23_QUEUES.noeSubmit)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect((alerts as { severity: string }[]).map((a) => a.severity)).toEqual([
        "warn",
        "critical",
      ]);
    });
  });

  // CH-7: a credential that cannot be opened is the tenant's to re-enter: the job is HELD (no attempt spent, no DLQ) and the alert
  // says so once, as the shared crons do; any other failure of the lookup still fails the job.
  describe("an org whose stored credential cannot be opened", () => {
    beforeEach(() => __resetClearinghouseAlertMemoryForTest());
    const withResolveError = (err: Error) => {
      const { deps, alerts } = depsFor(UNBOUND_NOT_ACTIVE);
      const transport: M23TransportDeps = {
        ...deps.transport,
        binding: {
          ...deps.transport.binding,
          forOrg: async () => {
            throw err;
          },
        },
      };
      return { deps: { ...deps, transport }, alerts };
    };
    const unreadable = () =>
      new ChartWardenError("CLEARINGHOUSE_CREDENTIAL_UNREADABLE", "unreadable", 503);

    it("holds the job and raises ONE alert carrying the code, never the message", async () => {
      const { deps, alerts } = withResolveError(unreadable());
      const { job, moved } = jobOf();

      await expect(run(deps, job, M23_QUEUES.claimSubmit)).rejects.toBeInstanceOf(DelayedError);
      await expect(run(deps, jobOf().job, M23_QUEUES.claimSubmit)).rejects.toBeInstanceOf(
        DelayedError,
      );

      expect(moved).toHaveLength(1);
      expect(alerts).toEqual([
        expect.objectContaining({
          alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
          severity: "warn",
          payload: { queue: M23_QUEUES.claimSubmit, reason: "CLEARINGHOUSE_CREDENTIAL_UNREADABLE" },
        }),
      ]);
    });

    it("holds a NOE with a critical alert", async () => {
      const { deps, alerts } = withResolveError(unreadable());
      await expect(run(deps, jobOf().job, M23_QUEUES.noeSubmit)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(alerts).toEqual([expect.objectContaining({ severity: "critical" })]);
    });

    it("still fails the job for any other failure of the lookup (a database fault is a retry, not a hold)", async () => {
      const { deps, alerts } = withResolveError(new Error("connection reset"));
      const { job, moved } = jobOf();

      await expect(run(deps, job, M23_QUEUES.claimSubmit)).rejects.toThrow("connection reset");

      expect(moved).toHaveLength(0);
      expect(alerts).toEqual([]);
    });
  });
});
