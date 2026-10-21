// The receiving hospice's 8xC draft consumer (off `m6.transfer.created` direction `in`): the pure snapshot
// plan, and the decisions it settles before touching the database.
import { CONTROL_NUMBER_RE } from "@chartwarden/billing";
import { describe, expect, it, vi } from "vitest";
import {
  M23_TRANSFER_NOTICE_DRAFT_CONSUMER,
  type TransferInFacts,
  buildM23TransferNoticeDraftConsumer,
  planTransferNoticeDraft,
} from "../outbox-consumers/m6-transfer-in-notice";

const FACTS: TransferInFacts = {
  transferEventId: "7b0f8a7e-3b1f-4a52-9a77-0a1b2c3d4e5f",
  direction: "in",
  admissionId: "adm-1",
  patientId: "pat-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  effectiveAt: "2026-01-10",
  counterpartyName: "Sending Hospice",
  counterpartyCcn: "381777",
  counterpartyNpi: "1234567893",
  periodSequenceAtTransfer: 2,
  inheritedElectionPeriodId: "ep-1",
  inheritedPeriodStart: "2025-12-01",
  admissionDate: "2026-01-10",
  attendingPhysicianId: "att-1",
  hospicePhysicianId: "hmd-1",
};

describe("planTransferNoticeDraft", () => {
  it("snapshots an original 81C dated from the transfer, with our own admission date", () => {
    // Arrange
    const id = "c3d4e5f6-0000-4000-8000-000000000001";

    // Act
    const plan = planTransferNoticeDraft({
      id,
      organizationId: "org-1",
      facts: FACTS,
      providerEntityId: "pe-1",
      providerCcn: "381501",
    });

    // Assert
    expect(plan).toMatchObject({
      id,
      action: "original",
      supersedesNoticeId: null,
      tob: "81C",
      statementFromDate: "2026-01-10",
      admissionDate: "2026-01-10",
      benefitPeriodSequence: 2,
      benefitPeriodStartDate: "2025-12-01",
      priorHospiceCcn: "381777",
      priorHospiceNpi: "1234567893",
      providerCcn: "381501",
      attendingPhysicianId: "att-1",
      certifyingPhysicianId: "hmd-1",
      electionPeriodId: "ep-1",
    });
    expect(plan.controlNumber).toMatch(CONTROL_NUMBER_RE);
    expect(plan.controlNumber.startsWith("381501-260110-")).toBe(true);
  });
});

describe("buildM23TransferNoticeDraftConsumer", () => {
  const deps = () => ({
    db: {} as never,
    outbox: { publish: vi.fn() },
    resolveTransferIn: vi.fn(async () => FACTS),
    resolveCcn: vi.fn(async () => "381501"),
    onSkipped: vi.fn(),
  });

  it("binds m6.transfer.created under its own consumer name (separate from the NOTR binding)", () => {
    const consumer = buildM23TransferNoticeDraftConsumer(deps());
    expect(consumer.eventTypes).toEqual(["m6.transfer.created"]);
    expect(consumer.consumerName).toBe(M23_TRANSFER_NOTICE_DRAFT_CONSUMER.consumerName);
    expect(consumer.consumerName).not.toBe("m23.m6-notr-triggers");
  });

  it("settles a transfer OUT without reading M6 (the NOTR consumer's business)", async () => {
    const d = deps();
    await buildM23TransferNoticeDraftConsumer(d).handle({
      organizationId: "org-1",
      payload: { transferEventId: FACTS.transferEventId, direction: "out" },
    });
    expect(d.onSkipped).toHaveBeenCalledWith({
      reason: "transfer_out",
      organizationId: "org-1",
      transferEventId: FACTS.transferEventId,
    });
    expect(d.resolveTransferIn).not.toHaveBeenCalled();
  });

  it("fails the delivery when the transfer is unknown or its admission has no provider entity", async () => {
    const missing = deps();
    missing.resolveTransferIn.mockResolvedValueOnce(null as never);
    await expect(
      buildM23TransferNoticeDraftConsumer(missing).handle({
        organizationId: "org-1",
        payload: { transferEventId: FACTS.transferEventId, direction: "in" },
      }),
    ).rejects.toThrow(/not found in org/);

    const unsited = deps();
    unsited.resolveTransferIn.mockResolvedValueOnce({ ...FACTS, providerEntityId: null });
    await expect(
      buildM23TransferNoticeDraftConsumer(unsited).handle({
        organizationId: "org-1",
        payload: { transferEventId: FACTS.transferEventId, direction: "in" },
      }),
    ).rejects.toThrow(/no provider entity/);
  });

  it("refuses a payload with no transferEventId", async () => {
    await expect(
      buildM23TransferNoticeDraftConsumer(deps()).handle({
        organizationId: "org-1",
        payload: { direction: "in" },
      }),
    ).rejects.toThrow(/no transferEventId/);
  });
});
