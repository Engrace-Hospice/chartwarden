// M25 Remittance & Denials — pure-domain unit tests (Phase 2). No DB, no Fastify, no real clock; plain
// data in, deterministic results out. Covers the three-strategy auto-match (D3), the two-tier posting
// routing (D4/D5/D13), the per-line posting outcome (§2.4), the appeal-tier deadline clock (D6/F04),
// denial aging (§1.1), and the denial + appeal state machines (§2.2).
import { describe, expect, it } from "vitest";
import {
  agingBucketLabel,
  agingDays,
  autoMatch,
  canTransitionAppeal,
  canTransitionDenial,
  classifyPostingOutcome,
  computeTierDeadline,
  crossedStaleAppealThreshold,
  daysUntilDeadline,
  deadlineAlertBoundary,
  decisionRequiresOutcome,
  effectiveCategory,
  isReopen,
  isWithinDeadline,
  type MatchCandidate,
  type MatchLineKeys,
  nextTier,
  outcomeEventKind,
  routeAdjustment,
  shouldSpawnNextTier,
  TIER_WINDOW_DAYS,
} from "../index";

describe("aging (§1.1)", () => {
  it("floors whole days and never goes negative", () => {
    const opened = new Date("2026-06-01T00:00:00Z");
    expect(agingDays(opened, new Date("2026-06-08T12:00:00Z"))).toBe(7);
    expect(agingDays(opened, new Date("2026-05-31T00:00:00Z"))).toBe(0);
  });

  it("maps days to the six buckets at the boundaries", () => {
    expect(agingBucketLabel(0)).toBe("0-7");
    expect(agingBucketLabel(7)).toBe("0-7");
    expect(agingBucketLabel(8)).toBe("8-15");
    expect(agingBucketLabel(15)).toBe("8-15");
    expect(agingBucketLabel(16)).toBe("16-30");
    expect(agingBucketLabel(30)).toBe("16-30");
    expect(agingBucketLabel(31)).toBe("31-60");
    expect(agingBucketLabel(60)).toBe("31-60");
    expect(agingBucketLabel(61)).toBe("61-90");
    expect(agingBucketLabel(90)).toBe("61-90");
    expect(agingBucketLabel(91)).toBe("91+");
    expect(agingBucketLabel(400)).toBe("91+");
  });

  it("flags the 90-day stale-appeal escalation", () => {
    expect(crossedStaleAppealThreshold(90)).toBe(false);
    expect(crossedStaleAppealThreshold(91)).toBe(true);
  });
});

describe("appeal-tier deadlines (D6 / M25-F04)", () => {
  it("redetermination anchors on remittance receipt + 120 days", () => {
    const remit = new Date("2026-01-01T00:00:00Z");
    const deadline = computeTierDeadline("redetermination", remit);
    expect(deadline.toISOString().slice(0, 10)).toBe("2026-05-01");
    expect(TIER_WINDOW_DAYS.redetermination).toBe(120);
  });

  it("the F04 boundary case: created 100 days after remit → 20 days remaining", () => {
    const remit = new Date("2026-01-01T00:00:00Z");
    const deadline = computeTierDeadline("redetermination", remit);
    const now = new Date("2026-04-11T00:00:00Z"); // 100 days after remit
    expect(daysUntilDeadline(deadline, now)).toBe(20);
    expect(isWithinDeadline(deadline, now)).toBe(true);
  });

  it("hard-blocks past T-0", () => {
    const deadline = computeTierDeadline("alj", new Date("2026-01-01T00:00:00Z")); // +60d
    expect(isWithinDeadline(deadline, new Date("2026-03-05T00:00:00Z"))).toBe(false);
  });

  it("later tiers anchor on the prior decision date with their own windows", () => {
    const decided = new Date("2026-01-01T00:00:00Z");
    expect(computeTierDeadline("reconsideration", decided).toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(computeTierDeadline("council", decided).toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("walks the tier hierarchy and terminates at federal_court", () => {
    expect(nextTier("redetermination")).toBe("reconsideration");
    expect(nextTier("council")).toBe("federal_court");
    expect(nextTier("federal_court")).toBeNull();
  });

  it("emits one alert boundary per threshold and nothing past the deadline", () => {
    const deadline = new Date("2026-02-01T00:00:00Z");
    expect(deadlineAlertBoundary(deadline, new Date("2026-01-25T00:00:00Z"))).toBe(7);
    expect(deadlineAlertBoundary(deadline, new Date("2026-01-31T00:00:00Z"))).toBe(1);
    expect(deadlineAlertBoundary(deadline, new Date("2025-12-01T00:00:00Z"))).toBeNull(); // >30d out
    expect(deadlineAlertBoundary(deadline, new Date("2026-02-05T00:00:00Z"))).toBeNull(); // past
  });
});

describe("adjustment routing (D4 / D5 / D13)", () => {
  it("unmapped CARC always seeds a denial regardless of group", () => {
    expect(routeAdjustment("CO", "reduction", "unmapped")).toMatchObject({
      postAction: "denial_seeded",
      seedDenial: true,
    });
  });

  it("denial/recoupment categories seed a denial case", () => {
    expect(routeAdjustment("CO", "denial", "mapped").seedDenial).toBe(true);
    expect(routeAdjustment("OA", "recoupment", "mapped").postAction).toBe("denial_seeded");
  });

  it("PR records on the patient-responsibility ledger", () => {
    expect(routeAdjustment("PR", "reduction", "mapped")).toMatchObject({
      postAction: "ledger_recorded",
      seedPrLedger: true,
    });
  });

  it("CO/PI auto-post; OA/CR flag for review", () => {
    expect(routeAdjustment("CO", "reduction", "mapped").postAction).toBe("auto_posted");
    expect(routeAdjustment("PI", "reduction", "mapped").postAction).toBe("auto_posted");
    expect(routeAdjustment("OA", "informational", "mapped").postAction).toBe("flagged_review");
    expect(routeAdjustment("CR", "informational", "mapped").postAction).toBe("flagged_review");
  });

  it("effectiveCategory falls back to unmapped when the catalog has no category", () => {
    expect(effectiveCategory(null)).toEqual({ category: "unmapped", taxonomyStatus: "unmapped" });
    expect(effectiveCategory("denial")).toEqual({ category: "denial", taxonomyStatus: "mapped" });
  });
});

describe("posting outcome (§2.4)", () => {
  it("CLP02=22 is a recoupment regardless of amount", () => {
    expect(classifyPostingOutcome(22, 1000, 800)).toBe("recouped");
  });
  it("zero payment is a denial", () => {
    expect(classifyPostingOutcome(1, 1000, 0)).toBe("denied");
  });
  it("full payment within $1 tolerance is paid", () => {
    expect(classifyPostingOutcome(1, 1000, 1000)).toBe("paid");
    expect(classifyPostingOutcome(1, 1000, 999.5)).toBe("paid");
  });
  it("under-payment is partial", () => {
    expect(classifyPostingOutcome(1, 1000, 600)).toBe("partial_paid");
  });
  it("maps each outcome to its M23-consumer event", () => {
    expect(outcomeEventKind("paid")).toBe("m25.remittance.claim_paid");
    expect(outcomeEventKind("recouped")).toBe("m25.remittance.claim_recouped");
  });
});

describe("auto-match (D3)", () => {
  const candidates: MatchCandidate[] = [
    { claimId: "c-icn", payerIcn: "ICN-123", claimControlNumber: "CCN-1", totalCharge: 1000 },
    { claimId: "c-ctrl", payerIcn: "ICN-999", claimControlNumber: "CCN-XYZ", totalCharge: 500 },
    {
      claimId: "c-heur",
      patientMemberId: "M-42",
      serviceFrom: "2026-06-01",
      serviceTo: "2026-06-30",
      totalCharge: 800,
    },
  ];

  it("strategy 1 — payer ICN exact → auto, confidence 100", () => {
    const line: MatchLineKeys = { clp07PayerIcn: "ICN-123", totalCharge: 1000 };
    expect(autoMatch(line, candidates)).toMatchObject({
      matched: true,
      claimId: "c-icn",
      strategy: "payer_icn",
      confidence: 100,
      requiresManual: false,
    });
  });

  it("strategy 2 — patient control exact → auto", () => {
    const line: MatchLineKeys = { clp01PatientControlNumber: "CCN-XYZ", totalCharge: 500 };
    expect(autoMatch(line, candidates)).toMatchObject({
      matched: true,
      claimId: "c-ctrl",
      strategy: "patient_control",
      requiresManual: false,
    });
  });

  it("strategy 3 — heuristic hit ALWAYS routes to manual", () => {
    const line: MatchLineKeys = {
      patientMemberId: "M-42",
      serviceFrom: "2026-06-10",
      serviceTo: "2026-06-15",
      totalCharge: 800.5,
    };
    expect(autoMatch(line, candidates)).toMatchObject({
      matched: true,
      claimId: "c-heur",
      strategy: "heuristic",
      requiresManual: true,
    });
  });

  it("no key match → unmatched/manual", () => {
    expect(autoMatch({ clp07PayerIcn: "NOPE", totalCharge: 1 }, candidates)).toEqual({
      matched: false,
      requiresManual: true,
    });
  });

  it("charge outside the $1 band defeats the heuristic", () => {
    const line: MatchLineKeys = {
      patientMemberId: "M-42",
      serviceFrom: "2026-06-10",
      serviceTo: "2026-06-15",
      totalCharge: 900,
    };
    expect(autoMatch(line, candidates).matched).toBe(false);
  });
});

describe("state machines (§2.2)", () => {
  it("denial: legal edges and the gated reopen", () => {
    expect(canTransitionDenial("open", "in_progress")).toBe(true);
    expect(canTransitionDenial("escalated", "appealed")).toBe(true);
    expect(canTransitionDenial("resolved", "closed")).toBe(true);
    expect(canTransitionDenial("closed", "open")).toBe(true);
    expect(isReopen("closed", "open")).toBe(true);
    expect(canTransitionDenial("open", "closed")).toBe(false);
    expect(canTransitionDenial("closed", "in_progress")).toBe(false);
  });

  it("appeal: forward-only, withdrawn from any non-terminal, closed/withdrawn frozen", () => {
    expect(canTransitionAppeal("draft", "submitted")).toBe(true);
    expect(canTransitionAppeal("under_review", "decided")).toBe(true);
    expect(canTransitionAppeal("submitted", "withdrawn")).toBe(true);
    expect(canTransitionAppeal("decided", "closed")).toBe(true);
    expect(canTransitionAppeal("closed", "draft")).toBe(false);
    expect(canTransitionAppeal("withdrawn", "submitted")).toBe(false);
    expect(canTransitionAppeal("draft", "decided")).toBe(false); // no skipping
  });

  it("appeal: a decision must carry an outcome; unfavorable spawns the next tier", () => {
    expect(decisionRequiresOutcome("decided", undefined)).toBe(false);
    expect(decisionRequiresOutcome("decided", "favorable")).toBe(true);
    expect(decisionRequiresOutcome("submitted", undefined)).toBe(true);
    expect(shouldSpawnNextTier("unfavorable")).toBe(true);
    expect(shouldSpawnNextTier("favorable")).toBe(false);
  });
});
