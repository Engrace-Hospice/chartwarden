import * as billing from "@wardenx/billing";
import { BillingRuleRegistry, pass } from "@wardenx/billing";
import type { Rule } from "@wardenx/billing";
// apps/backend/src/modules/23-billing-medicare/__tests__/assembly.test.ts — the §10 task-30 CLAIM ASSEMBLY
// service tests (D10 / D15). The service constructs its repos internally (`new repositories.X(tx)`), so this
// suite PARTIAL-mocks `@wardenx/billing`: the data ports are swapped for the in-memory `_billing-repo-fakes`
// store, while ALL pure domain (calculateHipps / calculateSia / sequestration / control-number / TOB / the
// rule registry) stays REAL — so the assembled claim's money + lines are genuinely computed, not stubbed.
// `withOrgContext` is exercised against a fake no-op transaction (`makeFakeDb`). Asserted invariants:
//   • D15 — a non-Medicare-primary window is rejected NON_MEDICARE_PRIMARY_PAYER before any write.
//   • D10 — an `awaiting_cosignature` encounter is EXCLUDED from the assembled line's backing set (no
//     retroactive add); only `billable` encounters back a line.
//   • server-authoritative — the response lines are HIPPS-derived; any client-supplied line data is ignored.
//   • one logical unit — claim + claim_line[] + hipps_calculation (+ optional sia_calculation) + the initial
//     validation_run + the creation history row + the `m23.claim.draft_created` outbox emit all land together.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaimAssemblyService } from "../services/claim-assembly";
import type { ClaimAssemblyActor, ClaimAssemblySeams } from "../services/claim-assembly";
import type { FakeStore } from "./_billing-repo-fakes";
import { makeFakeDb } from "./_billing-repo-fakes";

vi.mock("@wardenx/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/billing")>();
  const { buildFakeRepositories } = await import("./_billing-repo-fakes");
  const { repos, store } = buildFakeRepositories();
  return {
    ...actual,
    repositories: { ...actual.repositories, ...repos, __store: store },
  };
});

const store = (billing.repositories as unknown as { __store: FakeStore }).__store;

const ORG = "org-1";
const ACTOR: ClaimAssemblyActor = {
  organizationId: ORG,
  userId: "user-1",
  membershipId: "mem-1",
  actorKind: "user",
};

/** F-214 — a diagnosis read with nothing withheld for Part 2 consent. */
const NO_WITHHOLD = <T>(sequence: T) => ({
  sequence,
  withheldForConsentCount: 0,
  terminalWithheldForConsent: false,
});

const RATE_TABLE = {
  // TODO(CMS-fixture): the published FY per-diem amounts replace these representative values.
  rhcDays1to60PerDiemCents: 20_000,
  rhcDays61PlusPerDiemCents: 16_000,
  chcHourlyRateCents: 6_250,
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
  // F-211 labor shares (wage index is 1.0000 here, so they do not move any price in this suite).
  rhcLaborShare: "0.6600",
  chcLaborShare: "0.6600",
  ircLaborShare: "0.5400",
  gipLaborShare: "0.6400",
} as const;

/** The tenant-entered visit-charge schedule (per 15-minute unit) every scenario bills visits from unless it overrides. */
const VISIT_CHARGES = {
  effectiveFrom: "2025-01-01",
  effectiveTo: null,
  charges: {
    rn: 2_500,
    lpn: 2_400,
    chha: 1_500,
    msw: 3_000,
    pt: 3_500,
    ot: 3_400,
    slp: 3_300,
  },
} as const;

/** One trivial always-pass rule so the initial validation run executes deterministically (all_pass). */
const trivialPassRule: Rule = {
  key: "test.always_pass",
  version: 1,
  category: "hipps",
  title: "always pass",
  description: "test rule",
  severity: "error",
  regulatoryRequired: false,
  check: () => pass("test.always_pass", "error", "ok"),
};

function buildRegistry(): BillingRuleRegistry {
  const registry = new BillingRuleRegistry();
  registry.registerRule(trivialPassRule);
  registry.freeze();
  return registry;
}

/** Build a full assembly seam bundle with happy-path defaults; `overrides` swaps in scenario-specific ports. */
function buildSeams(overrides: Partial<ClaimAssemblySeams> = {}): ClaimAssemblySeams {
  const seams: ClaimAssemblySeams = {
    patientPayer: {
      medicarePrimaryForRange: async () => ({ patientPayerId: "pp-1", medicarePrimary: true }),
    },
    admission: {
      resolveForRange: async () => ({
        admissionId: "adm-1",
        hospiceAdmissionDate: "2025-11-01",
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        placeOfDeath: null,
        transferOut: null,
      }),
    },
    electionPeriods: {
      coveringRange: async () => [
        {
          electionPeriodId: "ep-1",
          sequence: 1,
          effectiveFrom: "2025-10-01",
          effectiveTo: null,
          revoked: false,
          revocationDate: null,
        },
      ],
    },
    certifications: { forPatient: async () => [] },
    faceToFace: { forPatient: async () => [] },
    levelOfCare: {
      periodsInRange: async () => [
        {
          levelOfCarePeriodId: "loc-1",
          levelOfCare: "routine_home_care",
          from: "2025-11-01",
          to: "2025-11-07",
          chcDocumentedHours: null,
          gipAdmissionCriteriaDocumented: null,
        },
      ],
    },
    billableEncounters: {
      forRange: async () => [
        { encounterId: "enc-bill", serviceDate: "2025-11-03", billability: "billable" },
        {
          encounterId: "enc-cosign",
          serviceDate: "2025-11-04",
          billability: "awaiting_cosignature",
        },
      ],
    },
    diagnoses: { forRange: async () => NO_WITHHOLD([]) },
    signedEncounters: { inWindow: async () => [] },
    evvCompliance: { bracketsForEncounters: async () => [] },
    mdm: {
      resolveProviderEntity: async () => ({
        ccn: "123456",
        macJurisdiction: "ngs_j6",
        cbsaCode: null,
      }),
      resolveClinicalParticipants: async () => ({
        attending: null,
        hospicePhysician: null,
        placeOfService: "home",
      }),
    },
    terminology: {
      resolveForClaim: async () => ({ valueSetMembership: {}, icd10Billable: {} }),
    },
    capProjection: {
      // Default: M26 unavailable → cap rules warn-skip (preserves the pre-bind assertions). Scenario tests
      // override with an `ok` projection to exercise the live cap rules.
      projectionForOrg: async () => ({
        status: "unavailable",
        aggregateProjectedCents: null,
        aggregateCapCents: null,
        pctOfCap: null,
        ipuWithinCap: null,
      }),
      projectionForPatient: async () => ({
        status: "unavailable",
        projectedCapCents: null,
        capLimitCents: null,
        withinCap: null,
      }),
    },
    referenceData: {
      hippsRateTable: async () => RATE_TABLE,
      chcHourlyRateCents: async () => 6_000,
      wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: null }),
      activeSequestrationPolicy: async () => ({
        sequestrationPolicyId: "seq-1",
        percentage: "2.00",
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
      }),
      visitChargeVersions: async () => [VISIT_CHARGES],
    },
    ruleRegistry: buildRegistry(),
    outbox: {
      publish: async (_tx, event) => {
        store.emitted.push(event);
      },
    },
    now: () => new Date("2025-11-10T00:00:00.000Z"),
    ...overrides,
  };
  return seams;
}

const REQUEST = {
  providerEntityId: "pe-1",
  patientId: "pat-1",
  serviceFrom: "2025-11-01",
  serviceTo: "2025-11-07",
  tob: "812",
} as const;

beforeEach(() => store.reset());
afterEach(() => vi.clearAllMocks());

describe("D15 — non-Medicare-primary window is rejected before any write", () => {
  it("rejects NON_MEDICARE_PRIMARY_PAYER and persists nothing", async () => {
    const seams = buildSeams({
      patientPayer: {
        medicarePrimaryForRange: async () => ({ patientPayerId: "pp-1", medicarePrimary: false }),
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await expect(svc.assemble(ACTOR, REQUEST)).rejects.toMatchObject({
      code: "NON_MEDICARE_PRIMARY_PAYER",
    });
    expect(store.claims.size).toBe(0);
    expect(store.lines).toHaveLength(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("rejects when no payer resolution is returned at all (fail-closed)", async () => {
    const seams = buildSeams({
      patientPayer: { medicarePrimaryForRange: async () => null },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await expect(svc.assemble(ACTOR, REQUEST)).rejects.toMatchObject({
      code: "NON_MEDICARE_PRIMARY_PAYER",
    });
  });
});

describe("AI-BLOCK (D13) — no AI principal may assemble a claim", () => {
  it("rejects an ai_* actor before reading any seam", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await expect(
      svc.assemble({ ...ACTOR, actorKind: "ai_copilot" }, REQUEST),
    ).rejects.toMatchObject({ code: "AI_ACTOR_FORBIDDEN" });
    expect(store.claims.size).toBe(0);
  });
});

describe("server-authoritative assembly — produces claim + lines + hipps in one logical unit", () => {
  it("derives the HIPPS lines + penny-exact money and persists the whole aggregate together", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    const res = await svc.assemble(ACTOR, REQUEST);

    // Response shape: a DRAFT claim with one all-RHC days-1-7 segment over the 7-day window.
    expect(res.state).toBe("DRAFT");
    expect(res.lineCount).toBe(1);
    expect(res.perDiemClassCode).toBe("R1000");
    // 7 days × $200.00 wage-adjusted (factor 1.0000) = $1,400.00.
    expect(res.totalChargeCents).toBe(140_000);
    expect(res.initialValidationOutcome).toBe("all_pass");

    // The whole aggregate landed in the one unit of work.
    expect(store.claims.size).toBe(1);
    const claim = [...store.claims.values()][0];
    expect(claim.state).toBe("draft");
    expect(claim.totalChargeCents).toBe(140_000);
    // Sequestration 2.00% over the gross: net expected = 140000 − round(140000 × 0.02) = 137200.
    expect(claim.totalExpectedPaymentCents).toBe(137_200);
    expect(claim.sequestrationPolicyId).toBe("seq-1");

    expect(store.lines).toHaveLength(1);
    expect(store.lines[0].revenueCode).toBe("0651"); // RHC
    expect(store.lines[0].unitCount).toBe(7);
    expect(store.lines[0].unitRateCents).toBe(20_000); // wage-adjusted per-diem, server-derived
    expect(store.lines[0].lineChargeCents).toBe(140_000);

    expect(store.hipps).toHaveLength(1);
    expect(store.hipps[0].rhcDays1to60).toBe(7);
    expect(store.hipps[0].rhcDays61Plus).toBe(0);

    // The initial §11.A validation run executed (the trivial pass rule) + recorded the result.
    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0];
    expect(run.trigger).toBe("initial_assembly");
    expect(run.outcome).toBe("all_pass");
    expect(run.rulesExecuted).toBe(1);
    expect(store.results.size).toBe(1);

    // The creation history row (NULL → draft) + the §4.10 outbox emit, same unit of work (D2).
    expect(store.history).toHaveLength(1);
    expect(store.history[0].fromState).toBeNull();
    expect(store.history[0].toState).toBe("draft");
    expect(store.emitted.map((e: { eventName: string }) => e.eventName)).toContain(
      "m23.claim.draft_created",
    );
  });

  it("ignores any client-supplied line data — lines are HIPPS-derived only (server-authoritative)", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    // A malicious/legacy client tacks lines + an inflated charge onto the request body; all ignored.
    const tampered = {
      ...REQUEST,
      lines: [{ revenueCode: "9999", unitRateCents: 999_999, unitCount: 1 }],
      totalChargeCents: 1,
    } as unknown as typeof REQUEST;

    const res = await svc.assemble(ACTOR, tampered);
    expect(res.lineCount).toBe(1);
    expect(res.totalChargeCents).toBe(140_000);
    expect(store.lines[0].revenueCode).toBe("0651");
    expect(store.lines[0].unitRateCents).toBe(20_000);
  });
});

describe("D10 — cosignature-wait visits are excluded from the assembled line backing set (no retroactive add)", () => {
  it("only billable encounters back a line; awaiting_cosignature is omitted entirely", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    await svc.assemble(ACTOR, REQUEST);

    expect(store.lines).toHaveLength(1);
    const backing: string[] = store.lines[0].backingEncounterIds;
    expect(backing).toContain("enc-bill");
    expect(backing).not.toContain("enc-cosign"); // D10: the cosignature-wait visit is never auto-added
  });
});

describe("SIA add-on (D6) — a deceased patient's last-7-days RN/MSW care produces a sia_calculation row", () => {
  it("writes one sia_calculation; the add-on is expected PAYMENT, never a billed charge", async () => {
    const seams = buildSeams({
      admission: {
        resolveForRange: async () => ({
          admissionId: "adm-1",
          hospiceAdmissionDate: "2025-11-01",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: "2025-11-07",
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      signedEncounters: {
        inWindow: async () => [
          {
            encounterId: "rn-1",
            serviceDate: "2025-11-06",
            discipline: "RN",
            signed: true,
            cosignRequired: false,
            cosigned: false,
            durationMinutes: 120,
          },
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    const res = await svc.assemble(ACTOR, REQUEST);

    expect(store.sia).toHaveLength(1);
    // 120 min capped (≤240) priced at the CHC hourly rate $60.00 → 2h × $60.00 = $120.00.
    expect(store.sia[0].siaAddOnCents).toBe(12_000);
    // The billed total is the sum of the line charges only ($1,400.00): the MAC derives the SIA from the visit
    // lines, so it is never a charge (the 837I claim total must balance to its lines).
    expect(res.totalChargeCents).toBe(140_000);
    const claim = [...store.claims.values()][0];
    expect(claim.totalChargeCents).toBe(140_000);
    // Expected payment keeps the add-on: gross $1,520.00 less 2% sequestration ($30.40) = $1,489.60.
    expect(claim.totalExpectedPaymentCents).toBe(148_960);
  });

  it("writes NO sia_calculation for a living patient", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    expect(store.sia).toHaveLength(0);
  });
});

describe("F-209 (#251) — the claim carries the real M7 diagnosis sequence", () => {
  const SEQ = [
    { position: 1, code: "C34.90", relationship: "terminal" as const },
    { position: 2, code: "J44.9", relationship: "related" as const },
    { position: 3, code: "I10", relationship: "unrelated" as const },
  ];

  it("threads the sequence into the validation context, the terminology call, and terminal-only line pointers", async () => {
    let seenSequence: unknown = null;
    const registry = new BillingRuleRegistry();
    registry.registerRule({
      ...trivialPassRule,
      key: "test.capture_sequence",
      check: (ctx) => {
        seenSequence = ctx.claim.icd10Sequence;
        return pass("test.capture_sequence", "error", "ok");
      },
    });
    registry.freeze();
    const terminologyCalls: Array<readonly string[] | undefined> = [];
    const forRange = vi.fn(async () => NO_WITHHOLD(SEQ));
    const seams = buildSeams({
      ruleRegistry: registry,
      diagnoses: { forRange },
      terminology: {
        resolveForClaim: async (_org, _asOf, codes) => {
          terminologyCalls.push(codes);
          return { valueSetMembership: {}, icd10Billable: {} };
        },
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);

    expect(forRange).toHaveBeenCalledWith(ORG, "pat-1", {
      from: REQUEST.serviceFrom,
      to: REQUEST.serviceTo,
    });
    expect(terminologyCalls).toEqual([["C34.90", "J44.9", "I10"]]);
    expect(seenSequence).toEqual(SEQ);
    expect(store.lines.length).toBeGreaterThan(0);
    for (const line of store.lines) expect(line.icdPointerPositions).toEqual([1]);
  });

  it("with no diagnoses: empty sequence, empty pointers (the icd10_sequencing rule reports the gap honestly)", async () => {
    const seams = buildSeams();
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    for (const line of store.lines) expect(line.icdPointerPositions).toEqual([]);
  });

  it("F-214: threads the withheld-for-consent summary (count + terminal flag, never codes) into the validation context", async () => {
    let seen: unknown = null;
    const registry = new BillingRuleRegistry();
    registry.registerRule({
      ...trivialPassRule,
      key: "test.capture_withheld",
      check: (ctx) => {
        seen = {
          n: ctx.claim.diagnosesWithheldForConsent,
          t: ctx.claim.terminalDiagnosisWithheldForConsent,
        };
        return pass("test.capture_withheld", "error", "ok");
      },
    });
    registry.freeze();
    const seams = buildSeams({
      ruleRegistry: registry,
      diagnoses: {
        forRange: async () => ({
          sequence: [{ position: 1, code: "J44.9", relationship: "related" as const }],
          withheldForConsentCount: 1,
          terminalWithheldForConsent: true,
        }),
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    expect(seen).toEqual({ n: 1, t: true });
    // The withheld terminal is not replaced: a `related` diagnosis is never promoted, so no line points at it.
    for (const line of store.lines) expect(line.icdPointerPositions).toEqual([]);
  });

  it("propagates an unbound diagnoses seam fail-closed (never reads as 'no diagnoses')", async () => {
    const seams = buildSeams({
      diagnoses: {
        forRange: async () => {
          throw new Error("SEAM_UNBOUND");
        },
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await expect(svc.assemble(ACTOR, REQUEST)).rejects.toThrow("SEAM_UNBOUND");
    expect(store.claims.size).toBe(0);
  });
});

describe("F-212 - no sequestration policy fails CLOSED with an actionable error (never a silent 0% / 2% default)", () => {
  it("names the service date, the provider entity, the route and the permission, and persists nothing", async () => {
    const seams = buildSeams({
      referenceData: {
        hippsRateTable: async () => RATE_TABLE,
        chcHourlyRateCents: async () => 6_000,
        wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: null }),
        activeSequestrationPolicy: async () => null,
        visitChargeVersions: async () => [],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    const err = await svc.assemble(ACTOR, REQUEST).then(
      () => null,
      (e: unknown) => e as { code: string; statusCode: number; message: string },
    );
    expect(err).toMatchObject({ code: "SEQUESTRATION_POLICY_UNAVAILABLE", statusCode: 422 });
    expect(err?.message).toContain("POST /api/v1/billing/sequestration-policies");
    expect(err?.message).toContain("billing.sequestration_policy.edit");
    expect(store.claims.size).toBe(0);
  });
});

describe("F-213 (#252) — placeOfService is resolved over the whole claim range and drives the line Q-code", () => {
  it.each([
    ["home", "Q5001"],
    ["alf", "Q5002"],
    ["ltc", "Q5003"],
    ["snf", "Q5004"],
    ["hospital", "Q5005"],
    ["ipu", "Q5006"],
    ["ltch", "Q5007"],
    ["psych", "Q5008"],
    [null, "Q5009"],
  ] as const)("resolved placeOfService %s -> every line Q-code %s", async (pos, qCode) => {
    const resolve = vi.fn(async () => ({
      attending: null,
      hospicePhysician: null,
      placeOfService: pos,
    }));
    const seams = buildSeams({
      mdm: { ...buildSeams().mdm, resolveClinicalParticipants: resolve },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    // The resolver gets the WHOLE service range (a range can span a move), not just serviceFrom.
    expect(resolve).toHaveBeenCalledWith(ORG, "pat-1", REQUEST.serviceFrom, {
      from: REQUEST.serviceFrom,
      to: REQUEST.serviceTo,
    });
    expect(store.lines.length).toBeGreaterThan(0);
    for (const line of store.lines) expect(line.qCode).toBe(qCode);
  });
});

describe("two-tier RHC carry-over — our earlier stay + another hospice's days from HETS (ch. 11 §30.2)", () => {
  const readmission = {
    admissionId: "adm-1",
    hospiceAdmissionDate: "2025-11-01",
    rhcPriorHospiceDays: 11,
    // Our stay 09/20–09/30 (11 days, gap 32 to 11/01).
    rhcPriorStays: [{ admissionId: "adm-0", startedOn: "2025-09-20", endedOn: "2025-09-30" }],
    dischargeDate: null,
    dischargeReason: null,
    deceasedDate: null,
    placeOfDeath: null,
    transferOut: null,
  };

  it("prices the claim with the merged count and records the basis + chain on hipps_calculation", async () => {
    // Arrange: a fresh HETS check shows another hospice 08/01–09/15 (46 days, gap 5 to our stay).
    store.eligibilityChecks.push({
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: ORG,
      patientId: REQUEST.patientId,
      asOfServiceDate: "2025-11-01",
      outcome: "active_part_a",
      checkedAt: new Date("2025-11-05T00:00:00.000Z"),
      staleAt: new Date("2025-12-05T00:00:00.000Z"),
      parsedPayload: {
        hospicePeriods: [
          {
            kind: "benefit_period",
            periodNumber: 1,
            startDate: "2025-08-01",
            endDate: "2025-09-15",
            hospiceNpi: "1649726464",
            revocationOrDischargeDate: "2025-09-15",
            revocationCode: "1",
            daysUsed: 46,
          },
        ],
        hospiceHistoryTruncated: false,
      },
    });
    const svc = buildClaimAssemblyService(
      makeFakeDb() as never,
      buildSeams({ admission: { resolveForRange: async () => readmission } }),
    );

    // Act
    await svc.assemble(ACTOR, REQUEST);

    // Assert: 46 + 11 = 57 prior days → 11/01–11/03 are days 58–60 (high), 11/04–11/07 low.
    expect(store.hipps[0].rhcDays1to60).toBe(3);
    expect(store.hipps[0].rhcDays61Plus).toBe(4);
    expect(store.hipps[0].rhcCarryOver).toMatchObject({
      priorDays: 57,
      basis: "hets_merged",
      startsAtDay: 58,
      hetsCheck: { ageDays: 5, stale: false },
      chain: [
        { source: "hets", hospiceNpi: "1649726464", countedDays: 46 },
        { source: "internal", ref: "adm-0", countedDays: 11 },
      ],
    });
  });

  it("falls back to our own stays (basis internal_only) when no HETS check is on file", async () => {
    const svc = buildClaimAssemblyService(
      makeFakeDb() as never,
      buildSeams({ admission: { resolveForRange: async () => readmission } }),
    );
    await svc.assemble(ACTOR, REQUEST);
    expect(store.hipps[0].rhcCarryOver).toMatchObject({ priorDays: 11, basis: "internal_only" });
    expect(store.hipps[0].rhcDays1to60).toBe(7);
  });
});

describe("CMS ch. 11 §30.3 — every visit by hospice staff is its own dated, 15-minute-unit claim line", () => {
  const visit = (over: Record<string, unknown>) => ({
    encounterId: "enc-rn",
    serviceDate: "2025-11-03",
    billability: "billable" as const,
    discipline: "rn",
    encounterType: "routine_visit",
    durationMinutes: 45,
    ...over,
  });

  it("emits a 0551/G0299 line (3 units) after the per-diem line, backed by the visit's encounter", async () => {
    const seams = buildSeams({
      billableEncounters: { forRange: async () => [visit({})] },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    const res = await svc.assemble(ACTOR, REQUEST);

    expect(store.lines).toHaveLength(2);
    expect(store.lines[0].revenueCode).toBe("0651");
    expect(store.lines[1]).toMatchObject({
      lineNumber: 2,
      revenueCode: "0551",
      hcpcsCode: "G0299",
      serviceDateFrom: "2025-11-03",
      serviceDateTo: "2025-11-03",
      unitCount: 3,
      levelOfCare: "routine_home_care",
      levelOfCarePeriodId: "loc-1",
      backingEncounterIds: ["enc-rn"],
      modifiers: [],
    });
    expect(res.lineCount).toBe(2);
  });

  it("bills a visit line at the tenant's charge per 15-minute unit; the total is the sum of the line charges and expected payment is untouched", async () => {
    const seams = buildSeams({
      billableEncounters: { forRange: async () => [visit({})] }, // 45 minutes = 3 units, RN
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    const res = await svc.assemble(ACTOR, REQUEST);

    expect(store.lines[1]).toMatchObject({
      unitCount: 3,
      unitRateCents: 2_500,
      lineChargeCents: 7_500,
    });
    const sum = store.lines.reduce(
      (s: number, l: { lineChargeCents: number }) => s + l.lineChargeCents,
      0,
    );
    expect(res.totalChargeCents).toBe(140_000 + 7_500);
    expect(res.totalChargeCents).toBe(sum);
    // The informational visit charge never reaches the payment: gross $1,400.00 less 2% sequestration.
    expect([...store.claims.values()][0].totalExpectedPaymentCents).toBe(137_200);
  });

  it("looks the charge up per visit date and discipline from the schedule version covering that date", async () => {
    const seams = buildSeams({
      referenceData: {
        ...buildSeams().referenceData,
        visitChargeVersions: async () => [
          {
            ...VISIT_CHARGES,
            effectiveTo: "2025-11-03",
            charges: { ...VISIT_CHARGES.charges, rn: 2_000 },
          },
          {
            ...VISIT_CHARGES,
            effectiveFrom: "2025-11-04",
            charges: { ...VISIT_CHARGES.charges, rn: 2_200 },
          },
        ],
      },
      billableEncounters: {
        forRange: async () => [
          visit({ encounterId: "a", serviceDate: "2025-11-03", durationMinutes: 15 }),
          visit({ encounterId: "b", serviceDate: "2025-11-05", durationMinutes: 15 }),
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    expect(store.lines.slice(1).map((l: { unitRateCents: number }) => l.unitRateCents)).toEqual([
      2_000, 2_200,
    ]);
  });

  it("fails closed (422 VISIT_CHARGE_MISSING) naming the disciplines, not the encounters, when a billed discipline has no charge", async () => {
    const seams = buildSeams({
      referenceData: {
        ...buildSeams().referenceData,
        visitChargeVersions: async () => [
          { ...VISIT_CHARGES, charges: { ...VISIT_CHARGES.charges, pt: null, msw: null } },
        ],
      },
      billableEncounters: {
        forRange: async () => [
          visit({ encounterId: "e1" }), // rn: has a charge
          visit({ encounterId: "e2", discipline: "pt", encounterType: "pt_visit" }),
          visit({ encounterId: "e3", discipline: "msw", encounterType: "msw_followup" }),
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    const err = await svc.assemble(ACTOR, REQUEST).then(
      () => null,
      (e: unknown) => e as { code: string; statusCode: number; message: string },
    );
    expect(err).toMatchObject({ code: "VISIT_CHARGE_MISSING", statusCode: 422 });
    expect(err?.message).toContain("msw, pt");
    expect(err?.message).toContain("POST /api/v1/billing/visit-charge-schedules");
    expect(err?.message).toContain("billing.visit_charge.admin");
    expect(err?.message).not.toContain("e2");
    expect(store.claims.size).toBe(0);
  });

  it("fails closed when no schedule exists at all, but needs none for a claim with no visit lines", async () => {
    const noSchedule = {
      ...buildSeams().referenceData,
      visitChargeVersions: async () => [],
    };
    const withVisit = buildSeams({
      referenceData: noSchedule,
      billableEncounters: { forRange: async () => [visit({})] },
    });
    await expect(
      buildClaimAssemblyService(makeFakeDb() as never, withVisit).assemble(ACTOR, REQUEST),
    ).rejects.toMatchObject({ code: "VISIT_CHARGE_MISSING" });

    store.reset();
    const noVisit = buildSeams({ referenceData: noSchedule }); // only the cosign-wait encounter: no visit lines
    const res = await buildClaimAssemblyService(makeFakeDb() as never, noVisit).assemble(
      ACTOR,
      REQUEST,
    );
    expect(res.lineCount).toBe(1);
  });

  it("keeps an LPN visit (G0300), an aide visit (0571/G0156) and a social-work call (0569) distinct", async () => {
    const seams = buildSeams({
      billableEncounters: {
        forRange: async () => [
          visit({ encounterId: "e1", discipline: "lpn", encounterType: "lpn_visit" }),
          visit({ encounterId: "e2", discipline: "chha", encounterType: "chha_visit" }),
          visit({
            encounterId: "e3",
            discipline: "msw",
            encounterType: "telephonic",
            durationMinutes: 20,
          }),
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);

    const visits = store.lines
      .slice(1)
      .map((l: { revenueCode: string; hcpcsCode: string }) => [l.revenueCode, l.hcpcsCode]);
    expect(visits).toEqual([
      ["0551", "G0300"],
      ["0571", "G0156"],
      ["0569", "G0155"],
    ]);
  });

  it("builds no visit line for an awaiting-cosignature visit, a chaplain visit or a reader without disciplines", async () => {
    const seams = buildSeams({
      billableEncounters: {
        forRange: async () => [
          visit({ encounterId: "a", billability: "awaiting_cosignature" }),
          visit({ encounterId: "b", discipline: "chaplain", encounterType: "chaplain_visit" }),
          { encounterId: "c", serviceDate: "2025-11-03", billability: "billable" as const },
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    expect(store.lines).toHaveLength(1);
  });

  it("assembles WITHOUT the line (never guessing units) when a billable visit has no documented duration, and warns", async () => {
    const registry = new BillingRuleRegistry();
    registry.registerRule(billing.visitLinesReportable);
    registry.freeze();
    const seams = buildSeams({
      ruleRegistry: registry,
      billableEncounters: {
        forRange: async () => [
          visit({ durationMinutes: 0 }),
          visit({ encounterId: "enc-ok", durationMinutes: 30 }),
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);

    const res = await svc.assemble(ACTOR, REQUEST);

    // The claim assembled: the per-diem line plus ONLY the documented visit.
    expect(res.initialValidationOutcome).toBe("all_pass"); // a warning never fails the run
    type StoredLine = { backingEncounterIds: string[]; revenueCode: string };
    const stored = store.lines as StoredLine[];
    expect(stored.map((l) => l.backingEncounterIds)).toContainEqual(["enc-ok"]);
    expect(
      stored.some((l) => l.backingEncounterIds.includes("enc-rn") && l.revenueCode === "0551"),
    ).toBe(false);
    // …and the skipped visit is surfaced as a warning naming the encounter id only.
    const warning = [...store.results.values()].find(
      (r: { ruleKey: string }) => r.ruleKey === "visit_lines_reportable",
    );
    expect(warning).toMatchObject({ outcome: "warn", severity: "warn" });
    expect(warning.remediation.defects).toEqual([
      expect.objectContaining({
        code: "VISIT_DURATION_MISSING",
        refs: { encounterId: "enc-rn" },
      }),
    ]);
  });

  it("does not guess visit lines at an inpatient hospice facility (Q5006 weekly reporting is deferred)", async () => {
    const seams = buildSeams({
      billableEncounters: { forRange: async () => [visit({})] },
      mdm: {
        ...buildSeams().mdm,
        resolveClinicalParticipants: async () => ({
          attending: null,
          hospicePhysician: null,
          placeOfService: "ipu",
        }),
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    expect(store.lines).toHaveLength(1);
    expect(store.lines[0].revenueCode).toBe("0651");
  });
});

describe("CMS ch. 11 §30.3 — continuous home care (0652) is one dated line per day in 15-minute units", () => {
  const chcSeams = () =>
    buildSeams({
      levelOfCare: {
        periodsInRange: async () => [
          {
            levelOfCarePeriodId: "loc-chc",
            levelOfCare: "continuous_home_care",
            from: "2025-11-01",
            to: "2025-11-02",
            chcDocumentedHours: 10,
            gipAdmissionCriteriaDocumented: null,
          },
        ],
      },
    });

  it("bills 10 documented hours as 40 units at a quarter of the hourly rate", async () => {
    const svc = buildClaimAssemblyService(makeFakeDb() as never, chcSeams());
    await svc.assemble(ACTOR, { ...REQUEST, serviceTo: "2025-11-02" });

    expect(store.lines).toHaveLength(2);
    for (const line of store.lines) {
      expect(line.revenueCode).toBe("0652");
      expect(line.unitCount).toBe(40);
      // $62.50/h x labor-share-adjusted at wage index 1.0000 = 6250c/h -> 1562.5 -> 1563c per quarter hour.
      expect(line.unitRateCents).toBe(1_563);
      expect(line.lineChargeCents).toBe(40 * 1_563);
    }
  });

  it("keeps the claim total equal to the line charges while expected payment stays on the exact hourly basis", async () => {
    const svc = buildClaimAssemblyService(makeFakeDb() as never, chcSeams());
    const res = await svc.assemble(ACTOR, { ...REQUEST, serviceTo: "2025-11-02" });

    expect(res.totalChargeCents).toBe(2 * 40 * 1_563);
    const claim = [...store.claims.values()][0];
    // 2 days x 10h x $62.50 = $1,250.00 gross; 2% sequestration -> $1,225.00.
    expect(claim.totalExpectedPaymentCents).toBe(122_500);
  });
});

describe("837I claim header — physician NPIs (UB-04 FL 76 attending / FL 78 certifying)", () => {
  const physician = (npi: string) => ({
    npi,
    status: "active" as const,
    licenseUnexpiredOnServiceDates: true,
  });

  it("persists the attending NPI and a different certifying NPI on the claim", async () => {
    const seams = buildSeams({
      mdm: {
        ...buildSeams().mdm,
        resolveClinicalParticipants: async () => ({
          attending: physician("1234567893"),
          hospicePhysician: physician("1982736455"),
          placeOfService: "home",
        }),
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    await svc.assemble(ACTOR, REQUEST);
    const claim = [...store.claims.values()][0];
    expect(claim.attendingPhysicianNpi).toBe("1234567893");
    expect(claim.certifyingPhysicianNpi).toBe("1982736455");
  });

  it("leaves the NPIs null when the physicians are unresolved (never a guess)", async () => {
    const svc = buildClaimAssemblyService(makeFakeDb() as never, buildSeams());
    await svc.assemble(ACTOR, REQUEST);
    const claim = [...store.claims.values()][0];
    expect(claim.attendingPhysicianNpi).toBeNull();
    expect(claim.certifyingPhysicianNpi).toBeNull();
  });
});

describe("the line-reading default rules accept an assembled claim that carries visit lines", () => {
  it("level-of-care, place-of-service, modifier and total-balance rules all pass over a 0551/G0299 visit line", async () => {
    const registry = new BillingRuleRegistry();
    for (const rule of [
      billing.levelOfCareCoherence,
      billing.placeOfServiceConsistency,
      billing.modifierCodesValid,
      billing.claimTotalMatchesLines,
    ]) {
      registry.registerRule(rule);
    }
    registry.freeze();
    const seams = buildSeams({
      ruleRegistry: registry,
      billableEncounters: {
        forRange: async () => [
          {
            encounterId: "enc-rn",
            serviceDate: "2025-11-03",
            billability: "billable" as const,
            discipline: "rn",
            encounterType: "routine_visit",
            durationMinutes: 45,
          },
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    const res = await svc.assemble(ACTOR, REQUEST);
    expect(store.lines).toHaveLength(2);
    expect(res.initialValidationOutcome).toBe("all_pass");
  });
});

describe("claim_total_matches_lines — the assembled claim always balances (SIA included)", () => {
  it("passes the real rule for a deceased patient with an SIA add-on", async () => {
    const registry = new BillingRuleRegistry();
    registry.registerRule(billing.claimTotalMatchesLines);
    registry.freeze();
    const seams = buildSeams({
      ruleRegistry: registry,
      admission: {
        resolveForRange: async () => ({
          admissionId: "adm-1",
          hospiceAdmissionDate: "2025-11-01",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: "2025-11-07",
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      signedEncounters: {
        inWindow: async () => [
          {
            encounterId: "rn-1",
            serviceDate: "2025-11-06",
            discipline: "RN",
            signed: true,
            cosignRequired: false,
            cosigned: false,
            durationMinutes: 120,
          },
        ],
      },
    });
    const svc = buildClaimAssemblyService(makeFakeDb() as never, seams);
    const res = await svc.assemble(ACTOR, REQUEST);
    expect(res.initialValidationOutcome).toBe("all_pass");
  });
});
