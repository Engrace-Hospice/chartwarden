// apps/backend/__tests__/care-plan-gates-grace-and-legacy.test.ts — M7 §2.6 sign-gate clock (19):
//   (a) the grace past a due date is CALENDAR days in the org timezone, so it does not drift by an hour
//       across a DST change (the due columns are stored end-of-day org-tz; a flat +24h is wrong on the two
//       transition days);
//   (b) a plan signed before TASK-040D has `next_review_due_at` NULL with `initial_signed_at` set, and
//       migration 0161 does not backfill it — the gate and the cron scan derive the due date in code.
// Pure / fake-tx: no DB.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { carePlanGateSnapshotsForOrg } from "../src/modules/07-care-plan/jobs/cron-store";
import { planReviewGateScan } from "../src/modules/07-care-plan/jobs/index";
import {
  computeInitialDueAt,
  computeNextReviewDueAt,
} from "../src/modules/07-care-plan/lifecycle/gate-clock";
import {
  type CarePlanClockFacts,
  evaluateCarePlanOverdue,
} from "../src/modules/07-care-plan/lifecycle/overdue-gate";

const PLAN = "plan-1";
const PAT = "patient-1";

const unsignedInitial = (initialDueAt: string): CarePlanClockFacts => ({
  planId: PLAN,
  patientId: PAT,
  hasSignedInitialVersion: false,
  initialDueAt,
  nextReviewDueAt: null,
});

const signedReview = (nextReviewDueAt: string | null, extra?: object): CarePlanClockFacts => ({
  planId: PLAN,
  patientId: PAT,
  hasSignedInitialVersion: true,
  initialDueAt: "2026-01-06T07:59:59.999Z",
  nextReviewDueAt,
  ...extra,
});

describe("gate grace is calendar-day in the org timezone (DST)", () => {
  // America/Los_Angeles springs forward 2026-03-08 and falls back 2026-11-01.
  it("initial gate across spring-forward: engages at end of the grace DAY, not due + 24h", () => {
    // Due = end of 03-07 PST = 2026-03-08T07:59:59.999Z; grace 1 day => end of 03-08 PDT.
    const dueAt = "2026-03-08T07:59:59.999Z";
    const facts = unsignedInitial(dueAt);
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.998Z").initialOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.999Z").initialOverdue).toBe(true);
    // Flat +24h would still say "not overdue" here (the grace shifted 1h late).
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T07:00:00.000Z").initialOverdue).toBe(true);
  });

  it("initial gate across fall-back: does not engage an hour early", () => {
    // Due = end of 10-31 PDT = 2026-11-01T06:59:59.999Z; grace 1 day => end of 11-01 PST.
    const facts = unsignedInitial("2026-11-01T06:59:59.999Z");
    // Flat +24h would already say "overdue" at 22:59 local on 11-01.
    expect(evaluateCarePlanOverdue(facts, "2026-11-02T07:00:00.000Z").initialOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(facts, "2026-11-02T07:59:59.998Z").initialOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(facts, "2026-11-02T07:59:59.999Z").initialOverdue).toBe(true);
  });

  it("review gate (2-day grace) across spring-forward", () => {
    const dueAt = computeNextReviewDueAt("2026-02-19T15:00:00.000Z"); // due day 03-06
    expect(dueAt).toBe("2026-03-07T07:59:59.999Z");
    const facts = signedReview(dueAt);
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.998Z").reviewOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.999Z").reviewOverdue).toBe(true);
  });

  it("honours an explicit org timezone (America/New_York)", () => {
    // Due = end of 03-07 EST = 2026-03-08T04:59:59.999Z; grace 1 day => end of 03-08 EDT.
    const facts = unsignedInitial("2026-03-08T04:59:59.999Z");
    const tz = "America/New_York";
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T03:59:59.998Z", tz).initialOverdue).toBe(
      false,
    );
    expect(evaluateCarePlanOverdue(facts, "2026-03-09T03:59:59.999Z", tz).initialOverdue).toBe(
      true,
    );
  });

  it("outside any DST change the grace is still exactly 1 / 2 calendar days", () => {
    const initialDue = computeInitialDueAt("2026-06-01T15:00:00.000Z"); // 06-06 PDT end
    const initial = unsignedInitial(initialDue);
    expect(evaluateCarePlanOverdue(initial, "2026-06-07T06:59:59.999Z").initialOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(initial, "2026-06-08T06:59:59.999Z").initialOverdue).toBe(true);
    const reviewDue = computeNextReviewDueAt("2026-06-01T15:00:00.000Z"); // 06-16 PDT end
    const review = signedReview(reviewDue);
    expect(evaluateCarePlanOverdue(review, "2026-06-19T06:59:59.998Z").reviewOverdue).toBe(false);
    expect(evaluateCarePlanOverdue(review, "2026-06-19T06:59:59.999Z").reviewOverdue).toBe(true);
  });
});

describe("legacy plans: NULL next_review_due_at with initial_signed_at set (19)", () => {
  const initialSignedAt = "2026-02-19T15:00:00.000Z";
  const derivedDue = computeNextReviewDueAt(initialSignedAt); // 2026-03-07T07:59:59.999Z

  it("the gate treats the plan as due at computeNextReviewDueAt(initial_signed_at)", () => {
    const facts = signedReview(null, { initialSignedAt });
    const before = evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.998Z");
    expect(before.reviewOverdue).toBe(false);
    expect(before.nextReviewDueAt).toBe(derivedDue);
    const after = evaluateCarePlanOverdue(facts, "2026-03-09T06:59:59.999Z");
    expect(after.reviewOverdue).toBe(true);
    expect(after.overdue).toBe(true);
    expect(after.nextReviewDueAt).toBe(derivedDue);
  });

  it("a stored next_review_due_at always wins over the derived one", () => {
    const facts = signedReview("2026-12-31T07:59:59.999Z", { initialSignedAt });
    const out = evaluateCarePlanOverdue(facts, "2026-06-01T00:00:00.000Z");
    expect(out.reviewOverdue).toBe(false);
    expect(out.nextReviewDueAt).toBe("2026-12-31T07:59:59.999Z");
  });

  it("stays inert when neither a stored due date nor initial_signed_at is known", () => {
    const out = evaluateCarePlanOverdue(signedReview(null), "2027-01-01T00:00:00.000Z");
    expect(out.reviewOverdue).toBe(false);
    expect(out.nextReviewDueAt).toBeNull();
  });

  it("an unsigned plan never derives a review due date from a stray initial_signed_at", () => {
    const facts: CarePlanClockFacts = {
      ...unsignedInitial("2026-01-06T07:59:59.999Z"),
      initialSignedAt,
    };
    const out = evaluateCarePlanOverdue(facts, "2027-01-01T00:00:00.000Z");
    expect(out.reviewOverdue).toBe(false);
    expect(out.nextReviewDueAt).toBeNull();
  });
});

/** A fake tx whose `select().from().where()` resolves the given `care_plan` rows. */
function fakeTx(rows: ReadonlyArray<Record<string, unknown>>): DbClient {
  const chain = { from: () => ({ where: async () => rows }) };
  return { select: () => chain } as unknown as DbClient;
}

const baseRow = {
  id: PLAN,
  patientId: PAT,
  createdAt: new Date("2026-02-14T15:00:00.000Z"),
  admissionActivatedAt: new Date("2026-02-14T15:00:00.000Z"),
  initialDueAt: new Date("2026-02-20T07:59:59.999Z"),
  initialSignedAt: null as Date | null,
  nextReviewDueAt: null as Date | null,
  initialWarningEmitted: false,
  reviewDueEmitted: false,
  reviewOverdueEmitted: false,
};

describe("care-plan gates cron snapshot over legacy rows (19)", () => {
  it("derives nextReviewDueAt from initial_signed_at when the column is NULL", async () => {
    const [snap] = await carePlanGateSnapshotsForOrg(
      fakeTx([{ ...baseRow, initialSignedAt: new Date("2026-02-19T15:00:00.000Z") }]),
      "org-1",
    );
    expect(snap?.hasSignedInitialVersion).toBe(true);
    expect(snap?.nextReviewDueAt).toBe("2026-03-07T07:59:59.999Z");
  });

  it("keeps the stored next_review_due_at and leaves unsigned plans null", async () => {
    const stored = new Date("2026-04-01T06:59:59.999Z");
    const snaps = await carePlanGateSnapshotsForOrg(
      fakeTx([
        {
          ...baseRow,
          id: "stored",
          initialSignedAt: new Date("2026-02-19T15:00:00.000Z"),
          nextReviewDueAt: stored,
        },
        { ...baseRow, id: "unsigned" },
      ]),
      "org-1",
    );
    expect(snaps.find((s) => s.planId === "stored")?.nextReviewDueAt).toBe(stored.toISOString());
    expect(snaps.find((s) => s.planId === "unsigned")?.nextReviewDueAt).toBeNull();
  });

  it("the review scan then fires review_overdue for the legacy plan", async () => {
    const snaps = await carePlanGateSnapshotsForOrg(
      fakeTx([{ ...baseRow, initialSignedAt: new Date("2026-02-19T15:00:00.000Z") }]),
      "org-1",
    );
    const plan = planReviewGateScan(snaps, "2026-03-10T12:00:00.000Z");
    expect(plan.events.map((e) => e.eventName)).toEqual(["m7.care_plan.review_overdue"]);
    expect(plan.markedPlanIds).toEqual([PLAN]);
  });
});
