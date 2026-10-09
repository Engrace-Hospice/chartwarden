// GAP-049 — the two scheduled §4.9 alerts (mortality review due, CoP re-attestation overdue) have a producer.
import { describe, expect, it, vi } from "vitest";
import {
  type ReviewOverdueAlertInput,
  copReviewOverdueAlert,
  mortalityReviewAlert,
  runReviewOverdueSweeps,
} from "../jobs/review-overdue-sweeps";

const NOW = new Date("2026-10-08T08:30:00.000Z");
const DAY = 86_400_000;

describe("review-overdue alert builders", () => {
  it("dedupes a mortality alert inside its 2-day bucket and re-pages in the next", () => {
    const review = { reviewId: "mr-1", targetCompletionAt: "2026-10-01T00:00:00.000Z" };
    const a = mortalityReviewAlert("org-1", review, NOW);
    const sameBucket = mortalityReviewAlert("org-1", review, new Date(NOW.getTime() + 1_000));
    const nextBucket = mortalityReviewAlert("org-1", review, new Date(NOW.getTime() + 2 * DAY));
    expect(a.eventType).toBe("m30.alerts.mortality_review_due");
    expect(a.severity).toBe("info");
    expect(sameBucket.correlationId).toBe(a.correlationId);
    expect(nextBucket.correlationId).not.toBe(a.correlationId);
  });

  it("pages a CoP overdue citation as a warn on a 14-day cadence, with no patient data", () => {
    const citation = {
      statusId: "cop-1",
      copCitation: "418.58",
      nextReviewDueAt: "2026-04-01T00:00:00.000Z",
    };
    const a = copReviewOverdueAlert("org-1", citation, NOW);
    expect(a.eventType).toBe("m30.alerts.cop_review_overdue");
    expect(a.severity).toBe("warn");
    expect(
      copReviewOverdueAlert("org-1", citation, new Date(NOW.getTime() + 7 * DAY)).correlationId,
    ).toBe(a.correlationId);
    expect(Object.keys(a.payload)).not.toContain("patientId");
  });
});

describe("runReviewOverdueSweeps", () => {
  it("raises one alert per overdue row, per org, and survives a failing org", async () => {
    const emit = vi.fn(async (_org: string, _i: ReviewOverdueAlertInput) => undefined);
    const warn = vi.fn();
    const summary = await runReviewOverdueSweeps({
      listActiveOrgs: async () => [
        { organizationId: "org-1" },
        { organizationId: "org-bad" },
        { organizationId: "org-2" },
      ],
      scanMortality: async (org) => {
        if (org === "org-bad") throw new Error("rls");
        return org === "org-1"
          ? [{ reviewId: "mr-1", targetCompletionAt: "2026-10-01T00:00:00.000Z" }]
          : [];
      },
      scanCop: async (org) =>
        org === "org-2"
          ? [
              {
                statusId: "cop-1",
                copCitation: "418.58",
                nextReviewDueAt: "2026-04-01T00:00:00.000Z",
              },
            ]
          : [],
      emit,
      now: () => NOW,
      warn,
    });
    expect(summary).toEqual({ orgs: 3, mortalityRaised: 1, copRaised: 1, failedOrgs: 1 });
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["org-1", "org-2"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
