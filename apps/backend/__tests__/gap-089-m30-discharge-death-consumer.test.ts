// GAP-089 — unit tests for M30's `m6.discharge.death` (mortality half) consumer binding. No DB: the facts
// seam and the ports' insert are exercised live in gap-089-090-m30-worker-inputs.live.test.ts.
import type { DbClient } from "@wardenx/db";
import * as quality from "@wardenx/quality";
import { describe, expect, it, vi } from "vitest";
import { buildM30DischargeDeathConsumer } from "../src/modules/30-quality/outbox-consumers/m6-discharge-death";

const DB = {} as DbClient;
const OUTBOX = { publish: vi.fn(async () => undefined) };

const NO_MD = async () => null;
const MD = "99999999-9999-4999-8999-999999999999";
const FACTS = {
  admissionId: "a-1",
  patientId: "p-1",
  providerEntityId: "pe-1",
  deathAt: new Date("2026-09-01T00:00:00.000Z"),
  source: "internal_clinician_recorded" as const,
};

const event = (payload: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-envelope",
  eventType: "m6.discharge.death",
  aggregateKind: "discharge_event",
  aggregateId: "d-1",
  attemptCount: 0,
  createdAt: new Date(),
  payload,
});

describe("buildM30DischargeDeathConsumer", () => {
  it("binds m6.discharge.death for consumer module m30", () => {
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: async () => null,
      resolveMedicalDirectorForOrg: NO_MD,
    });
    expect(c.eventTypes).toEqual(["m6.discharge.death"]);
    expect(c.consumerModule).toBe("m30");
  });

  it("asks the seam about the ENVELOPE org, never a payload org", async () => {
    const seam = vi.fn(async () => null);
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: seam,
      resolveMedicalDirectorForOrg: NO_MD,
    });
    await c.handle(event({ dischargeEventId: "d-1", organizationId: "org-payload" }));
    expect(seam).toHaveBeenCalledWith(DB, "org-envelope", "d-1");
  });

  it("dead-letters (throws) on a death admission with no provider entity instead of skipping", async () => {
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: async () => ({
        admissionId: "a-1",
        patientId: "p-1",
        providerEntityId: null,
        deathAt: new Date(),
        source: "internal_clinician_recorded",
      }),
      resolveMedicalDirectorForOrg: NO_MD,
    });
    await expect(c.handle(event({ dischargeEventId: "d-1" }))).rejects.toThrow(/providerEntityId/);
  });

  it("rejects a payload with no dischargeEventId", async () => {
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: async () => null,
      resolveMedicalDirectorForOrg: NO_MD,
    });
    await expect(c.handle(event({}))).rejects.toThrow(/dischargeEventId/);
  });

  it("assigns the resolved Medical Director, resolving against the ENVELOPE org and the death site", async () => {
    const resolve = vi.fn(async () => MD);
    const insert = vi.fn(async (_ev: unknown) => undefined);
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: async () => FACTS,
      resolveMedicalDirectorForOrg: resolve,
    });
    vi.spyOn(quality, "handleDischargeDeathMortality").mockImplementation(async (ev) => {
      await insert(ev);
      return { eventName: "m6.discharge.death", effects: ["mortality_review_draft"] };
    });
    await c.handle(event({ dischargeEventId: "d-1", organizationId: "org-payload" }));
    expect(resolve).toHaveBeenCalledWith("org-envelope", "pe-1");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-envelope", assignedReviewerMembershipId: MD }),
    );
  });

  it("leaves the review unassigned, warns, and still creates it when no Medical Director resolves", async () => {
    const warn = vi.fn();
    const insert = vi.fn(async (_ev: unknown) => undefined);
    vi.spyOn(quality, "handleDischargeDeathMortality").mockImplementation(async (ev) => {
      await insert(ev);
      return { eventName: "m6.discharge.death", effects: ["mortality_review_draft"] };
    });
    const c = buildM30DischargeDeathConsumer({
      db: DB,
      outbox: OUTBOX,
      deathDischargeFactsForOrg: async () => FACTS,
      resolveMedicalDirectorForOrg: NO_MD,
      warn,
    });
    await c.handle(event({ dischargeEventId: "d-1" }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no Medical Director"),
      expect.objectContaining({ organizationId: "org-envelope", providerEntityId: "pe-1" }),
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ assignedReviewerMembershipId: null }),
    );
  });
});
