// apps/backend/src/modules/23-billing-medicare/__tests__/consumer-domain.test.ts — the §4.4 / §4.10 inbound
// CONSUMER domain tests (mirrors the M27 `consumer-domain.test.ts` precedent). The handlers are PURE +
// port-injected, so these tests need NO DB / Fastify / BullMQ — they drive each handler with lightweight
// `vi.fn()` effect-port doubles and assert the topic→effect projection the boot dispatcher relies on:
//
//  • m6.election.signed → a `noe_record` DRAFT (effect `create_noe_draft`), idempotent no-op when the bound
//    port returns null.
//  • the three terminating M6 events (revocation / discharge / transfer-OUT) → a `notr_record` DRAFT with the
//    correct trigger; a transfer-IN is a deliberate no-op.
//  • the re-validate fan-out carries the upstream `event_id` (the worker's `(event_id, target_claim_id)`
//    dedup key) + the fixed `re_validation_after_correction` trigger.
//  • m5.patient.deceased → freeze-then-revalidate, in order.
//  • the M25/M26 forward-seam handlers are INERT (fail-closed) and are NOT boot-bound by registerM23Consumers.
//  • m22.document.rendered → the back-ref write, with the §4.4 `kind → table.column` mapping + every off-path
//    no-op (foreign source module / unknown kind / the no-column denial-appeal kind).
import { describe, expect, it, vi } from "vitest";
import {
  ForwardSeamNotLandedError,
  M23_DENY_STUB_SUBSCRIPTION_TOPICS,
  M23_LIVE_SUBSCRIPTION_TOPICS,
  RE_VALIDATION_TRIGGER,
  dispatchM23UpstreamEvent,
  handleDischargeCreated,
  handleDocumentRendered,
  handleElectionSigned,
  handlePatientDeceased,
  handleRevalidateTrigger,
  handleRevocationCreated,
  handleTransferCreated,
  registerM23Consumers,
  resolveDocumentBackRefTarget,
} from "../consumers";
import type { M23ConsumerPorts } from "../consumers";

const ORG = "org-1";

/** Build a full {@link M23ConsumerPorts} of `vi.fn()` spies, with sensible "happy-path" defaults. */
function makePorts(overrides: Partial<M23ConsumerPorts> = {}): M23ConsumerPorts {
  return {
    createNoeDraft: vi.fn(async () => ({ noeId: "noe-1" })),
    createNotrDraft: vi.fn(async () => ({ notrId: "notr-1" })),
    enqueueRevalidation: vi.fn(async () => ({ revalidationJobId: "job-1" })),
    freezeNewClaims: vi.fn(async () => undefined),
    recordDocumentBackReference: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("m6.election.signed → NOE draft (task 47)", () => {
  it("projects a single create_noe_draft effect and forwards the election facts + triggering event id", async () => {
    const ports = makePorts();
    const report = await handleElectionSigned(
      {
        eventId: "evt-1",
        organizationId: ORG,
        providerEntityId: "pe-1",
        admissionId: "adm-1",
        patientId: "pat-1",
        electionPeriodId: "ep-1",
        electionEffectiveDate: "2025-11-01",
      },
      ports,
    );
    expect(report.effects).toEqual(["create_noe_draft"]);
    expect(report.actedOnIds).toEqual(["noe-1"]);
    expect(ports.createNoeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        electionPeriodId: "ep-1",
        electionEffectiveDate: "2025-11-01",
        triggeringEventId: "evt-1", // §2.6 idempotency anchor
      }),
    );
  });

  it("is a deliberate no-op (no effect) when the bound port reports an idempotent already-drafted election", async () => {
    const ports = makePorts({ createNoeDraft: vi.fn(async () => null) });
    const report = await handleElectionSigned(
      {
        eventId: "evt-2",
        organizationId: ORG,
        providerEntityId: "pe-1",
        admissionId: "adm-1",
        patientId: "pat-1",
        electionPeriodId: "ep-1",
        electionEffectiveDate: "2025-11-01",
      },
      ports,
    );
    expect(report.effects).toEqual([]);
    expect(report.actedOnIds).toEqual([]);
  });
});

describe("terminating M6 events → NOTR draft (task 50)", () => {
  const base = {
    eventId: "evt-3",
    organizationId: ORG,
    providerEntityId: "pe-1",
    admissionId: "adm-1",
    patientId: "pat-1",
    terminationEffectiveDate: "2025-11-20",
  };

  it("revocation → create_notr_draft with trigger 'revocation'", async () => {
    const ports = makePorts();
    const report = await handleRevocationCreated(base, ports);
    expect(report.effects).toEqual(["create_notr_draft"]);
    expect(ports.createNotrDraft).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "revocation", terminationEffectiveDate: "2025-11-20" }),
    );
  });

  it("discharge → create_notr_draft with trigger 'discharge'", async () => {
    const ports = makePorts();
    await handleDischargeCreated(base, ports);
    expect(ports.createNotrDraft).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "discharge" }),
    );
  });

  it("transfer-OUT → create_notr_draft with trigger 'transfer_out'", async () => {
    const ports = makePorts();
    const report = await handleTransferCreated({ ...base, direction: "out" }, ports);
    expect(report.effects).toEqual(["create_notr_draft"]);
    expect(ports.createNotrDraft).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "transfer_out" }),
    );
  });

  it("transfer-IN is a deliberate no-op (a transfer-in seeds an inherited-sequence claim, not a NOTR)", async () => {
    const ports = makePorts();
    const report = await handleTransferCreated({ ...base, direction: "in" }, ports);
    expect(report.effects).toEqual([]);
    expect(ports.createNotrDraft).not.toHaveBeenCalled();
  });
});

describe("re-validate fan-out trigger + (event_id, target_claim_id) idempotency anchor (tasks 53/54)", () => {
  it("forwards every changed-entity id + the fixed re_validation_after_correction trigger + the event id", async () => {
    const ports = makePorts();
    const report = await handleRevalidateTrigger(
      "m8.encounter.signed",
      { eventId: "evt-9", organizationId: ORG, patientId: "pat-1", encounterId: "enc-1" },
      ports,
    );
    expect(report.effects).toEqual(["revalidate"]);
    expect(report.actedOnIds).toEqual(["job-1"]);
    expect(ports.enqueueRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        triggeringEventId: "evt-9", // the worker dedups on (eventId, claimId); the handler must propagate it
        fact: expect.objectContaining({
          sourceTopic: "m8.encounter.signed",
          trigger: RE_VALIDATION_TRIGGER,
          patientId: "pat-1",
          encounterId: "enc-1",
        }),
      }),
    );
  });

  it("the trigger value is the frozen 're_validation_after_correction' constant", () => {
    expect(RE_VALIDATION_TRIGGER).toBe("re_validation_after_correction");
  });

  it("re-delivering the SAME upstream event re-enqueues with the SAME idempotency key (dedup is downstream)", async () => {
    const ports = makePorts();
    const event = { eventId: "evt-dup", organizationId: ORG, admissionId: "adm-1" } as const;
    await handleRevalidateTrigger("m6.loc.changed", event, ports);
    await handleRevalidateTrigger("m6.loc.changed", event, ports);
    const calls = (ports.enqueueRevalidation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.triggeringEventId).toBe("evt-dup");
    expect(calls[1]?.[0]?.triggeringEventId).toBe("evt-dup");
  });
});

describe("m5.patient.deceased → freeze then revalidate (task 53), in order", () => {
  it("freezes new-claim creation BEFORE enqueuing the in-flight re-validate", async () => {
    const order: string[] = [];
    const ports = makePorts({
      freezeNewClaims: vi.fn(async () => {
        order.push("freeze");
      }),
      enqueueRevalidation: vi.fn(async () => {
        order.push("revalidate");
        return { revalidationJobId: "job-1" };
      }),
    });
    const report = await handlePatientDeceased(
      { eventId: "evt-d", organizationId: ORG, patientId: "pat-1", deceasedDate: "2025-12-01" },
      ports,
    );
    expect(report.effects).toEqual(["freeze_new_claims", "revalidate"]);
    expect(order).toEqual(["freeze", "revalidate"]);
    expect(ports.freezeNewClaims).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: "pat-1", reason: "patient_deceased" }),
    );
  });
});

describe("M25 / M26 forward-seam consumers are INERT (deny-stub, fail-closed)", () => {
  it("an m25 remittance event fails closed via dispatch (no live binding until M25 lands)", async () => {
    await expect(
      dispatchM23UpstreamEvent(
        {
          topic: "m25.remittance.claim_paid",
          payload: { eventId: "e", organizationId: ORG, claimId: "c" },
        },
        makePorts(),
      ),
    ).rejects.toBeInstanceOf(ForwardSeamNotLandedError);
  });

  it("an m26 cap-projection event fails closed via dispatch (no live binding until M26 lands)", async () => {
    await expect(
      dispatchM23UpstreamEvent(
        { topic: "m26.cap.projection_updated.v1", payload: { eventId: "e", organizationId: ORG } },
        makePorts(),
      ),
    ).rejects.toMatchObject({ code: "FORWARD_SEAM_UNBOUND" });
  });

  it("registerM23Consumers binds ONLY the LIVE topics — never a deny-stub topic", () => {
    const bound: string[] = [];
    registerM23Consumers({
      ports: makePorts(),
      bind: (eventName) => {
        bound.push(eventName);
      },
    });
    for (const live of M23_LIVE_SUBSCRIPTION_TOPICS) expect(bound).toContain(live);
    for (const denyStub of M23_DENY_STUB_SUBSCRIPTION_TOPICS) expect(bound).not.toContain(denyStub);
    expect(M23_DENY_STUB_SUBSCRIPTION_TOPICS.length).toBeGreaterThan(0); // there ARE deny-stub topics to exclude
  });
});

describe("m22.document.rendered → back-ref write (task 57)", () => {
  const evt = {
    eventId: "evt-doc",
    sourceModule: "m23",
    kind: "noe_confirmation_receipt",
    aggregateId: "noe-1",
    documentId: "doc-1",
  };

  it("records the document_id on the resolved noe_record.confirmation_document_id", async () => {
    const ports = makePorts();
    const report = await handleDocumentRendered(evt, ports);
    expect(report.effects).toEqual(["record_document_back_reference"]);
    expect(report.actedOnIds).toEqual(["noe-1"]);
    expect(ports.recordDocumentBackReference).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { table: "noe_record", column: "confirmation_document_id" },
        aggregateId: "noe-1",
        documentId: "doc-1",
        triggeringEventId: "evt-doc",
      }),
    );
  });

  it("is a no-op for a document another module requested (sourceModule !== 'm23')", async () => {
    const ports = makePorts();
    const report = await handleDocumentRendered({ ...evt, sourceModule: "m30" }, ports);
    expect(report.effects).toEqual([]);
    expect(ports.recordDocumentBackReference).not.toHaveBeenCalled();
  });

  it("is a no-op for an unrecognized render kind", async () => {
    const ports = makePorts();
    const report = await handleDocumentRendered({ ...evt, kind: "some_other_letter" }, ports);
    expect(report.effects).toEqual([]);
    expect(ports.recordDocumentBackReference).not.toHaveBeenCalled();
  });

  it("is a no-op for denial_appeal_cover_letter — the one M23 kind with NO back-ref column", async () => {
    const ports = makePorts();
    const report = await handleDocumentRendered(
      { ...evt, kind: "denial_appeal_cover_letter", aggregateId: "claim-1" },
      ports,
    );
    expect(report.effects).toEqual([]);
    expect(ports.recordDocumentBackReference).not.toHaveBeenCalled();
  });

  it("resolveDocumentBackRefTarget maps the four kinds totally (and denial-appeal → null)", () => {
    expect(resolveDocumentBackRefTarget("noe_confirmation_receipt")).toEqual({
      table: "noe_record",
      column: "confirmation_document_id",
    });
    expect(resolveDocumentBackRefTarget("notr_confirmation_receipt")).toEqual({
      table: "notr_record",
      column: "confirmation_document_id",
    });
    expect(resolveDocumentBackRefTarget("claim_acknowledgment_letter")).toEqual({
      table: "claim",
      column: "acknowledgment_document_id",
    });
    expect(resolveDocumentBackRefTarget("denial_appeal_cover_letter")).toBeNull();
  });
});
