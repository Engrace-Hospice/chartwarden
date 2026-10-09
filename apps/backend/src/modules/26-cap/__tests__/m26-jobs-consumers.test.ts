// M26 P4 unit tests — the §4.4 consumer dispatch (topic → effect), the §4.8 pure cron handlers (fan-out
// over a stub store), and the §3.7 eraser (per-patient redaction counts + tenant FK-ordered destruction).
import { describe, expect, it, vi } from "vitest";
import {
  type CapConsumerStore,
  M26_UPSTREAM_SUBSCRIPTIONS,
  createInMemoryCapConsumerStore,
  dispatchM26UpstreamEvent,
} from "../consumers/index";
import { createCapEraser, createInMemoryCapRedactStore } from "../erasers/cap-eraser";
import { runCapYearClose, runNightlyProjection, runPsrVarianceWatchdog } from "../jobs/m26-jobs";

describe("M26 §4.4 consumer dispatch", () => {
  it("subscribes the ten upstream topics", () => {
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toContain("m25.remittance.claim_paid");
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toContain("m25.remittance.claim_partial_paid");
    expect(M26_UPSTREAM_SUBSCRIPTIONS).not.toContain("m25.remittance.advice_posted");
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toContain("m23.claim.line_finalized");
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toContain("m25.remittance.claim_recouped");
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toHaveLength(10);
  });

  it("routes m25.remittance.claim_recouped → recordAccrualLine with a negative reversal amount (F-163)", async () => {
    const calls: unknown[] = [];
    const store: CapConsumerStore = {
      ...createInMemoryCapConsumerStore(),
      async recordAccrualLine(line) {
        calls.push(line);
        return { recorded: true };
      },
    };
    const r = await dispatchM26UpstreamEvent(
      {
        topic: "m25.remittance.claim_recouped",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          claimId: "c1",
          recoupedAmountCents: 12345,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-31",
          postedAt: "2025-02-01T00:00:00Z",
        },
      },
      store,
    );
    expect(r.handled).toBe(true);
    expect(calls[0]).toMatchObject({
      sourceKind: "reversal",
      sourceId: "c1",
      patientId: "p1",
      amountCents: -12345,
    });
  });

  it("m23.claim.replaced/.voided still no-op today — neither payload carries patientId or an amount (F-131)", async () => {
    const store: CapConsumerStore = {
      ...createInMemoryCapConsumerStore(),
      recordAccrualLine: vi.fn(async () => ({ recorded: true })),
    };
    const r = await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.replaced",
        payload: {
          organizationId: "o1",
          originalClaimId: "c1",
          replacementClaimId: "c2",
          reason: "x",
        },
      },
      store,
    );
    expect(r.handled).toBe(false);
    expect(store.recordAccrualLine).not.toHaveBeenCalled();
  });

  it("routes m25.remittance.claim_paid → recordAccrualLine with the paid amount (D4)", async () => {
    const calls: unknown[] = [];
    const store: CapConsumerStore = {
      ...createInMemoryCapConsumerStore(),
      async recordAccrualLine(line) {
        calls.push(line);
        return { recorded: true };
      },
    };
    const r = await dispatchM26UpstreamEvent(
      {
        topic: "m25.remittance.claim_paid",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          remittanceLineId: "rl1",
          paidAmountCents: 12345,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-31",
          postedAt: "2025-02-01T00:00:00Z",
        },
      },
      store,
    );
    expect(r.handled).toBe(true);
    expect(calls[0]).toMatchObject({
      sourceKind: "remittance",
      amountCents: 12345,
      patientId: "p1",
    });
  });

  it("routes claim.line_finalized hospice LOC rev codes → recordInpatientDay; ignores any other rev code", async () => {
    const store: CapConsumerStore = {
      ...createInMemoryCapConsumerStore(),
      recordInpatientDay: vi.fn(async () => ({ recorded: true })),
    };
    const gip = await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.line_finalized",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          claimId: "c1",
          claimLineId: "cl1",
          revenueCode: "0656",
          days: 3,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-03",
          finalizedAt: "2025-02-01T00:00:00Z",
        },
      },
      store,
    );
    expect(gip.handled).toBe(true);
    const other = await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.line_finalized",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          claimId: "c1",
          claimLineId: "cl2",
          revenueCode: "0250",
          days: 3,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-03",
          finalizedAt: "2025-02-01T00:00:00Z",
        },
      },
      store,
    );
    expect(other.handled).toBe(false);
    // GAP-038 — a routine-home-care day is the cap denominator, so it IS recorded.
    const rhc = await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.line_finalized",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          claimId: "c1",
          claimLineId: "cl3",
          revenueCode: "0651",
          days: 30,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-30",
          finalizedAt: "2025-02-01T00:00:00Z",
        },
      },
      store,
    );
    expect(rhc.handled).toBe(true);
    expect(store.recordInpatientDay).toHaveBeenLastCalledWith(
      expect.objectContaining({ revCode: "0651", days: 30 }),
    );
  });

  it("routes m5.patient.deceased → freezePatient", async () => {
    const freeze = vi.fn(async () => ({ frozen: true }));
    const store: CapConsumerStore = { ...createInMemoryCapConsumerStore(), freezePatient: freeze };
    const r = await dispatchM26UpstreamEvent(
      {
        topic: "m5.patient.deceased",
        payload: { organizationId: "o1", patientId: "p1", deceasedAt: "2025-03-01" },
      },
      store,
    );
    expect(r.handled).toBe(true);
    expect(freeze).toHaveBeenCalledWith("o1", "p1", "2025-03-01");
  });
});

describe("M26 §4.8 pure cron handlers", () => {
  it("nightly projection recomputes every open period", async () => {
    const recompute = vi.fn(async () => {});
    const r = await runNightlyProjection(
      { listOpenPeriods: async () => [{ id: "a" }, { id: "b" }], recompute },
      "o1",
    );
    expect(r.recomputed).toBe(2);
    expect(recompute).toHaveBeenCalledTimes(2);
  });
  it("cap-year close closes every period past the grace window", async () => {
    const close = vi.fn(async () => {});
    const r = await runCapYearClose(
      { listClosablePeriods: async () => [{ id: "a" }], close },
      "o1",
      "2026-11-01",
    );
    expect(r.closed).toBe(1);
  });
  it("psr watchdog reports the stale count", async () => {
    const r = await runPsrVarianceWatchdog(
      { staleReconciliationCount: async () => 4 },
      "o1",
      "2026-01-01T00:00:00Z",
    );
    expect(r.stale).toBe(4);
  });
});

describe("M26 §3.7 eraser (D14)", () => {
  it("the in-memory eraser counts zero (deferred bind); the contract returns an aggregate count", async () => {
    const eraser = createCapEraser(createInMemoryCapRedactStore());
    const res = await eraser.erase({ orgId: "o1" }, "p1");
    expect(res.erased).toBe(0);
  });
  it("redaction sums the per-table counts the store reports", async () => {
    const eraser = createCapEraser({
      redactBeneficiaryAccrual: async () => 1,
      redactAccrualLines: async () => 3,
      redactInpatientDayLines: async () => 2,
      redactProjectionSnapshots: async () => 0,
      redactThresholdEvents: async () => 1,
      redactPsrReconciliation: async () => 0,
    });
    const res = await eraser.erase({ orgId: "o1" }, "p1");
    expect(res.erased).toBe(7);
  });
  it("a missing org or subject is a no-op", async () => {
    const eraser = createCapEraser(createInMemoryCapRedactStore());
    expect((await eraser.erase({ orgId: "" }, "p1")).erased).toBe(0);
    expect((await eraser.erase({ orgId: "o1" }, "")).erased).toBe(0);
  });
});
