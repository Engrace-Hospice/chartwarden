import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClaimMdEraDeliveryService } from "../claimmd-era-delivery";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROVIDER = "00000000-0000-4000-8000-000000000011";
const INBOX = "00000000-0000-4000-8000-000000000101";
const RESOLUTION = "00000000-0000-4000-8000-000000000102";
const DELIVERY = "00000000-0000-4000-8000-000000000103";
const ACCOUNT = "synthetic-account";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function raw835() {
  const body = ["BPR*I*0.00*C*NON*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
    "TRN*1*TRACE-SYNTH*1512345678", "N1*PR*SYNTHETIC PAYER*XV*99999", "N1*PE*SYNTHETIC HOSPICE*XX*1999999999",
    "CLP*PCN-SYNTH*4*0.00*0.00*0.00*MC*ICN-SYNTH"];
  const isa13 = "100000001";
  const isa = ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "SYNTHMAC".padEnd(15),
    "ZZ", "SYNTHHOSPICE".padEnd(15), "260616", "1200", "^", "00501", isa13, "0", "T", ":"].join("*");
  return isa + "~" + ["GS*HP*SYNTHMAC*SYNTHHOSPICE*20260616*1200*77*X*005010X221A1", "ST*835*0001", ...body,
    "SE*7*0001", "GE*1*77", "IEA*1*" + isa13].map((s) => s + "~").join("");
}

function setup(options: { readonly failFirstCommit?: boolean; readonly resolutionFails?: boolean } = {}) {
  const raw = raw835();
  const decision = { payeeOutcome: "verified", transactionSets: [{ fileIndex: 0, transactionSetControlNumber: "0001",
    payee: { npi: "1999999999", taxId: null } }], claims: [{ fileIndex: 0, transactionSetControlNumber: "0001",
    pcn: "PCN-SYNTH", outcome: "unmatched", claimId: null }] };
  const trace: string[] = [];
  let commitCount = 0;
  const stagedDetail: Record<string, unknown>[] = [];
  const store = {
    readCapturedEra: vi.fn(async () => ({ inboxId: INBOX, streamId: "stream", vendor: "claimmd", accountReference: ACCOUNT,
      usage: "test" as const, eraId: "77", originalDigest: sha(JSON.stringify([raw])), files: [raw] })),
    readVerifiedResolution: vi.fn(async () => {
      if (options.resolutionFails) throw new Error("synthetic failure");
      return { resolutionId: RESOLUTION, inboxId: INBOX, accountReference: ACCOUNT, usage: "test" as const, eraId: "77",
        originalDigest: sha(JSON.stringify([raw])), version: 1, algorithmVersion: "BIL141A_V1", organizationId: ORG,
        providerEntityId: PROVIDER, locationId: null, decision };
    }),
    prepareDelivery: vi.fn(async () => ({ outcome: "prepared" as const, deliveryId: DELIVERY,
      idempotencyKey: sha("stable-idempotency-key"), stageIds: [], organizationId: ORG })),
    finishDelivery: vi.fn(async (value: { readonly state: string; readonly stageIds: readonly string[] }) => {
      commitCount++;
      trace.push("central-commit");
      if (options.failFirstCommit && commitCount === 1) throw new Error("synthetic timeout after stage");
      return { outcome: value.state, reason: null };
    }),
    confirmDeliveryTenantFinalized: vi.fn(async () => { trace.push("tenant-finalized"); }),
    holdDelivery: vi.fn(async () => ({ id: DELIVERY, organizationId: ORG, stageIds: [] as string[], tenantFinalized: true,
      state: "held", safeErrorCode: "SOURCE_REVALIDATION_FAILED" })),
    pendingDelivery: vi.fn(async () => [INBOX]),
  };
  const stageComponent = vi.fn(async (value: { readonly protectedDetails: Record<string, unknown> }) => {
    trace.push("tenant-stage");
    stagedDetail.push(value.protectedDetails);
    return { outcome: "staged" as const, stageId: "00000000-0000-4000-8000-000000000104" };
  });
  const finalizeStage = vi.fn(async () => { trace.push("tenant-stage-finalized"); });
  const service = createClaimMdEraDeliveryService({ store: store as never, tenantDb: {} as never,
    siteReader: { providerEntityOwners: vi.fn(), locationOwners: vi.fn() },
    keyRing: { activeId: "synthetic-key", byId: new Map([["synthetic-key", Buffer.alloc(32, 7)]]) },
    accountReference: ACCOUNT, usage: "test", stageComponent: stageComponent as never, finalizeStage: finalizeStage as never });
  return { service, store, stageComponent, finalizeStage, stagedDetail, trace };
}

describe("BIL-1.4.1B safe M25 delivery", () => {
  it("stages only after verified source/resolution checks and commits before making the tenant row review-eligible", async () => {
    const x = setup();
    expect(await x.service.deliver(INBOX)).toBe("delivered");
    expect(x.trace).toEqual(["tenant-stage", "central-commit", "tenant-stage-finalized", "tenant-finalized"]);
    expect(x.stageComponent).toHaveBeenCalledTimes(1);
    expect(x.stagedDetail[0]?.claimOutcomes).toEqual([{ fileIndex: 0, transactionSetControlNumber: "0001",
      pcn: "PCN-SYNTH", outcome: "unmatched", claimId: null }]);
    expect(x.store.finishDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: "delivered", resolutionVersion: 1,
      organizationId: ORG, providerEntityId: PROVIDER }));
  });

  it("uses stage uniqueness to recover a crash after stage commit without creating a second stage", async () => {
    const x = setup({ failFirstCommit: true });
    const first = await x.service.runOnce();
    expect(first).toMatchObject({ examined: 1, failed: 1 });
    const second = await x.service.runOnce();
    expect(second).toMatchObject({ examined: 1, delivered: 1 });
    expect(x.stageComponent).toHaveBeenCalledTimes(2);
    const calls = x.stageComponent.mock.calls.map(([value]) =>
      (value as unknown as { source: { idempotencyKey: string } }).source.idempotencyKey);
    expect(new Set(calls).size).toBe(1);
  });

  it("holds when source or verified resolution cannot be revalidated and never calls a posting port", async () => {
    const x = setup({ resolutionFails: true });
    expect(await x.service.deliver(INBOX)).toBe("held");
    expect(x.stageComponent).not.toHaveBeenCalled();
    expect(x.store.holdDelivery).toHaveBeenCalledWith(expect.objectContaining({ reason: "SOURCE_REVALIDATION_FAILED" }));
    expect(x.trace).toEqual(["tenant-stage-finalized"]);
    expect("receiveAdvice" in x.service).toBe(false);
    expect("postAdvice" in x.service).toBe(false);
  });

  it("preserves a terminal receipt when another worker completes before source revalidation fails", async () => {
    const x = setup({ resolutionFails: true });
    x.store.holdDelivery.mockResolvedValueOnce({ id: DELIVERY, organizationId: ORG, stageIds: [],
      tenantFinalized: true, state: "delivered", safeErrorCode: "SOURCE_REVALIDATION_FAILED" });
    expect(await x.service.deliver(INBOX)).toBe("delivered");
    expect(x.finalizeStage).not.toHaveBeenCalled();
    expect(x.store.confirmDeliveryTenantFinalized).not.toHaveBeenCalled();
    expect(x.stageComponent).not.toHaveBeenCalled();
  });

  it("finishes an existing terminal receipt after a concurrent worker committed but did not finalize the stage", async () => {
    const x = setup({ resolutionFails: true });
    x.store.holdDelivery.mockResolvedValueOnce({ id: DELIVERY, organizationId: ORG,
      stageIds: ["00000000-0000-4000-8000-000000000104"], tenantFinalized: false,
      state: "delivered", safeErrorCode: "SOURCE_REVALIDATION_FAILED" });
    expect(await x.service.deliver(INBOX)).toBe("delivered");
    expect(x.finalizeStage).toHaveBeenCalledWith(expect.objectContaining({ disposition: "delivered" }));
    expect(x.store.confirmDeliveryTenantFinalized).toHaveBeenCalledWith(DELIVERY);
    expect(x.stageComponent).not.toHaveBeenCalled();
  });
});
