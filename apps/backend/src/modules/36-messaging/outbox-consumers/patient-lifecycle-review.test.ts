import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER,
  M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES,
  buildM36PatientLifecycleReviewConsumer,
} from "./patient-lifecycle-review";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const U1 = "44444444-4444-4444-8444-444444444444";
const U2 = "55555555-5555-4555-8555-555555555555";

const event = (eventType: string, payload: Record<string, unknown>) =>
  ({
    id: "evt-1",
    eventType,
    organizationId: ORG,
    payload: { organizationId: "attacker-copy-is-ignored", ...payload },
  }) as never;

function setup(
  opts: {
    care?: { patientId: string; otherAdmissionUnderCare: boolean } | null;
    flag?: boolean;
    subjects?: string[];
    supervisors?: number;
  } = {},
) {
  const emit = vi.fn().mockImplementation(async (_org: string, input: { eventType: string }) => ({
    alertId: "a",
    resolvedRecipientCount: input.eventType === "m36.review.queued" ? (opts.supervisors ?? 1) : 1,
  }));
  const admissionCare = vi
    .fn()
    .mockResolvedValue(
      opts.care === undefined ? { patientId: PATIENT, otherAdmissionUnderCare: false } : opts.care,
    );
  const queueForPatient = vi.fn().mockResolvedValue({ openSubjects: opts.subjects ?? [U1] });
  const isFlagOn = vi.fn().mockResolvedValue(opts.flag ?? true);
  const warn = vi.fn();
  const consumer = buildM36PatientLifecycleReviewConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    admissionCare,
    queueForPatient,
    isFlagOn,
    warn,
  });
  return { emit, admissionCare, queueForPatient, isFlagOn, warn, consumer };
}

describe("M36 patient lifecycle review consumer", () => {
  it("subscribes to the discharge and death events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes]).toEqual([...M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES]);
  });

  it("queues a discharge by admission, tenant from the envelope", async () => {
    const { consumer, queueForPatient, admissionCare } = setup();
    await consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "other" }),
    );
    expect(admissionCare).toHaveBeenCalledWith(ORG, ADMISSION);
    expect(queueForPatient).toHaveBeenCalledWith(ORG, {
      cause: "discharge",
      triggerRef: ADMISSION,
      patientId: PATIENT,
    });
  });

  it("queues a transfer-out reason as cause transfer", async () => {
    const { consumer, queueForPatient } = setup();
    await consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "transfer" }),
    );
    expect(queueForPatient).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ cause: "transfer", triggerRef: ADMISSION }),
    );
  });

  it("converges the M6 death and the M5 death record on the patient as trigger", async () => {
    const { consumer, queueForPatient } = setup();
    await consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "death" }),
    );
    await consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    const [first, second] = queueForPatient.mock.calls.map((c) => c[1]);
    expect(first).toEqual({ cause: "death", triggerRef: PATIENT, patientId: PATIENT });
    expect(second).toEqual(first);
  });

  it("skips a late discharge of a readmitted patient but never skips a death", async () => {
    const { consumer, queueForPatient } = setup({
      care: { patientId: PATIENT, otherAdmissionUnderCare: true },
    });
    await consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "other" }),
    );
    expect(queueForPatient).not.toHaveBeenCalled();
    await consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "death" }),
    );
    expect(queueForPatient).toHaveBeenCalledTimes(1);
  });

  it("throws on a malformed payload or an admission that does not resolve", async () => {
    const { consumer } = setup({ care: null });
    await expect(consumer.handle(event("m5.patient.deceased", {}))).rejects.toThrow(/no patientId/);
    await expect(
      consumer.handle(event("m6.admission.discharged", { reason: "other" })),
    ).rejects.toThrow(/no admissionId/);
    await expect(
      consumer.handle(event("m6.admission.discharged", { admissionId: ADMISSION, reason: "x" })),
    ).rejects.toThrow(/does not resolve/);
  });

  it("alerts supervisors and each assignee under distinct PHI-free correlation ids", async () => {
    const { consumer, emit } = setup({ subjects: [U1, U2, U1] });
    await consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    const calls = emit.mock.calls.map((c) => c[1] as { eventType: string; correlationId: string });
    expect(calls.map((c) => c.eventType)).toEqual([
      "m36.review.queued",
      "m36.review.task_needs_decision",
      "m36.review.task_needs_decision",
    ]);
    expect(new Set(calls.map((c) => c.correlationId)).size).toBe(3);
    for (const c of calls) expect(c.correlationId).not.toContain(PATIENT);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(PATIENT);
  });

  it("queues but raises no alert when the flag is off, or when nothing was queued", async () => {
    const off = setup({ flag: false });
    await off.consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    expect(off.queueForPatient).toHaveBeenCalled();
    expect(off.emit).not.toHaveBeenCalled();
    const none = setup({ subjects: [] });
    await none.consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    expect(none.emit).not.toHaveBeenCalled();
  });

  it("warns when no supervisor resolves while the assignees are still alerted", async () => {
    const { consumer, emit, warn } = setup({ supervisors: 0 });
    await consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PATIENT);
    expect(emit.mock.calls.map((c) => (c[1] as { eventType: string }).eventType)).toContain(
      "m36.review.task_needs_decision",
    );
  });
});
