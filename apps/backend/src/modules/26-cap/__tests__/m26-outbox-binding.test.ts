// GAP-075 / GAP-077 — the M26 upstream binding against the REAL catalogued payload shapes (which carry no
// `organizationId`): the tenant must come from the dispatcher envelope. The older consumer tests injected
// `organizationId` into the payload, which hid that the live handlers saw an empty tenant.
import { describe, expect, it, vi } from "vitest";
import { createInMemoryCapConsumerStore } from "../consumers/index";
import { BOUND_TOPICS, buildM26UpstreamConsumer } from "../consumers/outbox-binding";

function storeWithSpies() {
  return {
    ...createInMemoryCapConsumerStore(),
    recordAccrualLine: vi.fn(async () => ({ recorded: true })),
    recordInpatientDay: vi.fn(async () => ({ recorded: true })),
    freezePatient: vi.fn(async () => ({ frozen: true })),
  };
}

describe("M26 upstream binding — envelope tenant", () => {
  it("records a paid accrual line under the ENVELOPE org for a claim_paid payload", async () => {
    const store = storeWithSpies();
    await buildM26UpstreamConsumer(store).handle({
      id: "e1",
      eventType: "m25.remittance.claim_paid",
      organizationId: "org-envelope",
      payload: {
        claimId: "c1",
        remittanceLineId: "rl1",
        remittanceAdviceId: "ra1",
        paidAmount: "123.45",
        patientId: "p1",
        paidAmountCents: 12345,
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
        postedAt: "2026-02-01T00:00:00.000Z",
      },
    });
    expect(store.recordAccrualLine).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-envelope",
        patientId: "p1",
        sourceKind: "remittance",
        sourceId: "rl1",
        amountCents: 12345,
      }),
    );
  });

  it("an org id smuggled in the payload never overrides the envelope", async () => {
    const store = storeWithSpies();
    await buildM26UpstreamConsumer(store).handle({
      id: "e2",
      eventType: "m5.patient.deceased",
      organizationId: "org-envelope",
      payload: { organizationId: "org-attacker", patientId: "p1", deceasedAt: "2026-03-01" },
    });
    expect(store.freezePatient).toHaveBeenCalledWith("org-envelope", "p1", "2026-03-01");
  });

  it("refuses a paid line the payer sent without a service period or patient (never fabricates)", async () => {
    const store = storeWithSpies();
    const consumer = buildM26UpstreamConsumer(store);
    const base = {
      remittanceLineId: "rl1",
      paidAmountCents: 100,
      postedAt: "2026-02-01T00:00:00.000Z",
    };
    await consumer.handle({
      id: "e3",
      eventType: "m25.remittance.claim_partial_paid",
      organizationId: "o",
      payload: { ...base, patientId: "p1", serviceFrom: null, serviceTo: null },
    });
    await consumer.handle({
      id: "e4",
      eventType: "m25.remittance.claim_paid",
      organizationId: "o",
      payload: { ...base, patientId: null, serviceFrom: "2026-01-01", serviceTo: "2026-01-02" },
    });
    expect(store.recordAccrualLine).not.toHaveBeenCalled();
  });

  it("records inpatient days from the catalogued line_finalized shape", async () => {
    const store = storeWithSpies();
    await buildM26UpstreamConsumer(store).handle({
      id: "e5",
      eventType: "m23.claim.line_finalized",
      organizationId: "org-envelope",
      payload: {
        claimId: "c1",
        claimLineId: "cl1",
        revenueCode: "0656",
        patientId: "p1",
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-03",
        serviceDate: "2026-01-01",
        days: 3,
        finalizedAt: "2026-02-01T00:00:00.000Z",
      },
    });
    expect(store.recordInpatientDay).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-envelope",
        revCode: "0656",
        days: 3,
        sourceId: "cl1",
      }),
    );
  });
});
