// apps/backend/__tests__/discipline-plans-volunteer.test.ts — M15-T04 (§2.2.5–§2.2.7, §7.4–§7.6).
//
// The 42 CFR §418.78 volunteer domain: the compliance-gate lifecycle, the effective status M17's
// pre-schedule gate consumes, the expiry → inactive cascade, and the 418.78(e) 5% hour ledger + ratio.
// Pure — every fact is injected — plus the M8 volunteer-visit resolver against a registered fake seam.
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { resolveVolunteerVisitCandidates } from "../src/modules/15-discipline-care-plans/consumers/index";
import { DisciplinePlanStateError } from "../src/modules/15-discipline-care-plans/lifecycle/index";
import {
  GATE_STORE_UNAVAILABLE,
  type OpenVolunteerAssignment,
  type VolunteerGateFacts,
  aggregateVolunteerHours,
  checkVolunteerHourEntry,
  computeVolunteerHourRatio,
  decideCreateVolunteerAssignment,
  decideExpireGate,
  decideInactivateAssignmentsForGate,
  decideReactivateAssignment,
  decideRecordGate,
  decideRevokeGate,
  deriveGateStatus,
  effectiveStatusFor,
  fiscalYearFor,
  gatesToExpire,
  planGateExpiryAlerts,
  ratioAlertSeverity,
  statusEdge,
} from "../src/modules/15-discipline-care-plans/volunteer/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const PLAN_B = "3b3b3b3b-3333-3333-3333-333333333333";
const VOLUNTEER = "77777777-7777-7777-7777-777777777777";
const COORDINATOR = "88888888-8888-8888-8888-888888888888";
const PROVIDER_ENTITY = "99999999-9999-9999-9999-999999999999";
const NOW = "2026-03-01T12:00:00.000Z";

/** The six BLOCKING gate kinds (`vaccination_status` is tracked but never blocks — §2.3 D7). */
const BLOCKING = [
  "background_check",
  "tb_screening",
  "confidentiality_agreement",
  "initial_training",
  "annual_ce",
  "assignment_specific_training",
] as const;

/** Build a gate row valid from a year ago until `validUntil` (null = lifetime). */
function gate(
  kind: (typeof BLOCKING)[number] | "vaccination_status",
  overrides: Partial<VolunteerGateFacts> = {},
): VolunteerGateFacts {
  return {
    gateId: `gate-${kind}`,
    volunteerMembershipId: VOLUNTEER,
    gateKind: kind,
    status: "satisfied",
    validFrom: "2025-03-01T00:00:00.000Z",
    validUntil: "2027-03-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

/** A fully-credentialed volunteer: every blocking gate current. */
function allGatesSatisfied(): VolunteerGateFacts[] {
  return BLOCKING.map((k) => gate(k));
}

/** Assert a guard raises the exact §4.2 machine-readable code (the message is prose, the code is the contract). */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DisciplinePlanStateError);
    expect((err as DisciplinePlanStateError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be raised, but nothing was thrown`);
}

function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

describe("M15 §2.2.6 volunteer compliance gate lifecycle", () => {
  it("derives status over the validity window, not the materialized column", () => {
    // The stored column says `satisfied`; the window elapsed two days ago. A missed nightly run must not
    // re-qualify an expired volunteer.
    const stale = gate("tb_screening", {
      status: "satisfied",
      validUntil: "2026-02-27T00:00:00.000Z",
    });
    expect(deriveGateStatus(stale, NOW)).toBe("expired");
  });

  it("derives expiring_soon inside the 30-day lead-in and satisfied outside it", () => {
    expect(
      deriveGateStatus(gate("annual_ce", { validUntil: "2026-03-20T12:00:00.000Z" }), NOW),
    ).toBe("expiring_soon");
    expect(
      deriveGateStatus(gate("annual_ce", { validUntil: "2026-06-01T12:00:00.000Z" }), NOW),
    ).toBe("satisfied");
  });

  it("treats a lifetime gate (null valid_until) as satisfied and a future window as not_yet_satisfied", () => {
    expect(deriveGateStatus(gate("initial_training", { validUntil: null }), NOW)).toBe("satisfied");
    expect(
      deriveGateStatus(gate("initial_training", { validFrom: "2026-06-01T00:00:00.000Z" }), NOW),
    ).toBe("not_yet_satisfied");
  });

  it("lets revocation win over a still-open window", () => {
    expect(deriveGateStatus(gate("background_check", { revokedAt: NOW }), NOW)).toBe("revoked");
  });

  it("refuses a second current row for the same (volunteer, kind)", () => {
    expectCode(
      () =>
        decideRecordGate(
          {
            volunteerMembershipId: VOLUNTEER,
            gateKind: "tb_screening",
            validFrom: NOW,
            validUntil: "2027-03-01T00:00:00.000Z",
            existingGates: [gate("tb_screening")],
          },
          NOW,
        ),
      "GATE_ALREADY_CURRENT",
    );
  });

  it("accepts a renewal recorded after the previous window expired", () => {
    const decision = decideRecordGate(
      {
        volunteerMembershipId: VOLUNTEER,
        gateKind: "tb_screening",
        validFrom: NOW,
        validUntil: "2027-03-01T00:00:00.000Z",
        existingGates: [gate("tb_screening", { validUntil: "2026-02-01T00:00:00.000Z" })],
      },
      NOW,
    );
    expect(decision.status).toBe("satisfied");
  });

  it("rejects an inverted validity window and a dated one-time credential", () => {
    expectCode(
      () =>
        decideRecordGate(
          {
            volunteerMembershipId: VOLUNTEER,
            gateKind: "tb_screening",
            validFrom: "2026-06-01T00:00:00.000Z",
            validUntil: "2026-03-01T00:00:00.000Z",
            existingGates: [],
          },
          NOW,
        ),
      "VALID_UNTIL_BEFORE_VALID_FROM",
    );
    expectCode(
      () =>
        decideRecordGate(
          {
            volunteerMembershipId: VOLUNTEER,
            gateKind: "initial_training",
            validFrom: NOW,
            validUntil: "2027-03-01T00:00:00.000Z",
            existingGates: [],
          },
          NOW,
        ),
      "INITIAL_TRAINING_LIFETIME",
    );
  });

  it("requires a reason to revoke and refuses a second revocation", () => {
    expectCode(() => decideRevokeGate(gate("annual_ce"), "  ", NOW), "GATE_REVOKE_REASON_REQUIRED");
    expectCode(
      () => decideRevokeGate(gate("annual_ce", { revokedAt: NOW }), "falsified", NOW),
      "GATE_ALREADY_TERMINAL",
    );
    expect(decideRevokeGate(gate("annual_ce"), "credential withdrawn by issuer", NOW).status).toBe(
      "revoked",
    );
  });

  it("flips only an elapsed gate to expired, and emits m15.volunteer.gate_expired", () => {
    const expired = gate("tb_screening", { validUntil: "2026-02-01T00:00:00.000Z" });
    const decision = decideExpireGate(expired, NOW);
    expect(decision.status).toBe("expired");
    expect(outboxEvents(decision.effects)).toEqual(["m15.volunteer.gate_expired"]);
    expectCode(() => decideExpireGate(gate("tb_screening"), NOW), "GATE_ALREADY_TERMINAL");
  });

  it("selects exactly the gates a nightly run must expire", () => {
    const gates = [
      gate("tb_screening", { gateId: "g1", validUntil: "2026-02-01T00:00:00.000Z" }),
      gate("annual_ce", { gateId: "g2" }),
      gate("background_check", {
        gateId: "g3",
        validUntil: "2026-01-01T00:00:00.000Z",
        revokedAt: NOW,
      }),
    ];
    expect(gatesToExpire(gates, NOW).map((g) => g.gateId)).toEqual(["g1"]);
  });
});

describe("M15 §7.5 gate expiry alert ladder", () => {
  /** A gate expiring exactly `daysOut` whole days from NOW. */
  function expiringIn(daysOut: number, gateId: string): VolunteerGateFacts {
    return gate("tb_screening", {
      gateId,
      validUntil: new Date(Date.parse(NOW) + daysOut * 86_400_000).toISOString(),
    });
  }

  it("fires 30 → info, 14 → warn, 7 → warn, 1 → critical", () => {
    const marks = [30, 14, 7, 1].map((d) => expiringIn(d, `g${d}`));
    const notices = marks.flatMap((g) => planGateExpiryAlerts([g], NOW));
    expect(notices.map((n) => [n.daysOut, n.severity])).toEqual([
      [30, "info"],
      [14, "warn"],
      [7, "warn"],
      [1, "critical"],
    ]);
  });

  it("stays silent between ladder marks and after expiry", () => {
    expect(planGateExpiryAlerts([expiringIn(21, "g21")], NOW)).toEqual([]);
    expect(planGateExpiryAlerts([expiringIn(-3, "gone")], NOW)).toEqual([]);
  });

  it("does not re-page a mark that was already sent", () => {
    const g = expiringIn(14, "g14");
    expect(planGateExpiryAlerts([g], NOW, new Map([["g14", [14]]]))).toEqual([]);
    expect(planGateExpiryAlerts([g], NOW, new Map([["g14", [30]]]))).toHaveLength(1);
  });
});

describe("M15 §7.4 / §4.4 volunteer effective status", () => {
  it("is active only when every blocking gate clears", () => {
    const status = effectiveStatusFor(VOLUNTEER, allGatesSatisfied(), NOW);
    expect(status).toEqual({ membershipId: VOLUNTEER, isActive: true, failingGates: [] });
  });

  it("reports a MISSING gate as failing, exactly like an expired one", () => {
    const missingTb = allGatesSatisfied().filter((g) => g.gateKind !== "tb_screening");
    expect(effectiveStatusFor(VOLUNTEER, missingTb, NOW)).toMatchObject({
      isActive: false,
      failingGates: ["tb_screening"],
    });
  });

  it("keeps expiring_soon clearing — the 30-day notice warns, it does not strand the volunteer", () => {
    const soon = allGatesSatisfied().map((g) =>
      g.gateKind === "annual_ce"
        ? gate("annual_ce", { validUntil: "2026-03-15T12:00:00.000Z" })
        : g,
    );
    expect(effectiveStatusFor(VOLUNTEER, soon, NOW).isActive).toBe(true);
  });

  it("ignores vaccination_status — tracked and alerted, never blocking (D7)", () => {
    const withExpiredVax = [
      ...allGatesSatisfied(),
      gate("vaccination_status", { validUntil: "2025-01-01T00:00:00.000Z" }),
    ];
    expect(effectiveStatusFor(VOLUNTEER, withExpiredVax, NOW).isActive).toBe(true);
  });

  it("ignores another volunteer's gates", () => {
    const someoneElse = allGatesSatisfied().map((g) => ({
      ...g,
      volunteerMembershipId: COORDINATOR,
    }));
    expect(effectiveStatusFor(VOLUNTEER, someoneElse, NOW)).toMatchObject({
      isActive: false,
      failingGates: [...BLOCKING],
    });
  });

  it("denies fail-CLOSED when the gate store is unreadable (§8.7 / M15-F11)", () => {
    expect(effectiveStatusFor(VOLUNTEER, null, NOW)).toEqual({
      membershipId: VOLUNTEER,
      isActive: false,
      failingGates: [GATE_STORE_UNAVAILABLE],
    });
  });

  it("detects the status edge the watcher emits on", () => {
    const active = effectiveStatusFor(VOLUNTEER, allGatesSatisfied(), NOW);
    const inactive = effectiveStatusFor(VOLUNTEER, [], NOW);
    expect(statusEdge(active, inactive)).toBe("deactivated");
    expect(statusEdge(inactive, active)).toBe("reactivated");
    expect(statusEdge(active, active)).toBe("none");
  });
});

describe("M15 §7.4 / §8.6 volunteer assignment gating", () => {
  const base = {
    planId: PLAN,
    planKind: "volunteer_plan" as const,
    volunteerMembershipId: VOLUNTEER,
    coordinatorMembershipId: COORDINATOR,
  };

  it("saves cleanly for a fully-credentialed volunteer", () => {
    const decision = decideCreateVolunteerAssignment({ ...base, gates: allGatesSatisfied() }, NOW);
    expect(decision).toMatchObject({ failingGates: [], overridden: false });
  });

  it("refuses the INSERT with VOLUNTEER_GATE_UNMET when a gate is expired", () => {
    const gates = allGatesSatisfied().map((g) =>
      g.gateKind === "tb_screening"
        ? gate("tb_screening", { validUntil: "2026-01-01T00:00:00.000Z" })
        : g,
    );
    expectCode(
      () => decideCreateVolunteerAssignment({ ...base, gates }, NOW),
      "VOLUNTEER_GATE_UNMET",
    );
  });

  it("refuses an assignment on a plan that is not a volunteer plan", () => {
    expectCode(
      () =>
        decideCreateVolunteerAssignment(
          { ...base, planKind: "msw_plan", gates: allGatesSatisfied() },
          NOW,
        ),
      "NOT_A_VOLUNTEER_PLAN",
    );
  });

  it("denies when the gate store is unreadable, even with no override", () => {
    expectCode(
      () => decideCreateVolunteerAssignment({ ...base, gates: null }, NOW),
      "VOLUNTEER_GATE_UNMET",
    );
  });

  it("allows the §8.6 override only with a documented reason ≥ 40 chars, and audits it", () => {
    expectCode(
      () =>
        decideCreateVolunteerAssignment(
          { ...base, gates: [], override: { reason: "too short" } },
          NOW,
        ),
      "GATE_OVERRIDE_REASON_REQUIRED",
    );
    const decision = decideCreateVolunteerAssignment(
      {
        ...base,
        gates: [],
        override: {
          reason:
            "TB screening renewal is documented in the paper chart pending scan; DON approved 2026-03-01.",
        },
      },
      NOW,
    );
    expect(decision.overridden).toBe(true);
    expect(decision.failingGates).toEqual([...BLOCKING]);
    expect(decision.effects.some((e) => e.kind === "gate_override")).toBe(true);
  });
});

describe("M15 §7.5 expiry → inactive cascade", () => {
  const open: OpenVolunteerAssignment[] = [
    { assignmentId: "a1", planId: PLAN, volunteerMembershipId: VOLUNTEER, inactivatedAt: null },
    { assignmentId: "a2", planId: PLAN_B, volunteerMembershipId: VOLUNTEER, inactivatedAt: null },
    { assignmentId: "a3", planId: PLAN, volunteerMembershipId: COORDINATOR, inactivatedAt: null },
  ];

  it("stamps gate_expired:<kind> on every open row for the volunteer only", () => {
    const cascade = decideInactivateAssignmentsForGate({
      volunteerMembershipId: VOLUNTEER,
      gateKind: "tb_screening",
      openAssignments: open,
      at: NOW,
    });
    expect(cascade.inactivations.map((i) => i.assignmentId)).toEqual(["a1", "a2"]);
    expect(cascade.inactivations[0]?.inactivationReason).toBe("gate_expired:tb_screening");
    expect(cascade.openAssignmentsCount).toBe(2);
    expect(cascade.affectedPlanIds).toEqual([PLAN, PLAN_B]);
    expect(outboxEvents(cascade.effects)).toEqual(["m15.volunteer.assignment_inactivated"]);
  });

  it("keeps the FIRST cause on an already-inactivated row and stays quiet when nothing is open", () => {
    const alreadyOut = open.map((a) => ({ ...a, inactivatedAt: "2026-02-01T00:00:00.000Z" }));
    const cascade = decideInactivateAssignmentsForGate({
      volunteerMembershipId: VOLUNTEER,
      gateKind: "annual_ce",
      openAssignments: alreadyOut,
      at: NOW,
    });
    expect(cascade.inactivations).toEqual([]);
    expect(cascade.effects).toEqual([]);
  });

  it("never auto-reactivates: renewal + a fresh coordinator acknowledgment are both required", () => {
    const inactive: OpenVolunteerAssignment = {
      assignmentId: "a1",
      planId: PLAN,
      volunteerMembershipId: VOLUNTEER,
      inactivatedAt: "2026-02-01T00:00:00.000Z",
    };
    expectCode(
      () =>
        decideReactivateAssignment({
          assignment: inactive,
          gates: [],
          coordinatorAcknowledged: true,
          now: NOW,
        }),
      "VOLUNTEER_GATE_UNMET",
    );
    expectCode(
      () =>
        decideReactivateAssignment({
          assignment: inactive,
          gates: allGatesSatisfied(),
          coordinatorAcknowledged: false,
          now: NOW,
        }),
      "COORDINATOR_ACKNOWLEDGMENT_REQUIRED",
    );
    expectCode(
      () =>
        decideReactivateAssignment({
          assignment: { ...inactive, inactivatedAt: null },
          gates: allGatesSatisfied(),
          coordinatorAcknowledged: true,
          now: NOW,
        }),
      "ASSIGNMENT_NOT_INACTIVE",
    );
    expect(
      decideReactivateAssignment({
        assignment: inactive,
        gates: allGatesSatisfied(),
        coordinatorAcknowledged: true,
        now: NOW,
      }).effects,
    ).toEqual([{ kind: "audit" }]);
  });
});

describe("M15 §2.2.7 volunteer hour ledger", () => {
  it("buckets an instant into the fiscal year — calendar by default, end-year for a non-calendar FY", () => {
    expect(fiscalYearFor("2026-03-01T00:00:00.000Z")).toBe(2026);
    expect(fiscalYearFor("2025-11-15T00:00:00.000Z", 10)).toBe(2026);
    expect(fiscalYearFor("2026-09-15T00:00:00.000Z", 10)).toBe(2026);
    expect(fiscalYearFor("2026-10-01T00:00:00.000Z", 10)).toBe(2027);
  });

  it("guards the entry invariants the DB CHECKs back", () => {
    const ok = {
      volunteerMembershipId: VOLUNTEER,
      source: "volunteer_admin_hours" as const,
      durationMinutes: 90,
      occurredAt: NOW,
      sourceEncounterId: null,
      adjustmentReason: null,
      adjustedByMembershipId: null,
    };
    expect(() => checkVolunteerHourEntry(ok)).not.toThrow();
    expectCode(
      () => checkVolunteerHourEntry({ ...ok, durationMinutes: 0 }),
      "HOUR_ENTRY_DURATION_INVALID",
    );
    // Negative minutes are the audited correction path only.
    expectCode(
      () => checkVolunteerHourEntry({ ...ok, durationMinutes: -30 }),
      "HOUR_ENTRY_DURATION_INVALID",
    );
    expectCode(
      () =>
        checkVolunteerHourEntry({
          ...ok,
          source: "manual_adjustment",
          durationMinutes: -30,
          adjustmentReason: null,
        }),
      "HOUR_ADJUSTMENT_REASON_REQUIRED",
    );
    expect(() =>
      checkVolunteerHourEntry({
        ...ok,
        source: "manual_adjustment",
        durationMinutes: -30,
        adjustmentReason: "double-counted the 12 Feb visit",
        adjustedByMembershipId: COORDINATOR,
      }),
    ).not.toThrow();
    expectCode(
      () => checkVolunteerHourEntry({ ...ok, source: "encounter" }),
      "HOUR_ENTRY_SOURCE_MISMATCH",
    );
  });

  it("aggregates unledgered in-year visits and is idempotent on source_encounter_id", () => {
    const existing = [
      {
        volunteerMembershipId: VOLUNTEER,
        source: "encounter" as const,
        durationMinutes: 60,
        occurredAt: "2026-01-10T00:00:00.000Z",
        sourceEncounterId: "enc-1",
        adjustmentReason: null,
        adjustedByMembershipId: null,
      },
    ];
    const agg = aggregateVolunteerHours({
      providerEntityId: PROVIDER_ENTITY,
      fiscalYear: 2026,
      existingEntries: existing,
      candidates: [
        // already ledgered → skipped
        {
          encounterId: "enc-1",
          volunteerMembershipId: VOLUNTEER,
          occurredAt: "2026-01-10T00:00:00.000Z",
          durationMinutes: 60,
        },
        // new, in year → counted
        {
          encounterId: "enc-2",
          volunteerMembershipId: VOLUNTEER,
          occurredAt: "2026-02-14T00:00:00.000Z",
          durationMinutes: 45,
        },
        // out of the bucket's fiscal year → ignored
        {
          encounterId: "enc-3",
          volunteerMembershipId: VOLUNTEER,
          occurredAt: "2025-12-30T00:00:00.000Z",
          durationMinutes: 30,
        },
      ],
      asOfAt: NOW,
    });
    expect(agg.newEntries.map((e) => e.sourceEncounterId)).toEqual(["enc-2"]);
    expect(agg.totalVolunteerHourMinutes).toBe(105);
    expect(outboxEvents(agg.effects)).toEqual(["m15.volunteer.ratio_recomputed"]);
    expect(agg.effects).toContainEqual({
      kind: "set_ledger_total",
      totalVolunteerHourMinutes: 105,
      asOfAt: NOW,
    });
  });

  it("reports an unresolvable visit duration instead of counting it as zero", () => {
    const agg = aggregateVolunteerHours({
      providerEntityId: PROVIDER_ENTITY,
      fiscalYear: 2026,
      existingEntries: [],
      candidates: [
        {
          encounterId: "enc-9",
          volunteerMembershipId: VOLUNTEER,
          occurredAt: "2026-02-01T00:00:00.000Z",
          durationMinutes: null,
        },
      ],
      asOfAt: NOW,
    });
    expect(agg.unresolvedDurationEncounterIds).toEqual(["enc-9"]);
    expect(agg.newEntries).toEqual([]);
    expect(agg.totalVolunteerHourMinutes).toBe(0);
  });
});

describe("M15 §7.6 418.78(e) 5% ratio", () => {
  const bucket = { providerEntityId: PROVIDER_ENTITY, fiscalYear: 2026 };

  it("surfaces `unavailable` with a stated reason while the M27 denominator is unbound — never 0%", () => {
    const r = computeVolunteerHourRatio({
      ...bucket,
      volunteerHourMinutes: 12_000,
      staffPatientCareMinutes: null,
    });
    expect(r.ratio).toBeNull();
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("cost basis unavailable");
    expect(ratioAlertSeverity(r)).toBeNull();
  });

  it("treats a zero denominator as unavailable, not as a CoP breach", () => {
    const r = computeVolunteerHourRatio({
      ...bucket,
      volunteerHourMinutes: 0,
      staffPatientCareMinutes: 0,
    });
    expect(r.status).toBe("unavailable");
  });

  it("badges green at/above 5%, yellow in 3–5%, red below 3% — and pages accordingly", () => {
    const at5 = computeVolunteerHourRatio({
      ...bucket,
      volunteerHourMinutes: 5_000,
      staffPatientCareMinutes: 100_000,
    });
    const at4 = computeVolunteerHourRatio({
      ...bucket,
      volunteerHourMinutes: 4_000,
      staffPatientCareMinutes: 100_000,
    });
    const at2 = computeVolunteerHourRatio({
      ...bucket,
      volunteerHourMinutes: 2_000,
      staffPatientCareMinutes: 100_000,
    });
    expect([at5.status, at4.status, at2.status]).toEqual(["green", "yellow", "red"]);
    expect([ratioAlertSeverity(at5), ratioAlertSeverity(at4), ratioAlertSeverity(at2)]).toEqual([
      null,
      "warn",
      "critical",
    ]);
  });
});

describe("M15 §7.6 M8 volunteer-visit resolver (SignedEncountersReader seam)", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  function digest(overrides: Record<string, unknown> = {}) {
    return {
      encounterId: "enc-1",
      patientId: PATIENT,
      admissionId: "adm-1",
      encounterType: "volunteer_visit",
      discipline: "volunteer",
      serviceDate: "2026-02-14",
      signedAt: "2026-02-15T18:00:00.000Z",
      signedByMembershipId: VOLUNTEER,
      lateEntryTier: "same_day",
      status: "signed",
      evvBracketState: "not_applicable",
      ...overrides,
    };
  }

  function registerReader(digests: ReadonlyArray<Record<string, unknown>>): void {
    registerSeam("SignedEncountersReader", {
      signedEncountersForPatientSince: async () => digests,
      renderPayloadFor: async () => {
        throw new Error("not used");
      },
    });
  }

  it("keeps only volunteer_visit encounters signed by the assigned volunteer, anchored on the SERVICE date", async () => {
    registerReader([
      digest(),
      // another discipline's visit to the same patient is not volunteer time
      digest({ encounterId: "enc-2", encounterType: "routine_visit", discipline: "rn" }),
      // a volunteer visit signed by somebody else
      digest({ encounterId: "enc-3", signedByMembershipId: COORDINATOR }),
    ]);
    const candidates = await resolveVolunteerVisitCandidates({
      orgId: ORG,
      servedPatients: [{ patientId: PATIENT, volunteerMembershipId: VOLUNTEER }],
      since: "2026-01-01T00:00:00.000Z",
      durationsByEncounterId: new Map([["enc-1", 75]]),
    });
    expect(candidates).toEqual([
      {
        encounterId: "enc-1",
        volunteerMembershipId: VOLUNTEER,
        occurredAt: "2026-02-14T00:00:00.000Z",
        durationMinutes: 75,
      },
    ]);
  });

  it("returns a null duration when none was resolved (the aggregator reports it, never zeroes it)", async () => {
    registerReader([digest()]);
    const candidates = await resolveVolunteerVisitCandidates({
      orgId: ORG,
      servedPatients: [{ patientId: PATIENT, volunteerMembershipId: VOLUNTEER }],
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(candidates[0]?.durationMinutes).toBeNull();
  });

  it("de-duplicates the same encounter reached through two assignments", async () => {
    registerReader([digest()]);
    const candidates = await resolveVolunteerVisitCandidates({
      orgId: ORG,
      servedPatients: [
        { patientId: PATIENT, volunteerMembershipId: VOLUNTEER },
        { patientId: PATIENT, volunteerMembershipId: VOLUNTEER },
      ],
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(candidates).toHaveLength(1);
  });
});
