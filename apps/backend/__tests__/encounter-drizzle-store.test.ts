// #107 — the Drizzle EncounterReaderStore: signedEncountersForPatientSince reads the real encounter table
// inside a per-org withOrgContext envelope and projects rows to SignedEncounterDigest (signer = author,
// evvBracketState coalesced). This is the read that un-zeros M30's HVLDL numerator.
import { describe, expect, it, vi } from "vitest";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";

/** A fake DbClient whose `transaction` (the withOrgContext entry) runs the body against a tx returning `rows`. */
function fakeScopedDb(rows: unknown[]) {
  const execute = vi.fn(async () => {}); // the set_config GUC writes
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  const tx = { execute, select: () => chain };
  const transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return { execute, transaction, db: { transaction } as never };
}

const ROW = {
  encounterId: "enc-1",
  patientId: "pat-1",
  admissionId: "adm-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-02-10",
  signedAt: new Date("2026-02-10T17:00:00.000Z"),
  authoredByMembershipId: "mem-1",
  lateEntryTier: "normal",
  status: "signed",
  evvBracketState: "evv_present",
};

describe("createDrizzleEncounterReaderStore.signedEncountersForPatientSince", () => {
  it("opens a per-org withOrgContext envelope and maps rows to the digest", async () => {
    const { db, transaction, execute } = fakeScopedDb([ROW]);
    const store = createDrizzleEncounterReaderStore(db);

    const out = await store.signedEncountersForPatientSince(
      "org-1",
      "pat-1",
      "2026-02-07T00:00:00.000Z",
    );

    expect(transaction).toHaveBeenCalledTimes(1); // withOrgContext opened a tx
    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2); // app.org_id + app.user_id set_config
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      encounterId: "enc-1",
      discipline: "rn",
      serviceDate: "2026-02-10",
      signedByMembershipId: "mem-1", // signer = author
      status: "signed",
      evvBracketState: "evv_present",
    });
  });

  it("coalesces a null evvBracketState to the non-present state (never counts as EVV-verified)", async () => {
    const { db } = fakeScopedDb([{ ...ROW, evvBracketState: null }]);
    const store = createDrizzleEncounterReaderStore(db);
    const out = await store.signedEncountersForPatientSince(
      "org-1",
      "pat-1",
      "2026-02-07T00:00:00.000Z",
    );
    expect(out[0]?.evvBracketState).toBe("evv_missing_documented");
  });
});
