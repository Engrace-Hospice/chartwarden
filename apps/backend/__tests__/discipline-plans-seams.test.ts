// apps/backend/__tests__/discipline-plans-seams.test.ts — M15-T05 (§4.3 the seams M15 PUBLISHES).
//
// Seven read surfaces registered into the M1 registry by `registerDisciplinePlanSeams`, two of them the
// LOCKED contracts M17 shipped first (M17-F06/ADR-0009) — so this file's headline assertion is that
// registering CLOSES M17's Wave-F deny-stubs: `getVolunteerComplianceProvider()` / `getSupervisoryCadence
// Reader()` resolved from MODULE 17's own consumed-seam accessors stop throwing and answer M15's data.
//
// The rest guards the properties the providers exist to preserve:
//   • the volunteer gate NEVER throws and denies on an unreadable store (§8.7 / M15-F11 fail-CLOSED);
//   • both supervisory seams answer through the ONE §7.1 ladder, and a store failure propagates rather than
//     collapsing into the contract's "no obligation" null;
//   • a zero denominator answers `null`, never a fabricated 0% (rates) / never a 0% CoP breach (the ratio).
import { BLOCKING_VOLUNTEER_GATE_KINDS } from "@wardenx/discipline-plans";
import type { DisciplinePlanDigest, DisciplinePlanIdgDigest, MswRiskFactor } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, validateSeams } from "../src/bootstrap/index";
import {
  type DisciplinePlanSeamStore,
  GATE_STORE_UNAVAILABLE,
  type VolunteerGateFacts,
  createDisciplineComplianceProvider,
  createDisciplinePlanReader,
  createInMemoryDisciplinePlanSeamStore,
  createMswRiskFactorReader,
  createSupervisoryCadencePlanReader,
  createSupervisoryCadenceReader,
  createVolunteerComplianceProvider,
  createVolunteerGateExpiryReader,
  getDisciplineComplianceProvider,
  getDisciplinePlanReader,
  getMswRiskFactorReader,
  getSupervisoryCadencePlanReader,
  getVolunteerGateExpiryReader,
  orgLocalDateOf,
  rateOf,
  registerDisciplinePlanSeams,
} from "../src/modules/15-discipline-care-plans/index";
// The M17-side accessors — the whole point of the two LOCKED binds is that M17's OWN resolver stops denying.
import {
  getSupervisoryCadenceReader as m17GetSupervisoryCadenceReader,
  getVolunteerComplianceProvider as m17GetVolunteerComplianceProvider,
} from "../src/modules/17-scheduling/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const ADMISSION = "44444444-4444-4444-4444-444444444444";
const PLAN = "33333333-3333-3333-3333-333333333333";
const PLAN_B = "3b3b3b3b-3333-3333-3333-333333333333";
const VOLUNTEER = "77777777-7777-7777-7777-777777777777";
const AIDE = "aaaaaaaa-7777-7777-7777-777777777777";
const RN = "bbbbbbbb-7777-7777-7777-777777777777";
const PROVIDER_ENTITY = "99999999-9999-9999-9999-999999999999";
const LOCATION = "55555555-5555-5555-5555-555555555555";
const NOW = "2026-03-01T12:00:00.000Z";
const clock = () => NOW;

const digest = (over: Partial<DisciplinePlanDigest> = {}): DisciplinePlanDigest => ({
  planId: PLAN,
  organizationId: ORG,
  patientId: PATIENT,
  admissionId: ADMISSION,
  providerEntityId: PROVIDER_ENTITY,
  locationId: LOCATION,
  kind: "aide_poc",
  status: "active",
  lastSignedVersionId: null,
  lastSignedAt: null,
  nextSupervisoryDueAt: null,
  initialAssessmentSignedAt: null,
  spiritualCareDeclinedAt: null,
  ...over,
});

const clearingGate = (over: Partial<VolunteerGateFacts> = {}): VolunteerGateFacts => ({
  gateId: "gate-1",
  volunteerMembershipId: VOLUNTEER,
  gateKind: "tb_screening",
  status: "satisfied",
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

/** Every BLOCKING 418.78 gate cleared — the only shape that makes a volunteer bookable (a kind with no
 *  clearing row fails identically to an expired one, so the list must be complete). */
const allClearingGates = (): VolunteerGateFacts[] =>
  BLOCKING_VOLUNTEER_GATE_KINDS.map((gateKind, i) =>
    clearingGate({
      gateId: `g-${i}`,
      gateKind,
      validUntil: gateKind === "initial_training" ? null : "2027-01-01T00:00:00.000Z",
    }),
  );

afterEach(() => __resetSeamsForTest());

describe("registerDisciplinePlanSeams (§4.3) closes M17's Wave-F deny-stubs", () => {
  it("binds the two LOCKED contracts so M17's OWN accessors stop denying", async () => {
    __resetSeamsForTest();
    // Before: nothing registered → validateSeams applies M1's fail-closed deny-stubs.
    validateSeams();
    expect(() => m17GetVolunteerComplianceProvider().effectiveStatusFor(ORG, VOLUNTEER)).toThrow(
      /not implemented/,
    );
    expect(() => m17GetSupervisoryCadenceReader().nextSupervisoryDueAt(ORG, ADMISSION)).toThrow(
      /not implemented/,
    );

    // After: M15 registers the real impls over them (the composition root's wireModuleSeams order).
    const { store } = createInMemoryDisciplinePlanSeamStore({
      gates: allClearingGates(),
      plans: [
        {
          digest: digest({ nextSupervisoryDueAt: "2026-03-10T08:00:00.000Z" }),
          supervisingRnMembershipId: RN,
          aideMembershipId: AIDE,
        },
      ],
    });
    registerDisciplinePlanSeams({ store, clock, timeZone: "America/Los_Angeles" });
    validateSeams();

    await expect(
      m17GetVolunteerComplianceProvider().effectiveStatusFor(ORG, VOLUNTEER),
    ).resolves.toEqual({ membershipId: VOLUNTEER, isActive: true, failingGates: [] });
    await expect(
      m17GetSupervisoryCadenceReader().nextSupervisoryDueAt(ORG, ADMISSION),
    ).resolves.toEqual({ admissionId: ADMISSION, nextDueAt: "2026-03-10" });
  });

  it("registers all seven §4.3 seams and still boots (validateSeams)", () => {
    __resetSeamsForTest();
    registerDisciplinePlanSeams({ clock });
    expect(() => validateSeams()).not.toThrow();
    // Every published accessor resolves an impl (not the deny-stub) — a smoke check on the seven keys.
    expect(getDisciplinePlanReader()).toBeDefined();
    expect(getMswRiskFactorReader()).toBeDefined();
    expect(getVolunteerGateExpiryReader()).toBeDefined();
    expect(getSupervisoryCadencePlanReader()).toBeDefined();
    expect(getDisciplineComplianceProvider()).toBeDefined();
  });

  it("leaves an UNWIRED boot on the fail-closed deny-stubs (M15 is not required to boot)", () => {
    __resetSeamsForTest();
    expect(() => validateSeams()).not.toThrow();
    expect(() => getDisciplinePlanReader().activePlansForPatient(ORG, PATIENT)).toThrow(
      /not implemented/,
    );
    expect(() => getMswRiskFactorReader().riskFactorsForAdmission(ORG, ADMISSION)).toThrow(
      /not implemented/,
    );
    expect(() => getVolunteerGateExpiryReader().listExpiringGates(ORG, 30)).toThrow(
      /not implemented/,
    );
    expect(() => getSupervisoryCadencePlanReader().nextSupervisoryDueFor(ORG, PLAN)).toThrow(
      /not implemented/,
    );
    expect(() =>
      getDisciplineComplianceProvider().volunteerHourCostRatio(ORG, PROVIDER_ENTITY, 2026),
    ).toThrow(/not implemented/);
  });
});

describe("DisciplinePlanReader (§4.3)", () => {
  it("returns only ACTIVE plans for the patient, and null for an unknown plan", async () => {
    const idgDigest: DisciplinePlanIdgDigest = {
      planId: PLAN,
      kind: "aide_poc",
      status: "active",
      oneLineSummary: "Aide POC — bathing + ambulation support",
      activeGoalCount: 2,
      activeInterventionCount: 3,
      lastSignedAt: "2026-02-20T17:00:00.000Z",
      nextSupervisoryDueAt: "2026-03-06T17:00:00.000Z",
      openComplianceFlags: [],
      appliedConfidentialityFilter: false,
    };
    const { store } = createInMemoryDisciplinePlanSeamStore({
      plans: [
        { digest: digest(), idgDigest },
        { digest: digest({ planId: PLAN_B, status: "closed", kind: "msw_plan" }) },
      ],
    });
    const reader = createDisciplinePlanReader(store);

    const active = await reader.activePlansForPatient(ORG, PATIENT);
    expect(active.map((p) => p.planId)).toEqual([PLAN]);
    expect(await reader.planSummaryForIdg(ORG, PLAN)).toEqual(idgDigest);
    expect(await reader.planById(ORG, PLAN_B)).toBeNull();
  });
});

describe("MswRiskFactorReader (§4.3) exposes factors, never a score (§1.2)", () => {
  it("returns the admission's factors verbatim — no severity re-weighting", async () => {
    const factor: MswRiskFactor = {
      planId: PLAN,
      admissionId: ADMISSION,
      assessmentId: "assess-1",
      factor: "caregiver_isolation",
      severity: "high",
      icd10: null,
      capturedAt: "2026-02-14T18:00:00.000Z",
    };
    const { store } = createInMemoryDisciplinePlanSeamStore({ riskFactors: [factor] });
    const reader = createMswRiskFactorReader(store);
    expect(await reader.riskFactorsForAdmission(ORG, ADMISSION)).toEqual([factor]);
    expect(await reader.riskFactorsForAdmission(ORG, "other-admission")).toEqual([]);
  });
});

describe("VolunteerComplianceProvider (LOCKED §4.4) fails CLOSED and never throws", () => {
  it("denies with the service_unavailable sentinel when the gate store cannot be read", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({ gateStoreUnavailable: true });
    const provider = createVolunteerComplianceProvider(store, clock);
    expect(await provider.effectiveStatusFor(ORG, VOLUNTEER)).toEqual({
      membershipId: VOLUNTEER,
      isActive: false,
      failingGates: [GATE_STORE_UNAVAILABLE],
    });
  });

  it("denies — without throwing — when the store REJECTS (an outage is not a pass)", async () => {
    const failing: DisciplinePlanSeamStore = {
      ...createInMemoryDisciplinePlanSeamStore().store,
      gatesForMembership: async () => {
        throw new Error("connection terminated");
      },
    };
    const provider = createVolunteerComplianceProvider(failing, clock);
    const status = await provider.effectiveStatusFor(ORG, VOLUNTEER);
    expect(status.isActive).toBe(false);
    expect(status.failingGates).toEqual([GATE_STORE_UNAVAILABLE]);
  });

  it("denies a volunteer with NO gate rows at all (a missing gate fails like an expired one)", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({ gates: [] });
    const status = await createVolunteerComplianceProvider(store, clock).effectiveStatusFor(
      ORG,
      VOLUNTEER,
    );
    expect(status.isActive).toBe(false);
    expect(status.failingGates).toContain("tb_screening");
  });

  it("clears a volunteer whose blocking gates all clear, and re-denies once one expires", async () => {
    const gates = allClearingGates();
    const { store } = createInMemoryDisciplinePlanSeamStore({ gates });
    expect(
      (await createVolunteerComplianceProvider(store, clock).effectiveStatusFor(ORG, VOLUNTEER))
        .isActive,
    ).toBe(true);

    const expired = createInMemoryDisciplinePlanSeamStore({
      gates: gates.map((g) =>
        g.gateKind === "tb_screening" ? { ...g, validUntil: "2026-02-01T00:00:00.000Z" } : g,
      ),
    });
    const status = await createVolunteerComplianceProvider(expired.store, clock).effectiveStatusFor(
      ORG,
      VOLUNTEER,
    );
    expect(status.isActive).toBe(false);
    expect(status.failingGates).toEqual(["tb_screening"]);
  });
});

describe("VolunteerGateExpiryReader (§4.3 additive sweep)", () => {
  it("returns gates inside the horizon and excludes expired / revoked / non-expiring ones", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      gates: [
        clearingGate({ gateId: "soon", validUntil: "2026-03-20T00:00:00.000Z" }), // 18 days out
        clearingGate({ gateId: "far", validUntil: "2026-06-01T00:00:00.000Z" }), // beyond 30
        clearingGate({ gateId: "lapsed", validUntil: "2026-02-01T00:00:00.000Z" }), // already expired
        clearingGate({ gateId: "revoked", revokedAt: "2026-02-10T00:00:00.000Z" }),
        clearingGate({ gateId: "lifetime", gateKind: "initial_training", validUntil: null }),
      ],
    });
    const expiring = await createVolunteerGateExpiryReader(store, clock).listExpiringGates(ORG, 30);
    expect(expiring).toEqual([
      { membershipId: VOLUNTEER, gateKind: "tb_screening", validUntil: "2026-03-20T00:00:00.000Z" },
    ]);
  });
});

describe("the supervisory seams share ONE §7.1 ladder", () => {
  const clockRowSeed = (nextDueAt: string | null) => ({
    plans: [
      {
        digest: digest({ nextSupervisoryDueAt: nextDueAt }),
        aideMembershipId: AIDE,
        supervisingRnMembershipId: RN,
      },
    ],
  });

  it("SupervisoryCadenceReader answers the org-tz DATE of the timestamptz column", async () => {
    // 2026-03-10T02:00Z is still 2026-03-09 in America/Los_Angeles — the DATE must follow the org, not UTC.
    const { store } = createInMemoryDisciplinePlanSeamStore(
      clockRowSeed("2026-03-10T02:00:00.000Z"),
    );
    const reader = createSupervisoryCadenceReader(store, "America/Los_Angeles");
    expect(await reader.nextSupervisoryDueAt(ORG, ADMISSION)).toEqual({
      admissionId: ADMISSION,
      nextDueAt: "2026-03-09",
    });
    expect(orgLocalDateOf("2026-03-10T02:00:00.000Z", "UTC")).toBe("2026-03-10");
  });

  it("SupervisoryCadenceReader answers null when no clock is armed (pre-first-signature)", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore(clockRowSeed(null));
    const reader = createSupervisoryCadenceReader(store, "America/Los_Angeles");
    expect(await reader.nextSupervisoryDueAt(ORG, ADMISSION)).toBeNull();
  });

  it("SupervisoryCadenceReader PROPAGATES a store failure — an outage is never 'no obligation'", async () => {
    const failing: DisciplinePlanSeamStore = {
      ...createInMemoryDisciplinePlanSeamStore().store,
      supervisoryClockForAdmission: async () => {
        throw new Error("connection terminated");
      },
    };
    await expect(
      createSupervisoryCadenceReader(failing, "UTC").nextSupervisoryDueAt(ORG, ADMISSION),
    ).rejects.toThrow(/connection terminated/);
  });

  it("SupervisoryCadencePlanReader reports the ladder status for the plan", async () => {
    // now = 2026-03-01T12:00Z. Due 2026-03-02 → 'due' (inside the 2-day warn mark of the 14-day cadence).
    const { store } = createInMemoryDisciplinePlanSeamStore(
      clockRowSeed("2026-03-02T12:00:00.000Z"),
    );
    expect(
      await createSupervisoryCadencePlanReader(store, clock).nextSupervisoryDueFor(ORG, PLAN),
    ).toEqual({
      planId: PLAN,
      nextDueAt: "2026-03-02T12:00:00.000Z",
      cadenceDays: 14,
      status: "due",
    });
  });

  it("listOverdueSupervisory carries hoursOverdue + gateEngaged and drops on_time/due plans", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      plans: [
        // 1 day past due → overdue, gate not yet engaged (the grace is 2 days at the 14-day cadence).
        {
          digest: digest({ nextSupervisoryDueAt: "2026-02-28T12:00:00.000Z" }),
          aideMembershipId: AIDE,
          supervisingRnMembershipId: RN,
        },
        // 3 days past due → gate_engaged (CHHA encounter signing blocks).
        {
          digest: digest({ planId: PLAN_B, nextSupervisoryDueAt: "2026-02-26T12:00:00.000Z" }),
          aideMembershipId: AIDE,
          supervisingRnMembershipId: RN,
        },
        // Not due for a week → not a worklist item.
        {
          digest: digest({ planId: "plan-c", nextSupervisoryDueAt: "2026-03-08T12:00:00.000Z" }),
        },
      ],
    });
    const overdue = await createSupervisoryCadencePlanReader(store, clock).listOverdueSupervisory({
      orgId: ORG,
    });
    expect(overdue.map((o) => [o.planId, o.hoursOverdue, o.gateEngaged])).toEqual([
      [PLAN, 24, false],
      [PLAN_B, 72, true],
    ]);
    expect(overdue[0]?.aideMembershipId).toBe(AIDE);
  });

  it("listOverdueSupervisory honours the provider-entity / location scope", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      plans: [
        { digest: digest({ nextSupervisoryDueAt: "2026-02-26T12:00:00.000Z" }) },
        {
          digest: digest({
            planId: PLAN_B,
            nextSupervisoryDueAt: "2026-02-26T12:00:00.000Z",
            providerEntityId: "other-pe",
          }),
        },
      ],
    });
    const scoped = await createSupervisoryCadencePlanReader(store, clock).listOverdueSupervisory({
      orgId: ORG,
      providerEntityId: PROVIDER_ENTITY,
    });
    expect(scoped.map((o) => o.planId)).toEqual([PLAN]);
  });
});

describe("DisciplineComplianceProvider (§4.3) — an empty scope is null, never 0", () => {
  it("divides the store's tallies, and answers null on a zero denominator", async () => {
    expect(rateOf({ numerator: 0, denominator: 0 })).toBeNull();
    const { store } = createInMemoryDisciplinePlanSeamStore({
      complianceCounts: {
        supervisoryOnTime: { numerator: 9, denominator: 10 },
        mswInitialOnTime: { numerator: 3, denominator: 4 },
        chaplainInitialOnTime: { numerator: 0, denominator: 0 },
        volunteerGateCompliance: { numerator: 5, denominator: 5 },
      },
    });
    const provider = createDisciplineComplianceProvider(store);
    const scope = { orgId: ORG };
    expect(await provider.supervisoryOnTimeRate(scope)).toBe(0.9);
    expect(await provider.mswInitialOnTimeRate(scope)).toBe(0.75);
    expect(await provider.volunteerGateComplianceRate(scope)).toBe(1);
    // A scope with no chaplain obligation has no rate to fail — null, so M30's small-N suppression can see it.
    expect(await provider.chaplainInitialOnTimeRate(scope)).toBeNull();
  });

  it("also exposes the raw counts behind the rate (M30's supervisory/volunteer-gate measure inputs)", async () => {
    // The rate methods above THROW the denominator away, which is fine for a dashboard tile but wrong for
    // a CMS-reportable measure (`ratioResult()` suppresses on a denominator under the small-N floor, and a
    // rate has already discarded it). These sibling methods are the fix — same store round-trip, no division.
    const { store } = createInMemoryDisciplinePlanSeamStore({
      complianceCounts: {
        supervisoryOnTime: { numerator: 9, denominator: 10 },
        mswInitialOnTime: { numerator: 3, denominator: 4 },
        chaplainInitialOnTime: { numerator: 0, denominator: 0 },
        volunteerGateCompliance: { numerator: 5, denominator: 5 },
      },
    });
    const provider = createDisciplineComplianceProvider(store);
    const scope = { orgId: ORG };
    expect(await provider.supervisoryOnTimeCounts(scope)).toEqual({ numerator: 9, denominator: 10 });
    expect(await provider.volunteerGateComplianceCounts(scope)).toEqual({
      numerator: 5,
      denominator: 5,
    });
  });

  it("badges the 418.78(e) ratio `unavailable` while the M27 hours denominator is unbound", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      hourTotals: [
        {
          providerEntityId: PROVIDER_ENTITY,
          fiscalYear: 2026,
          volunteerHourMinutes: 12_000,
          staffPatientCareMinutes: null,
        },
      ],
    });
    const ratio = await createDisciplineComplianceProvider(store).volunteerHourCostRatio(
      ORG,
      PROVIDER_ENTITY,
      2026,
    );
    expect(ratio.status).toBe("unavailable");
    expect(ratio.ratio).toBeNull();
    expect(ratio.volunteerHourMinutes).toBe(12_000);
    expect(ratio.reason).toMatch(/Module 27/);
  });

  it("computes the ratio once the denominator resolves", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      hourTotals: [
        {
          providerEntityId: PROVIDER_ENTITY,
          fiscalYear: 2026,
          volunteerHourMinutes: 12_000,
          staffPatientCareMinutes: 100_000,
        },
      ],
    });
    const ratio = await createDisciplineComplianceProvider(store).volunteerHourCostRatio(
      ORG,
      PROVIDER_ENTITY,
      2026,
    );
    expect(ratio.ratio).toBeCloseTo(0.12, 5);
    expect(ratio.status).toBe("green");
  });
});
