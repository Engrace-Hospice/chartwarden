// The live m17.visit.published consumer opens the draft with the modality the visit implies, UNCONFIRMED.
import { describe, expect, it, vi } from "vitest";
import { buildM8VisitPublishedConsumer } from "../src/modules/08-encounters/outbox-consumers/m17-visit-scheduled";

const ORG = "11111111-1111-4111-8111-111111111111";

function payloadWith(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    organizationId: ORG,
    visitId: "22222222-2222-4222-8222-222222222222",
    patientId: "33333333-3333-4333-8333-333333333333",
    admissionId: "44444444-4444-4444-8444-444444444444",
    assignedMembershipId: "55555555-5555-4555-8555-555555555555",
    assignedDiscipline: "rn",
    encounterType: "routine_visit",
    serviceDate: "2026-05-05",
    ...extra,
  };
}

/** A fake DbClient whose tenant transaction records the draft insert's values. */
function recordingDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return insertChain;
    },
    onConflictDoNothing: () => insertChain,
    returning: () => Promise.resolve([{ id: "66666666-6666-4666-8666-666666666666" }]),
  };
  const tx = { execute: vi.fn(async () => {}), insert: () => insertChain };
  const db = { transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)) } as never;
  return { db, inserted };
}

async function seed(extra: Record<string, unknown>) {
  const { db, inserted } = recordingDb();
  const consumer = buildM8VisitPublishedConsumer({
    db,
    outbox: { publish: async () => {} },
    isAdmissionActive: async () => true,
  });
  await consumer.handle({ organizationId: ORG, payload: payloadWith(extra) });
  return inserted[0] ?? {};
}

describe("m8.seed-visit-encounter modality seeding", () => {
  it("seeds in_person, unconfirmed, from a patient_home visit", async () => {
    const row = await seed({ visitSetting: "patient_home" });
    expect(row.visitModality).toBe("in_person");
    expect(row.visitModalityConfirmedAt).toBeUndefined();
    expect(row.visitModalityConfirmedBy).toBeUndefined();
  });

  it("seeds telephonic from a telephonic visit", async () => {
    expect((await seed({ visitSetting: "telephonic" })).visitModality).toBe("telephonic");
  });

  it("seeds telephonic from a telephonic encounter type", async () => {
    const row = await seed({ encounterType: "telephonic", visitSetting: "facility" });
    expect(row.visitModality).toBe("telephonic");
  });

  it("seeds null when the payload carries no usable visit setting", async () => {
    expect((await seed({})).visitModality).toBeNull();
    expect((await seed({ visitSetting: "mystery" })).visitModality).toBeNull();
  });
});
