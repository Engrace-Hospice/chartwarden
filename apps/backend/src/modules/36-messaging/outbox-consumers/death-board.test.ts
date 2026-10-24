import { describe, expect, it, vi } from "vitest";
import {
  M36_DEATH_BOARD_CONSUMER,
  M36_DEATH_BOARD_EVENT_TYPES,
  buildM36DeathBoardConsumer,
} from "./death-board";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";

const event = (eventType: string, payload: Record<string, unknown>) =>
  ({
    id: "evt-1",
    eventType,
    organizationId: ORG,
    payload: { organizationId: "attacker-copy-is-ignored", ...payload },
  }) as never;

function setup(opts: { flag?: boolean | "throws"; care?: unknown } = {}) {
  const createForDeath = vi.fn().mockResolvedValue({ created: true, boardId: "b" });
  const admissionCare = vi
    .fn()
    .mockResolvedValue(
      opts.care === undefined ? { patientId: PATIENT, otherAdmissionUnderCare: false } : opts.care,
    );
  const consumer = buildM36DeathBoardConsumer({
    admissionCare,
    service: { createForDeath },
    isFlagOn: async () => {
      if (opts.flag === "throws") throw new Error("flag down");
      return opts.flag ?? true;
    },
  });
  return { consumer, createForDeath, admissionCare };
}

describe("m36.death-board consumer", () => {
  it("subscribes to the two lifecycle events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_DEATH_BOARD_CONSUMER);
    expect([...consumer.eventTypes]).toEqual([...M36_DEATH_BOARD_EVENT_TYPES]);
    expect(consumer.eventTypes).toContain("m5.patient.deceased");
    expect(consumer.eventTypes).toContain("m6.admission.discharged");
  });

  it("opens the board for m5.patient.deceased, tenant from the envelope", async () => {
    const t = setup();
    await t.consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    expect(t.createForDeath).toHaveBeenCalledWith(ORG, PATIENT);
  });

  it("opens the board for a discharge with reason death, patient from M6", async () => {
    const t = setup();
    await t.consumer.handle(
      event("m6.admission.discharged", { admissionId: ADMISSION, reason: "death" }),
    );
    expect(t.admissionCare).toHaveBeenCalledWith(ORG, ADMISSION);
    expect(t.createForDeath).toHaveBeenCalledWith(ORG, PATIENT);
  });

  it("opens nothing for a transfer or an ordinary discharge", async () => {
    for (const reason of ["transfer", "revocation", "expired"]) {
      const t = setup();
      await t.consumer.handle(event("m6.admission.discharged", { admissionId: ADMISSION, reason }));
      expect(t.createForDeath).not.toHaveBeenCalled();
    }
  });

  it("does nothing, and reads nothing, while the flag is off or unreadable", async () => {
    for (const flag of [false, "throws"] as const) {
      const t = setup({ flag });
      await t.consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
      expect(t.createForDeath).not.toHaveBeenCalled();
      expect(t.admissionCare).not.toHaveBeenCalled();
    }
  });

  it("throws (relay retry) on a malformed payload or an unresolved admission", async () => {
    const t = setup();
    await expect(t.consumer.handle(event("m5.patient.deceased", {}))).rejects.toThrow(/patientId/);
    const u = setup({ care: null });
    await expect(
      u.consumer.handle(
        event("m6.admission.discharged", { admissionId: ADMISSION, reason: "death" }),
      ),
    ).rejects.toThrow(/does not resolve/);
    expect(u.createForDeath).not.toHaveBeenCalled();
  });

  it("propagates a service failure so the dispatcher retries", async () => {
    const t = setup();
    t.createForDeath.mockRejectedValueOnce(new Error("no eligible owner"));
    await expect(
      t.consumer.handle(event("m5.patient.deceased", { patientId: PATIENT })),
    ).rejects.toThrow(/no eligible owner/);
  });
});
