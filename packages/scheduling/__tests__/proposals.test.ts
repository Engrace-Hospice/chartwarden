// @wardenx/scheduling — §2.2.4 / §7.7 D5 frequency parser + frequency-driven proposal domain — M17-T04.
import { describe, expect, it } from "vitest";
import {
  parseFrequency,
  isCadencedFrequency,
  frequencyCadenceDays,
  computeProposalDates,
  planFrequencyProposals,
  transitionProposal,
  PROPOSE_HORIZON_DAYS,
  outboxEvents,
  SchedulingStateError,
  type FrequencyProposalInput,
} from "../src";

describe("§7.7 parseFrequency grammar", () => {
  it("parses count:unit:period", () => {
    expect(parseFrequency("2:visit:week")).toEqual({
      count: 2,
      unit: "visit",
      period: "week",
      raw: "2:visit:week",
    });
    expect(parseFrequency("1:visit:day")).toMatchObject({ count: 1, unit: "visit", period: "day" });
    expect(parseFrequency("1:visit:episode")).toMatchObject({ period: "episode" });
    expect(parseFrequency("1:prn:prn")).toMatchObject({ unit: "prn", period: "prn" });
    expect(parseFrequency("1:continuous:day")).toMatchObject({ unit: "continuous" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseFrequency("  3:visit:week  ").raw).toBe("3:visit:week");
  });

  it("rejects a malformed / out-of-grammar string with FREQUENCY_UNPARSEABLE", () => {
    for (const bad of ["2 visits per week", "visit:week", "2:visit", "2:visit:year", "0:visit:week", "x:visit:week", ""]) {
      try {
        parseFrequency(bad);
        throw new Error(`expected '${bad}' to throw`);
      } catch (e) {
        expect(e).toBeInstanceOf(SchedulingStateError);
        expect(e).toMatchObject({ code: "FREQUENCY_UNPARSEABLE" });
      }
    }
  });
});

describe("§7.7 cadence derivation", () => {
  it("derives the whole-day interval for cadenced frequencies", () => {
    expect(frequencyCadenceDays(parseFrequency("2:visit:week"))).toBe(4); // round(7/2)
    expect(frequencyCadenceDays(parseFrequency("3:visit:week"))).toBe(2); // round(7/3)
    expect(frequencyCadenceDays(parseFrequency("1:visit:week"))).toBe(7);
    expect(frequencyCadenceDays(parseFrequency("1:visit:day"))).toBe(1);
    expect(frequencyCadenceDays(parseFrequency("2:visit:month"))).toBe(15); // round(30/2)
  });

  it("floors the interval at 1 day for high-rate frequencies", () => {
    expect(frequencyCadenceDays(parseFrequency("10:visit:week"))).toBe(1);
  });

  it("treats prn / continuous / episode as non-cadenced", () => {
    expect(isCadencedFrequency(parseFrequency("1:prn:prn"))).toBe(false);
    expect(isCadencedFrequency(parseFrequency("1:continuous:day"))).toBe(false);
    expect(isCadencedFrequency(parseFrequency("1:visit:episode"))).toBe(false);
    expect(frequencyCadenceDays(parseFrequency("1:prn:prn"))).toBeNull();
  });
});

describe("§7.7 computeProposalDates", () => {
  it("emits two dates for 2:visit:week within a 7-day window (the §7.1 fixture)", () => {
    // windowStart 2026-07-06; no prior anchor → starts at the window. interval = round(7/2) = 4.
    // horizon 7 → [windowStart, 2026-07-13]: 07-06 and 07-10 fall inside (the §7.1 "two proposals").
    const dates = computeProposalDates(parseFrequency("2:visit:week"), null, "2026-07-06", 7);
    expect(dates).toEqual(["2026-07-06", "2026-07-10"]);
  });

  it("steps one interval past the anchor (last serviced date)", () => {
    const dates = computeProposalDates(parseFrequency("1:visit:week"), "2026-07-01", "2026-07-06", 14);
    // anchor + 7 = 2026-07-08; then +7 = 2026-07-15; +7 = 2026-07-22 (> horizon 2026-07-20).
    expect(dates).toEqual(["2026-07-08", "2026-07-15"]);
  });

  it("fast-forwards a long-dormant anchor into the window (no stale back-fill)", () => {
    const dates = computeProposalDates(parseFrequency("1:visit:week"), "2026-01-01", "2026-07-06", 7);
    expect(dates.every((d) => d >= "2026-07-06")).toBe(true);
    expect(dates.length).toBeGreaterThan(0);
  });

  it("returns no dates for a non-cadenced frequency", () => {
    expect(computeProposalDates(parseFrequency("1:prn:prn"), null, "2026-07-06", 30)).toEqual([]);
    expect(computeProposalDates(parseFrequency("1:visit:episode"), null, "2026-07-06", 90)).toEqual([]);
  });

  it("is deterministic — identical inputs produce the identical set", () => {
    const a = computeProposalDates(parseFrequency("3:visit:week"), null, "2026-07-06");
    const b = computeProposalDates(parseFrequency("3:visit:week"), null, "2026-07-06");
    expect(a).toEqual(b);
    expect(PROPOSE_HORIZON_DAYS).toBe(7);
  });
});

const baseInput = (overrides: Partial<FrequencyProposalInput> = {}): FrequencyProposalInput => ({
  organizationId: "org-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  patientId: "whitfield",
  admissionId: "adm-1",
  interventionId: "iv-rn-9",
  frequency: "2:visit:week",
  proposedVisitPurpose: "routine_visit",
  proposedDiscipline: "registered_nurse",
  proposedDurationMinutes: 60,
  anchorDate: null,
  windowStart: "2026-07-06",
  ...overrides,
});

describe("§7.7 planFrequencyProposals", () => {
  it("builds one pending proposal per due date with a deterministic idempotency key", () => {
    const planned = planFrequencyProposals(baseInput());
    expect(planned.length).toBe(2);
    expect(planned.map((p) => p.sourceIdempotencyKey)).toEqual([
      "iv-rn-9:2026-07-06",
      "iv-rn-9:2026-07-10",
    ]);
    const first = planned[0];
    expect(first.source).toBe("frequency_driven_m7");
    expect(first.proposedVisitPurpose).toBe("routine_visit");
    expect(first.proposedDiscipline).toBe("registered_nurse");
    expect(first.suggestedMembershipId).toBeNull();
    expect(first.sourcePayload).toMatchObject({
      upstreamEventId: "iv-rn-9",
      interventionId: "iv-rn-9",
      frequency: "2:visit:week",
      proposedForDate: "2026-07-06",
    });
  });

  it("carries the genesis audit + m17.visit.proposed outbox effects", () => {
    const [first] = planFrequencyProposals(baseInput());
    expect(first.effects.some((e) => e.kind === "audit")).toBe(true);
    expect(outboxEvents(first.effects)).toEqual(["m17.visit.proposed"]);
  });

  it("threads an optional best-fit clinician suggestion through", () => {
    const planned = planFrequencyProposals(baseInput({ suggestedMembershipId: "mem-7" }));
    expect(planned[0].suggestedMembershipId).toBe("mem-7");
  });

  it("emits no proposals for a non-cadenced intervention frequency", () => {
    expect(planFrequencyProposals(baseInput({ frequency: "1:prn:prn" }))).toEqual([]);
  });

  it("propagates FREQUENCY_UNPARSEABLE for a malformed frequency", () => {
    expect(() => planFrequencyProposals(baseInput({ frequency: "garbage" }))).toThrow(SchedulingStateError);
  });
});

describe("§2.2.4 proposal status machine", () => {
  it("publishes a pending proposal, linking the minted visit", () => {
    const t = transitionProposal("pending", { type: "publish", visitId: "visit-99" });
    expect(t.to).toBe("published");
    expect(t.effects.some((e) => e.kind === "audit")).toBe(true);
    expect(t.effects.some((e) => e.kind === "bump_version")).toBe(true);
  });

  it("dismisses with a documented reason and captures it (denylisted)", () => {
    const t = transitionProposal("pending", { type: "dismiss", reason: "duplicate of an existing visit" });
    expect(t.to).toBe("dismissed");
    expect(t.effects).toContainEqual({
      kind: "capture_reason",
      field: "dismissal_reason",
      value: "duplicate of an existing visit",
    });
  });

  it("rejects an empty dismissal reason", () => {
    expect(() => transitionProposal("pending", { type: "dismiss", reason: "  " })).toThrow(
      /PROPOSAL_DISMISSAL_REASON_REQUIRED|dismissal/i,
    );
  });

  it("marks a stale proposal and emits the stale-detected event", () => {
    const t = transitionProposal("pending", { type: "stale" });
    expect(t.to).toBe("stale");
    expect(outboxEvents(t.effects)).toEqual(["m17.stale_visit_detected"]);
  });

  it("rejects an illegal transition from a terminal state", () => {
    for (const from of ["published", "dismissed", "stale"] as const) {
      try {
        transitionProposal(from, { type: "dismiss", reason: "x reason long enough" });
        throw new Error(`expected ${from} to reject`);
      } catch (e) {
        expect(e).toMatchObject({ code: "ILLEGAL_PROPOSAL_TRANSITION" });
      }
    }
  });
});
