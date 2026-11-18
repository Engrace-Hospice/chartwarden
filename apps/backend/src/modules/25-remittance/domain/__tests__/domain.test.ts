// M25 Remittance & Denials — pure-domain unit tests (Phase 2). No DB, no Fastify, no real clock; plain
// data in, deterministic results out. Covers the three-strategy auto-match (D3), the two-tier posting
// routing (D4/D5/D13), the per-line posting outcome (§2.4), the appeal-tier deadline clock (D6/F04),
// denial aging (§1.1), and the denial + appeal state machines (§2.2).
import { describe, expect, it } from "vitest";
import {
  type MatchCandidate,
  type MatchLineKeys,
  TIER_WINDOW_DAYS,
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
  deriveTierDeadline,
  effectiveCategory,
  explicitIdentityAgrees,
  isReopen,
  isWithinDeadline,
  nextTier,
  noticeDayOf,
  outcomeEventKind,
  routeAdjustment,
  shouldSpawnNextTier,
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
  it("redetermination runs 120 days from presumed receipt (notice date + 5 days)", () => {
    const derived = deriveTierDeadline("redetermination", "2026-01-01");
    expect(derived.presumedReceiptOn).toBe("2026-01-06");
    expect(derived.lastFilingDay).toBe("2026-05-06");
    expect(TIER_WINDOW_DAYS.redetermination).toBe(120);
  });

  it("the F04 boundary case: 100 days after the notice → 27 days of the window remain", () => {
    const deadline = computeTierDeadline("redetermination", "2026-01-01");
    const now = new Date("2026-04-11T00:00:00Z"); // 100 days after the notice date
    expect(daysUntilDeadline(deadline, now)).toBe(27); // last day May 6 is usable to its end
    expect(isWithinDeadline(deadline, now)).toBe(true);
  });

  it("hard-blocks past T-0 but not on the last filing day", () => {
    const deadline = computeTierDeadline("alj", "2026-01-01"); // calendar Sat 03-07, rolled back to Fri 2026-03-06
    expect(isWithinDeadline(deadline, new Date("2026-03-06T12:00:00Z"))).toBe(true);
    expect(isWithinDeadline(deadline, new Date("2026-03-09T00:00:00Z"))).toBe(false);
  });

  it("later tiers anchor on the prior decision-letter date with their own windows", () => {
    expect(deriveTierDeadline("reconsideration", "2026-01-01").lastFilingDay).toBe("2026-07-02"); // Sun 07-05, Sat 07-04 holiday observed Fri 07-03
    expect(deriveTierDeadline("council", "2026-01-01").lastFilingDay).toBe("2026-03-06");
  });

  it("reads a notice date off a UTC-midnight timestamp", () => {
    expect(noticeDayOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
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

  it("does not alert in the hours after an end-of-day deadline has passed", () => {
    const deadline = new Date("2026-02-01T04:59:59.999Z");
    expect(deadlineAlertBoundary(deadline, new Date("2026-02-01T10:00:00Z"))).toBeNull();
    expect(deadlineAlertBoundary(deadline, new Date("2026-02-01T03:00:00Z"))).toBe(1);
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

  describe("a claim sent under external patient control numbers (the 835 echoes the transmitted CLM01)", () => {
    const sent: MatchCandidate[] = [
      {
        claimId: "c-new",
        claimControlNumber: "CCN-NEW-00",
        transmittedControlNumbers: ["A1B2C3D4E5F6G7H8J", "K1L2M3N4P5Q6R7S8T"],
        totalCharge: 500,
      },
      {
        claimId: "c-other",
        claimControlNumber: "CCN-OTHER-00",
        transmittedControlNumbers: ["Z9Y8X7W6V5U4T3S2R"],
        totalCharge: 500,
      },
    ];

    it("strategy 2 — CLP01 equal to a number the claim was transmitted under → auto", () => {
      for (const clp01 of ["A1B2C3D4E5F6G7H8J", "K1L2M3N4P5Q6R7S8T"]) {
        expect(
          autoMatch({ clp01PatientControlNumber: clp01, totalCharge: 500 }, sent),
        ).toMatchObject({
          matched: true,
          claimId: "c-new",
          strategy: "patient_control",
          requiresManual: false,
        });
      }
    });

    it("strategy 2 — a historical claim (no transmitted number) still matches on its own control number", () => {
      const line: MatchLineKeys = { clp01PatientControlNumber: "CCN-OLD-00", totalCharge: 500 };
      expect(
        autoMatch(line, [{ claimId: "c-old", claimControlNumber: "CCN-OLD-00", totalCharge: 500 }]),
      ).toMatchObject({ matched: true, claimId: "c-old", strategy: "patient_control" });
    });

    it("strategy 2 — two claims carrying the same CLP01 are ambiguous, never auto-bound", () => {
      const twice: MatchCandidate[] = [
        { claimId: "c-1", transmittedControlNumbers: ["A1B2C3D4E5F6G7H8J"] },
        { claimId: "c-2", transmittedControlNumbers: ["A1B2C3D4E5F6G7H8J"] },
      ];
      expect(
        autoMatch({ clp01PatientControlNumber: "A1B2C3D4E5F6G7H8J", totalCharge: 1 }, twice),
      ).toEqual({ matched: false, requiresManual: true });
    });

    it("strategy 1 still wins: the payer ICN binds before any control number is read", () => {
      const withIcn: MatchCandidate[] = [
        { claimId: "c-icn", payerIcn: "ICN-7", transmittedControlNumbers: ["Z9Y8X7W6V5U4T3S2R"] },
        { claimId: "c-ctl", transmittedControlNumbers: ["A1B2C3D4E5F6G7H8J"] },
      ];
      expect(
        autoMatch(
          {
            clp07PayerIcn: "ICN-7",
            clp01PatientControlNumber: "A1B2C3D4E5F6G7H8J",
            totalCharge: 1,
          },
          withIcn,
        ),
      ).toMatchObject({ claimId: "c-icn", strategy: "payer_icn" });
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

  describe("explicit association identity (a source-owner-authorized candidate)", () => {
    const claim = {
      payerIcn: "ICN-1",
      claimControlNumber: "CCN-1-00",
      transmittedControlNumbers: ["A1B2C3D4E5F6G7H8J"],
    };

    it("agrees on the payer ICN, the internal control number, or a transmitted one", () => {
      expect(explicitIdentityAgrees(claim, { payerIcn: "ICN-1" })).toBe(true);
      expect(explicitIdentityAgrees(claim, { patientControlNumber: "CCN-1-00" })).toBe(true);
      expect(explicitIdentityAgrees(claim, { patientControlNumber: "A1B2C3D4E5F6G7H8J" })).toBe(
        true,
      );
      expect(
        explicitIdentityAgrees(claim, {
          payerIcn: "ICN-1",
          patientControlNumber: "A1B2C3D4E5F6G7H8J",
        }),
      ).toBe(true);
    });

    it("refuses a CLP01 the claim does not carry, even when the payer ICN matches", () => {
      expect(
        explicitIdentityAgrees(claim, { payerIcn: "ICN-1", patientControlNumber: "NOT-OURS" }),
      ).toBe(false);
    });

    it("refuses a different payer ICN, even when the control number matches", () => {
      expect(
        explicitIdentityAgrees(claim, {
          payerIcn: "ICN-OTHER",
          patientControlNumber: "A1B2C3D4E5F6G7H8J",
        }),
      ).toBe(false);
    });

    it("refuses a line that shares no exact identity with the claim", () => {
      expect(explicitIdentityAgrees(claim, {})).toBe(false);
      expect(explicitIdentityAgrees(claim, { payerIcn: "ICN-OTHER" })).toBe(false);
      expect(explicitIdentityAgrees(claim, { patientControlNumber: "NOT-OURS" })).toBe(false);
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
