// M25 — consumer + cron + eraser unit tests (Phase 3e). Pure handlers over in-memory stores; no DB, no
// BullMQ, no clock. Covers the 277CA / EVV denial-seed idempotency, the document back-reference, the
// aging rebucket + threshold alerts, the appeal-deadline boundary emit, and the PR-ledger eraser.
import { describe, expect, it } from "vitest";
import {
  type DenialSeedStore,
  handleClaimRejected,
  handleDocumentRendered,
  handleEvvAggregatorRejected,
} from "../consumers/handlers";
import { createRemittanceEraser } from "../erasers/remittance-eraser";
import {
  type AgingCaseRow,
  type DeadlineAppealRow,
  runAppealDeadlineWatch,
  runDenialAging,
} from "../jobs/m25-jobs";

function fakeSeedStore(): DenialSeedStore & { seeds: string[]; backrefs: number } {
  const seen = new Set<string>();
  const state = { seeds: [] as string[], backrefs: 0 };
  return {
    seeds: state.seeds,
    get backrefs() {
      return state.backrefs;
    },
    async seedDenial(input) {
      if (seen.has(input.idempotencyKey)) return { denialCaseId: `existing:${input.idempotencyKey}`, created: false };
      seen.add(input.idempotencyKey);
      state.seeds.push(input.idempotencyKey);
      return { denialCaseId: `new:${input.idempotencyKey}`, created: true };
    },
    async backrefDocument() {
      state.backrefs += 1;
      return { updated: true };
    },
  };
}

describe("consumers — denial seeding (§2.4 / §2.6)", () => {
  it("m23.claim.rejected seeds once and dedupes by (claim, date)", async () => {
    const store = fakeSeedStore();
    const ev = {
      organizationId: "o1",
      providerEntityId: "pe1",
      claimId: "c1",
      rejectionCodes: ["29"],
      occurredAt: "2026-06-20T10:00:00Z",
    };
    const first = await handleClaimRejected(store, ev);
    expect(first?.carcCode).toBe("29");
    expect(first?.source).toBe("claim_rejection_277ca");
    const dup = await handleClaimRejected(store, { ...ev, occurredAt: "2026-06-20T22:00:00Z" });
    expect(dup).toBeNull(); // same UTC date → deduped
    expect(store.seeds).toHaveLength(1);
  });

  it("m18.evv.aggregator_rejected seeds with the EVV ref + default N365 RARC, dedupes per submission", async () => {
    const store = fakeSeedStore();
    const ev = { organizationId: "o1", providerEntityId: "pe1", aggregatorSubmissionId: "s1" };
    const r = await handleEvvAggregatorRejected(store, ev);
    expect(r?.source).toBe("evv_aggregator_rejection");
    expect(await handleEvvAggregatorRejected(store, ev)).toBeNull();
    expect(store.seeds).toEqual(["evv:s1"]);
  });

  it("m22.document.rendered backrefs only M25-owned aggregates", async () => {
    const store = fakeSeedStore();
    expect(
      (await handleDocumentRendered(store, { organizationId: "o1", aggregateType: "appeal_case", aggregateId: "a1", documentId: "d1" })).updated,
    ).toBe(true);
    const other = await handleDocumentRendered(store, {
      organizationId: "o1",
      aggregateType: "claim" as "appeal_case",
      aggregateId: "x",
      documentId: "d2",
    });
    expect(other.updated).toBe(false);
    expect(store.backrefs).toBe(1);
  });
});

describe("crons (§2.4)", () => {
  it("denial-aging rebuckets changed cases and fires the 30-day cross alert once", async () => {
    const cases: AgingCaseRow[] = [
      { id: "d1", openedAt: "2026-05-01T00:00:00Z", currentBucketDays: 28, state: "open" }, // now 31 → crosses 30
      { id: "d2", openedAt: "2026-05-31T00:00:00Z", currentBucketDays: 1, state: "open" }, // stays small
    ];
    const written: Record<string, number> = {};
    const store = {
      async openCases() {
        return cases;
      },
      async setAgingBucketDays(id: string, days: number) {
        written[id] = days;
      },
    };
    const res = await runDenialAging(store, new Date("2026-06-01T00:00:00Z"));
    expect(res.rebucketed).toBe(1); // only d1's bucket changed (d2 was already 1 day)
    expect(written.d1).toBe(31);
    expect(written.d2).toBeUndefined();
    const agingAlerts = res.alerts.filter((a) => a.kind === "denial.aging_threshold_breached");
    expect(agingAlerts).toHaveLength(1);
    expect(agingAlerts[0]!.denialCaseId).toBe("d1");
  });

  it("appeal-deadline emits at the tightest boundary", async () => {
    const appeals: DeadlineAppealRow[] = [
      { id: "a1", tierDeadlineAt: "2026-06-08T00:00:00Z", state: "submitted" }, // 7 days out
      { id: "a2", tierDeadlineAt: "2026-09-01T00:00:00Z", state: "draft" }, // far out → no alert
    ];
    const res = await runAppealDeadlineWatch({ async watchableAppeals() { return appeals; } }, new Date("2026-06-01T00:00:00Z"));
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]).toMatchObject({ appealCaseId: "a1", detail: { daysRemaining: 7 } });
  });
});

describe("eraser (§3.7)", () => {
  it("erases PR-ledger rows for the patient subject, no-op without org/subject", async () => {
    let erasedFor = "";
    const eraser = createRemittanceEraser({
      async erasePrLedgerForPatient(_org, patientId) {
        erasedFor = patientId;
        return 3;
      },
    });
    expect(await eraser.erase({ orgId: "o1" }, "patient-9")).toEqual({ erased: 3 });
    expect(erasedFor).toBe("patient-9");
    expect(await eraser.erase({ orgId: "" }, "p")).toEqual({ erased: 0 });
  });
});
