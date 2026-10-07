// GAP-019 — the §7.3 soft-duplicate review rows: one open `patient_match_review` per soft candidate,
// highest score first, written on the admit transaction. The live RLS proof runs on the Docker stack.
import { describe, expect, it } from "vitest";
import { insertSoftMatchReviews } from "../src/modules/05-patient/match-review-db";

function fakeTx() {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: `rev-${inserted.length}` }] };
      },
    }),
  };
  return { tx: tx as never, inserted };
}

const INCOMING = {
  lastName: "SMITH",
  firstName: "MARY",
  dob: "1940-02-03",
  ssn: "123456789",
  mbi: null,
};

describe("insertSoftMatchReviews", () => {
  it("inserts one open review per candidate, best score first, and returns their ids", async () => {
    const { tx, inserted } = fakeTx();
    const ids = await insertSoftMatchReviews(tx, "org-1", "new-1", INCOMING, [
      { id: "cand-low", score: 0.78 },
      { id: "cand-high", score: 0.83 },
    ]);
    expect(ids).toEqual(["rev-1", "rev-2"]);
    expect(inserted.map((r) => r.candidateExistingPatientId)).toEqual(["cand-high", "cand-low"]);
    expect(inserted[0]).toMatchObject({
      organizationId: "org-1",
      newPatientId: "new-1",
      status: "open",
      score: "0.8300",
    });
  });

  it("never stores the SSN in the incoming snapshot", async () => {
    const { tx, inserted } = fakeTx();
    await insertSoftMatchReviews(tx, "org-1", "new-1", INCOMING, [{ id: "c", score: 0.8 }]);
    expect(JSON.stringify(inserted[0]?.candidateIncoming)).not.toContain("123456789");
  });

  it("inserts nothing for an empty candidate set", async () => {
    const { tx, inserted } = fakeTx();
    expect(await insertSoftMatchReviews(tx, "org-1", "new-1", INCOMING, [])).toEqual([]);
    expect(inserted).toHaveLength(0);
  });
});
