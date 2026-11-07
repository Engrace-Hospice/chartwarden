import { describe, expect, it, vi } from "vitest";
import { isPlatformJobRegistered, resetPlatformJobRegistry, withPlatformContext } from "@chartwarden/tenancy";
import { createClaimMdEraRecoveryService, registerClaimMdEraRecoveryPlatformJob, type ClaimMdEraRecoveryActor } from "../claimmd-era-recovery";
import { CLAIMMD_ERA_RECOVERY_JOB_ID } from "../claimmd-era-store";

const actor: ClaimMdEraRecoveryActor = {
  id: "10000000-0000-4000-8000-000000000001", kind: "platform_operator", authorization: "audited-era-recovery",
};
const request = {
  actionId: "20000000-0000-4000-8000-000000000001", inboxId: "30000000-0000-4000-8000-000000000001",
  accountReference: "synthetic-account", usage: "test" as const, stage: "ownership_resolution" as const,
  reasonCode: "NEW_EVIDENCE_AVAILABLE", expectedState: "unmatched", expectedVersion: 2,
};

function build(authorized = true) {
  const recover = vi.fn(async () => ({ outcome: "requeued" as const, state: "unmatched", retryEligible: true,
    resolutionVersion: 2, deliveryId: null }));
  const resolve = vi.fn(async () => ({ status: "ambiguous", version: 3 }));
  const service = createClaimMdEraRecoveryService({
    store: { recover } as never,
    resolver: { resolve } as never,
    authorize: vi.fn(async (candidate) => authorized && candidate.kind === "platform_operator" &&
      candidate.authorization === "audited-era-recovery"),
  });
  return { service, recover, resolve };
}

describe("internal Claim.MD ERA recovery boundary", () => {
  it("registers the recovery job required by the real audited platform-context gate", async () => {
    resetPlatformJobRegistry();
    const db = { transaction: async (fn: (tx: object) => Promise<unknown>) => fn({}) };
    const audit = vi.fn(async () => {});
    const run = () => withPlatformContext(db as never,
      { jobId: CLAIMMD_ERA_RECOVERY_JOB_ID, reason: "synthetic recovery", crossTenant: true },
      audit as never, async () => "authorized");
    try {
      expect(isPlatformJobRegistered(CLAIMMD_ERA_RECOVERY_JOB_ID)).toBe(false);
      await expect(run()).rejects.toThrow();
      registerClaimMdEraRecoveryPlatformJob();
      expect(isPlatformJobRegistered(CLAIMMD_ERA_RECOVERY_JOB_ID)).toBe(true);
      await expect(run()).resolves.toBe("authorized");
      expect(audit).toHaveBeenCalledOnce();
    } finally {
      resetPlatformJobRegistry();
    }
  });

  it("requires the audited privileged authorization before touching central state", async () => {
    const { service, recover } = build(false);
    await expect(service.requeue(request, actor)).rejects.toThrow("CLAIMMD_ERA_RECOVERY_FORBIDDEN");
    expect(recover).not.toHaveBeenCalled();
  });

  it("requires an explicit reason and sends expected state/version to the store", async () => {
    const { service, recover, resolve } = build();
    await expect(service.requeue({ ...request, reasonCode: "" }, actor)).rejects.toThrow("CLAIMMD_ERA_RECOVERY_REASON_REQUIRED");
    expect(recover).not.toHaveBeenCalled();
    const result = await service.requeue(request, actor);
    expect(recover).toHaveBeenCalledWith({ ...request, actorId: actor.id });
    expect(resolve).toHaveBeenCalledWith(request.inboxId);
    expect(result).toMatchObject({ outcome: "requeued", resolutionStatus: "ambiguous", resolutionVersion: 3 });
  });

  it("does not rerun ownership resolution for a reconciled action or other recovery stages", async () => {
    const { service, recover, resolve } = build();
    recover.mockResolvedValueOnce({ outcome: "reconciled", state: "delivered", retryEligible: false,
      resolutionVersion: 2, deliveryId: "40000000-0000-4000-8000-000000000001" } as never);
    await service.requeue(request, actor);
    expect(resolve).not.toHaveBeenCalled();
    await service.requeue({ ...request, actionId: "20000000-0000-4000-8000-000000000002", stage: "capture" }, actor);
    expect(resolve).not.toHaveBeenCalled();
  });
});
