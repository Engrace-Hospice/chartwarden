// The SIA snapshot a claim persists and the test that decides whether a re-validation moved it. `sia_calculation` is
// append-only, so a wrongly "same" verdict hides a change from the claim detail and a wrongly "different" one churns the
// history on every validation. Pure: the live proof of the append/lock/zero-revision flow is m23-visit-lines-assembly.live.
import { type SiaVisitInput, calculateSia } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";
import type { ClaimSia } from "../services/claim-assembly-facts";
import {
  type StoredSiaEvaluation,
  sameSiaEvaluation,
  siaEndedSnapshotInput,
  siaSnapshotInputOf,
  siaStillPromised,
} from "../services/claim-sia-snapshot";

const IDS = { orgId: "org-1", claimId: "claim-1" } as const;
const DEATH = "2025-11-07";
const rn = (over: Partial<SiaVisitInput> = {}): SiaVisitInput => ({
  encounterId: "enc-1",
  serviceDate: "2025-11-06",
  discipline: "rn",
  encounterType: "routine_visit",
  billability: "billable",
  durationMinutes: 120,
  modality: "in_person",
  modalityConfirmed: true,
  ...over,
});
const siaOf = (
  visits: SiaVisitInput[],
  extra: { advisory?: ClaimSia["priorClaimAdvisory"]; priced?: boolean } = {},
): ClaimSia => {
  const priced = extra.priced ?? true;
  return {
    result: calculateSia({
      deceasedDate: DEATH,
      visits,
      rhcPeriods: [{ from: "2025-11-01", to: DEATH }],
      claimWindow: { from: "2025-11-01", to: DEATH },
      chcHourlyRateCents: priced ? 6_000 : 0,
    }),
    pricing: priced
      ? { chcHourlyRateCents: 6_000 as never, fiscalYear: 2026, wageIndexFactor: "1.0000" }
      : null,
    priorClaimAdvisory: extra.advisory ?? null,
  };
};

/** What the DB hands back for `next` after a jsonb round-trip: same data, keys in a different order. */
function storedOf(next: ReturnType<typeof siaSnapshotInputOf>): StoredSiaEvaluation {
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .reverse()
              .map(([k, v]) => [k, reorder(v)]),
          )
        : value;
  return {
    basis: "units_v2",
    patientDeceasedDate: next.patientDeceasedDate,
    windowStart: next.windowStart,
    paidUnits: next.paidUnits,
    siaAddOnCents: next.siaAddOnCents,
    chcHourlyRateCents: next.chcHourlyRateCents,
    wageIndexFiscalYear: next.wageIndexFiscalYear,
    wageIndexFactor: next.wageIndexFactor,
    policy: reorder(next.policy),
    visitOutcomes: reorder(next.visitOutcomes),
    priorClaimAdvisory: reorder(next.priorClaimAdvisory),
  };
}

describe("siaSnapshotInputOf", () => {
  it("keeps the exact per-visit minutes but a whole-minute total, so an EVV bracket with seconds fits the integer column", () => {
    const fractional = 37 + 1 / 60;
    const next = siaSnapshotInputOf(siaOf([rn({ durationMinutes: fractional })]), IDS);
    expect(Number.isInteger(next.totalQualifyingMinutes)).toBe(true);
    expect(next.totalQualifyingMinutes).toBe(37);
    expect(next.visitOutcomes[0]?.durationMinutes).toBe(fractional);
  });

  it("records who supplied each visit's minutes in the stored outcomes (an additive key), and a changed source is a moved evaluation", () => {
    const typed = siaSnapshotInputOf(siaOf([rn({ timeSource: "clinician" })]), IDS);
    const evv = siaSnapshotInputOf(siaOf([rn({ timeSource: "evv" })]), IDS);
    expect(typed.visitOutcomes[0]?.timeSource).toBe("clinician");
    expect(evv.visitOutcomes[0]?.timeSource).toBe("evv");
    expect(sameSiaEvaluation(storedOf(typed), evv)).toBe(false);
  });

  it("stores no rate when nothing was priced (NULL means not priced, never a fabricated 0)", () => {
    const next = siaSnapshotInputOf(siaOf([rn({ durationMinutes: null })], { priced: false }), IDS);
    expect(next).toMatchObject({
      paidUnits: 0,
      siaAddOnCents: 0,
      chcHourlyRateCents: null,
      wageIndexFiscalYear: null,
      wageIndexFactor: null,
    });
    expect(next.visitOutcomes[0]).toMatchObject({ counted: false, excluded: "no_documented_time" });
  });

  it("carries the prior-month advisory, including an unpriced one", () => {
    const advisory = { from: "2025-10-31", to: "2025-10-31", units: 4, cents: null };
    expect(siaSnapshotInputOf(siaOf([rn()], { advisory }), IDS).priorClaimAdvisory).toEqual(
      advisory,
    );
  });
});

describe("sameSiaEvaluation", () => {
  const next = siaSnapshotInputOf(siaOf([rn()]), IDS);

  it("is the same evaluation across a jsonb round-trip that reorders object keys", () => {
    expect(sameSiaEvaluation(storedOf(next), next)).toBe(true);
  });

  it("moves when a visit's outcome changes (a clinician confirmed a delivery mode, a time was documented)", () => {
    const changed = siaSnapshotInputOf(siaOf([rn({ durationMinutes: 60 })]), IDS);
    expect(sameSiaEvaluation(storedOf(next), changed)).toBe(false);
  });

  it("moves when only the date of death moves, even though no visit outcome changed", () => {
    expect(
      sameSiaEvaluation(
        { ...storedOf(next), patientDeceasedDate: "2025-11-08", windowStart: "2025-11-02" },
        next,
      ),
    ).toBe(false);
  });

  it("moves when the CHC rate or the wage index is re-keyed", () => {
    expect(sameSiaEvaluation({ ...storedOf(next), chcHourlyRateCents: 6_001 }, next)).toBe(false);
    expect(sameSiaEvaluation({ ...storedOf(next), wageIndexFiscalYear: 2025 }, next)).toBe(false);
    expect(sameSiaEvaluation({ ...storedOf(next), wageIndexFactor: "1.0100" }, next)).toBe(false);
  });

  it("moves when the prior-month advisory moves", () => {
    const withAdvisory = siaSnapshotInputOf(
      siaOf([rn()], { advisory: { from: "2025-10-31", to: "2025-10-31", units: 4, cents: 6_000 } }),
      IDS,
    );
    expect(sameSiaEvaluation(storedOf(next), withAdvisory)).toBe(false);
  });

  it("never treats a legacy minutes_v1 row as the same: the first units revision is always appended", () => {
    expect(sameSiaEvaluation({ ...storedOf(next), basis: "minutes_v1" }, next)).toBe(false);
  });
});

describe("an ended add-on", () => {
  const promised = { paidUnits: 8, siaAddOnCents: 12_000 };

  it("is still promised while units or a legacy minutes amount remain, and not once both are zero", () => {
    expect(siaStillPromised(promised)).toBe(true);
    expect(siaStillPromised({ paidUnits: null, siaAddOnCents: 7_200 })).toBe(true); // legacy minutes_v1 amount
    expect(siaStillPromised({ paidUnits: 0, siaAddOnCents: 0 })).toBe(false);
    expect(siaStillPromised({ paidUnits: null, siaAddOnCents: 0 })).toBe(false);
  });

  it("still promises money while a zero-unit revision carries a prior-month advisory, so withdrawing the death record ends it too", () => {
    const advisoryOnly = {
      paidUnits: 0,
      siaAddOnCents: 0,
      priorClaimAdvisory: { from: "2025-10-31", to: "2025-10-31", units: 4, cents: 6_000 },
    };
    expect(siaStillPromised(advisoryOnly)).toBe(true);
    // ...but a zero-unit advisory, or none, promises nothing (the ended revision writes `null` and is recorded once).
    expect(
      siaStillPromised({
        ...advisoryOnly,
        priorClaimAdvisory: { ...advisoryOnly.priorClaimAdvisory, units: 0 },
      }),
    ).toBe(false);
    expect(siaStillPromised({ ...advisoryOnly, priorClaimAdvisory: null })).toBe(false);
  });

  it("records a zero revision that keeps the death date and window and prices nothing", () => {
    const ended = siaEndedSnapshotInput(
      { patientDeceasedDate: DEATH, windowStart: "2025-11-01" },
      IDS,
    );
    expect(ended).toMatchObject({
      organizationId: "org-1",
      claimId: "claim-1",
      patientDeceasedDate: DEATH,
      windowStart: "2025-11-01",
      paidUnits: 0,
      eligibleUnits: 0,
      truncatedUnits: 0,
      siaAddOnCents: 0,
      totalQualifyingMinutes: 0,
      chcHourlyRateCents: null, // the 1512 CHECK allows no rate only on a zero-unit row
      qualifyingVisits: [],
      visitOutcomes: [],
      priorClaimAdvisory: null,
    });
    // ...and a second validation of the same ended state is "not promised", so it is recorded once.
    expect(
      siaStillPromised({ paidUnits: ended.paidUnits, siaAddOnCents: ended.siaAddOnCents }),
    ).toBe(false);
  });
});
