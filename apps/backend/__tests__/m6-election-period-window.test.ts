// apps/backend/__tests__/m6-election-period-window.test.ts — the benefit-period window (42 CFR 418.21(a)).
//
// Found while fixing F-042: `election_period.effective_at` / `scheduled_end_at` / `actual_end_at` were
// read in seven places and written in none. The `m6.election.period_started` schema comment recorded the
// reason as "computing real dates here would mean fabricating a period-kind-derived (90/60-day) end date
// the schema has no source of truth for" — but the regulation fixes the length, the sequence is stored,
// and the start is the activation instant the caller already holds. These are the two pure functions that
// derivation now runs through; the live suite proves the write path calls them.
import { describe, expect, it } from "vitest";
import {
  ELECTION_PERIOD_GRAPH,
  ELECTION_PERIOD_LENGTH_DAYS,
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
  transitionElectionPeriod,
} from "../src/modules/06-admission/state-machines/index";

describe("electionPeriodKindForSequence — 42 CFR 418.21(a)", () => {
  it("gives the first TWO periods ninety days each", () => {
    expect(electionPeriodKindForSequence(1)).toBe("ninety_day");
    expect(electionPeriodKindForSequence(2)).toBe("ninety_day");
  });

  it("gives every subsequent period sixty days, without limit", () => {
    for (const seq of [3, 4, 12, 40]) {
      expect(electionPeriodKindForSequence(seq)).toBe("sixty_day");
    }
  });

  it("matches the two lengths the period_kind enum names", () => {
    expect(ELECTION_PERIOD_LENGTH_DAYS).toEqual({ ninety_day: 90, sixty_day: 60 });
  });
});

describe("electionPeriodScheduledEnd — the INCLUSIVE last covered day", () => {
  it("ends a 90-day period on its ninetieth day, not the day after", () => {
    // The date that goes on the NOE and the claim. 2026-01-01 + 89 days = 2026-03-31.
    expect(electionPeriodScheduledEnd("2026-01-01", "ninety_day")).toBe("2026-03-31");
  });

  it("ends a 60-day period on its sixtieth day", () => {
    expect(electionPeriodScheduledEnd("2026-01-01", "sixty_day")).toBe("2026-03-01");
  });

  it("crosses a leap day correctly", () => {
    // 2028 is a leap year: Feb has 29 days, so a 90-day period from Jan 1 lands a day earlier.
    expect(electionPeriodScheduledEnd("2028-01-01", "ninety_day")).toBe("2028-03-30");
  });

  it("crosses a year boundary correctly", () => {
    expect(electionPeriodScheduledEnd("2026-11-15", "sixty_day")).toBe("2027-01-13");
  });

  it("is pure UTC date math — no local timezone leaks in", () => {
    // A date string is a date, not an instant. Running this in any TZ must give the same answer, which
    // is why the implementation parses with an explicit `T00:00:00.000Z` rather than `new Date(s)`.
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(electionPeriodScheduledEnd("2026-01-01", "ninety_day")).toBe("2026-03-31");
      process.env.TZ = "Pacific/Midway"; // UTC-11
      expect(electionPeriodScheduledEnd("2026-01-01", "ninety_day")).toBe("2026-03-31");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("ELECTION_PERIOD_GRAPH — the two edges F-062 corrected", () => {
  it("lets a RECERT period activate straight from pending", () => {
    // 42 CFR 418.21(a) has the patient elect hospice ONCE. Every later benefit period continues that
    // election on a new CTI with no second election statement, so it never passes through `signed`.
    // Requiring `signed` here would have refused every recertification the platform ever performs.
    expect(ELECTION_PERIOD_GRAPH.pending).toContain("setActive");
    const t = transitionElectionPeriod("pending", {
      type: "setActive",
      certificationSigned: true,
      admissionActivated: true,
      sequence: 4,
      f2fAttested: true,
      effectiveAt: "2026-01-01",
    });
    expect(t.to).toBe("active");
  });

  it("lets a REPLACEMENT election statement be signed for an already-signed period", () => {
    // A statement can be voided and replaced; signing the replacement must still run the §2.4
    // validators. It is a self-loop, not a state change.
    const t = transitionElectionPeriod("signed", {
      type: "signElectionStatement",
      signerKind: "patient",
      hasActiveDpoaConsent: false,
      curativeCareAcknowledgment: true,
      existingActiveElectionElsewhere: false,
      wouldOverlap: false,
    });
    expect(t.to).toBe("signed");
  });

  it("still refuses to re-elect a RUNNING period", () => {
    // A period already active is not re-elected by a new statement, and silently regressing it to
    // `signed` would be worse than the refusal.
    expect(() =>
      transitionElectionPeriod("active", {
        type: "signElectionStatement",
        signerKind: "patient",
        hasActiveDpoaConsent: false,
        curativeCareAcknowledgment: true,
        existingActiveElectionElsewhere: false,
        wouldOverlap: false,
      }),
    ).toThrow(/cannot signElectionStatement from 'active'/);
  });

  it("refuses a sequence-3 activation with no attested F2F — 42 CFR 418.22(a)(4)", () => {
    expect(() =>
      transitionElectionPeriod("pending", {
        type: "setActive",
        certificationSigned: true,
        admissionActivated: true,
        sequence: 3,
        f2fAttested: false,
        effectiveAt: "2026-01-01",
      }),
    ).toThrow(/recert period requires an attested F2F/);
  });
});
