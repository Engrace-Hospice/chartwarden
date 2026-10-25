// The pure model behind the Medicaid work queue: claims in the states that need a person and the org-wide validation
// worklist become one list. Medicaid has no server deadline, so rows are ranked by what is stuck (state) and then by how
// long they have waited (oldest first) — nothing is labelled "at risk" or "overdue". A claim in both sources is one row.
import { describe, expect, it } from "vitest";
import {
  type BlockedClaim,
  type MedicaidClaimRow,
  buildMedicaidWork,
  isUrgentMedicaid,
} from "../medicaid-work-model";

const claim = (over: Partial<MedicaidClaimRow> = {}): MedicaidClaimRow => ({
  id: "c1",
  patientId: "p1",
  state: "READY",
  tob: "811",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
  medicaidClaimControlNumber: "MCN-1",
  updatedAt: "2026-10-20T00:00:00Z",
  ...over,
});
const blocked = (over: Partial<BlockedClaim> = {}): BlockedClaim => ({
  claimId: "c1",
  patientId: "p1",
  state: "FAILED_VALIDATION",
  medicaidClaimControlNumber: "MCN-1",
  updatedAt: "2026-10-20T00:00:00Z",
  ...over,
});

describe("buildMedicaidWork", () => {
  it("gives each state its next step and links the claim", () => {
    const items = buildMedicaidWork({
      claims: [
        claim({ id: "a", state: "DRAFT" }),
        claim({ id: "b", state: "READY" }),
        claim({ id: "c", state: "DENIED" }),
        claim({ id: "d", state: "ACK_TIMEOUT" }),
      ],
      blocked: [],
    });
    expect(items.map((i) => [i.key, i.nextAction])).toEqual(
      expect.arrayContaining([
        ["claim:a", "Complete the claim"],
        ["claim:b", "Submit the claim"],
        ["claim:c", "Review the denial"],
        ["claim:d", "Check the acknowledgment"],
      ]),
    );
    expect(items.find((i) => i.key === "claim:b")?.href).toBe("/medicaid/billing/claims/b");
  });

  it("ignores claims that are in flight or finished", () => {
    const items = buildMedicaidWork({
      claims: ["SUBMITTED", "POLLING", "ACK_PENDING", "ACK_ACCEPTED", "PAID", "VOIDED"].map((s) =>
        claim({ id: s, state: s }),
      ),
      blocked: [],
    });
    expect(items).toEqual([]);
  });

  it("ranks stuck states first, then the longest-waiting claim", () => {
    const items = buildMedicaidWork({
      claims: [
        claim({ id: "ready", state: "READY", updatedAt: "2026-10-01T00:00:00Z" }),
        claim({ id: "new", state: "DENIED", updatedAt: "2026-10-22T00:00:00Z" }),
        claim({ id: "old", state: "DENIED", updatedAt: "2026-10-05T00:00:00Z" }),
        claim({ id: "fv", state: "FAILED_VALIDATION" }),
      ],
      blocked: [],
    });
    expect(items.map((i) => i.key)).toEqual(["claim:fv", "claim:old", "claim:new", "claim:ready"]);
  });

  it("makes a claim in both sources one row that opens its validation run", () => {
    const items = buildMedicaidWork({
      claims: [claim({ state: "FAILED_VALIDATION" })],
      blocked: [blocked()],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.blocked).toBe(true);
    expect(items[0]?.href).toBe("/medicaid/billing/claims/c1/validation");
  });

  it("still lists a blocked claim when the claims source is not loaded", () => {
    const [item] = buildMedicaidWork({ claims: [], blocked: [blocked({ claimId: "z" })] });
    expect(item?.key).toBe("claim:z");
    expect(item?.nextAction).toBe("Fix the blocking rules");
  });

  it("marks only stuck states as urgent, not a claim that is merely ready or in draft", () => {
    const items = buildMedicaidWork({
      claims: [claim({ id: "r", state: "READY" }), claim({ id: "d", state: "DENIED" })],
      blocked: [],
    });
    expect(items.filter(isUrgentMedicaid).map((i) => i.key)).toEqual(["claim:d"]);
  });
});
